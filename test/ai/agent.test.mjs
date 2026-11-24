// Agent 主循环的行为锁（PROTOCOL-AGENT.md §6，AC10 / AC11 / AC12）。
//
// 用假的 generateText 驱动：真模型会让单测变慢、变 flaky，也会花钱。
// 假 generateText 拿到同一个 tools 对象，按剧本调用 `tools.run_command.execute`，
// 这样工具内部的审批 await、step 帧、done 帧都走真实代码路径。

import test from "node:test";
import assert from "node:assert/strict";
import { judge as realJudge } from "../../src/ai/judge.mjs";
import {
  MAX_STEPS,
  APPROVAL_TIMEOUT_MS,
  DEFAULT_BASE_PROMPT,
  DENIED_USER_TEXT,
  buildAgentSystemPrompt,
  createAgentRunner,
} from "../../src/ai/agent.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一个假 generateText：按 plan 依次调用 run_command，最后返回 text。 */
function scriptedGenerateText(plan, { text = "都跑完了，没有失败。" } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const tools = args.tools || {};
    for (const item of plan) {
      if (item.waitMs) await sleep(item.waitMs);
      if (args.abortSignal && args.abortSignal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      if (typeof item.hook === "function") await item.hook();
      await tools.run_command.execute(
        { command: item.command, why: item.why || "测试用理由" },
        { toolCallId: `call_${calls.length}_${item.command}` },
      );
    }
    return { text, steps: [] };
  };
  fn.calls = calls;
  return fn;
}

/** 记录出站帧的 send。 */
function makeSend() {
  const frames = [];
  const send = (frame) => frames.push(frame);
  send.frames = frames;
  send.ofType = (type) => frames.filter((frame) => frame.type === type);
  send.first = (type) => frames.find((frame) => frame.type === type) || null;
  return send;
}

/** 假的命令执行器：记录调用，返回预设结果。 */
function fakeRunner(result = { ok: true, exitCode: 0, output: "a.txt b.txt", truncated: false, durationMs: 12 }) {
  const calls = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      return typeof result === "function" ? result(input) : result;
    },
    async probe() {
      return true;
    },
    dispose() {},
  };
}

const autoJudge = async ({ command }) => ({
  decision: "auto",
  reason: "内置只读白名单",
  hit: null,
  risk: null,
  reviewModel: null,
});

const confirmJudge = async ({ command }) => ({
  decision: "confirm",
  reason: "AI 审阅：可能需要你确认",
  hit: null,
  risk: "danger",
  reviewModel: "review/model",
});

function makeAgent({ plan, runner, judgeFn, text } = {}) {
  const send = makeSend();
  const agent = createAgentRunner({
    log: () => {},
    runner: runner || fakeRunner(),
    generateText: scriptedGenerateText(plan || [], { text }),
    judgeFn: judgeFn || autoJudge,
  });
  return { agent, send };
}

const SOCKET = { marker: "socket-a" };

// ------------------------------------------------------------------ AC10

test("AC10：至少 2 步 —— 两次 agent.step 都发到 socket，最后有 agent.done", async () => {
  const { agent, send } = makeAgent({
    plan: [
      { command: "ls", why: "看看有什么" },
      { command: "cat a.txt", why: "读一下内容" },
    ],
  });
  const task = agent.start({
    requestId: "r1",
    question: "看看这里有几个文件",
    sessionId: "s1",
    socket: SOCKET,
    send,
    config: { autonomy: "balanced", allowlist: [] },
  });
  assert.equal(typeof task.taskId, "string");
  await sleep(60);

  assert.equal(send.ofType("agent.start").length, 1, "agent.start 只发一次");
  const start = send.first("agent.start");
  assert.equal(start.requestId, "r1");
  assert.equal(start.taskId, task.taskId);
  assert.equal(typeof start.model, "string");
  assert.equal(start.model.length > 0, true);
  assert.equal(start.targetSessionId, "s1");

  const stepIds = new Set(send.ofType("agent.step").map((frame) => frame.stepId));
  assert.equal(stepIds.size, 2, "两步各有一个 stepId");

  const steps = send.ofType("agent.step");
  const done = steps.filter((frame) => frame.status === "done");
  assert.equal(done.length, 2, "两步都跑完了");
  assert.deepEqual(
    steps.map((frame) => frame.index).filter((v, i, a) => a.indexOf(v) === i),
    [1, 2],
    "index 从 1 开始递增",
  );
  assert.equal(done[0].command, "ls");
  assert.equal(done[0].output, "a.txt b.txt");
  assert.equal(done[0].exitCode, 0);

  const dones = send.ofType("agent.done");
  assert.equal(dones.length, 1, "agent.done 只发一次");
  assert.equal(dones[0].text, "都跑完了，没有失败。");
  assert.equal(dones[0].steps, 2);
  assert.equal(dones[0].stopped, false);
  assert.equal(typeof dones[0].durationMs, "number");
});

