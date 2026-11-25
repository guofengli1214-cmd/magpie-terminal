// 标签短名（TASK-V4-F 遗留小修，V4-H §8 附带修）与 AI 会话前端 store 的行为锁。
//
// 这两块都不碰 DOM：tab-bar 的 shellShortName 是纯函数，
// agent-store 是纯状态机（Map + 订阅，不读 document）。

import test from "node:test";
import assert from "node:assert/strict";
import { shellShortName } from "../../app/ui/tab-bar.js";
import createAgentStore, { draftKey } from "../../app/core/agent-store.js";

// ---------------------------------------------------------------- titleFor

test("PowerShell 5 与 PowerShell 7 必须能区分（以前都是 PowerShell）", () => {
  const five = shellShortName("PowerShell 5");
  const seven = shellShortName("PowerShell 7");
  assert.notEqual(five, seven, `PS5=${five} PS7=${seven} 必须不同`);
  assert.match(five, /5|PS5/);
  assert.match(seven, /7|PS7/);
});

test("带完整版本号的 shell 名也能区分", () => {
  assert.equal(shellShortName("PowerShell 5 5.1.22621.6133"), "PS5");
  assert.equal(shellShortName("PowerShell 7 7.7.0"), "PS7");
});

test("bash 保持 bash（含 git bash 的版本号尾巴）", () => {
  assert.equal(shellShortName("bash"), "bash");
  assert.equal(shellShortName("bash 5.2.37"), "bash");
  assert.equal(shellShortName("Bash 5.2"), "bash");
});

test("其它 shell 不做猜测：带版本的去版本号，不带的原样", () => {
  assert.equal(shellShortName("zsh 5.9"), "zsh");
  assert.equal(shellShortName("fish"), "fish");
  assert.equal(shellShortName("pwsh 7"), "pwsh");
});

test("空 / 非字符串回落 shell", () => {
  assert.equal(shellShortName(""), "shell");
  assert.equal(shellShortName(null), "shell");
  assert.equal(shellShortName(undefined), "shell");
});

// ---------------------------------------------------------------- agent-store

function makeStore() {
  const store = createAgentStore();
  const seen = [];
  store.subscribe((snapshot) => seen.push(snapshot));
  return { store, seen };
}

function local(store, terminalId) {
  return store.focusTerminal(terminalId, { terminalKind: "local", shell: "bash 5.2.37" });
}

test("focusTerminal：没有会话时给一个草稿（key 前缀 draft:）", () => {
  const { store } = makeStore();
  const key = local(store, "pty-a");
  assert.equal(key, draftKey("pty-a"));
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.currentSessionId, key);
  assert.equal(snapshot.currentTerminalId, "pty-a");
  assert.equal(snapshot.turns.length, 0);
  assert.equal(snapshot.status, "idle");
});

test("setSessionsList：草稿就地并到该终端最近的已落会话（刷新后能看到历史）", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.setSessionsList([
    { id: "s-1", terminalId: "pty-a", terminalKind: "local", shell: "bash 5.2.37", title: "旧会话", messageCount: 4 },
  ]);
  assert.equal(store.getSnapshot().currentSessionId, "s-1");
});

test("focusTerminal：切终端 → 会话跟着切；切回来还是原来那个", () => {
  const { store } = makeStore();
  const a = local(store, "pty-a");
  const b = local(store, "pty-b");
  assert.notEqual(a, b);
  assert.equal(store.getSnapshot().currentSessionId, b);
  local(store, "pty-a");
  assert.equal(store.getSnapshot().currentSessionId, a);
});

test("两轮：beginRun 开新轮，agent.step 落在最新一轮，agent.done 写总结", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "r1", question: "第一问" });
  store.onStart({ requestId: "r1", taskId: "t1", sessionId: "s-real", round: 1 });
  assert.equal(store.getSnapshot().currentSessionId, "s-real", "草稿升级成真实 id");
  store.onStep({
    requestId: "r1",
    taskId: "t1",
    sessionId: "s-real",
    stepId: "st1",
    index: 1,
    kind: "command",
    status: "done",
    command: "ls",
    output: "a.txt",
    exitCode: 0,
    durationMs: 12,
  });
  store.onDone({ requestId: "r1", taskId: "t1", sessionId: "s-real", text: "第一答", steps: 1, stopped: false });

  const first = store.getSnapshot();
  assert.equal(first.turns.length, 1);
  assert.equal(first.turns[0].question, "第一问");
  assert.equal(first.turns[0].summary, "第一答");
  assert.equal(first.turns[0].steps.length, 1);
  assert.equal(first.status, "done");

  store.beginRun({ requestId: "r2", question: "第二问" });
  store.onStart({ requestId: "r2", taskId: "t2", sessionId: "s-real", round: 2 });
  store.onDone({ requestId: "r2", taskId: "t2", sessionId: "s-real", text: "第二答", steps: 0, stopped: false });
  const second = store.getSnapshot();
  assert.equal(second.turns.length, 2, "第二轮不能把第一轮吃掉");
  assert.equal(second.turns[0].summary, "第一答");
  assert.equal(second.turns[1].summary, "第二答");
});

