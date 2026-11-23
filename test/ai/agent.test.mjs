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
