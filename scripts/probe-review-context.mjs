// TASK-FIX17-J 验收探针：审阅带全量对话上下文、黑名单分级放行、60 秒超时、两会话缓存。
//
// 全部**真跑**，不 mock 判级、不 mock 消息构造：
//   ① 桩审阅网关（本地 OpenAI 兼容 HTTP）：真 reviewCommand 打过去，网关记下**真实请求体**
//      —— 于是「审阅到底看到了什么」不是我们声称的，是线上抓到的。
//   ② 真 judge + 真护栏：AC-上下文 / AC-放行 / AC-拦截 / AC-护栏 四条全部走生产代码路径。
//   ③ 真服务 + 真 Chrome（CDP）：审阅中那一行、auto 不出卡、卡片上的 justification、
//      agent.stop 在审阅中立刻中止（60 秒超时不许变成卡死）。
//   ④ 真网关 3 连发：用 buildReviewMessages 的同一份 messages 直接 fetch，把每次
//      usage.prompt_tokens_details.cached_tokens 的**原始数字**写进证据 JSON。
//
// 用法（仓库根）：
//   node scripts/probe-review-context.mjs              # 人读输出 + 截图/证据落 .dispatch/fix17-j/evidence/
//   node scripts/probe-review-context.mjs --out r.json # 额外写 JSON
//   node scripts/probe-review-context.mjs --no-cache   # 跳过需要真网关的那一步
//
// 退出码：0 全 PASS；1 有任何一条不过（或缓存那一步 BLOCKED）。

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import { startServer } from "../src/server/http.mjs";
import { openBrowser, sleep } from "./lib/cdp.mjs";
import { judge } from "../src/ai/judge.mjs";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TIMEOUT_MS,
  buildReviewMessages,
  serializeHistoryForReview,
} from "../src/ai/review.mjs";
import { buildHistoryMessages, createAgentRunner } from "../src/ai/agent.mjs";
import { createSessionStore } from "../src/ai/sessions.mjs";

const ROOT = path.resolve(".");
const EVIDENCE_DIR = path.resolve(".dispatch", "fix17-j", "evidence");
const SHOTS_DIR = path.join(EVIDENCE_DIR, "shots");
const DEFAULT_GATEWAY = "http://127.0.0.1:3425";
const GATEWAY_MODEL = "commandcode/deepseek/deepseek-v4.1-flash";

const results = [];
function record(name, pass, detail, expected) {
  results.push({ group: name.split(".")[0], name, pass: Boolean(pass), detail, expected: expected ?? null });
  if (pass) console.log(`PASS  ${name}`);
  else console.log(`FAIL  ${name}\n      got=${JSON.stringify(detail)}  expected=${JSON.stringify(expected)}`);
}
function note(text) {
  console.log(`      ${text}`);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return typeof value === "string" && value.length > 0 ? value : null;
}
const hasFlag = (flag) => process.argv.includes(flag);

/* ------------------------------------------------------------------ ① 桩审阅网关 */

const REVIEW_TOOL_SCHEMA = {
  type: "object",
  properties: {
    risk: { type: "string", enum: ["safe", "caution", "danger"] },
    aligned: { type: "boolean" },
    justification: { type: "string" },
    effect: { type: "string" },
    confirmWhy: { type: "string" },
    reversible: { type: "boolean" },
  },
  required: ["risk", "aligned", "justification", "effect", "confirmWhy", "reversible"],
};

/**
 * 本地 OpenAI 兼容网关：只用于审阅。
 *
 * mode:
 *   verdict —— 延迟 delayMs 后回一个 tool_call（内容取 state.verdict）
 *   hang    —— 收下请求，永不回包（用来验证超时 / 中止）
 */
function createStubGateway() {
  const state = {
    mode: "verdict",
    delayMs: 0,
    verdict: {
      risk: "caution",
      aligned: true,
      justification: "你在第 1 轮说这个文件夹是建错的",
      effect: "会删掉一个空文件夹",
      confirmWhy: "删掉就没了",
      reversible: false,
    },
    requests: [],
    hanging: [],
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const entry = { at: Date.now(), url: req.url, body: parsed, responded: false };
      state.requests.push(entry);

      if (state.mode === "hang") {
        state.hanging.push({ res, entry });
        return;
      }

      const respond = () => {
        if (res.writableEnded) return;
        entry.responded = true;
        const payload = {
          id: `chatcmpl-probe-${state.requests.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: (parsed && parsed.model) || "probe/model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_probe_${state.requests.length}`,
                    type: "function",
                    function: { name: "review_command", arguments: JSON.stringify(state.verdict) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060 },
        };
        const text = JSON.stringify(payload);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      if (state.delayMs > 0) setTimeout(respond, state.delayMs).unref?.();
      else respond();
    });
  });

  return {
    state,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const item of state.hanging) {
          try {
            item.res.destroy();
          } catch {
            // 忽略。
          }
        }
        server.close(() => resolve());
      }),
    /** 这次请求的 messages（去掉 SDK 自己加的 system 以外的部分）。 */
    lastReviewRequest() {
      return state.requests[state.requests.length - 1] || null;
    },
    /** 只算 review 请求（system 是本模块的审阅提示词）。 */
    reviewRequests() {
      return state.requests.filter((item) => {
        const messages = item.body && Array.isArray(item.body.messages) ? item.body.messages : [];
        const system = messages.find((message) => message.role === "system");
        return Boolean(system && typeof system.content === "string" && system.content.startsWith("你是命令安全审阅员"));
      });
    },
  };
}

