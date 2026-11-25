// Agent 主循环（PROTOCOL-AGENT.md §6，TASK-V4-H §5.2 / §5.3）。
//
// 用 Vercel AI SDK 的 generateText / streamText + tools 做多步执行。
//
// TASK-V4-H 的三处改动：
//   1. **多轮会话**：一次 agent.run 结束后会话不结束，下一次 agent.run 复用同一个
//      服务端会话（`src/ai/sessions.mjs`），把之前所有轮次与工具输出转成模型消息。
//   2. **会话持久化**：每一轮、每一步都落盘（落盘失败不影响本轮执行，只记日志）。
//   3. **审阅全档位**：judge 三档都调审阅，审阅结论（risk/effect/confirmWhy/reversible）
//      原样进 agent.approval 帧，前端据此画角标。
//
// TASK-FIX17-J 的四处改动：
//   1. **审阅带全量对话历史**：decide() 时把与主会话同一份 history + shell 传下去，
//      审阅才能判断「这条命令是不是用户几轮前就说过要做的事」。
//   2. **审阅中要有反馈**：调 judge 前后各发一个 agent.review 帧（start / done），
//      60 秒的超时不能变成用户以为卡死。
//   3. **confirm 卡带上 justification**：审阅的一句话依据进 agent.approval 帧。
//   4. **「剩下的都自动执行」（scope=rest）只越过普通确认，不越过灾难级**：
//      以前用 forbiddenReason 判，拆层后必须用 catastrophicReason，
//      否则普通黑名单（git push --force 一类）会被 autoRest 直接跑掉，等于绕开审阅。
//
// 关键约束（沿用 V3-D / V4-S）：
//   - 不要用 AI SDK 的 `toolApproval`：跨轮恢复有 bug。审批挂在 execute 内部 await。
//   - `stopWhen: stepCountIs(8)`。
//   - 任务结束必须发且只发一次 agent.done 或 agent.error。
//   - stop 时 abort + 所有 pending approval resolve 成 aborted，但**不杀**已在跑的 PTY 命令。

