// TASK-FIX17-J R3 / AC2 / AC3 / AC5：判级链带上下文 + 分级放行。
//
// 三件事在这里锁死：
//   1. 普通黑名单层（chmod -R / chown -R / git push --force / git reset --hard / git clean -fd）
//      在「审阅说符合意图 + 护栏通过」时 auto，aligned=false 时 confirm。
//   2. 删一个 cwd 内的空目录（对话里提过）→ auto（用户的原始诉求）。
//   3. 审阅真的收到了**全量**历史（第 1 轮的原话）与目标事实（空目录 entries=0）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { judge } from "../../src/ai/judge.mjs";
import { REVIEW_UNAVAILABLE_REASON } from "../../src/ai/judge.mjs";
import { buildHistoryMessages } from "../../src/ai/agent.mjs";
import { serializeHistoryForReview } from "../../src/ai/review.mjs";

const baseConfig = { model: null, autonomy: "balanced", allowlist: [], reviewModel: null, basePrompt: null };

/** 桩审阅：记录每次入参，回一个可配置的结论。 */
function stubReview(verdict) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return {
      risk: verdict.risk === undefined ? "caution" : verdict.risk,
      aligned: verdict.aligned === undefined ? null : verdict.aligned,
      justification: verdict.justification === undefined ? "测试用依据" : verdict.justification,
      effect: verdict.effect === undefined ? "测试用效果" : verdict.effect,
      confirmWhy: verdict.confirmWhy === undefined ? "测试用确认理由" : verdict.confirmWhy,
      reversible: verdict.reversible === undefined ? false : verdict.reversible,
      cachedTokens: verdict.cachedTokens === undefined ? null : verdict.cachedTokens,
      model: input.model || "review/model",
    };
  };
  fn.calls = calls;
  return fn;
}

/* ---------------------------------------------------------------- 沙箱 */

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-j-judge-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, "empty-dir"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "dist", "a.js"), "x");
  return { root, cwd };
}

const SANDBOX = makeSandbox();
const CWD = SANDBOX.cwd;
test.after(() => {
  try {
    fs.rmSync(SANDBOX.root, { recursive: true, force: true });
  } catch {
    // 忽略清理失败。
  }
});

/** 3 轮真实会话（第 1 轮就提到「我建错了 tmp-note」）。 */
function historyOf3Rounds() {
  return buildHistoryMessages({
    messages: [
      { role: "user", text: "我建错了个文件 tmp-note.txt", round: 1 },
      { role: "assistant", text: "好的，先留着也没关系。", round: 1 },
      { role: "user", text: "看看这个目录里有什么", round: 2 },
      { role: "assistant", text: "有 a.txt 和 b.txt。", round: 2 },
      { role: "user", text: "把它删掉", round: 3 },
    ],
    steps: [
      { round: 2, command: "ls", status: "done", output: "a.txt\nb.txt" },
      { round: 3, command: "rm tmp-note.txt", status: "done", output: "" },
    ],
  });
}

/* ---------------------------------------------------------------- AC2 */

const BLACKLIST_COMMANDS = [
  "chmod -R 777 ./dist",
  "chown -R me ./dist",
  "git push --force origin main",
  "git reset --hard HEAD~3",
  "git clean -fd",
];

test("AC2：黑名单层 + aligned=true + 护栏通过 → auto（reversible=false 也放行）", async () => {
  for (const command of BLACKLIST_COMMANDS) {
    const review = stubReview({ risk: "caution", aligned: true, reversible: false, justification: "你刚说要清理构建产物" });
    const verdict = await judge({
      command,
      config: { ...baseConfig, autonomy: "balanced", reviewModel: "some/model" },
      cwd: CWD,
      model: "m/x",
      history: historyOf3Rounds(),
      review,
    });
    assert.equal(verdict.decision, "auto", `${command} 应该 auto，实际 ${verdict.decision}（${verdict.reason}）`);
    assert.equal(verdict.aligned, true);
    assert.match(verdict.reason, /^AI 审阅：你刚说要清理构建产物/, `reason=${verdict.reason}`);
    assert.equal(review.calls.length, 1, `${command} 必须真的送审`);
    assert.equal(verdict.tier, "blacklist", `${command} 的 tier 应为 blacklist`);
    assert.equal(verdict.guardOk, true);
  }
});

test("AC2：黑名单层 aligned=false → confirm（任何档位，含 loose）", async () => {
  for (const command of BLACKLIST_COMMANDS) {
    for (const autonomy of ["strict", "balanced", "loose"]) {
      const review = stubReview({ risk: "safe", aligned: false, reversible: true, justification: "你没说过要动这个" });
      const verdict = await judge({
        command,
        config: { ...baseConfig, autonomy, reviewModel: "some/model" },
        cwd: CWD,
        history: historyOf3Rounds(),
        review,
      });
      assert.equal(verdict.decision, "confirm", `${command} @${autonomy} 必须 confirm（实际 ${verdict.decision}）`);
      assert.equal(review.calls.length, 1);
    }
  }
});

