// TASK-FIX17-J R5 / AC8：审阅中状态（agent.review 帧）+ 卡片上的 justification。
//
// 60 秒的审阅如果前端什么都不显示，用户只会以为卡死。所以：
//   * agent.mjs 在调 judge 前后各发一个 agent.review 帧（start / done(ms)）；
//   * agent-store.js 把 start 记成 { stepId, since }，done 清掉；
//   * ai-drawer.js 画一行灰色「正在审阅这条命令…（最多 60 秒）」，60 秒是后端的常量，
//     前端不重复一遍数字（重复就会漂移）。
//
// 真浏览器的端到端断言在 scripts/probe-review-context.mjs（这里不做 DOM）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import createAgentStore, { draftKey } from "../../app/core/agent-store.js";
import { createAgentRunner } from "../../src/ai/agent.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const DRAWER_JS = await readFile(path.join(REPO, "app", "ui", "ai-drawer.js"), "utf8");
const COMPONENTS_CSS = await readFile(path.join(REPO, "app", "styles", "components.css"), "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- 夹具 */

function makeSend() {
  const frames = [];
  const send = (frame) => frames.push(frame);
  send.frames = frames;
  send.ofType = (type) => frames.filter((frame) => frame.type === type);
  return send;
}

/** 假命令执行器（不碰 PTY）。 */
function fakeRunner() {
  return {
    async run() {
      return { ok: true, exitCode: 0, output: "ok", truncated: false, durationMs: 1 };
    },
    async probe() {
      return true;
    },
    dispose() {},
  };
}

/** 假 generateText：依次调用 run_command，最后给一句话。 */
function scriptedGenerateText(plan) {
  return async (args) => {
    for (const command of plan) {
      await args.tools.run_command.execute({ command, why: "测试用理由" }, { toolCallId: `call_${command}` });
    }
    return { text: "都跑完了。", steps: [] };
  };
}

/** 慢一点的判级：让 start / done 之间有可观察的间隔。 */
function slowJudge(verdict) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    await sleep(20);
    return verdict;
  };
  fn.calls = calls;
  return fn;
}

/* ---------------------------------------------------------------- 帧序列 */

test("AC8：每条命令都是 agent.review(start) → agent.step → agent.review(done)，且 stepId 对得上", async () => {
  const send = makeSend();
  const judgeFn = slowJudge({
    decision: "auto",
    reason: "AI 审阅：你可能想这么做",
    hit: null,
    risk: "caution",
    effect: "会删掉一个文件",
    confirmWhy: "删了就没了",
    reversible: false,
    reviewModel: "review/model",
    aligned: true,
    justification: "你说过 tmp-note.txt 是建错的",
  });
  const agent = createAgentRunner({
    log: () => {},
    runner: fakeRunner(),
    generateText: scriptedGenerateText(["rm tmp-note.txt", "rmdir empty-dir"]),
    judgeFn,
  });

  const task = agent.start({
    requestId: "r-j1",
    question: "把建错的东西删掉",
    sessionId: "s-j1",
    socket: { marker: "sock" },
    send,
    config: { autonomy: "balanced", allowlist: [], reviewModel: "review/model" },
  });
  await sleep(150);
  task.stop({ reason: "test" });

  const reviews = send.ofType("agent.review");
  const stepIds = [...new Set(send.ofType("agent.step").map((frame) => frame.stepId))];
  assert.equal(stepIds.length, 2, `两步应该各有一个 stepId，实际 ${stepIds.length}`);
  assert.equal(reviews.length, 4, `两步应该有 4 个 review 帧，实际 ${reviews.length}`);

  for (const [index, stepId] of stepIds.entries()) {
    const start = reviews[index * 2];
    const done = reviews[index * 2 + 1];
    assert.equal(start.state, "start", `第 ${index + 1} 步的第一个帧必须是 start`);
    assert.equal(done.state, "done", `第 ${index + 1} 步的第二个帧必须是 done`);
    assert.equal(start.stepId, stepId, "review 帧必须认领同一步");
    assert.equal(done.stepId, stepId);
    assert.equal(typeof done.ms, "number", "done 帧必须带耗时（ms）");
    assert.ok(done.ms >= 0);
  }

  // start 必须在对应的 step 帧之前（否则用户看不到「正在审阅」）。
  const order = send.frames.map((frame) => frame.type);
  const firstStart = order.indexOf("agent.review");
  const firstStep = order.indexOf("agent.step");
  assert.ok(firstStart !== -1 && firstStart < firstStep, `review.start 必须在 step 之前：${order.join(",")}`);

  // 判级真的拿到了上下文（不是只有命令）。
  assert.equal(judgeFn.calls.length, 2);
  assert.equal(judgeFn.calls[0].shell, "（未知）");
  assert.ok(Array.isArray(judgeFn.calls[0].history));
});