import crypto from "node:crypto";
import { streamText, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { DEFAULT_MODEL, gatewayBaseUrl } from "./gateway.mjs";
import { judge } from "./judge.mjs";
import { catastrophicReason } from "../policy/forbidden.mjs";
import { buildContext } from "./context.mjs";
import { OUTPUT_MAX_CHARS } from "./runner.mjs";

/** 审批等待上限（PROTOCOL §6.3）。 */
export const APPROVAL_TIMEOUT_MS = 120000;

/** 最多几步（PROTOCOL §6）。 */
export const MAX_STEPS = 8;

/** 历史里每条步骤摘要的输出上限（卡片 §5.2：单条 ≤ 800 字符）。 */
export const HISTORY_STEP_OUTPUT_MAX = 800;

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

/** 多轮会话追加在硬性规则后面的一段（TASK-V4-H §5.2：追问要能引用上文）。
 *
 * 刻意用 `· ` 而不是编号：PROTOCOL §6.2 的「硬性规则十条」是逐字契约
 * （`test/ai/prompt.test.mjs` 锁着条数），多轮补充不能混进那份编号里。 */
export const AGENT_HISTORY_RULES = [
  "## 这是同一段连续对话",
  "· 用户可能接着上一句追问（比如「那最大的那个呢？」）。上文里的命令与输出都是真实执行结果，请直接引用，不要说「我不知道你指什么」。",
  "· 需要新信息就继续调 run_command；不需要就别为了凑步数重复跑上文的命令。",
].join("\n");

/** EXEC_UNSUPPORTED 时追加给模型的一句（PROTOCOL §4.4）。 */
const UNSUPPORTED_HINT =
  "\n\n注意：这个终端不支持自动执行（EXEC_UNSUPPORTED）。不要再调用 run_command，改为只用文字回答，并把需要用户自己运行的命令列出来。";

/**
 * 组装 agent 系统提示词（PROTOCOL §6.2 + TASK-V4-H §5.2 多轮规则）。
 * @param {object} [config]
 * @returns {string}
 */
export function buildAgentSystemPrompt(config) {
  const conf = config && typeof config === "object" ? config : {};
  const base =
    typeof conf.basePrompt === "string" && conf.basePrompt.trim().length > 0
      ? conf.basePrompt
      : DEFAULT_BASE_PROMPT;
  return [base, "", AGENT_HARD_RULES, "", AGENT_HISTORY_RULES].join("\n");
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

/** 把一条步骤压成历史摘要（每条命令 + ≤800 字符输出）。 */
export function summarizeStepForHistory(step) {
  const command = typeof step.command === "string" ? step.command : "";
  if (!command) return "";
  const output = typeof step.output === "string" ? step.output : "";
  const trimmed = output.length > HISTORY_STEP_OUTPUT_MAX
    ? `${output.slice(0, HISTORY_STEP_OUTPUT_MAX)}…（输出已截断）`
    : output;
  const status = typeof step.status === "string" ? step.status : "done";
  return [`$ ${command}`, `（${status}）`, trimmed].filter((line) => line.length > 0).join("\n");
}

/**
 * 会话历史 → 模型消息（卡片 §5.2）。
 *
 * - 用户消息 → `user`
 * - AI 总结 → `assistant`
 * - 工具结果 → 该轮的步骤摘要（每条命令 + 摘要输出，单条 ≤ 800 字符），
 *   作为紧随用户问题之后的 `user` 消息；相邻同角色消息会被合并成一条，
 *   避免某些网关不接受连续同角色消息。
 *
 * @param {object|null} session 服务端会话（sessions.mjs 的形状）
 * @returns {Array<{role:"user"|"assistant", content:string}>}
 */
export function buildHistoryMessages(session) {
  if (!session || typeof session !== "object") return [];
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const steps = Array.isArray(session.steps) ? session.steps : [];
  const rounds = new Map();
  const roundOf = (value) => (Number.isFinite(value) && value > 0 ? value : 1);

  for (const message of messages) {
    const round = roundOf(message.round);
    if (!rounds.has(round)) rounds.set(round, { user: [], assistant: [], steps: [] });
    const bucket = rounds.get(round);
    if (message.role === "user" && typeof message.text === "string" && message.text.length > 0) {
      bucket.user.push(message.text);
    } else if (message.role === "assistant" && typeof message.text === "string" && message.text.length > 0) {
      bucket.assistant.push(message.text);
    }
  }
  for (const step of steps) {
    const round = roundOf(step.round);
    if (!rounds.has(round)) rounds.set(round, { user: [], assistant: [], steps: [] });
    rounds.get(round).steps.push(summarizeStepForHistory(step));
  }

  const out = [];
  const push = (role, content) => {
    if (!content) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
    else out.push({ role, content });
  };

  for (const round of [...rounds.keys()].sort((a, b) => a - b)) {
    const bucket = rounds.get(round);
    for (const text of bucket.user) push("user", text);
    const summary = bucket.steps.filter(Boolean);
    if (summary.length > 0) {
      push("user", ["【我在这一轮实际执行的命令与输出】", ...summary].join("\n\n"));
    }
    for (const text of bucket.assistant) push("assistant", text);
  }
  return out;
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

/** 从 generateText / streamText 的结果里捞思考过程（reasoning）。 */
export function extractReasoning(result) {
  if (!result || typeof result !== "object") return "";
  const parts = [];
  const steps = Array.isArray(result.steps) ? result.steps : [];
  for (const step of steps) {
    let text = "";
    try {
      text = typeof step.reasoningText === "string" ? step.reasoningText : "";
    } catch {
      text = "";
    }
    if (!text && Array.isArray(step.reasoning)) {
      text = step.reasoning
        .map((item) => (item && typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (text) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

/**
 * 创建 agent 执行器。
 *
 * @param {object} opts
 * @param {(entry:object)=>void} [opts.log]
 * @param {object} opts.runner createCommandRunner() 的返回值
 * @param {object} [opts.sessions] src/ai/sessions.mjs 的会话存储（不给就退化成不落盘）
 * @param {object} [opts.config] 默认配置（每次 start 可覆盖）
 * @param {Function} [opts.generateTextFn] 仅供测试注入
 * @param {Function} [opts.streamTextFn] 仅供测试注入（默认走真 streamText）
 * @param {Function} [opts.judgeFn] 仅供测试注入
 */
export function createAgentRunner(opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const runner = opts.runner;
  const sessions = opts.sessions || null;
  const defaultConfig = opts.config && typeof opts.config === "object" ? opts.config : {};
  const injectedStream =
    typeof opts.streamTextFn === "function"
      ? opts.streamTextFn
      : typeof opts.generateText === "function"
        ? opts.generateText
        : null;
  const judgeFn = typeof opts.judgeFn === "function" ? opts.judgeFn : judge;

  /** approvalId -> { resolve, timer, stepId, taskId } */
  const pending = new Map();

  /**
   * 会话落盘的串行链：sessionId -> Promise。
   *
   * 为什么必须有：`recordStep` 是异步写盘的，用户完全可能在写盘完成前就追问；
   * 下一轮读历史时必须先等上一条链落地，否则第二轮看不到第一轮的工具输出
   * （AC1 的硬要求）。写入失败不阻断后续写入。
   */
  const persistBySession = new Map();

  function chainPersist(sessionId, fn) {
    if (!sessionId) return Promise.resolve(null);
    const previous = persistBySession.get(sessionId) || Promise.resolve(null);
    const next = previous.then(fn, fn).then(
      (value) => value,
      () => null,
    );
    persistBySession.set(sessionId, next);
    return next;
  }

  /** 等某个会话的落盘链全部完成（下一轮读历史前调）。 */
  async function waitPersisted(sessionId) {
    if (!sessionId) return;
    const chain = persistBySession.get(sessionId);
    if (chain) await chain;
  }

  /** 每个 socket 一个当前任务：socket -> task */
  const bySocket = new Map();

  async function decide({ command, config: conf, cwd, model, history, shell, session, signal }) {
    return judgeFn({
      command,
      config: conf,
      cwd,
      model,
      history,
      shell,
      session,
      signal,
      log,
    });
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

  /** 落盘失败不影响执行，只记一条日志。 */
  function safe(promise, code) {
    if (!promise || typeof promise.then !== "function") return Promise.resolve(null);
    return promise.catch((err) => {
      log({ level: "warn", code: code || "AI_SESSION_WRITE_FAILED", msg: "ai session write failed", err });
      return null;
    });
  }

  /**
   * 解析本轮用哪个服务端会话：
   *   1) 显式给了 aiSessionId 且存在 → 用它
   *   2) 否则找该终端最近的会话（服务端兜底，卡片 §5.2）
   *   3) 都没有 → 新建（第一轮）
   */
  async function resolveSession({ aiSessionId, terminal }) {
    if (!sessions) {
      return {
        session: null,
        id: typeof aiSessionId === "string" && aiSessionId.length > 0 ? aiSessionId : "",
        round: 1,
        title: "",
      };
    }
    let existing = null;
    if (typeof aiSessionId === "string" && aiSessionId.length > 0) {
      // 上一轮可能还在写盘：先等链落地，否则 round 会算错、历史也不全（AC1）。
      await waitPersisted(aiSessionId);
      existing = await safe(sessions.getSession(aiSessionId), "AI_SESSION_READ_FAILED");
    }
    if (!existing && terminal && typeof terminal.id === "string" && terminal.id.length > 0) {
      existing = await safe(sessions.findByTerminal(terminal.id), "AI_SESSION_READ_FAILED");
      if (existing) await waitPersisted(existing.id);
    }
    if (existing) {
      const userRounds = existing.messages.filter((item) => item.role === "user"); 
      const maxRound = existing.messages.reduce((max, item) => Math.max(max, Number(item.round) || 0), 0);
      return {
        session: existing,
        id: existing.id,
        round: Math.max(maxRound, userRounds.length) + 1,
        title: existing.title,
      };
    }
    const created = await safe(
      sessions.createSession({
        title: "",
        terminalId: terminal && typeof terminal.id === "string" ? terminal.id : "",
        terminalKind: terminal && terminal.kind === "remote" ? "remote" : "local",
        shell: terminal && typeof terminal.shell === "string" ? terminal.shell : "",
        hostId: terminal ? terminal.hostId : null,
        hostName: terminal ? terminal.hostName : null,
        hostAddr: terminal ? terminal.hostAddr : null,
        keepId: terminal && terminal.id,
      }),
      "AI_SESSION_CREATE_FAILED",
    );
    return {
      session: created,
      id: created ? created.id : typeof aiSessionId === "string" ? aiSessionId : "",
      round: 1,
      title: created ? created.title : "",
    };
  }

  /**
   * 起一个任务。
   *
   * @returns {{taskId: string, stop: Function}|{busy: true}}
   */
  function start({
    requestId,
    question,
    model,
    context,
    sessionId,
    aiSessionId,
    terminal,
    send,
    config,
    socket,
  } = {}) {
    const effectiveConfig = config && typeof config === "object" ? { ...defaultConfig, ...config } : defaultConfig;
    const taskId = newTaskId();
    const chosenModel =
      typeof model === "string" && model.length > 0 ? model : process.env.MAGPIE_TERMINAL_MODEL || DEFAULT_MODEL;
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
    let aiSession = typeof aiSessionId === "string" ? aiSessionId : "";
    let round = 1;
    /**
     * 本任务的**全量**对话历史（与主会话同一份，含本轮用户提问）。
     *
     * 为什么要单独的变量：喂给模型时最后一条用户消息会被换成 buildAgentUserMessage
     * 的富文本（避免重复），但审阅需要看到用户**原话**——所以这里保留未裁剪的版本。
     * 只追加、不改写（prompt 缓存的前提）。
     */
    let taskHistory = [];
    /** 本任务的 shell 名（审阅要看「命令在这个 shell 里是什么语义」）。 */
    const taskShell = buildContext(context).shell;
    const startedAt = Date.now();
    /** 本任务发出的待审批（taskId 维度，stop 时全部 resolve）。 */
    const taskPending = new Set();

    const emit = (frame) => {
      try {
        send(aiSession ? { ...frame, sessionId: aiSession } : frame);
      } catch {
        // 连接已断，忽略。
      }
    };

    const firstMessage = buildAgentUserMessage(question, context);

    function awaitApproval({
      stepId,
      command,
      why,
      risk,
      effect,
      confirmWhy,
      reversible,
      reviewModel,
      justification,
      reviewReason,
      reviewHit,
    }) {
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
          // 审阅结论：任何档位都有值；审阅失败时四个字段都是 null（角标置灰）。
          risk: risk === undefined ? null : risk,
          effect: effect === undefined ? null : effect,
          confirmWhy: confirmWhy === undefined ? null : confirmWhy,
          reversible: reversible === undefined ? null : reversible,
          reviewModel: reviewModel === undefined ? null : reviewModel,
          // TASK-FIX17-H R3：把 judge 的「为什么没送审」原话传给前端。
          // 以前卡片只有 risk=null 一个信号，只能说「审阅不可用」，而实际
          // 最常见的原因是「命令里有输出重定向，所以没送审」（judge 第 3.5 级）。
          // 新增字段，不改上面任何已有字段的语义。
          reviewReason: typeof reviewReason === "string" ? reviewReason : null,
          reviewHit: typeof reviewHit === "string" ? reviewHit : null,
          // TASK-FIX17-J R5：审阅给出的「一句话依据」（符合/不符合用户意图），
          // 卡片上直接显示，用户不用去猜 AI 为什么这么判。
          justification: typeof justification === "string" ? justification : null,
        });
      });
    }

    /** 把一步写进会话文件（串行链；失败不影响执行）。 */
    function recordStep(patch) {
      if (!sessions || !aiSession) return Promise.resolve(null);
      return chainPersist(aiSession, () =>
        safe(sessions.upsertStep(aiSession, { ...patch, round }), "AI_SESSION_STEP_FAILED"),
      );
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

        // 1. 分级（审阅可能要看 60 秒，前后各发一帧，前端才能显示「正在审阅…」）。
        emit({ type: "agent.review", requestId, taskId, stepId, state: "start" });
        const reviewStartedAt = Date.now();
        let verdict;
        try {
          verdict = await decide({
            command,
            config: effectiveConfig,
            cwd: context && context.cwd,
            model: chosenModel,
            history: taskHistory,
            shell: taskShell,
            signal: controller.signal,
          });
        } catch {
          verdict = {
            decision: "confirm",
            reason: "判定过程异常，按需要确认处理",
            hit: null,
            risk: null,
            effect: null,
            confirmWhy: null,
            reversible: null,
            reviewModel: null,
            aligned: null,
            justification: null,
          };
        }
        emit({
          type: "agent.review",
          requestId,
          taskId,
          stepId,
          state: "done",
          ms: Date.now() - reviewStartedAt,
        });

        let auto = verdict.decision === "auto";
        // scope === "rest" 之后的 confirm 级命令直接跑；**灾难级**仍然 confirm（PROTOCOL §6.3）。
        // TASK-FIX17-J：这里必须用 catastrophicReason —— 用 forbiddenReason 会把
        // 普通黑名单（git push --force / git reset --hard 一类）也当成可直接跑，
        // 等于绕开审阅与护栏。判定不靠 reason 文本前缀（那太脆）。
        if (!auto && autoRest && catastrophicReason(command) === null) auto = true;

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
        recordStep({
          stepId,
          command,
          decision: auto ? "auto" : "confirm",
          status: auto ? "running" : "awaiting",
          startedAt: Date.now(),
        });

        if (!auto) {
          const answer = await awaitApproval({
            stepId,
            command,
            why,
            risk: verdict.risk,
            effect: verdict.effect,
            confirmWhy: verdict.confirmWhy,
            reversible: typeof verdict.reversible === "boolean" ? verdict.reversible : null,
            reviewModel: verdict.reviewModel || null,
            reviewReason: verdict.reason,
            reviewHit: verdict.hit,
            justification: verdict.justification,
          });
          if (stopped || answer.aborted) {
            emit({ type: "agent.step", requestId, taskId, stepId, index, kind: "command", status: "skipped", command, why });
            recordStep({ stepId, command, decision: "confirm", status: "skipped", endedAt: Date.now() });
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
            recordStep({ stepId, command, decision: "confirm", status: "denied", endedAt: Date.now() });
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
          recordStep({ stepId, command, decision: "confirm", status: "running" });
        }

        // 2. 执行
        let runResult;
        try {
          runResult = await runner.run({ sessionId: targetSessionId, command });
        } catch {
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
          const failedOutput = runResult && typeof runResult.output === "string" ? clampOutput(runResult.output) : "";
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
            output: failedOutput,
            exitCode: runResult && runResult.exitCode !== undefined ? runResult.exitCode : null,
            userText,
          });
          recordStep({
            stepId,
            command,
            decision: auto ? "auto" : "confirm",
            status: "failed",
            output: failedOutput,
            endedAt: Date.now(),
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
        recordStep({
          stepId,
          command,
          decision: auto ? "auto" : "confirm",
          status,
          output,
          endedAt: Date.now(),
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

    function cleanupPending() {
      for (const approvalId of [...taskPending]) {
        const item = pending.get(approvalId);
        if (!item) continue;
        pending.delete(approvalId);
        taskPending.delete(approvalId);
        if (item.timer) clearTimeout(item.timer);
        item.resolve({ approved: false, aborted: true });
      }
    }

    function releaseBusy() {
      if (sessions && aiSession) sessions.markBusy(aiSession, false);
    }

    /** 任务收尾时的落盘：等既有链 → 追加助手消息 → （停止时）标状态。 */
    function persistFinish(finalText, wasStopped) {
      if (!sessions || !aiSession) return Promise.resolve(null);
      return chainPersist(aiSession, async () => {
        await safe(
          sessions.appendMessage(aiSession, {
            role: "assistant",
            text: finalText,
            round,
            at: Date.now(),
          }),
          "AI_SESSION_APPEND_FAILED",
        );
        if (wasStopped === true) {
          await safe(sessions.setStatus(aiSession, "stopped"), "AI_SESSION_STATUS_FAILED");
        }
        return null;
      });
    }

    function finish({ text, stopped: wasStopped }) {
      if (settled) return;
      settled = true;
      task.settled = true;
      cleanupPending();
      if (socket && bySocket.get(socket) === task) bySocket.delete(socket);
      const finalText = typeof text === "string" ? text : "";
      // 会话保持 open；被停止的标「已停止」（AC12）。
      // **落盘先完成再发 done**：done 是「这一轮已经落盘」的信号，前端收到它就能
      // 安全追问/切会话读历史；先发 done 再异步写盘会让紧接着的追问读到旧文件
      // （实测：并行跑全量时第二轮的历史里少第一轮的工具输出）。
      releaseBusy();
      const emitDone = () => {
        emit({
          type: "agent.done",
          requestId,
          taskId,
          text: finalText,
          steps: stepCount,
          stopped: wasStopped === true,
          durationMs: Date.now() - startedAt,
        });
        log({
          level: "info",
          code: "AGENT_DONE",
          msg: "agent task finished",
          taskId,
          sessionId: aiSession || null,
          round,
          steps: stepCount,
          stopped: wasStopped === true,
          durationMs: Date.now() - startedAt,
        });
      };
      const persisted = persistFinish(finalText, wasStopped === true);
      if (persisted && typeof persisted.then === "function") persisted.then(emitDone, emitDone);
      else emitDone();
    }

    function fail({ code, userText }) {
      if (settled) return;
      settled = true;
      task.settled = true;
      cleanupPending();
      if (socket && bySocket.get(socket) === task) bySocket.delete(socket);
      releaseBusy();
      emit({ type: "agent.error", requestId, taskId, code, userText });
      // 任务结束必须发且只发一次 done 或 error（PROTOCOL 6.8 第 6 点）。
      log({
        level: "warn",
        code,
        msg: "agent task failed",
        taskId,
        sessionId: aiSession || null,
        round,
        steps: stepCount,
        durationMs: Date.now() - startedAt,
      });
    }

    if (socket) bySocket.set(socket, task);

    const system = buildAgentSystemPrompt(effectiveConfig);

    (async () => {
      // 1. 先解析服务端会话（多轮的关键）。
      const resolved = await resolveSession({ aiSessionId, terminal });
      aiSession = resolved.id;
      round = resolved.round;
      if (sessions && aiSession) sessions.markBusy(aiSession, true);

      if (!sessions || !aiSession) {
        // 没有会话存储（老测试 / 降级）：保持「一问一跑」的单轮行为。
        emit({ type: "agent.start", requestId, taskId, model: chosenModel, targetSessionId });
      } else {
        // 等上一轮的落盘链落地，否则本轮看不到上一轮的工具输出（AC1）。
        await waitPersisted(aiSession);
        await safe(
          sessions.appendMessage(aiSession, { role: "user", text: question, round, at: Date.now() }),
          "AI_SESSION_APPEND_FAILED",
        );
        emit({
          type: "agent.start",
          requestId,
          taskId,
          model: chosenModel,
          targetSessionId,
          sessionTitle: resolved.title || "",
          round,
        });
      }

      // 2. 历史 + 本轮消息。
      let history = [];
      if (sessions && aiSession) {
        await waitPersisted(aiSession);
        const fresh = await safe(sessions.getSession(aiSession), "AI_SESSION_READ_FAILED");
        history = buildHistoryMessages(fresh);
        // TASK-FIX17-J：审阅用的是**未裁剪**的这份（含本轮用户原话）。
        // 对话会话的前缀形状不变：仍然 [...history, 本轮富文本消息]，只追加不改写。
        taskHistory = history;
        // 最后一轮（本轮）刚写的用户消息与 firstMessage 重复 → 去掉，避免同一句出现两次。
        const last = history[history.length - 1];
        if (last && last.role === "user" && typeof question === "string" && last.content.trim() === question.trim()) {
          history.pop();
        }
      }
      const messages = [...history, { role: "user", content: firstMessage }];

      try {
        let finalText = "";
        let reasoning = "";
        let streamed = "";
        if (injectedStream) {
          const result = await injectedStream({
            model: providerFor(gatewayBaseUrl())(chosenModel),
            system,
            tools: { run_command: runCommandTool },
            stopWhen: stepCountIs(MAX_STEPS),
            abortSignal: controller.signal,
            messages,
          });
          finalText = result && typeof result.text === "string" ? result.text : "";
          reasoning = extractReasoning(result);
        } else {
          const stream = streamText({
            model: providerFor(gatewayBaseUrl())(chosenModel),
            system,
            tools: { run_command: runCommandTool },
            stopWhen: stepCountIs(MAX_STEPS),
            abortSignal: controller.signal,
            messages,
            // 中止时的内部 Promise 拒绝不让它变成 unhandledRejection（否则会崩进程）。
            onError: ({ error }) => {
              log({
                level: "warn",
                code: "AGENT_STREAM_ERROR",
                msg: "agent stream reported an error",
                taskId,
                reason: error && error.name ? error.name : "error",
              });
            },
          });
          // 逐字把文本推给前端（AC13 加分项）；工具与审批仍在 execute 内部走。
          try {
            for await (const delta of stream.textStream) {
              if (settled || stopped) break;
              if (typeof delta !== "string" || delta.length === 0) continue;
              streamed += delta;
              emit({ type: "agent.text", requestId, taskId, text: delta });
            }
          } catch {
            // 流中断时仍有 stream.text 兜底。
          }
          // **不要展开这个流对象**：`{...stream}` 会触发全部 getter（steps / warnings /
          // reasoning / sources / toolCalls …），每个都建一个 Promise，中止时集体变成
          // unhandledRejection，实测会把 node 进程打崩。只取我们需要的那两个。
          try {
            if (!settled && !stopped) finalText = await stream.text;
          } catch {
            finalText = "";
          }
          try {
            const steps = await stream.steps;
            reasoning = extractReasoning({ steps });
          } catch {
            reasoning = "";
          }
        }
        if (settled) return;
        const finalTextRaw = typeof finalText === "string" ? finalText : "";
        if (reasoning) {
          emit({ type: "agent.reasoning", requestId, taskId, text: reasoning });
          if (sessions && aiSession) {
            // 思考过程跟着本轮的用户消息一起落盘（前端切回来还能展开）。
            void safe(
              sessions.appendMessage(aiSession, {
                role: "tool",
                text: "",
                reasoning,
                round,
                at: Date.now(),
              }),
              "AI_SESSION_APPEND_FAILED",
            );
          }
        }
        const text =
          finalTextRaw.trim().length > 0
            ? finalTextRaw
            : streamed.trim().length > 0
              ? streamed
              : stepCount > 0
                ? "命令都跑完了，但没有拿到文字总结。"
                : "没有拿到结果。";
        finish({ text, stopped });
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
        log({ level: "error", code: "AGENT_FAILED", msg: "agent generation failed", taskId, sessionId: aiSession || null });
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
    decide,
  };
}