test("AC10：run_command 的返回带 exitCode / output / truncated（模型看得到真输出）", async () => {
  let captured = null;
  const fn = async (args) => {
    captured = await args.tools.run_command.execute(
      { command: "ls", why: "看目录" },
      { toolCallId: "call_1" },
    );
    return { text: "ok" };
  };
  const send = makeSend();
  const agent = createAgentRunner({ log: () => {}, runner: fakeRunner(), generateText: fn, judgeFn: autoJudge });
  agent.start({ requestId: "r1", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(40);
  assert.equal(captured.exitCode, 0);
  assert.equal(captured.output, "a.txt b.txt");
  assert.equal(captured.truncated, false);
});

test("失败的命令也回喂模型（exitCode 非 0 → step status failed）", async () => {
  const { agent, send } = makeAgent({
    plan: [{ command: "cat nope", why: "读文件" }],
    runner: fakeRunner({ ok: true, exitCode: 2, output: "no such file", truncated: false }),
  });
  agent.start({ requestId: "r1", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(40);
  const step = send.ofType("agent.step").find((frame) => frame.status === "failed");
  assert.ok(step, "非零退出码的步骤状态是 failed");
  assert.equal(step.exitCode, 2);
  assert.equal(step.output, "no such file");
});

test("EXEC_UNSUPPORTED 时不再傻跑，工具返回错误 + 提示模型改成文字回答", async () => {
  let returned = null;
  const fn = async (args) => {
    returned = await args.tools.run_command.execute({ command: "ls", why: "看" }, { toolCallId: "c1" });
    return { text: "这个终端不支持自动执行。" };
  };
  const send = makeSend();
  const agent = createAgentRunner({
    log: () => {},
    runner: fakeRunner({
      ok: false,
      code: "EXEC_UNSUPPORTED",
      exitCode: null,
      output: "",
      truncated: false,
      userText: "这个终端不支持自动执行（可能是 Windows 的 cmd.exe），我把命令列给你，你复制到终端里运行。",
    }),
    generateText: fn,
    judgeFn: autoJudge,
  });
  agent.start({ requestId: "r1", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(40);
  assert.equal(returned.error, "EXEC_UNSUPPORTED");
  assert.ok(returned.userText.includes("不支持自动执行"));
  assert.ok(returned.userText.includes("run_command"), "要告诉模型别再调 run_command");
});

// ------------------------------------------------------------------ AC11

test("AC11：approved:false → 工具返回 denied，模型不重试", async () => {
  const runner = fakeRunner();
  let returned = null;

  const fn = async (args) => {
    returned = await args.tools.run_command.execute(
      { command: "rm -rf build", why: "清理构建产物" },
      { toolCallId: "call_denied" },
    );
    // 模型收到 denied 后不再调工具，直接收尾。
    return { text: "你拒绝了删除，我没有动 build 目录。" };
  };

  const send = makeSend();
  const agent = createAgentRunner({ log: () => {}, runner, generateText: fn, judgeFn: confirmJudge });

  agent.start({ requestId: "r1", question: "清一下构建", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(20);

  const approval = send.first("agent.approval");
  assert.ok(approval, "confirm 级命令必须发 agent.approval");
  assert.equal(approval.command, "rm -rf build");
  assert.equal(approval.risk, "danger");
  assert.equal(approval.requestId, "r1");
  assert.equal(typeof approval.approvalId, "string");

  // 用户拒绝
  const resolved = agent.resolveApproval({ approvalId: approval.approvalId, approved: false });
  assert.equal(resolved, true, "resolveApproval 必须认得这个 approvalId");
  await sleep(40);

  assert.equal(returned.denied, true);
  assert.equal(returned.userText, DENIED_USER_TEXT);
  assert.equal(runner.calls.length, 0, "被拒绝的命令绝不能执行");

  const stepDenied = send.ofType("agent.step").find((frame) => frame.status === "denied");
  assert.ok(stepDenied, "要有一条 denied 的 step");
  const dones = send.ofType("agent.done");
  assert.equal(dones.length, 1, "收尾必须有且只有一条 agent.done");
  assert.equal(dones[0].steps, 1);
});

test("AC11：approved:true → 真的执行、发 done 帧", async () => {
  const runner = fakeRunner({ ok: true, exitCode: 0, output: "removed", truncated: false, durationMs: 5 });
  let returned = null;
  const fn = async (args) => {
    returned = await args.tools.run_command.execute(
      { command: "rm -rf build", why: "清理" },
      { toolCallId: "call_ok" },
    );
    return { text: "删掉了。" };
  };
  const send = makeSend();
  const agent = createAgentRunner({ log: () => {}, runner, generateText: fn, judgeFn: confirmJudge });
  const task = agent.start({ requestId: "r1", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(20);
  const approval = send.first("agent.approval");
  agent.resolveApproval({ approvalId: approval.approvalId, approved: true });
  await sleep(40);
  assert.equal(returned.exitCode, 0);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].command, "rm -rf build");
  assert.equal(send.ofType("agent.done").length, 1);
  assert.equal(task.taskId, send.first("agent.start").taskId);
});

test("AC11：scope=rest → 后续 confirm 级命令直接跑（硬禁止仍然 confirm）", async () => {
  const runner = fakeRunner();
  const approvals = [];
  const fn = async (args) => {
    for (const command of ["mkdir a", "mkdir b", "sudo ls"]) {
      const result = await args.tools.run_command.execute({ command, why: "x" }, { toolCallId: `c-${command}` });
      approvals.push(result);
      if (result.denied) break;
    }
    return { text: "做完了。" };
  };
  const send = makeSend();
  // 走真判级链（审阅用假实现），这样「硬禁止仍然 confirm」是真实行为。
  const judgeFn = (input) =>
    realJudge({
      ...input,
      review: async () => ({ risk: "caution", why: "测试用", reversible: true, model: "review/model" }),
    });
  const agent = createAgentRunner({ log: () => {}, runner, generateText: fn, judgeFn });

  agent.start({ requestId: "r1", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });

  // 第一条：放行 + 「剩余全部」。
  await sleep(20);
  const first = send.ofType("agent.approval")[0];
  assert.equal(first.command, "mkdir a");
  agent.resolveApproval({ approvalId: first.approvalId, approved: true, scope: "rest" });

  // mkdir b 因 rest 直接跑；sudo ls 仍然要审批 —— 这里拒绝它。
  await sleep(30);
  const frames = send.ofType("agent.approval");
  assert.equal(frames.length, 2, "sudo ls 必须再问一次");
  agent.resolveApproval({ approvalId: frames[1].approvalId, approved: false });
  await sleep(60);

  // mkdir a 等审批；mkdir b 因 scope=rest 直接跑；sudo ls 必须还要审批（硬禁止）。
  assert.deepEqual(runner.calls.map((call) => call.command), ["mkdir a", "mkdir b"], `实际跑了 ${JSON.stringify(runner.calls.map((c) => c.command))}`);
  assert.equal(send.ofType("agent.approval").length, 2, "rest 只放行非硬禁止的，sudo 仍然要问");
  assert.equal(send.ofType("agent.approval")[1].command, "sudo ls");
  assert.equal(approvals.at(-1).denied, true, "sudo 被拒绝后工具返回 denied");
});

// ------------------------------------------------------------------ AC12

test("AC12：stop 后 pending approval 全部 resolve 成 aborted，并发 agent.done{stopped:true}", async () => {
  const runner = fakeRunner();
  const fn = async (args) => {
    await args.tools.run_command.execute({ command: "rm -rf build", why: "x" }, { toolCallId: "c1" });
    return { text: "不该走到这里" };
  };
  const send = makeSend();
  const agent = createAgentRunner({ log: () => {}, runner, generateText: fn, judgeFn: confirmJudge });
  const task = agent.start({ requestId: "r1", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(20);
  assert.equal(send.ofType("agent.approval").length, 1);
  assert.equal(agent.pendingCount(), 1);

  task.stop({ reason: "user" });
  await sleep(20);

  assert.equal(agent.pendingCount(), 0, "stop 必须清空 pending");
  assert.equal(runner.calls.length, 0, "stop 不该执行被挂起的命令");
  const dones = send.ofType("agent.done");
  assert.equal(dones.length, 1);
  assert.equal(dones[0].stopped, true);
  assert.ok(/停止/.test(dones[0].text));
});

test("AC12：stop 之后只发一次 done（再 stop 不重复发）", async () => {
  const send = makeSend();
  const fn = async () => {
    await sleep(200);
    return { text: "late" };
  };
  const agent = createAgentRunner({ log: () => {}, runner: fakeRunner(), generateText: fn, judgeFn: autoJudge });
  const task = agent.start({ requestId: "r1", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(10);
  task.stop({ reason: "user" });
  task.stop({ reason: "user" });
  agent.stopAll();
  await sleep(60);
  assert.equal(send.ofType("agent.done").length, 1);
});

test("AC12：运行中第二次 agent.run → agent.error{BUSY}，且不影响第一个任务", async () => {
  const send = makeSend();
  const fn = async (args) => {
    await sleep(80);
    await args.tools.run_command.execute({ command: "ls", why: "x" }, { toolCallId: "c1" });
    return { text: "ok" };
  };
  const agent = createAgentRunner({ log: () => {}, runner: fakeRunner(), generateText: fn, judgeFn: autoJudge });

  const first = agent.start({ requestId: "r1", question: "q1", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(10);
  const second = agent.start({ requestId: "r2", question: "q2", sessionId: "s1", socket: SOCKET, send, config: {} });
  assert.equal(second.busy, true);

  const errors = send.ofType("agent.error");
  assert.equal(errors.length, 1, "第二个任务只回一条 agent.error");
  assert.equal(errors[0].code, "BUSY");
  assert.equal(errors[0].requestId, "r2");
  assert.ok(errors[0].userText.includes("上一个任务还在跑"));

  await sleep(150);
  // 第一个任务不受影响。
  assert.equal(send.ofType("agent.start").filter((frame) => frame.requestId === "r1").length, 1);
  assert.equal(send.ofType("agent.done").length, 1);
  assert.equal(first.taskId.length > 0, true);
});

test("AC12：不同 socket 可以各跑一个任务（BUSY 是按连接算的）", async () => {
  const sendA = makeSend();
  const sendB = makeSend();
  const fn = async () => {
    await sleep(40);
    return { text: "ok" };
  };
  const agent = createAgentRunner({ log: () => {}, runner: fakeRunner(), generateText: fn, judgeFn: autoJudge });
  const a = agent.start({ requestId: "ra", question: "q", sessionId: "s1", socket: { id: "A" }, send: sendA, config: {} });
  const b = agent.start({ requestId: "rb", question: "q", sessionId: "s1", socket: { id: "B" }, send: sendB, config: {} });
  assert.equal(a.busy, undefined);
  assert.equal(b.busy, undefined);
  await sleep(120);
  assert.equal(sendA.ofType("agent.done").length, 1);
  assert.equal(sendB.ofType("agent.done").length, 1);
});

test("任务结束后同一 socket 可以再起一个任务（BUSY 解除）", async () => {
  const send = makeSend();
  const agent = createAgentRunner({ log: () => {}, runner: fakeRunner(), generateText: scriptedGenerateText([]), judgeFn: autoJudge });
  agent.start({ requestId: "r1", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(40);
  const again = agent.start({ requestId: "r2", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });
  assert.equal(again.busy, undefined);
  await sleep(40);
  assert.equal(send.ofType("agent.done").length, 2);
});

// ------------------------------------------------------------------ 失败路径 / 常量

test("generateText 抛错 → agent.error，不抛到外面", async () => {
  const send = makeSend();
  const fn = async () => {
    throw new Error("gateway exploded");
  };
  const agent = createAgentRunner({ log: () => {}, runner: fakeRunner(), generateText: fn, judgeFn: autoJudge });
  agent.start({ requestId: "r1", question: "q", sessionId: "s1", socket: SOCKET, send, config: {} });
  await sleep(40);
  const errors = send.ofType("agent.error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "AGENT_FAILED");
  assert.equal(typeof errors[0].userText, "string");
  assert.equal(send.ofType("agent.done").length, 0, "error 与 done 不重复发");
});

test("stopAll 停掉所有 socket 的任务", async () => {
  const sendA = makeSend();
  const sendB = makeSend();
  const fn = async () => {
    await sleep(300);
    return { text: "late" };
  };
  const agent = createAgentRunner({ log: () => {}, runner: fakeRunner(), generateText: fn, judgeFn: autoJudge });
  agent.start({ requestId: "ra", question: "q", sessionId: "s1", socket: { id: "A" }, send: sendA, config: {} });
  agent.start({ requestId: "rb", question: "q", sessionId: "s1", socket: { id: "B" }, send: sendB, config: {} });
  await sleep(10);
  agent.stopAll();
  await sleep(30);
  assert.equal(sendA.ofType("agent.done").length, 1);
  assert.equal(sendB.ofType("agent.done").length, 1);
  assert.equal(sendA.ofType("agent.done")[0].stopped, true);
});

test("resolveApproval 对未知 approvalId 返回 false", () => {
  const agent = createAgentRunner({ log: () => {}, runner: fakeRunner() });
  assert.equal(agent.resolveApproval({ approvalId: "nope", approved: true }), false);
});

test("常量：最多 8 步、审批超时 120s", () => {
  assert.equal(MAX_STEPS, 8);
  assert.equal(APPROVAL_TIMEOUT_MS, 120000);
});

// ------------------------------------------------------------------ 提示词

test("系统提示词 = 基础提示词 + 硬性规则（PROTOCOL §6.2）", () => {
  const prompt = buildAgentSystemPrompt({});
  assert.ok(prompt.startsWith(DEFAULT_BASE_PROMPT), "首段是内置基础提示词");
  assert.ok(prompt.includes("## 硬性规则"));
  // 十条规则的关键句都要在。
  for (const needle of [
    "你不是在建议命令，你是在替用户干活",
    "最后必须用大白话讲清楚",
    "最多 8 步",
    "不要原样重试",
    "包括 rm / mv 这类删除移动",
    "唯一绝对不给的是 sudo / su",
    "不要使用 find",
    "rg --files",
    "查看 HTTP 头用 curl -I",
    "如果某条命令被用户拒绝，不要重试",
    "任务完成后必须用文字给出结论",
  ]) {
    assert.ok(prompt.includes(needle), `提示词缺少：${needle}`);
  }
});

test("自定义 basePrompt 替换默认基础提示词，硬性规则仍然保留", () => {
  const prompt = buildAgentSystemPrompt({ basePrompt: "你是我的私人助理。" });
  assert.ok(prompt.startsWith("你是我的私人助理。"));
  assert.equal(prompt.includes(DEFAULT_BASE_PROMPT), false);
  assert.ok(prompt.includes("## 硬性规则"));
});

test("basePrompt 是空串 / 非字符串时回落默认", () => {
  assert.ok(buildAgentSystemPrompt({ basePrompt: "   " }).startsWith(DEFAULT_BASE_PROMPT));
  assert.ok(buildAgentSystemPrompt({ basePrompt: 123 }).startsWith(DEFAULT_BASE_PROMPT));
  assert.ok(buildAgentSystemPrompt(undefined).startsWith(DEFAULT_BASE_PROMPT));
});

// ===========================================================================
// TASK-V4-H §5.2：多轮会话（AC1）
// ===========================================================================

const { createSessionStore } = await import("../../src/ai/sessions.mjs");
const { buildHistoryMessages, summarizeStepForHistory, HISTORY_STEP_OUTPUT_MAX, extractReasoning } =
  await import("../../src/ai/agent.mjs");
const os = await import("node:os");
const pathMod = await import("node:path");
const { mkdtemp } = await import("node:fs/promises");

async function tempStore() {
  const dir = await mkdtemp(pathMod.join(os.tmpdir(), "mt-agent-sessions-"));
  return createSessionStore({ dir, log: () => {} });
}

/** 等某个帧出现（全量并行跑时固定 sleep 不可靠）。 */
async function waitForFrame(send, type, count = 1, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const frames = send.ofType(type);
    if (frames.length >= count) return frames;
    if (Date.now() - started > timeoutMs) return frames;
    await sleep(10);
  }
}

/** 等条件成立。 */
async function waitUntil(fn, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await sleep(20);
  }
}

/** 记下每次调用收到的 messages，按剧本调工具。 */
function recordingGenerateText(plans, texts) {
  const calls = [];
  const fn = async (args) => {
    calls.push({ messages: args.messages });
    const plan = plans[calls.length - 1] || [];
    for (const item of plan) {
      await args.tools.run_command.execute(
        { command: item.command, why: item.why || "测试用理由" },
        { toolCallId: `call_${calls.length}_${item.command}` },
      );
    }
    return { text: (texts && texts[calls.length - 1]) || "做完了。", steps: [] };
  };
  fn.calls = calls;
  return fn;
}

function localTerminal(id) {
  return { id, kind: "local", shell: "bash 5.2.37" };
}

test("AC1：同一会话连续两问，第二问的模型输入里有上一轮的真实输出", async () => {
  const store = await tempStore();
  const send = makeSend();
  const fn = recordingGenerateText(
    [[{ command: "ls -S", why: "按大小排" }], [{ command: "ls -lh a.txt", why: "看最大的那个" }]],
    ["最大的文件是 a.txt（12MB）。", "a.txt 12MB，是目录里最大的。"],
  );
  const runner = fakeRunner({
    ok: true,
    exitCode: 0,
    output: "12M a.txt\n4.0M b.log\n",
    truncated: false,
    durationMs: 3,
  });
  const agent = createAgentRunner({
    log: () => {},
    runner,
    sessions: store,
    generateText: fn,
    judgeFn: autoJudge,
  });

  agent.start({
    requestId: "r1",
    question: "这个目录里最大的文件是哪个？",
    sessionId: "pty-1",
    terminal: localTerminal("pty-1"),
    socket: SOCKET,
    send,
    config: {},
  });
  await waitForFrame(send, "agent.start");
  const startFrame = send.first("agent.start");
  assert.equal(typeof startFrame.sessionId, "string", "agent.start 必须带 sessionId");
  assert.equal(startFrame.round, 1);
  const aiSessionId = startFrame.sessionId;

  // 真实用户是看到第一轮的总结后才追问的：这里等 agent.done 再开第二轮
  // （并行跑全量时固定 sleep 会让第二轮赶在第一轮落盘之前，那是在测一个不存在的场景）。
  await waitForFrame(send, "agent.done", 1);
  await store.flush();

  agent.start({
    requestId: "r2",
    question: "那最大的那个呢？给我具体大小。",
    sessionId: "pty-1",
    aiSessionId,
    terminal: localTerminal("pty-1"),
    socket: SOCKET,
    send,
    config: {},
  });
  await waitForFrame(send, "agent.done", 2);
  // 第二轮可能还在收尾（落盘走串行链）：等第二轮自己的 agent.start 与 done 都齐了。
  await waitForFrame(send, "agent.start", 2);
  await waitUntil(() => send.ofType("agent.done").length >= 2, 8000);
  await sleep(30);
  await store.flush();

  assert.equal(fn.calls.length, 2, `应该跑了两轮，实际 ${fn.calls.length}（start=${send.ofType("agent.start").length} done=${send.ofType("agent.done").length}）`);
  const joined = fn.calls[1].messages.map((message) => message.content).join("\n---\n");
  assert.ok(joined.includes("这个目录里最大的文件是哪个？"), "第二轮必须看到第一轮的问题");
  assert.ok(joined.includes("12M a.txt"), "第二轮必须看到第一轮的真实命令输出");
  assert.ok(joined.includes("a.txt（12MB）"), "第二轮必须看到第一轮的助手结论");
  assert.ok(joined.includes("那最大的那个呢？"), "第二轮自己的问题也要在");

  const startFrames = send.ofType("agent.start");
  assert.equal(startFrames.length, 2);
  assert.equal(startFrames[1].sessionId, aiSessionId, "第二问必须复用同一会话");
  assert.equal(startFrames[1].round, 2);

  await store.flush();
  const stored = await store.getSession(aiSessionId);
  assert.equal(stored.messages.filter((item) => item.role === "user").length, 2);
  assert.equal(stored.messages.filter((item) => item.role === "assistant").length, 2);
  assert.equal(stored.steps.length, 2);
  assert.equal(stored.steps[0].command, "ls -S");
});

test("§5.2：不带 aiSessionId 也能按终端找回最近会话（服务端兜底）", async () => {
  const store = await tempStore();
  const send = makeSend();
  const fn = recordingGenerateText([[], []]);
  const agent = createAgentRunner({
    log: () => {},
    runner: fakeRunner(),
    sessions: store,
    generateText: fn,
    judgeFn: autoJudge,
  });

  agent.start({
    requestId: "r1",
    question: "第一问",
    sessionId: "pty-9",
    terminal: localTerminal("pty-9"),
    socket: SOCKET,
    send,
    config: {},
  });
  await waitForFrame(send, "agent.done", 1);
  const firstId = send.first("agent.start").sessionId;
  agent.start({
    requestId: "r2",
    question: "第二问",
    sessionId: "pty-9",
    terminal: localTerminal("pty-9"),
    socket: SOCKET,
    send,
    config: {},
  });
  await waitForFrame(send, "agent.done", 2);
  assert.equal(send.ofType("agent.start")[1].sessionId, firstId, "同一终端第二轮要接回原会话");
});

test("§5.2：不同终端各自一个会话，互不串味", async () => {
  const store = await tempStore();
  const send = makeSend();
  const fn = recordingGenerateText([[], []]);
  const agent = createAgentRunner({
    log: () => {},
    runner: fakeRunner(),
    sessions: store,
    generateText: fn,
    judgeFn: autoJudge,
  });

  agent.start({
    requestId: "r1",
    question: "终端 A 的问题",
    sessionId: "pty-a",
    terminal: localTerminal("pty-a"),
    socket: { id: "A" },
    send,
    config: {},
  });
  await waitForFrame(send, "agent.done", 1);
  agent.start({
    requestId: "r2",
    question: "终端 B 的问题",
    sessionId: "pty-b",
    terminal: { id: "pty-b", kind: "remote", shell: "ssh x@y", hostName: "prod", hostAddr: "10.0.0.9" },
    socket: { id: "B" },
    send,
    config: {},
  });
  await waitForFrame(send, "agent.done", 2);
  const starts = send.ofType("agent.start");
  assert.notEqual(starts[0].sessionId, starts[1].sessionId);
  const joined = fn.calls[1].messages.map((message) => message.content).join("\n");
  assert.equal(joined.includes("终端 A 的问题"), false, "B 终端的新会话不该看到 A 的问题");
  const remote = await store.getSession(starts[1].sessionId);
  assert.equal(remote.terminalKind, "remote");
  assert.equal(remote.hostName, "prod");
  assert.equal(remote.hostAddr, "10.0.0.9");
});

test("AC12：停止后会话标「已停止」，已跑完的输出保留", async () => {
  const store = await tempStore();
  const send = makeSend();
  const fn = async (args) => {
    await args.tools.run_command.execute({ command: "ls", why: "看目录" }, { toolCallId: "c1" });
    await sleep(300);
    return { text: "late" };
  };
  const agent = createAgentRunner({
    log: () => {},
    runner: fakeRunner(),
    sessions: store,
    generateText: fn,
    judgeFn: autoJudge,
  });
  const task = agent.start({
    requestId: "r1",
    question: "跑一下",
    sessionId: "pty-1",
    terminal: localTerminal("pty-1"),
    socket: SOCKET,
    send,
    config: {},
  });
  await waitForFrame(send, "agent.start");
  await waitForFrame(send, "agent.step");
  task.stop({ reason: "user" });
  await waitForFrame(send, "agent.done");
  const aiSessionId = send.first("agent.start").sessionId;
  // 停止后的落盘走串行链（不阻塞 done 帧），所以这里等它落地而不是死等一次。
  const settled = await waitUntil(async () => {
    await store.flush();
    const current = await store.getSession(aiSessionId);
    return current && current.status === "stopped";
  }, 3000);
  await store.flush();
  const stored = await store.getSession(aiSessionId);
  assert.equal(settled, true, `会话应在 3s 内标成 stopped，实际 status=${stored && stored.status}`);
  assert.equal(stored.status, "stopped");
  assert.equal(stored.steps.length, 1, "已跑完的那一步要留着");
  assert.equal(stored.steps[0].status, "done");
  assert.equal(stored.steps[0].output, "a.txt b.txt");
});

test("§5.2：buildHistoryMessages 把历史转成 user/assistant，工具结果压成 ≤800 字符摘要", () => {
  const long = "x".repeat(2000);
  const summary = summarizeStepForHistory({ command: "ls", status: "done", output: long });
  assert.ok(summary.includes("输出已截断"));
  assert.ok(summary.length <= HISTORY_STEP_OUTPUT_MAX + 200);
  assert.equal(summarizeStepForHistory({ command: "", output: "x" }), "", "没命令的步骤不进历史");

  const messages = buildHistoryMessages({
    messages: [
      { role: "user", text: "第一问", round: 1, at: 1, reasoning: null },
      { role: "assistant", text: "第一答", round: 1, at: 2, reasoning: null },
      { role: "user", text: "第二问", round: 2, at: 3, reasoning: null },
    ],
    steps: [
      { stepId: "a", command: "ls", status: "done", output: "a.txt", round: 1 },
      { stepId: "b", command: "pwd", status: "done", output: "/tmp", round: 1 },
    ],
  });
  assert.deepEqual(
    messages.map((item) => item.role),
    ["user", "assistant", "user"],
    "工具摘要贴在本轮用户问题后面（相邻同角色合并成一条），然后是助手结论",
  );
  assert.ok(messages[0].content.includes("第一问"));
  assert.ok(messages[0].content.includes("$ ls"), "工具摘要必须进历史");
  assert.ok(messages[0].content.includes("$ pwd"));
  assert.equal(messages[1].content, "第一答");
  assert.equal(messages[2].content, "第二问");
});

test("§5.2：会话落盘失败不影响本轮执行（记 AI_SESSION_*_FAILED 日志）", async () => {
  const broken = {
    getSession: async () => null,
    findByTerminal: async () => null,
    createSession: async () => ({ id: "s-broken", title: "" }),
    appendMessage: async () => {
      throw new Error("disk full");
    },
    upsertStep: async () => {
      throw new Error("disk full");
    },
    setStatus: async () => {
      throw new Error("disk full");
    },
    markBusy: () => {},
    flush: async () => {},
  };
  const send = makeSend();
  const logs = [];
  const agent = createAgentRunner({
    log: (line) => logs.push(line),
    runner: fakeRunner(),
    sessions: broken,
    generateText: scriptedGenerateText([{ command: "ls" }]),
    judgeFn: autoJudge,
  });
  agent.start({
    requestId: "r1",
    question: "看目录",
    sessionId: "pty-1",
    terminal: localTerminal("pty-1"),
    socket: SOCKET,
    send,
    config: {},
  });
  await waitForFrame(send, "agent.done");
  assert.equal(send.ofType("agent.done").length, 1, "落盘失败也不能让任务崩");
  assert.ok(logs.some((line) => line.code === "AI_SESSION_APPEND_FAILED"));
});

test("AC13：extractReasoning 从 steps 里捞 reasoningText（供思考块）", () => {
  assert.equal(extractReasoning(null), "");
  assert.equal(
    extractReasoning({ steps: [{ reasoningText: "先 ls 看看" }, { reasoningText: "再 df -h" }] }),
    "先 ls 看看\n\n再 df -h",
  );
  assert.equal(extractReasoning({ steps: [{ reasoning: [{ text: "A" }, { text: "B" }] }] }), "A\nB");
});

test("§5.2：agent.* 出站帧都带 sessionId（前端靠它区分）", async () => {
  const store = await tempStore();
  const send = makeSend();
  const agent = createAgentRunner({
    log: () => {},
    runner: fakeRunner(),
    sessions: store,
    generateText: scriptedGenerateText([{ command: "mkdir testdir" }]),
    judgeFn: (input) =>
      realJudge({
        ...input,
        review: async () => ({ risk: "caution", effect: "x", confirmWhy: "y", reversible: false, model: "m" }),
      }),
  });
  agent.start({
    requestId: "r1",
    question: "看看",
    sessionId: "pty-1",
    terminal: localTerminal("pty-1"),
    socket: SOCKET,
    send,
    config: { autonomy: "balanced" },
  });
  await waitForFrame(send, "agent.approval");
  const approval = send.first("agent.approval");
  assert.ok(approval, "需要一个 agent.approval 帧");
  assert.equal(approval.risk, "caution");
  assert.equal(approval.effect, "x");
  assert.equal(approval.confirmWhy, "y");
  assert.equal(approval.reversible, false);
  agent.resolveApproval({ approvalId: approval.approvalId, approved: false });
  await waitForFrame(send, "agent.done");
  const aiSessionId = send.first("agent.start").sessionId;
  for (const type of ["agent.start", "agent.step", "agent.approval", "agent.done"]) {
    const frame = send.first(type);
    assert.ok(frame, `缺少 ${type} 帧`);
    assert.equal(frame.sessionId, aiSessionId, `${type} 必须带 sessionId`);
  }
});
