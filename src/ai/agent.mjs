// Agent 主循环（PROTOCOL-AGENT.md §6）。
//
// 用 Vercel AI SDK 的 generateText + tools 做多步执行。
//
// 关键约束：
//   - 不要用 AI SDK 的 `toolApproval`：跨轮恢复有 bug（第 3 轮必报
//     `Tool result is missing for tool call`）。审批挂在 execute 内部 await。
//   - `stopWhen: stepCountIs(8)`。
//   - 任务结束必须发且只发一次 agent.done 或 agent.error。
//   - stop 时 abort + 所有 pending approval resolve 成 aborted，但**不杀**已在跑的 PTY 命令。

import crypto from "node:crypto";
import { generateText, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { DEFAULT_MODEL, gatewayBaseUrl } from "./gateway.mjs";
import { judge } from "./judge.mjs";
import { forbiddenReason } from "../policy/forbidden.mjs";
import { buildContext } from "./context.mjs";
import { OUTPUT_MAX_CHARS } from "./runner.mjs";

/** 审批等待上限（PROTOCOL §6.3）。 */
export const APPROVAL_TIMEOUT_MS = 120000;

/** 最多几步（PROTOCOL §6）。 */
export const MAX_STEPS = 8;

/** 内置基础提示词（PROTOCOL §6.2 逐字）。 */
export const DEFAULT_BASE_PROMPT =
  "你是一个内置在终端里的 AI 助手。你的服务对象是不太懂命令行的普通用户。你的工作是理解他想达成什么，然后自己动手在终端里把这件事做完，最后用他自己的语言告诉他结果。";

/** 硬性规则（PROTOCOL §6.2 逐字）。 */
export const AGENT_HARD_RULES = [
  "## 硬性规则",
  "1. 你不是在建议命令，你是在替用户干活。需要看什么就自己调用 run_command 去看。",
  "2. 用户可能完全不懂命令行，所以：不要让他自己敲命令来帮你确认；不要在回答里堆命令；最后必须用大白话讲清楚「发生了什么、现在是什么情况、你要不要做什么」。",
  "3. 一条命令拿不到全部信息就多跑几条，最多 8 步。每一步都要有明确目的，不要重复已跑过的命令。",
  "4. 命令失败（exitCode 非 0）先读错误再决定下一步，不要原样重试。",
  "5. 你自己不执行任何命令，应用会按安全策略自动执行或弹确认卡。所以照常给出用户要的命令，包括 rm / mv 这类删除移动；不要因为「它是破坏性操作」就拒绝给命令。",
  "6. 唯一绝对不给的是 sudo / su 这类提权命令。",
  "7. 不要使用 find，文件检索用 rg -n（搜内容）、rg --files（列文件）或 ls。",
  "8. 查看 HTTP 头用 curl -I，不要用 curl 下载或上传。",
  "9. 如果某条命令被用户拒绝，不要重试，改用别的办法或告诉用户需要他手动做什么。",
  "10. 任务完成后必须用文字给出结论，不要只留一串命令输出。",
].join("\n");

/** EXEC_UNSUPPORTED 时追加给模型的一句（PROTOCOL §4.4）。 */
const UNSUPPORTED_HINT =
  "\n\n注意：这个终端不支持自动执行（EXEC_UNSUPPORTED）。不要再调用 run_command，改为只用文字回答，并把需要用户自己运行的命令列出来。";

/**
 * 组装 agent 系统提示词（PROTOCOL §6.2）。
 * @param {object} [config]
 * @returns {string}
 */
export function buildAgentSystemPrompt(config) {
  const conf = config && typeof config === "object" ? config : {};
  const base =
    typeof conf.basePrompt === "string" && conf.basePrompt.trim().length > 0
      ? conf.basePrompt
      : DEFAULT_BASE_PROMPT;
  return [base, "", AGENT_HARD_RULES].join("\n");
}

let cachedProvider = null;
let cachedProviderBase = null;

function providerFor(baseUrl) {
  if (cachedProvider && cachedProviderBase === baseUrl) return cachedProvider;
  cachedProviderBase = baseUrl;
  cachedProvider = createOpenAICompatible({
    name: "magpie",
    baseURL: `${baseUrl}/v1`,
    apiKey: "magpie",
  });
  return cachedProvider;
}

/** 用户消息（cwd / shell / 最近输出 + 意图）。 */
function buildAgentUserMessage(question, context) {
  const ctx = buildContext(context);
  return [
    `当前工作目录：${ctx.cwd}`,
    `当前 shell：${ctx.shell}`,
    ctx.recentOutput ? `终端最近输出：\n${ctx.recentOutput}` : "终端最近没有输出。",
    "",
    `用户想要：${typeof question === "string" ? question : ""}`,
  ].join("\n");
}

/** 用户拒绝时工具返回给模型的话（PROTOCOL §6.1 逐字）。 */
export const DENIED_USER_TEXT =
  "用户拒绝了这条命令。不要重试同一条，换个做法告诉用户为什么需要他手动处理。";

function newTaskId() {
  return `t-${crypto.randomBytes(5).toString("hex")}`;
}

function newApprovalId() {
  return `a-${crypto.randomBytes(6).toString("hex")}`;
}

/** 截断进 agent.step 的输出（runner 已截断，这里只兜底）。 */
function clampOutput(text) {
  const value = typeof text === "string" ? text : "";
  return value.length > OUTPUT_MAX_CHARS ? value.slice(0, OUTPUT_MAX_CHARS) : value;
}

/**
 * 创建 agent 执行器。
 *
 * @param {object} opts
 * @param {(entry:object)=>void} [opts.log]
 * @param {object} opts.runner createCommandRunner() 的返回值
 * @param {object} [opts.config] 默认配置（每次 start 可覆盖）
 * @param {Function} [opts.generateTextFn] 仅供测试注入
 * @param {Function} [opts.judgeFn] 仅供测试注入
 */
export function createAgentRunner(opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const runner = opts.runner;
  const defaultConfig = opts.config && typeof opts.config === "object" ? opts.config : {};
  const generateTextFn = typeof opts.generateText === "function" ? opts.generateText : generateText;
  const judgeFn = typeof opts.judgeFn === "function" ? opts.judgeFn : judge;

  /** approvalId -> { resolve, timer, stepId, taskId } */
  const pending = new Map();

  /** 每个 socket 一个当前任务：socket -> task */
  const bySocket = new Map();

  /**
   * 决定一条命令怎么走（分级链），并把结果翻译成「要不要问用户」。
   * 导出给测试直接打（AC5 / AC6 走 judge，这里只做映射）。
   */
  async function decide({ command, config, cwd, model }) {
    return judgeFn({ command, config, cwd, model });
  }

  function resolveApproval({ approvalId, approved, scope } = {}) {
    const item = pending.get(approvalId);
    if (!item) return false;
    pending.delete(approvalId);
    if (item.timer) clearTimeout(item.timer);
    item.resolve({ approved: approved === true, scope: scope || "once" });
    return true;
  }

  function stopAll() {
    for (const task of [...bySocket.values()]) {
      try {
        task.stop({ reason: "server-close" });
      } catch {
        // 忽略。
      }
    }
    bySocket.clear();
    for (const [id, item] of pending) {
      pending.delete(id);
      if (item.timer) clearTimeout(item.timer);
      item.resolve({ approved: false, aborted: true });
    }
  }

  /** 找到某个 socket 上的任务（用于 stop / approve 路由）。 */
  function taskForSocket(socket) {
    return bySocket.get(socket) || null;
  }

  /**
   * 起一个任务。
   *
   * @returns {{taskId: string, stop: Function}|{busy: true}}
   */
  function start({ requestId, question, model, context, sessionId, send, config, socket } = {}) {
    const effectiveConfig = config && typeof config === "object" ? { ...defaultConfig, ...config } : defaultConfig;
    const taskId = newTaskId();
    const chosenModel = typeof model === "string" && model.length > 0 ? model : process.env.MAGPIE_TERMINAL_MODEL || DEFAULT_MODEL;
    const targetSessionId = typeof sessionId === "string" ? sessionId : "";

    // 一个连接同时只允许一个 agent 任务（TASK-V3-D §3 非目标）。
    const existing = socket ? bySocket.get(socket) : null;
    if (existing && !existing.settled) {
      send({
        type: "agent.error",
        requestId,
        taskId,
        code: "BUSY",
        userText: "上一个任务还在跑，等它结束或点停止。",
      });
      return { busy: true, taskId };
    }

    const controller = new AbortController();
    let stopped = false;
    let settled = false;
    let autoRest = false;
    let stepCount = 0;
    const startedAt = Date.now();
    /** 本任务发出的待审批（taskId 维度，stop 时全部 resolve）。 */
    const taskPending = new Set();

    const emit = (frame) => {
      try {
        send(frame);
      } catch {
        // 连接已断，忽略。
      }
    };

    const firstMessage = buildAgentUserMessage(question, context);

    function awaitApproval({ stepId, command, why, risk, reviewWhy, reversible, reviewModel }) {
      const approvalId = newApprovalId();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.has(approvalId)) return;
          pending.delete(approvalId);
          taskPending.delete(approvalId);
          resolve({ approved: false, timeout: true });
        }, APPROVAL_TIMEOUT_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
        pending.set(approvalId, { resolve, timer, stepId, taskId });
        taskPending.add(approvalId);
        emit({
          type: "agent.approval",
          requestId,
          taskId,
          stepId,
          approvalId,
          command,
          why: typeof why === "string" ? why : "",
          risk: risk === undefined ? null : risk,
          reviewWhy: reviewWhy === undefined ? null : reviewWhy,
          reversible: reversible === undefined ? null : reversible,
          reviewModel: reviewModel === undefined ? null : reviewModel,
        });
      });
    }

    const runCommandTool = tool({
      description: "在用户当前的终端里执行一条 shell 命令，并返回真实输出。",
      inputSchema: z.object({
        command: z.string().describe("完整的一行命令"),
        why: z.string().describe("用大白话说明为什么要跑这条，给完全不懂命令行的用户看"),
      }),
      execute: async ({ command, why }, { toolCallId }) => {
        if (stopped || controller.signal.aborted) {
          return { denied: true, aborted: true, userText: "任务已停止，不要再执行任何命令。" };
        }
        stepCount += 1;
        const stepId = `s-${crypto.randomBytes(5).toString("hex")}`;
        const index = stepCount;

        // 1. 分级
        let verdict;
        try {
          verdict = await decide({ command, config: effectiveConfig, cwd: context && context.cwd, model: chosenModel });
        } catch {
          verdict = {
            decision: "confirm",
            reason: "判定过程异常，按需要确认处理",
            hit: null,
            risk: null,
            reviewModel: null,
          };
        }

        let auto = verdict.decision === "auto";
        // scope === "rest" 之后的 confirm 级命令直接跑；硬禁止仍然 confirm（PROTOCOL §6.3）。
        // 硬禁止用 forbiddenReason 再确认一次，不靠 reason 文本前缀（那太脆）。
        if (!auto && autoRest && forbiddenReason(command) === null) auto = true;

        emit({
          type: "agent.step",
          requestId,
          taskId,
          stepId,
          index,
          kind: "command",
          status: auto ? "running" : "awaiting",
          command,
          why: typeof why === "string" ? why : "",
        });

        if (!auto) {
          const answer = await awaitApproval({
            stepId,
            command,
            why,
            risk: verdict.risk,
            // agent.approval 帧要「第二 AI 的结论 + 原话 + 可撤销」，judge 已透出。
            reviewWhy: typeof verdict.reviewWhy === "string" ? verdict.reviewWhy : null,
            reversible: typeof verdict.reversible === "boolean" ? verdict.reversible : null,
            reviewModel: verdict.reviewModel || null,
          });
          if (stopped || answer.aborted) {
            emit({ type: "agent.step", requestId, taskId, stepId, index, kind: "command", status: "skipped", command, why });
            return { denied: true, aborted: true, userText: "任务已停止，不要再执行任何命令。" };
          }
          if (!answer.approved) {
            emit({
              type: "agent.step",
              requestId,
              taskId,
              stepId,
              index,
              kind: "command",
              status: "denied",
              command,
              why,
              userText: answer.timeout ? "等你确认超时了，这条没有执行。" : DENIED_USER_TEXT,
            });
            return { denied: true, userText: DENIED_USER_TEXT };
          }
          if (answer.scope === "rest") autoRest = true;
          emit({
            type: "agent.step",
            requestId,
            taskId,
            stepId,
            index,
            kind: "command",
            status: "running",
            command,
            why,
          });
        }

        // 2. 执行
        let runResult;
        try {
          runResult = await runner.run({ sessionId: targetSessionId, command });
        } catch (err) {
          runResult = {
            ok: false,
            code: "EXEC_FAILED",
            exitCode: null,
            output: "",
            truncated: false,
            userText: "命令执行失败。",
          };
        }

        if (!runResult || runResult.ok === false) {
          const userText = (runResult && runResult.userText) || "命令没有执行。";
          const code = (runResult && runResult.code) || "EXEC_FAILED";
          emit({
            type: "agent.step",
            requestId,
            taskId,
            stepId,
            index,
            kind: "command",
            status: "failed",
            command,
            why,
            output: runResult && typeof runResult.output === "string" ? clampOutput(runResult.output) : "",
            exitCode: runResult && runResult.exitCode !== undefined ? runResult.exitCode : null,
            userText,
          });
          if (code === "EXEC_UNSUPPORTED") {
            return { error: code, userText: `${userText}${UNSUPPORTED_HINT}` };
          }
          return { error: code, userText };
        }

        const output = clampOutput(runResult.output);
        const status = runResult.exitCode === 0 ? "done" : "failed";
        emit({
          type: "agent.step",
          requestId,
          taskId,
          stepId,
          index,
          kind: "command",
          status,
          command,
          why,
          output,
          exitCode: runResult.exitCode === undefined ? null : runResult.exitCode,
          durationMs: runResult.durationMs === undefined ? undefined : runResult.durationMs,
          ...(runResult.userText ? { userText: runResult.userText } : {}),
        });

        return {
          exitCode: runResult.exitCode === undefined ? null : runResult.exitCode,
          output,
          truncated: runResult.truncated === true,
          ...(runResult.userText ? { userText: runResult.userText } : {}),
        };
      },
    });

    const task = {
      taskId,
      settled: false,
      stop({ reason } = {}) {
        if (settled) return;
        stopped = true;
        for (const approvalId of [...taskPending]) {
          const item = pending.get(approvalId);
          if (!item) continue;
          pending.delete(approvalId);
          taskPending.delete(approvalId);
          if (item.timer) clearTimeout(item.timer);
          item.resolve({ approved: false, aborted: true });
        }
        try {
          controller.abort();
        } catch {
          // 忽略。
        }
        if (!settled) {
          finish({
            text: reason === "disconnect" ? "连接断开了，任务已停止。" : "任务已停止。",
            stopped: true,
          });
        }
      },
    };

    function finish({ text, stopped: wasStopped }) {
      if (settled) return;
      settled = true;
      task.settled = true;
      for (const approvalId of [...taskPending]) {
        const item = pending.get(approvalId);
        if (!item) continue;
        pending.delete(approvalId);
        taskPending.delete(approvalId);
        if (item.timer) clearTimeout(item.timer);
        item.resolve({ approved: false, aborted: true });
      }
      if (socket && bySocket.get(socket) === task) bySocket.delete(socket);
      emit({
        type: "agent.done",
        requestId,
        taskId,
        text: typeof text === "string" ? text : "",
        steps: stepCount,
        stopped: wasStopped === true,
        durationMs: Date.now() - startedAt,
      });
      log({
        level: "info",
        code: "AGENT_DONE",
        msg: "agent task finished",
        taskId,
        steps: stepCount,
        stopped: wasStopped === true,
        durationMs: Date.now() - startedAt,
      });
    }

    function fail({ code, userText }) {
      if (settled) return;
      settled = true;
      task.settled = true;
      for (const approvalId of [...taskPending]) {
        const item = pending.get(approvalId);
        if (!item) continue;
        pending.delete(approvalId);
        taskPending.delete(approvalId);
        if (item.timer) clearTimeout(item.timer);
        item.resolve({ approved: false, aborted: true });
      }
      if (socket && bySocket.get(socket) === task) bySocket.delete(socket);
      emit({ type: "agent.error", requestId, taskId, code, userText });
      // 任务结束必须发且只发一次 done 或 error（PROTOCOL 6.8 第 6 点）。
      log({
        level: "warn",
        code,
        msg: "agent task failed",
        taskId,
        steps: stepCount,
        durationMs: Date.now() - startedAt,
      });
    }

    if (socket) bySocket.set(socket, task);

    // agent.start 必须在任何 agent.step 之前发出。
    emit({ type: "agent.start", requestId, taskId, model: chosenModel, targetSessionId });

    const system = buildAgentSystemPrompt(effectiveConfig);

    (async () => {
      try {
        const result = await generateTextFn({
          model: providerFor(gatewayBaseUrl())(chosenModel),
          system,
          tools: { run_command: runCommandTool },
          stopWhen: stepCountIs(MAX_STEPS),
          abortSignal: controller.signal,
          messages: [{ role: "user", content: firstMessage }],
        });
        if (settled) return;
        const text =
          result && typeof result.text === "string" && result.text.trim().length > 0
            ? result.text
            : stepCount > 0
              ? "命令都跑完了，但没有拿到文字总结。"
              : "没有拿到结果。";
        finish({ text, stopped: false });
      } catch (err) {
        if (settled) return;
        if (stopped || (err && (err.name === "AbortError" || err.code === "ABORT_ERR"))) {
          finish({ text: "任务已停止。", stopped: true });
          return;
        }
        const message = err && err.message ? String(err.message) : String(err);
        const isUnsupported = /EXEC_UNSUPPORTED/.test(message);
        fail({
          code: isUnsupported ? "EXEC_UNSUPPORTED" : "AGENT_FAILED",
          userText: isUnsupported
            ? "这个终端不支持自动执行，我把命令列出来给你自己运行。"
            : "AI 执行任务时出错了，可以重试，或手动在终端里操作。",
        });
        log({ level: "error", code: "AGENT_FAILED", msg: "agent generateText failed", taskId });
      }
    })();

    return task;
  }

  return {
    start,
    resolveApproval,
    stopAll,
    taskForSocket,
    // 仅供测试
    pendingCount: () => pending.size,
  };
}
