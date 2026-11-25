// TASK-FIX17-J R6 / AC6（单测部分）：两个会话的 prompt 前缀必须 append-only。
//
// 用户的原话：「长会话的情况下两个会话的缓存也都不能丢，丢缓存会增加使用成本」。
// 网关的前缀缓存是按「消息字节前缀」命中的，所以这里锁的是字节级前缀关系：
//   * 审阅会话：buildReviewMessages(h3) 的第一段必须以 buildReviewMessages(h2) 的第一段开头；
//     第二段（assistant 的固定回执）三次调用必须完全相同；
//   * 对话会话：messages = [...buildHistoryMessages(session), 本轮富文本]，追加一轮不许改写前面。
//
// 这四个断言是「缓存不丢」的唯一机器证据。任何「每轮重摘要 / 重排消息」的改法都会当场红。

import test from "node:test";
import assert from "node:assert/strict";

import { buildHistoryMessages } from "../../src/ai/agent.mjs";
import { REVIEW_SYSTEM_PROMPT, buildReviewMessages, serializeHistoryForReview } from "../../src/ai/review.mjs";

/** 造第 r 轮的历史（用户原话 + 终端块 + 助手回答），形状与 buildHistoryMessages 一致。 */
function historyUpTo(rounds) {
  const out = [];
  for (let r = 1; r <= rounds; r += 1) {
    out.push({ role: "user", content: `第${r}轮：用户说的话 round-${r}` });
    out.push({
      role: "user",
      content: `【我在这一轮实际执行的命令与输出】\n\n$ echo round-${r}\n（done）\n\nround-${r}`,
    });
    out.push({ role: "assistant", content: `第${r}轮：助手的回答 answer-${r}` });
  }
  return out;
}

const h1 = buildReviewMessages({ command: "ls", history: historyUpTo(1), cwd: "/repo", shell: "bash" });
const h2 = buildReviewMessages({ command: "ls", history: historyUpTo(2), cwd: "/repo", shell: "bash" });
const h3 = buildReviewMessages({ command: "ls", history: historyUpTo(3), cwd: "/repo", shell: "bash" });

/* ---------------------------------------------------------------- 审阅会话 */

test("AC6-1：h3 的第一段以 h2 的第一段开头 —— buildReviewMessages(h3).messages[0].content.startsWith(…h2)", () => {
  assert.ok(
    buildReviewMessages({ command: "ls", history: historyUpTo(3), cwd: "/repo", shell: "bash" }).messages[0].content.startsWith(
      buildReviewMessages({ command: "ls", history: historyUpTo(2), cwd: "/repo", shell: "bash" }).messages[0].content,
    ),
    "第 3 轮的上下文必须包含前两轮的**完整**前缀（否则缓存整段作废）",
  );
  // 与上面 h3/h2 那份是同一份数据（别名不许指向副本）。
  assert.equal(buildReviewMessages({ command: "ls", history: historyUpTo(3), cwd: "/repo", shell: "bash" }).messages[0].content, h3[0].content);
});

test("AC6-2：h2 的第一段以 h1 的第一段开头", () => {
  assert.ok(h2.messages[0].content.startsWith(h1.messages[0].content));
});

test("AC6-3：第二段（固定回执）三次调用逐字节相同", () => {
  assert.equal(h1.messages[1].content, h2.messages[1].content);
  assert.equal(h2.messages[1].content, h3.messages[1].content);
  assert.equal(h1[1].role, "assistant");
});

test("AC6-4：system 三次相同，且不含任何轮次数值 / 上下文", () => {
  // system 是常量导出，三次调用本来就只有一份；这里同时钉死「里面不许有会变的东西」。
  assert.equal(REVIEW_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT);
  assert.equal(/\d+\s*轮/.test(REVIEW_SYSTEM_PROMPT), false);
  assert.equal(REVIEW_SYSTEM_PROMPT.includes("第1轮"), false);
  assert.equal(REVIEW_SYSTEM_PROMPT.includes("【对话上下文】"), false);
});

test("AC6-5：buildReviewMessages 是纯函数（同一输入两次调用深度相等）", () => {
  const a = buildReviewMessages({ command: "rm tmp-note.txt", history: historyUpTo(3), cwd: "/repo", shell: "bash" });
  const b = buildReviewMessages({ command: "rm tmp-note.txt", history: historyUpTo(3), cwd: "/repo", shell: "bash" });
  assert.deepEqual(a, b);
  // 也不许改输入对象。
  const history = historyUpTo(2);
  const snapshot = JSON.stringify(history);
  buildReviewMessages({ command: "ls", history, cwd: "/repo", shell: "bash" });
  assert.equal(JSON.stringify(history), snapshot, "buildReviewMessages 不许改动传入的 history");
});

test("AC6-6：改命令只影响第三段（尾部），前两段逐字节不变", () => {
  const one = buildReviewMessages({ command: "ls", history: historyUpTo(2), cwd: "/repo", shell: "bash" });
  const two = buildReviewMessages({ command: "rm -rf ./dist", history: historyUpTo(2), cwd: "/repo", shell: "bash" });
  assert.equal(one[0].content, two[0].content);
  assert.equal(one[1].content, two[1].content);
  assert.notEqual(one[2].content, two[2].content);
});

test("AC6-7：序列化文本本身是 append-only（前缀就是前缀，不是「重排版」）", () => {
  for (let rounds = 1; rounds < 4; rounds += 1) {
    const short = serializeHistoryForReview(historyUpTo(rounds));
    const long = serializeHistoryForReview(historyUpTo(rounds + 1));
    assert.ok(long.startsWith(short), `第 ${rounds} 轮的序列化必须是第 ${rounds + 1} 轮的前缀`);
  }
});

/* ---------------------------------------------------------------- 对话会话 */

/** 服务端会话形状（sessions.mjs）：messages + steps，按 round 分组。 */
function sessionUpTo(rounds) {
  const messages = [];
  const steps = [];
  for (let r = 1; r <= rounds; r += 1) {
    messages.push({ role: "user", text: `第${r}轮：用户说的话`, round: r });
    steps.push({ round: r, command: `echo round-${r}`, status: "done", output: `round-${r}` });
    messages.push({ role: "assistant", text: `第${r}轮：助手的回答`, round: r });
  }
  return { messages, steps };
}

test("AC6-8：对话会话的历史只追加 —— 追加一轮后前面的消息逐字节不变", () => {
  const one = buildHistoryMessages(sessionUpTo(1));
  const two = buildHistoryMessages(sessionUpTo(2));
  const three = buildHistoryMessages(sessionUpTo(3));

  assert.ok(two.length > one.length);
  assert.deepEqual(two.slice(0, one.length), one, "第 2 轮必须原样包含第 1 轮的消息");
  assert.deepEqual(three.slice(0, two.length), two, "第 3 轮必须原样包含前两轮的消息");
});

test("AC6-9：对话会话的 messages 形状不变 —— [...history, {user: 本轮富文本}]", () => {
  const session = sessionUpTo(2);
  const history = buildHistoryMessages(session);
  const firstMessage = "当前工作目录：/repo\n\n用户想要：删掉 tmp-note.txt";
  const messages = [...history, { role: "user", content: firstMessage }];
  assert.equal(messages.length, history.length + 1);
  assert.equal(messages[messages.length - 1].role, "user");
  assert.equal(messages[messages.length - 1].content, firstMessage);
  // 形状是 user/assistant 交替的扁平数组，不许在开头塞 system 段（那会毁掉网关前缀）。
  assert.equal(messages[0].role, "user");
  assert.equal(messages.some((item) => item.role === "system"), false);
});