test("onApproval：审阅四字段（risk / effect / confirmWhy / reversible）进 pendingApprovals", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "r1", question: "q" });
  store.onStart({ requestId: "r1", taskId: "t1", sessionId: "s-1", round: 1 });
  store.onStep({
    requestId: "r1",
    taskId: "t1",
    sessionId: "s-1",
    stepId: "st1",
    index: 1,
    kind: "command",
    status: "awaiting",
    command: "mkdir a",
  });
  store.onApproval({
    requestId: "r1",
    taskId: "t1",
    sessionId: "s-1",
    stepId: "st1",
    approvalId: "a1",
    command: "mkdir a",
    why: "建目录",
    risk: "caution",
    effect: "会新建一个空目录 a",
    confirmWhy: "写盘操作，要你点头",
    reversible: true,
    reviewModel: "m/x",
  });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.pendingApprovals.length, 1);
  const item = snapshot.pendingApprovals[0];
  assert.equal(item.risk, "caution");
  assert.equal(item.effect, "会新建一个空目录 a");
  assert.equal(item.confirmWhy, "写盘操作，要你点头");
  assert.equal(item.reversible, true);
  assert.equal(snapshot.status, "awaiting");
});

test("onApproval：risk=null（审阅不可用）也保留，前端据此画灰色角标", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "r1", question: "q" });
  store.onStart({ requestId: "r1", taskId: "t1", sessionId: "s-1", round: 1 });
  store.onApproval({
    requestId: "r1",
    taskId: "t1",
    sessionId: "s-1",
    stepId: "st1",
    approvalId: "a1",
    command: "rm x",
    risk: null,
    effect: null,
    confirmWhy: null,
    reversible: null,
  });
  const item = store.getSnapshot().pendingApprovals[0];
  assert.equal(item.risk, null);
  assert.equal(item.effect, null);
  assert.equal(item.confirmWhy, null);
  assert.equal(item.reversible, null);
});

test("跨会话的待确认在快照里是并集（把手角标要看到别的标签），但 sessionPending 只有当前会话", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "ra", question: "a" });
  store.onStart({ requestId: "ra", taskId: "ta", sessionId: "s-a", round: 1 });
  store.onApproval({
    requestId: "ra",
    taskId: "ta",
    sessionId: "s-a",
    stepId: "sta",
    approvalId: "apa",
    command: "mkdir a",
    risk: "caution",
  });
  // 切到终端 B（另一个会话），A 的待确认仍在并集里。
  local(store, "pty-b");
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.pendingApprovals.length, 1, "并集要包含别的会话的待确认");
  assert.equal(snapshot.sessionPending.length, 0, "当前会话自己没有待确认");
});

test("onText / onReasoning 落到最新一轮（AC13 / AC5）", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "r1", question: "q" });
  store.onStart({ requestId: "r1", taskId: "t1", sessionId: "s-1", round: 1 });
  store.onText({ requestId: "r1", taskId: "t1", sessionId: "s-1", text: "最大" });
  store.onText({ requestId: "r1", taskId: "t1", sessionId: "s-1", text: "的是 a.txt" });
  store.onReasoning({ requestId: "r1", taskId: "t1", sessionId: "s-1", text: "先 ls" });
  const turn = store.getSnapshot().turns[0];
  assert.equal(turn.streamText, "最大的是 a.txt");
  assert.equal(turn.reasoning, "先 ls");
});

test("markStopped：清待确认但保留步骤，状态变 stopped（AC12）", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "r1", question: "q" });
  store.onStart({ requestId: "r1", taskId: "t1", sessionId: "s-1", round: 1 });
  store.onStep({
    requestId: "r1",
    taskId: "t1",
    sessionId: "s-1",
    stepId: "st1",
    index: 1,
    kind: "command",
    status: "done",
    command: "ls",
    output: "a.txt",
  });
  store.onApproval({
    requestId: "r1",
    taskId: "t1",
    sessionId: "s-1",
    stepId: "st2",
    approvalId: "a2",
    command: "rm x",
    risk: "danger",
  });
  store.markStopped();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, "stopped");
  assert.equal(snapshot.pendingApprovals.length, 0);
  assert.equal(snapshot.turns[0].steps.length, 1, "已跑完的步骤要留着");
});