test("AC8：agent.approval 帧带 justification（没有就是 null）", async () => {
  const send = makeSend();
  const agent = createAgentRunner({
    log: () => {},
    runner: fakeRunner(),
    generateText: scriptedGenerateText(["git push --force origin main"]),
    judgeFn: slowJudge({
      decision: "confirm",
      reason: "AI 审阅：你没说要推",
      hit: null,
      risk: "caution",
      effect: "会覆盖远端历史",
      confirmWhy: "推上去就不好撤",
      reversible: false,
      reviewModel: "review/model",
      aligned: false,
      justification: "你只说了看看状态",
    }),
  });
  const task = agent.start({
    requestId: "r-j2",
    question: "看看状态",
    sessionId: "s-j2",
    socket: { marker: "sock" },
    send,
    config: { autonomy: "balanced", reviewModel: "review/model" },
  });
  await sleep(80);
  task.stop({ reason: "test" });

  const approval = send.ofType("agent.approval")[0];
  assert.ok(approval, "必须发出确认卡");
  assert.equal(approval.justification, "你只说了看看状态");
  assert.equal(approval.risk, "caution");
});

test("R5：判级抛错时 done 帧仍然发（不会永远显示「正在审阅」）", async () => {
  const send = makeSend();
  const agent = createAgentRunner({
    log: () => {},
    runner: fakeRunner(),
    generateText: scriptedGenerateText(["ls -la"]),
    judgeFn: async () => {
      throw new Error("boom");
    },
  });
  const task = agent.start({
    requestId: "r-j3",
    question: "看看",
    sessionId: "s-j3",
    socket: { marker: "sock" },
    send,
    config: { autonomy: "balanced" },
  });
  await sleep(60);
  task.stop({ reason: "test" });

  const reviews = send.ofType("agent.review");
  assert.equal(reviews.length, 2, `必须 start + done 各一个，实际 ${reviews.length}`);
  assert.equal(reviews[0].state, "start");
  assert.equal(reviews[1].state, "done");
});

test("R5：scope=rest 不许绕过灾难级（autoRest 用 catastrophicReason 判）", async () => {
  const send = makeSend();
  const agent = createAgentRunner({
    log: () => {},
    runner: fakeRunner(),
    // 先跑一条普通命令让用户点「剩下的都自动执行」，再让模型要跑灾难级。
    generateText: scriptedGenerateText(["npm run build", "rm -rf /"]),
    judgeFn: async ({ command }) => ({
      decision: command === "npm run build" ? "confirm" : "confirm",
      reason: "需要确认",
      hit: null,
      risk: "caution",
      effect: null,
      confirmWhy: null,
      reversible: true,
      reviewModel: null,
      aligned: null,
      justification: null,
    }),
  });
  const task = agent.start({
    requestId: "r-j4",
    question: "构建完清掉",
    sessionId: "s-j4",
    socket: { marker: "sock" },
    send,
    config: { autonomy: "balanced" },
  });
  await sleep(30);
  // 第一张卡点「剩下的都自动执行」。
  const first = send.ofType("agent.approval")[0];
  assert.ok(first, "第一条要先出确认卡");
  agent.resolveApproval({ approvalId: first.approvalId, approved: true, scope: "rest" });
  await sleep(80);
  task.stop({ reason: "test" });

  const approvals = send.ofType("agent.approval");
  assert.equal(approvals.length, 2, "rest 之后的灾难级命令仍然要出卡（不许被 autoRest 直接跑掉）");
  assert.equal(approvals[1].command, "rm -rf /");
});

/* ---------------------------------------------------------------- store */

function makeStoreWithSession() {
  const store = createAgentStore();
  const key = store.focusTerminal("pty-j", { terminalKind: "local", shell: "bash" });
  assert.equal(key, draftKey("pty-j"));
  store.onStart({ requestId: "r-s1", taskId: "t-s1", sessionId: "s-s1", round: 1, model: "m/x" });
  return store;
}