/* ------------------------------------------------------------------ 夹具 */

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-j-probe-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, "empty-dir"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "dist", "a.js"), "x");
  return { root, cwd };
}

/** 3 轮真会话：第 1 轮就说「我建错了个文件」，第 3 轮才说「把它删掉」。 */
const THREE_ROUND_HISTORY = buildHistoryMessages({
  messages: [
    { role: "user", text: "我建错了个文件夹 empty-dir，先留着", round: 1 },
    { role: "assistant", text: "好，需要删的时候说一声。", round: 1 },
    { role: "user", text: "看看这个目录里有什么", round: 2 },
    { role: "assistant", text: "有 dist 和一个空目录 empty-dir。", round: 2 },
    { role: "user", text: "把 empty-dir 删掉", round: 3 },
  ],
  steps: [{ round: 2, command: "ls", status: "done", output: "dist empty-dir" }],
});

/**
 * 12 轮的长会话（缓存那一步用）：用户的成本担忧本来就出在**长会话**上。
 * 短历史（3 轮）在真网关上会看到「第 1、2 次 miss、第 3 次才命中」—— 那是上游建缓存要时间，
 * 不是前缀不稳定；长历史更接近真实场景，也是这张卡要保的东西。
 */
function longHistory(rounds = 12) {
  const out = [];
  for (let r = 1; r <= rounds; r += 1) {
    out.push({
      role: "user",
      content: `第${r}轮：我在整理这个项目，想确认一些构建相关的事情，编号 note-${r}，顺便看看日志和依赖状态。`,
    });
    out.push({
      role: "user",
      content: `【我在这一轮实际执行的命令与输出】\n\n$ ls -la && git status\n（done）\n\ntotal 48\ndrwxr-xr-x 1 user 197121 0 Nov 25 10:0${r % 10} .\n-rw-r--r-- 1 user 197121 1234 Nov 25 10:0${r % 10} package.json\nround-${r} output line one\nround-${r} output line two`,
    });
    out.push({
      role: "assistant",
      content: `第${r}轮：看到了，目录里有 package.json 和 src，git 干净，编号 note-${r} 我记住了。`,
    });
  }
  return out;
}

function reviewConfig(extra) {
  return { model: null, autonomy: "balanced", allowlist: [], reviewModel: "probe/model", basePrompt: null, ...extra };
}

/* ------------------------------------------------------------------ ② 判级链 */