test("restoreSession：从服务端全文还原多轮时间线（AC2 / AC3 切回）", () => {
  const { store } = makeStore();
  store.restoreSession("s-restore", {
    id: "s-restore",
    title: "修复 PTY 尺寸同步",
    terminalId: "pty-a",
    terminalKind: "local",
    shell: "bash 5.2.37",
    status: "open",
    messages: [
      { role: "user", text: "第一问", round: 1 },
      { role: "assistant", text: "第一答", reasoning: "想了一下", round: 1 },
      { role: "user", text: "第二问", round: 2 },
    ],
    steps: [
      { stepId: "x1", command: "ls", status: "done", output: "a.txt", round: 1 },
      { stepId: "x2", command: "pwd", status: "done", output: "/tmp", round: 2 },
    ],
  });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].question, "第一问");
  assert.equal(snapshot.turns[0].summary, "第一答");
  assert.equal(snapshot.turns[0].reasoning, "想了一下");
  assert.equal(snapshot.turns[0].steps.length, 1);
  assert.equal(snapshot.turns[1].steps[0].command, "pwd");
  assert.equal(snapshot.currentSessionId, "s-restore");
});

test("作用域隔离：别的 requestId 的帧被丢弃，不动当前会话", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "cur", question: "q" });
  store.onStart({ requestId: "cur", taskId: "tc", sessionId: "s-1", round: 1 });
  const applied = store.onStep({
    requestId: "other",
    taskId: "to",
    sessionId: "s-1",
    stepId: "st-other",
    index: 1,
    kind: "command",
    status: "done",
    command: "ls",
  });
  assert.equal(applied, null);
  assert.equal(store.getSnapshot().turns[0].steps.length, 0);
});

test("newDraft：再点「新会话」不覆盖当前会话的历史", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "r1", question: "旧问题" });
  store.onStart({ requestId: "r1", taskId: "t1", sessionId: "s-old", round: 1 });
  store.onDone({ requestId: "r1", taskId: "t1", sessionId: "s-old", text: "旧回答", steps: 0, stopped: false });
  store.newDraft("pty-a", { terminalKind: "local", shell: "bash 5.2.37" });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.turns.length, 0, "新草稿是空的");
  assert.notEqual(snapshot.currentSessionId, "s-old");
  // 旧会话还在 store 里（切回去还能看到）。
  store.selectSession("s-old");
  assert.equal(store.getSnapshot().turns.length, 1);
  assert.equal(store.getSnapshot().turns[0].summary, "旧回答");
});

// ---------------------------------------------------------------- TASK-FIX17-H R3
//
// approval 帧新增 reviewReason / reviewHit：risk=null 时前端靠它们说人话，
// 不再把「因为命令含重定向所以没送审」冒充成「审阅服务坏了」。

test("onApproval：reviewReason / reviewHit 进 pendingApprovals", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "r1", question: "q" });
  store.onStart({ requestId: "r1", taskId: "t1", sessionId: "s-1", round: 1 });
  store.onApproval({
    requestId: "r1",
    taskId: "t1",
    sessionId: "s-1",
    stepId: "st1",
    approvalId: "a1",
    command: "ls > out.txt",
    risk: null,
    reviewReason: "命令含输出重定向，可能写文件",
    reviewHit: "redirect",
  });
  const item = store.getSnapshot().pendingApprovals[0];
  assert.equal(item.reviewReason, "命令含输出重定向，可能写文件");
  assert.equal(item.reviewHit, "redirect");
  // 老字段语义一个都不许变。
  assert.equal(item.risk, null);
  assert.equal(item.command, "ls > out.txt");
});

test("onApproval：非字符串 / 空串的 reviewReason → null（前端回落到原文案）", () => {
  const { store } = makeStore();
  local(store, "pty-a");
  store.beginRun({ requestId: "r1", question: "q" });
  store.onStart({ requestId: "r1", taskId: "t1", sessionId: "s-1", round: 1 });
  store.onApproval({
    requestId: "r1",
    taskId: "t1",
    sessionId: "s-1",
    stepId: "st1",
    approvalId: "a1",
    command: "rm x",
    risk: null,
    reviewReason: 42,
    reviewHit: "",
  });
  const item = store.getSnapshot().pendingApprovals[0];
  assert.equal(item.reviewReason, null);
  assert.equal(item.reviewHit, null);
});