test("AC2：黑名单层 aligned=null（老桩没这个字段）也 confirm —— 不许落到档位兜底", async () => {
  for (const command of BLACKLIST_COMMANDS) {
    const review = stubReview({ risk: "safe", reversible: true });
    const verdict = await judge({
      command,
      config: { ...baseConfig, autonomy: "loose", reviewModel: "some/model" },
      cwd: CWD,
      review,
    });
    assert.equal(verdict.decision, "confirm", `${command} 没有 aligned=true 就不许 auto`);
  }
});

test("AC2：strict 档下即使 aligned=true 也不 auto（黑名单层一样）", async () => {
  const review = stubReview({ risk: "safe", aligned: true, reversible: true });
  const verdict = await judge({
    command: "git push --force origin main",
    config: { ...baseConfig, autonomy: "strict", reviewModel: "some/model" },
    cwd: CWD,
    review,
  });
  assert.equal(verdict.decision, "confirm");
});

test("AC2：risk=danger 时 aligned=true 也不 auto（7b 在 7d 之前）", async () => {
  const review = stubReview({ risk: "danger", aligned: true, reversible: false });
  const verdict = await judge({
    command: "rm -rf ./dist",
    config: { ...baseConfig, autonomy: "loose", reviewModel: "some/model" },
    cwd: CWD,
    history: [{ role: "user", content: "把 dist 删掉" }],
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.risk, "danger");
});

/* ---------------------------------------------------------------- AC3 */

test("AC3：删 cwd 内的空目录（对话里提过名字）→ auto", async () => {
  const history = [
    { role: "user", content: "我前面用错了 mkdir，建了个空的 empty-dir" },
    { role: "assistant", content: "要不要我删掉？" },
    { role: "user", content: "删掉吧" },
  ];
  const review = stubReview({
    risk: "caution",
    aligned: true,
    reversible: false,
    justification: "你在第 1 轮说 empty-dir 是建错的、第 3 轮说删掉它",
  });
  const verdict = await judge({
    command: "rmdir empty-dir",
    config: { ...baseConfig, autonomy: "balanced", reviewModel: "some/model" },
    cwd: CWD,
    history,
    review,
  });
  assert.equal(verdict.decision, "auto", `实际 ${verdict.decision} / ${verdict.reason}`);
  assert.equal(verdict.guardOk, true);
  // 空目录这个事实真的送到了审阅（否则模型只是瞎猜）。
  const facts = review.calls[0].targetFacts;
  assert.ok(facts && Array.isArray(facts.targets), "必须把 targetFacts 交给审阅");
  assert.equal(facts.targets[0].type, "dir");
  assert.equal(facts.targets[0].entries, 0);
  assert.equal(facts.emptyDirs, 1);
});

test("AC3：同样的空目录，但审阅说「这不是用户要的」→ confirm", async () => {
  const review = stubReview({ risk: "caution", aligned: false, reversible: false });
  const verdict = await judge({
    command: "rmdir empty-dir",
    config: { ...baseConfig, autonomy: "balanced", reviewModel: "some/model" },
    cwd: CWD,
    history: [{ role: "user", content: "看看这里有啥" }],
    review,
  });
  assert.equal(verdict.decision, "confirm");
});

/* ---------------------------------------------------------------- 护栏闸门 */

test("AC4/judge：cwd 外的删除目标即使 aligned=true + risk=safe 也 confirm，且日志 guardOk:false", async () => {
  const logs = [];
  const outside = path.join(SANDBOX.root, "not-mentioned");
  const review = stubReview({ risk: "safe", aligned: true, reversible: true, justification: "用户要的" });
  const verdict = await judge({
    command: `rm -rf "${outside}"`,
    config: { ...baseConfig, autonomy: "loose", reviewModel: "some/model" },
    cwd: CWD,
    history: [{ role: "user", content: "帮我清理一下电脑" }],
    review,
    log: (entry) => logs.push(entry),
  });
  assert.equal(verdict.decision, "confirm", `实际 ${verdict.decision}`);
  assert.equal(verdict.guardOk, false);
  assert.match(verdict.reason, /工作目录以外/);
  const line = logs.find((entry) => entry.code === "REVIEW");
  assert.ok(line, "必须有一条 REVIEW 日志");
  assert.equal(line.guardOk, false);
  assert.equal(line.aligned, true);
  assert.match(String(line.justification), /用户要的/);
});

/* ---------------------------------------------------------------- AC5 */

test("AC5：审阅收到的是全量历史（第 1 轮原话必须在，不截断到最近两轮）", async () => {
  const history = historyOf3Rounds();
  const review = stubReview({ risk: "caution", aligned: true, reversible: false });
  await judge({
    command: "rm tmp-note.txt",
    config: { ...baseConfig, autonomy: "balanced", reviewModel: "some/model" },
    cwd: CWD,
    history,
    shell: "bash 5.2.37",
    review,
  });
  const input = review.calls[0];
  assert.deepEqual(input.history, history, "传给审阅的 history 必须逐字等于主会话那份");
  assert.equal(input.shell, "bash 5.2.37", "shell 必须传下去");

  const text = serializeHistoryForReview(input.history);
  assert.match(text, /我建错了个文件 tmp-note\.txt/, "第 1 轮的用户原话必须在");
  assert.match(text, /看看这个目录里有什么/, "第 2 轮也要在");
  assert.match(text, /把它删掉/, "第 3 轮也要在");
});

test("AC5：只传 session 不传 history 时，judge 自己按会话现算（等价路径）", async () => {
  const session = {
    messages: [
      { role: "user", text: "第 1 轮：我建错了 tmp-note.txt", round: 1 },
      { role: "assistant", text: "第 1 轮回答", round: 1 },
      { role: "user", text: "第 3 轮：把它删掉", round: 3 },
    ],
    steps: [],
  };
  const review = stubReview({ risk: "caution", aligned: true, reversible: false });
  await judge({
    command: "rm tmp-note.txt",
    config: { ...baseConfig, autonomy: "balanced", reviewModel: "some/model" },
    cwd: CWD,
    session,
    review,
  });
  const input = review.calls[0];
  assert.ok(Array.isArray(input.history) && input.history.length >= 2, "session 必须被换算成 history");
  const text = serializeHistoryForReview(input.history);
  assert.match(text, /第 1 轮：我建错了 tmp-note\.txt/);
  assert.match(text, /第 3 轮：把它删掉/);
});

test("AC5：[REVIEW] 日志带 aligned / justification / guardOk / cachedTokens / historyChars / tier", async () => {
  const logs = [];
  const review = stubReview({
    risk: "caution",
    aligned: true,
    reversible: false,
    justification: "你在第 1 轮说这个文件是建错的",
    cachedTokens: 2176,
  });
  await judge({
    command: "rm tmp-note.txt",
    config: { ...baseConfig, autonomy: "balanced", reviewModel: "some/model" },
    cwd: CWD,
    history: historyOf3Rounds(),
    review,
    log: (entry) => logs.push(entry),
  });
  const line = logs.find((entry) => entry.code === "REVIEW");
  assert.ok(line);
  assert.equal(line.aligned, true);
  assert.equal(line.justification, "你在第 1 轮说这个文件是建错的");
  assert.equal(line.guardOk, true);
  assert.equal(line.cachedTokens, 2176);
  assert.equal(line.tier, "blacklist");
  assert.equal(typeof line.historyChars, "number");
  assert.ok(line.historyChars > 0);
  // 完整命令仍然不许进日志。
  assert.equal(typeof line.commandHead, "string");
  assert.ok(line.commandHead.length <= 40);
  assert.equal(line.command, undefined);
});

/* ---------------------------------------------------------------- 失败路径 */

test("R3 7a：审阅失败 → confirm + REVIEW_FAILED（带 tier / guardOk / historyChars）", async () => {
  const logs = [];
  const verdict = await judge({
    command: "npm run build",
    config: { ...baseConfig, autonomy: "loose", reviewModel: "some/model" },
    cwd: CWD,
    history: historyOf3Rounds(),
    review: async () => null,
    log: (entry) => logs.push(entry),
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE_REASON);
  assert.equal(verdict.risk, null);
  const failed = logs.find((entry) => entry.code === "REVIEW_FAILED");
  assert.ok(failed, "必须写 REVIEW_FAILED");
  assert.equal(failed.reason, "REVIEW_NO_VERDICT");
  assert.equal(typeof failed.historyChars, "number");
  assert.equal(failed.tier, "normal");
});

test("R3：非破坏性命令不 stat（targetFacts 为 null，零 IO）", async () => {
  const review = stubReview({ risk: "safe", aligned: true, reversible: true });
  await judge({
    command: "npm run build",
    config: { ...baseConfig, autonomy: "balanced", reviewModel: "some/model" },
    cwd: CWD,
    review,
  });
  assert.equal(review.calls[0].targetFacts, null, "没有破坏性命令头时不该算 targetFacts");
});

test("R3：judge 返回值新增字段的默认值（未送审分支也要有序）", async () => {
  const verdict = await judge({ command: "ls -la", config: { ...baseConfig }, review: stubReview({ risk: "safe" }) });
  assert.equal(verdict.decision, "auto");
  assert.equal(verdict.aligned, null);
  assert.equal(verdict.justification, null);
  assert.equal(verdict.tier, "normal");
  assert.equal(verdict.guardOk, true);
  assert.equal(verdict.cachedTokens, null);
});