async function runJudgeChecks({ gateway, sandbox }) {
  const startupRequests = gateway.reviewRequests().length;

  // ---- AC-上下文：真 reviewCommand 打到桩网关，抓它收到的 messages
  const logs = [];
  const history = THREE_ROUND_HISTORY;
  const verdict = await judge({
    command: "rm tmp-note.txt",
    config: reviewConfig({}),
    cwd: sandbox.cwd,
    history,
    shell: "bash 5.2.37",
    log: (entry) => logs.push(entry),
  });
  const contextRequests = gateway.reviewRequests();
  const contextRequest = contextRequests[contextRequests.length - 1];
  const wireMessages = contextRequest ? contextRequest.body.messages : [];
  const systemMessage = wireMessages.find((message) => message.role === "system");
  const nonSystem = wireMessages.filter((message) => message.role !== "system");
  const firstSegment = nonSystem[0] ? String(nonSystem[0].content || "") : "";

  record(
    "context.审阅真的收到了 3 段式 messages（user → assistant → user）",
    nonSystem.length === 3 && nonSystem[0].role === "user" && nonSystem[1].role === "assistant" && nonSystem[2].role === "user",
    { roles: nonSystem.map((message) => message.role) },
    ["user", "assistant", "user"],
  );
  record(
    "context.第一段以【对话上下文】开头",
    firstSegment.startsWith("【对话上下文】\n"),
    { head: firstSegment.slice(0, 30) },
    "【对话上下文】\\n…",
  );
  record(
    "context.第一段包含**第 1 轮**原话（不是只有最近两轮）",
    firstSegment.includes("我建错了个文件夹 empty-dir，先留着"),
    { hasRound1: firstSegment.includes("我建错了个文件夹 empty-dir，先留着"), firstSegment },
    "含第 1 轮用户原话",
  );
  record(
    "context.第一段同时包含第 3 轮原话（全量，不截断）",
    firstSegment.includes("把 empty-dir 删掉"),
    { hasRound3: firstSegment.includes("把 empty-dir 删掉") },
    "含第 3 轮用户原话",
  );
  record(
    "context.第一段至少 4 条 [第N轮·…] 标签（3 轮用户 + 1 轮助手/终端）",
    (firstSegment.match(/\[第\d+轮·/g) || []).length >= 4,
    { tags: (firstSegment.match(/\[第\d+轮·[^\]]*\]/g) || []).length },
    ">= 4 个轮次标签",
  );
  record(
    "context.和 buildReviewMessages 逐字节一致（前端/后端同一份契约）",
    firstSegment === buildReviewMessages({ command: "rm tmp-note.txt", history, cwd: sandbox.cwd, shell: "bash 5.2.37" })[0].content,
    { equal: firstSegment === buildReviewMessages({ command: "rm tmp-note.txt", history, cwd: sandbox.cwd, shell: "bash 5.2.37" })[0].content },
    "逐字节相等",
  );
  record(
    "context.第三段带命令 / cwd / shell，且命令在最后一条消息里",
    nonSystem[2] && String(nonSystem[2].content).includes("命令：rm tmp-note.txt") &&
      String(nonSystem[2].content).includes(`当前目录：${sandbox.cwd}`) &&
      String(nonSystem[2].content).includes("Shell：bash 5.2.37"),
    { third: nonSystem[2] ? String(nonSystem[2].content) : null },
    "命令 / 当前目录 / Shell 都在第三段",
  );
  record(
    "context.system 就是 REVIEW_SYSTEM_PROMPT（逐字节，缓存前缀第一段）",
    Boolean(systemMessage) && systemMessage.content === REVIEW_SYSTEM_PROMPT,
    { equal: Boolean(systemMessage) && systemMessage.content === REVIEW_SYSTEM_PROMPT },
    "逐字节相等",
  );
  record(
    "context.历史文本不含「共 N 轮」这种会变的头（缓存契约）",
    !/共\s*\d+\s*轮/.test(serializeHistoryForReview(history)),
    { text: serializeHistoryForReview(history).slice(0, 120) },
    "不含共 N 轮",
  );
  note(`judge 对 rm tmp-note.txt 的结论：${verdict.decision} / ${verdict.reason}`);

  // ---- AC-放行：cwd 内的空目录 + 历史提到 + aligned=true + reversible=false → auto
  gateway.state.verdict = {
    risk: "caution",
    aligned: true,
    justification: "你在第 1 轮说 empty-dir 是建错的、第 3 轮说删掉它",
    effect: "会删掉一个空文件夹",
    confirmWhy: "删掉就没了",
    reversible: false,
  };
  const beforeAuto = gateway.reviewRequests().length;
  const autoVerdict = await judge({
    command: "rmdir empty-dir",
    config: reviewConfig({}),
    cwd: sandbox.cwd,
    history,
    shell: "bash",
    log: (entry) => logs.push(entry),
  });
  const autoLog = logs.filter((entry) => entry.code === "REVIEW").pop();
  record(
    "allow.删 cwd 内的空目录（历史提过）→ auto",
    autoVerdict.decision === "auto",
    { decision: autoVerdict.decision, reason: autoVerdict.reason, risk: autoVerdict.risk },
    "auto",
  );
  record(
    "allow.reversible=false 不挡路（用户原话：删空文件夹一定要放行）",
    autoVerdict.reversible === false && autoVerdict.decision === "auto",
    { reversible: autoVerdict.reversible, decision: autoVerdict.decision },
    { reversible: false, decision: "auto" },
  );
  record("allow.确实送审了一次", gateway.reviewRequests().length === beforeAuto + 1, {
    before: beforeAuto,
    after: gateway.reviewRequests().length,
  }, { after: beforeAuto + 1 });
  record(
    "allow.日志 tier=blacklist / guardOk=true / aligned=true",
    Boolean(autoLog) && autoLog.tier === "blacklist" && autoLog.guardOk === true && autoLog.aligned === true,
    autoLog ? { tier: autoLog.tier, guardOk: autoLog.guardOk, aligned: autoLog.aligned, historyChars: autoLog.historyChars } : null,
    { tier: "blacklist", guardOk: true, aligned: true },
  );
  record(
    "allow.审阅收到的 targetFacts 说这是空目录（entries=0）",
    Boolean(autoLog) &&
      (() => {
        const req = gateway.reviewRequests()[gateway.reviewRequests().length - 1];
        const text = req ? String(req.body.messages[req.body.messages.length - 1].content) : "";
        return text.includes("0 个条目（当前为空）");
      })(),
    { lastThree: null },
    "含「0 个条目（当前为空）」",
  );

  // ---- AC-拦截：灾难级 → confirm 且审阅根本没被调用
  const beforeBlock = gateway.reviewRequests().length;
  const blockVerdict = await judge({
    command: "rm -rf /",
    config: reviewConfig({ autonomy: "loose" }),
    cwd: sandbox.cwd,
    history,
    log: (entry) => logs.push(entry),
  });
  record(
    "block.rm -rf / → confirm（即使桩审阅想放行）",
    blockVerdict.decision === "confirm" && /硬性禁止/.test(blockVerdict.reason),
    { decision: blockVerdict.decision, reason: blockVerdict.reason },
    "confirm / 硬性禁止",
  );
  record(
    "block.审阅**一次都没被调用**（灾难级不送审）",
    gateway.reviewRequests().length === beforeBlock,
    { before: beforeBlock, after: gateway.reviewRequests().length },
    { after: beforeBlock },
  );
  record("block.tier=catastrophic", blockVerdict.tier === "catastrophic", { tier: blockVerdict.tier }, "catastrophic");

  // ---- AC-护栏：cwd 外的目标 + 历史没提过 → confirm，日志 guardOk:false
  const guardLogs = [];
  const outside = path.join(sandbox.root, "not-mentioned");
  const beforeGuard = gateway.reviewRequests().length;
  const guardVerdict = await judge({
    command: `rm -rf "${outside}"`,
    config: reviewConfig({ autonomy: "loose" }),
    cwd: sandbox.cwd,
    history,
    log: (entry) => guardLogs.push(entry),
  });
  const guardLog = guardLogs.find((entry) => entry.code === "REVIEW");
  record(
    "guard.cwd 外且没提过 → confirm（即使 aligned=true + risk=caution）",
    guardVerdict.decision === "confirm",
    { decision: guardVerdict.decision, reason: guardVerdict.reason },
    "confirm",
  );
  record(
    "guard.日志 guardOk=false，且真的送审过（不是灾难级短路）",
    Boolean(guardLog) && guardLog.guardOk === false && gateway.reviewRequests().length === beforeGuard + 1,
    guardLog ? { guardOk: guardLog.guardOk, guardReason: guardLog.guardReason, requests: gateway.reviewRequests().length } : null,
    { guardOk: false },
  );
  record(
    "guard.卡片视角的原因说清了「工作目录以外」",
    /工作目录以外/.test(String(guardVerdict.reason)),
    { reason: guardVerdict.reason },
    "含「工作目录以外」",
  );

  // ---- 黑名单层 aligned=false → confirm（同一份桩审阅，只改 aligned）
  gateway.state.verdict = { ...gateway.state.verdict, aligned: false, justification: "你没说过要推远端" };
  const denyVerdict = await judge({
    command: "git push --force origin main",
    config: reviewConfig({ autonomy: "loose" }),
    cwd: sandbox.cwd,
    history,
    log: (entry) => logs.push(entry),
  });
  record(
    "block2.黑名单层 aligned=false → confirm（loose 档也不放）",
    denyVerdict.decision === "confirm" && denyVerdict.aligned === false,
    { decision: denyVerdict.decision, aligned: denyVerdict.aligned },
    { decision: "confirm", aligned: false },
  );

  // 恢复默认桩结论，后面的浏览器场景还要用。
  gateway.state.verdict = {
    risk: "caution",
    aligned: true,
    justification: "你在第 1 轮说 empty-dir 是建错的、第 3 轮说删掉它",
    effect: "会删掉一个空文件夹",
    confirmWhy: "删掉就没了",
    reversible: false,
  };
  gateway.state.delayMs = 0;
  return { startupRequests };
}