test("AC8/store：agent.review start 记 reviewing，done 清掉", () => {
  const store = makeStoreWithSession();
  assert.equal(store.getSnapshot().reviewing, null, "刚开始没有审阅中状态");

  store.onReview({ type: "agent.review", requestId: "r-s1", taskId: "t-s1", stepId: "s-1", state: "start" });
  const reviewing = store.getSnapshot().reviewing;
  assert.ok(reviewing, "start 之后必须有 reviewing");
  assert.equal(reviewing.stepId, "s-1");
  assert.equal(typeof reviewing.since, "number");

  store.onReview({ type: "agent.review", requestId: "r-s1", taskId: "t-s1", stepId: "s-1", state: "done", ms: 1234 });
  assert.equal(store.getSnapshot().reviewing, null, "done 之后必须清掉");
});

test("AC8/store：done 帧之后 agent.done / agent.error 也不许留下「正在审阅」", () => {
  const store = makeStoreWithSession();
  store.onReview({ type: "agent.review", requestId: "r-s1", taskId: "t-s1", stepId: "s-1", state: "start" });
  store.onDone({ type: "agent.done", requestId: "r-s1", taskId: "t-s1", text: "完了", stopped: false, durationMs: 1 });
  assert.equal(store.getSnapshot().reviewing, null);
});

test("AC8/store：agent.approval 的 justification 原样进状态（空 / 非字符串给 null）", () => {
  const store = makeStoreWithSession();
  store.onApproval({
    type: "agent.approval",
    requestId: "r-s1",
    taskId: "t-s1",
    stepId: "s-1",
    approvalId: "a-1",
    command: "rm tmp-note.txt",
    why: "你说删掉",
    risk: "caution",
    justification: "你在第 1 轮说这个文件是建错的",
  });
  assert.equal(store.getSnapshot().pendingApprovals[0].justification, "你在第 1 轮说这个文件是建错的");

  store.onApproval({
    type: "agent.approval",
    requestId: "r-s1",
    taskId: "t-s1",
    stepId: "s-2",
    approvalId: "a-2",
    command: "ls",
    why: "",
    risk: null,
    justification: "",
  });
  assert.equal(store.getSnapshot().pendingApprovals[1].justification, null);
});

test("AC8/store：别的任务的 review 帧不许改当前状态（作用域隔离）", () => {
  const store = makeStoreWithSession();
  store.onReview({ type: "agent.review", requestId: "r-别的", taskId: "t-别的", stepId: "s-x", state: "start" });
  assert.equal(store.getSnapshot().reviewing, null);
});

/* ---------------------------------------------------------------- 静态契约 */

test("AC8/UI：抽屉里有「正在审阅这条命令…（最多 60 秒）」一行，且带 data-role", () => {
  assert.ok(DRAWER_JS.includes("正在审阅这条命令…（最多 60 秒）"), "文案必须在");
  assert.ok(DRAWER_JS.includes('"data-role": "agent-reviewing"'), "必须有 data-role=agent-reviewing");
  assert.ok(DRAWER_JS.includes('"data-role": "approval-justification"'), "卡片必须有 justification 一行");
  assert.ok(DRAWER_JS.includes("审阅判断："), "卡片要标出这是审阅判断");
});

test("AC8/UI：reviewing 行只在 review 进行时出现（不是一直挂着）", () => {
  // 渲染分支必须由 reviewing.stepId 控制：命中当前 step 才画 / 没命中 step 才画在末尾。
  assert.ok(
    /reviewingStepId\(snapshot\) === step\.stepId/.test(DRAWER_JS),
    "命中当前 step 时才画在 step 里",
  );
  assert.ok(DRAWER_JS.includes('if (approval.justification)'), "没有 justification 不许画空行");
});

test("AC10/CSS：新增规则只用颜色令牌，不许出现颜色字面量", () => {
  const block = COMPONENTS_CSS.slice(
    COMPONENTS_CSS.indexOf(".agent-reviewing"),
    COMPONENTS_CSS.indexOf(".approval-justification b"),
  );
  assert.ok(block.length > 0, "新增的 CSS 段必须存在");
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(block), false, "不许出现十六进制颜色字面量");
  assert.equal(/rgba?\(/.test(block), false, "不许出现 rgb / rgba 字面量（只用 --term-* 令牌）");
  assert.ok(/var\(--term-muted\)/.test(block), "颜色必须用 --term-* 令牌");
});