/* ------------------------------------------------------------------ ③ 真浏览器 */

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const HELPERS = `
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const push = (frame) => window.__termDebugFrame(frame);
`;

async function waitFor(browser, expression, { timeoutMs = 20000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await browser.evaluate(`(() => { ${HELPERS} return Boolean(${expression}); })()`);
    } catch {
      value = false;
    }
    if (value) return true;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(80);
  }
}

async function shot(browser, name) {
  const buffer = await browser.screenshot();
  if (!buffer) return null;
  const target = path.join(SHOTS_DIR, `${name}.png`);
  await writeFile(target, buffer);
  return target;
}

/** 收集 agent 帧的 send（与 ws 无关，只用来喂浏览器）。 */
function makeSend() {
  const frames = [];
  const send = (frame) => frames.push(frame);
  send.frames = frames;
  send.ofType = (type) => frames.filter((frame) => frame.type === type);
  send.first = (type) => frames.find((frame) => frame.type === type) || null;
  return send;
}

/** 假命令执行器：不碰真 PTY（探针只验证判级与 UI）。 */
function fakeRunner() {
  const calls = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      return { ok: true, exitCode: 0, output: "", truncated: false, durationMs: 2 };
    },
    async probe() {
      return true;
    },
    dispose() {},
  };
}

function scriptedGenerateText(plan) {
  return async (args) => {
    for (const command of plan) {
      await args.tools.run_command.execute({ command, why: "探针用理由" }, { toolCallId: `call_${command}` });
    }
    return { text: "探针跑完了。", steps: [] };
  };
}

/** 把新产生的帧实时灌进浏览器（等价于 ws 推送）。 */
function makeRelay(browser) {
  let cursor = 0;
  const flush = async (send) => {
    const pending = send.frames.slice(cursor);
    if (pending.length === 0) return 0;
    await browser.evaluate(`(() => { ${HELPERS} const frames = ${JSON.stringify(pending)}; for (const frame of frames) push(frame); return frames.length; })()`);
    cursor = send.frames.length;
    return pending.length;
  };
  return { flush };
}

/** 等某个帧满足条件，同时持续把帧灌进浏览器。 */
async function waitFrame(send, relay, predicate, { timeoutMs = 15000, label = "frame" } = {}) {
  const started = Date.now();
  for (;;) {
    await relay.flush(send);
    const hit = send.frames.find(predicate);
    if (hit) {
      await relay.flush(send);
      return hit;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting frame: ${label}`);
    await sleep(50);
  }
}

async function runBrowserChecks({ gateway, sandbox, dir }) {
  process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
  process.env.MAGPIE_TERMINAL_LOG_DIR = path.join(dir, "logs");
  await mkdir(SHOTS_DIR, { recursive: true });

  const port = await freePort();
  const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
  // 真会话存储（探针用临时目录）：让 agent 的 taskHistory 真的有 3 轮历史。
  const sessionsDir = path.join(dir, "ai-sessions");
  await mkdir(sessionsDir, { recursive: true });
  const sessions = await createSessionStore({ dir: sessionsDir, log: quiet });
  const seeded = await sessions.createSession({ title: "", terminalId: "probe-terminal", terminalKind: "local", shell: "bash" });
  const at = Date.now();
  await sessions.appendMessage(seeded.id, { role: "user", text: "我建错了个文件夹 empty-dir，先留着", round: 1, at });
  await sessions.appendMessage(seeded.id, { role: "assistant", text: "好，需要删的时候说一声。", round: 1, at });
  await sessions.appendMessage(seeded.id, { role: "user", text: "看看这个目录里有什么", round: 2, at });
  await sessions.appendMessage(seeded.id, { role: "assistant", text: "有 dist 和一个空目录 empty-dir。", round: 2, at });
  await sessions.appendMessage(seeded.id, { role: "user", text: "把 empty-dir 删掉", round: 3, at });

  const handle = await startServer({ port, log: quiet });
  const base = `http://127.0.0.1:${port}`;
  let browser = null;
  let handleOpen = true;

  try {
    browser = await openBrowser({ width: 1360, height: 900 });
    await browser.navigate(`${base}/?token=${handle.token}`);
    await waitFor(browser, "document.readyState === 'complete'", { label: "页面加载" });
    await waitFor(browser, "typeof window.__termDebugFrame === 'function'", { label: "__termDebugFrame" });
    await waitFor(browser, "window.__termDebug().sessions.length >= 1", { timeoutMs: 30000, label: "首个终端" });
    await sleep(300);
    await browser.evaluate(`(() => { ${HELPERS}
      const open = document.querySelector('[data-role="app"]').getAttribute('data-ai-open');
      if (open !== 'true') q('[data-role="ai-handle"]').click();
      return true;
    })()`);
    await waitFor(browser, "document.querySelector('[data-role=\"app\"]').getAttribute('data-ai-open') === 'true'", {
      label: "抽屉打开",
    });

    const relay = makeRelay(browser);

    /* ---- 场景 1：auto（审阅中 → 消失 → 不出卡），审阅慢 700ms 以便观察 ---- */
    gateway.state.mode = "verdict";
    gateway.state.delayMs = 700;
    gateway.state.verdict = {
      risk: "caution",
      aligned: true,
      justification: "你在第 1 轮说 empty-dir 是建错的、第 3 轮说删掉它",
      effect: "会删掉一个空文件夹",
      confirmWhy: "删掉就没了",
      reversible: false,
    };
    const agentLogs = [];
    const send1 = makeSend();
    const agent1 = createAgentRunner({
      log: (entry) => agentLogs.push(entry),
      runner: fakeRunner(),
      sessions,
      generateText: scriptedGenerateText(["rmdir empty-dir"]),
    });
    const startedAt = Date.now();
    agent1.start({
      requestId: "probe-j-auto",
      question: "把 empty-dir 删掉",
      aiSessionId: seeded.id,
      socket: { marker: "probe" },
      send: send1,
      context: { cwd: sandbox.cwd, shell: { name: "bash", version: "5.2.37" } },
      config: reviewConfig({}),
    });

    // 审阅中：那一行必须出现（这就是「60 秒不是卡死」的唯一证据）。
    await waitFrame(send1, relay, (frame) => frame.type === "agent.review" && frame.state === "start", {
      label: "review start",
    });
    await waitFor(browser, 'document.querySelectorAll(\'[data-role="agent-reviewing"]\').length >= 1', {
      timeoutMs: 5000,
      label: "正在审阅那一行",
    });
    const reviewingText = await browser.evaluate(`(() => { ${HELPERS}
      const node = q('[data-role="agent-reviewing"]');
      return node ? node.textContent : null;
    })()`);
    record(
      "ui.审阅中显示「正在审阅这条命令…（最多 60 秒）」",
      reviewingText === "正在审阅这条命令…（最多 60 秒）",
      { text: reviewingText },
      "正在审阅这条命令…（最多 60 秒）",
    );
    const reviewingStore = await browser.evaluate(`(() => { ${HELPERS}
      const snapshot = window.__termDebugAgent();
      return { reviewing: snapshot.reviewing };
    })()`);
    record(
      "ui.store 里 reviewing 有 stepId 与 since（不是画个假动画）",
      Boolean(reviewingStore.reviewing && typeof reviewingStore.reviewing.stepId === "string" && typeof reviewingStore.reviewing.since === "number"),
      reviewingStore,
      "reviewing.stepId / since 都是真值",
    );
    await shot(browser, "j-reviewing");

    await waitFrame(send1, relay, (frame) => frame.type === "agent.done", { timeoutMs: 15000, label: "agent.done" });
    await relay.flush(send1);

    const afterAuto = await browser.evaluate(`(() => { ${HELPERS}
      return {
        reviewing: document.querySelectorAll('[data-role="agent-reviewing"]').length,
        approvals: document.querySelectorAll('[data-role="agent-approval"]').length,
        steps: document.querySelectorAll('[data-role="agent-step"]').length,
      };
    })()`);
    record("ui.审阅结束 → 那一行消失", afterAuto.reviewing === 0, afterAuto, { reviewing: 0 });
    record("ui.auto 的命令不出确认卡（用户不想看没意义的确认）", afterAuto.approvals === 0, afterAuto, { approvals: 0 });
    record("ui.auto 的命令仍然在时间线上有一步", afterAuto.steps >= 1, afterAuto, { steps: ">=1" });

    const reviewFrames = send1.ofType("agent.review");
    record(
      "ui.agent.review 帧顺序 start → done，且 done.ms 是真数字",
      reviewFrames.length === 2 &&
        reviewFrames[0].state === "start" &&
        reviewFrames[1].state === "done" &&
        typeof reviewFrames[1].ms === "number" &&
        reviewFrames[1].ms >= 500,
      { frames: reviewFrames },
      "start → done(ms>=500)",
    );
    record(
      "ui.审阅真的走了 700ms（不是同步假跑）",
      Date.now() - startedAt >= 700,
      { elapsed: Date.now() - startedAt },
      ">= 700ms",
    );

    // 这次 agent 的审阅请求里必须带着第 1 轮原话（agent → judge → review 的整条链）
    const agentReviewRequests = gateway.reviewRequests();
    const agentRequest = agentReviewRequests[agentReviewRequests.length - 1];
    const agentFirstUser = agentRequest
      ? String(agentRequest.body.messages.find((message) => message.role !== "system").content)
      : "";
    record(
      "ui.agent 自己的审阅请求也带着第 1 轮原话（不是只有 judge 单测里带着）",
      agentFirstUser.includes("我建错了个文件夹 empty-dir，先留着"),
      { head: agentFirstUser.slice(0, 160) },
      "含第 1 轮原话",
    );
    const autoReviewLog = agentLogs.find((entry) => entry.code === "REVIEW");
    record(
      "ui.REVIEW 日志的 historyChars > 0（上下文真进了审阅）",
      Boolean(autoReviewLog) && autoReviewLog.historyChars > 0 && autoReviewLog.tier === "blacklist",
      autoReviewLog ? { historyChars: autoReviewLog.historyChars, tier: autoReviewLog.tier, guardOk: autoReviewLog.guardOk } : null,
      { historyChars: ">0", tier: "blacklist" },
    );

    /* ---- 场景 2：confirm 卡显示 justification ---- */
    gateway.state.delayMs = 0;
    gateway.state.verdict = {
      risk: "caution",
      aligned: false,
      justification: "你只说了看看状态，没说要把历史推上去",
      effect: "会覆盖远端历史",
      confirmWhy: "推上去就不好撤",
      reversible: false,
    };
    const send2 = makeSend();
    const relay2 = makeRelay(browser);
    const agent2 = createAgentRunner({
      log: () => {},
      runner: fakeRunner(),
      sessions,
      generateText: scriptedGenerateText(["git push --force origin main"]),
    });
    agent2.start({
      requestId: "probe-j-confirm",
      question: "看看现在状态",
      aiSessionId: seeded.id,
      socket: { marker: "probe" },
      send: send2,
      context: { cwd: sandbox.cwd, shell: { name: "bash" } },
      config: reviewConfig({}),
    });
    await waitFrame(send2, relay2, (frame) => frame.type === "agent.approval", { label: "approval" });
    await relay2.flush(send2);
    await waitFor(browser, 'document.querySelectorAll(\'[data-role="agent-approval"]\').length >= 1', {
      label: "确认卡",
    });
    const card = await browser.evaluate(`(() => { ${HELPERS}
      const node = qa('[data-role="agent-approval"]')[0];
      const justification = node ? node.querySelector('[data-role="approval-justification"]') : null;
      return {
        text: justification ? justification.textContent : null,
        reviewing: document.querySelectorAll('[data-role="agent-reviewing"]').length,
        title: node && node.querySelector('.approval-head') ? node.querySelector('.approval-head').textContent : null,
      };
    })()`);
    record(
      "ui.确认卡显示「审阅判断：<justification>」",
      typeof card.text === "string" && card.text.includes("审阅判断：") && card.text.includes("你只说了看看状态"),
      card,
      "含「审阅判断：…你只说了看看状态…」",
    );
    record("ui.出卡时「正在审阅」已经消失", card.reviewing === 0, card, { reviewing: 0 });
    await shot(browser, "j-justification");

    /* ---- 场景 3：审阅永不返回 + agent.stop → 立刻中止、confirm、REVIEW_FAILED ---- */
    gateway.state.mode = "hang";
    const send3 = makeSend();
    const relay3 = makeRelay(browser);
    const timeoutLogs = [];
    const agent3 = createAgentRunner({
      log: (entry) => timeoutLogs.push(entry),
      runner: fakeRunner(),
      sessions,
      generateText: scriptedGenerateText(["rm -rf ./empty-dir"]),
    });
    const task3 = agent3.start({
      requestId: "probe-j-timeout",
      question: "删掉空目录",
      aiSessionId: seeded.id,
      socket: { marker: "probe" },
      send: send3,
      context: { cwd: sandbox.cwd, shell: { name: "bash" } },
      config: reviewConfig({}),
    });
    await waitFrame(send3, relay3, (frame) => frame.type === "agent.review" && frame.state === "start", {
      label: "hang review start",
    });
    await waitFor(browser, 'document.querySelectorAll(\'[data-role="agent-reviewing"]\').length >= 1', {
      timeoutMs: 5000,
      label: "正在审阅（挂住）",
    });
    const stopAt = Date.now();
    task3.stop({ reason: "probe" });
    const doneFrame = await waitFrame(send3, relay3, (frame) => frame.type === "agent.review" && frame.state === "done", {
      timeoutMs: 8000,
      label: "review done after stop",
    });
    const abortMs = Date.now() - stopAt;
    await sleep(150);
    await relay3.flush(send3);
    const failedLog = timeoutLogs.find((entry) => entry.code === "REVIEW_FAILED");
    record(
      "timeout.审阅挂住时 agent.stop 立刻中止（不等满 60 秒）",
      abortMs < 3000,
      { abortMs },
      "< 3000ms",
    );
    record(
      "timeout.中止后落 REVIEW_FAILED（fail-closed，不许静默）",
      Boolean(failedLog),
      failedLog ? { code: failedLog.code, reason: failedLog.reason, tier: failedLog.tier } : null,
      "REVIEW_FAILED",
    );
    record("timeout.done 帧仍然发出（前端不会永远转圈）", Boolean(doneFrame) && typeof doneFrame.ms === "number", doneFrame, "done(ms)");
    const afterTimeout = await browser.evaluate(`(() => { ${HELPERS}
      const snapshot = window.__termDebugAgent();
      return {
        reviewing: document.querySelectorAll('[data-role="agent-reviewing"]').length,
        storeReviewing: snapshot.reviewing,
        approvals: document.querySelectorAll('[data-role="agent-approval"]').length,
        storePending: snapshot.pendingApprovals.length,
        storeSteps: snapshot.steps.length,
        storeStatus: snapshot.status,
        frameTypes: ${JSON.stringify(send3.frames.map((frame) => frame.type + "/" + (frame.state || frame.status || "")))},
      };
    })()`);
    record(
      "timeout.UI 上「正在审阅」消失（不会永远挂着）",
      afterTimeout.reviewing === 0 && afterTimeout.storeReviewing === null,
      afterTimeout,
      { reviewing: 0, storeReviewing: null },
    );
    record(
      "timeout.中止后仍是 fail-closed：真的发了一张确认卡（随后因任务被停止而收尾）",
      send3.ofType("agent.approval").length >= 1 && afterTimeout.storeStatus === "stopped",
      { approvals: send3.ofType("agent.approval").length, status: afterTimeout.storeStatus },
      { approvals: ">=1", status: "stopped" },
    );
    await shot(browser, "j-timeout-confirm");

    // 收尾：把还挂着的审批 resolve 掉，避免后台计时器拖住进程（timer 已 unref，这里只是干净）。
    for (const approval of send3.ofType("agent.approval")) {
      agent3.resolveApproval({ approvalId: approval.approvalId, approved: false, scope: "once" });
    }

    record("timeout.REVIEW_TIMEOUT_MS === 60000", REVIEW_TIMEOUT_MS === 60000, { REVIEW_TIMEOUT_MS }, 60000);
  } finally {
    if (browser) await browser.close();
    if (handleOpen) {
      handleOpen = false;
      await handle.close();
    }
    gateway.state.mode = "verdict";
  }
}

/* ------------------------------------------------------------------ ④ 真网关缓存 */

async function fetchGateway(body) {
  const response = await fetch(`${DEFAULT_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

async function runCacheCheck({ history, sandbox }) {
  const messages = (command) =>
    buildReviewMessages({ command, history, cwd: sandbox.cwd, shell: "bash 5.2.37", targetFacts: null });

  const bodyOf = (command) => ({
    model: GATEWAY_MODEL,
    max_tokens: 200,
    temperature: 0,
    messages: [{ role: "system", content: REVIEW_SYSTEM_PROMPT }, ...messages(command)],
    tools: [
      {
        type: "function",
        function: {
          name: "review_command",
          description: "给出这条 shell 命令的风险评估",
          parameters: REVIEW_TOOL_SCHEMA,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "review_command" } },
  });

  const attempts = [];
  const commands = ["rm tmp-note.txt", "rm tmp-note.txt", "rmdir empty-dir"];
  for (const command of commands) {
    const startedAt = Date.now();
    let result = null;
    let error = null;
    try {
      result = await fetchGateway(bodyOf(command));
    } catch (err) {
      error = err && err.message ? err.message : String(err);
    }
    const usage = result && result.json && result.json.usage ? result.json.usage : {};
    const cached = usage.prompt_tokens_details ? usage.prompt_tokens_details.cached_tokens : undefined;
    attempts.push({
      command,
      status: result ? result.status : null,
      ms: Date.now() - startedAt,
      prompt_tokens: usage.prompt_tokens ?? null,
      cached_tokens: typeof cached === "number" ? cached : null,
      prompt_tokens_details: usage.prompt_tokens_details ?? null,
      usage,
      error,
      raw: result && result.status !== 200 ? String(result.text).slice(0, 2000) : null,
      choice_head:
        result && result.json && result.json.choices && result.json.choices[0]
          ? String(JSON.stringify(result.json.choices[0]).slice(0, 400))
          : null,
    });
    note(
      `真网关第 ${attempts.length} 次：prompt=${attempts[attempts.length - 1].prompt_tokens} cached=${attempts[attempts.length - 1].cached_tokens} ms=${attempts[attempts.length - 1].ms}`,
    );
  }

  const reachable = attempts.every((item) => item.status === 200);
  const hits = attempts.filter((item) => typeof item.cached_tokens === "number" && item.cached_tokens > 0).length;

  if (!reachable) {
    record(
      "cache.BLOCKED：真网关不可达 / 非 200（原始响应已落盘）",
      false,
      { attempts },
      "3 次都应为 200",
    );
    return { status: "BLOCKED", attempts, hits };
  }

  // 第 2、3 次应该命中（第 1 次允许 miss：上游建缓存要时间）。
  if (hits < 2) {
    record(
      "cache.BLOCKED：3 连发里 cached_tokens>0 不足 2 次（原始数字见 attempts）",
      false,
      { hits, attempts: attempts.map((item) => ({ prompt: item.prompt_tokens, cached: item.cached_tokens, ms: item.ms })) },
      ">= 2 次命中",
    );
    return { status: "BLOCKED", attempts, hits };
  }

  record(
    "cache.同前缀 3 连发里至少 2 次 cached_tokens > 0",
    hits >= 2,
    { hits, attempts: attempts.map((item) => item.cached_tokens) },
    ">= 2 次命中",
  );
  record(
    "cache.第 3 次换了命令但前缀没变 → 仍然命中（命令只在最后一条消息里）",
    typeof attempts[2].cached_tokens === "number" && attempts[2].cached_tokens > 0,
    { cached_tokens: attempts[2].cached_tokens, prompt_tokens: attempts[2].prompt_tokens },
    "cached_tokens > 0",
  );
  return { status: "PASS", attempts, hits };
}

/* ------------------------------------------------------------------ main */

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-j-probe-root-"));
const sandbox = makeSandbox();
const gateway = createStubGateway();
const stubUrl = await gateway.listen();
process.env.MAGPIE_TERMINAL_GATEWAY_URL = stubUrl;
note(`桩审阅网关：${stubUrl}`);
note(`真网关（缓存那一步）：${DEFAULT_GATEWAY}`);

let cacheResult = { status: "SKIPPED", attempts: [], hits: 0 };
try {
  console.log("\n== ① 判级链（真 judge + 真 reviewCommand + 桩网关） ==");
  await runJudgeChecks({ gateway, sandbox });

  console.log("\n== ② 真服务 + 真浏览器（CDP） ==");
  await runBrowserChecks({ gateway, sandbox, dir });

  if (hasFlag("--no-cache")) {
    console.log("\n== ③ 真网关缓存（已跳过：--no-cache） ==");
  } else {
    console.log("\n== ③ 真网关缓存（node fetch，3 连发同前缀） ==");
    cacheResult = await runCacheCheck({ history: longHistory(12), sandbox });
  }
} finally {
  process.env.MAGPIE_TERMINAL_GATEWAY_URL = "";
  await gateway.close();
  try {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败。
  }
}

const failed = results.filter((item) => !item.pass);
const summary = {
  at: new Date().toISOString(),
  stubGateway: stubUrl,
  reviewTimeoutMs: REVIEW_TIMEOUT_MS,
  passed: results.length - failed.length,
  total: results.length,
  cache: cacheResult,
  results,
  failed: failed.map((item) => item.name),
};
await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(path.join(EVIDENCE_DIR, "probe-review-context.json"), JSON.stringify(summary, null, 2), "utf8");
const out = argValue("--out");
if (out) await writeFile(path.resolve(out), JSON.stringify(summary, null, 2), "utf8");

console.log(`\n${summary.passed}/${summary.total} passed`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const item of failed) console.log(`  - ${item.name}`);
}
console.log(`证据：${path.join(EVIDENCE_DIR, "probe-review-context.json")}`);
process.exit(failed.length === 0 && cacheResult.status !== "BLOCKED" ? 0 : 1);
