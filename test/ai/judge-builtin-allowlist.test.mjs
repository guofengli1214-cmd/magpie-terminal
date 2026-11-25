// TASK-FIX17-I R2：judge 走 config 的 `builtinAllowlist`。
//
// 两条就够（PRD R5）：删掉 `free` 后 `free -h` 变 confirm；配置里没有该字段
// 时按默认清单工作（`free -h` 仍 auto）。其余「清单能不能扩/缩放行集合」
// 在 test/policy/builtin-allowlist.test.mjs 里锁（那里不经 judge，避免被
// J 批的黑名单审阅层干扰）。

import test from "node:test";
import assert from "node:assert/strict";

import { judge } from "../../src/ai/judge.mjs";
import { DEFAULT_BUILTIN_ALLOWLIST } from "../../src/policy/allowlist.mjs";

/** 固定回 safe 的假审阅（审批链没走到这一步时不该被调用）。 */
function reviewer() {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return { risk: "safe", effect: "测试", confirmWhy: "测试", reversible: true, model: input.model };
  };
  fn.calls = calls;
  return fn;
}

const BASE = {
  model: null,
  autonomy: "balanced",
  allowlist: [],
  reviewModel: null,
  basePrompt: null,
};

test("I-R2 judge：config.builtinAllowlist 少了 free → free -h 不再命中内置白名单（靠审核层才能放行）", async () => {
  const review = reviewer();
  const builtinAllowlist = DEFAULT_BUILTIN_ALLOWLIST.filter((rule) => rule !== "free");
  // 为什么不直接断言 confirm：J 批之后 `default:free` 会走审核层，
  // 默认 safe&&reversible → auto（这是 J 批的有意设计，不是本批的回归）。
  // 本批要锁的是「内置白名单真的听配置」：关掉审阅（reviewModel: ""）
  // 后它就是 confirm，且 hit 从 allow:free 变成 default:free。
  const verdict = await judge({
    command: "free -h",
    config: { ...BASE, reviewModel: "", builtinAllowlist },
    cwd: "/tmp",
    model: "m/x",
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.hit, "default:free");
});

test("I-R2 judge：没有 builtinAllowlist 字段 → 按默认清单，free -h 仍 auto", async () => {
  const review = reviewer();
  const verdict = await judge({
    command: "free -h",
    config: { ...BASE },
    cwd: "/tmp",
    model: "m/x",
    review,
  });
  assert.equal(verdict.decision, "auto");
  assert.equal(verdict.hit, "allow:free");
  assert.equal(review.calls.length, 0, "auto 不该去调审阅");
});

test("I-R2 judge：builtinAllowlist: [] → ls 落到 default:ls（审核关闭时一律 confirm，hit 可观测）", async () => {
  const review = reviewer();
  // reviewModel: "" = 用户关掉审阅（judge 第 6 级），一律 confirm 并原样带出
  // classify 的 reason / hit —— 这样才能确定性地看到“清单空了”的效果
  // （否则 J 批的审阅层会把一个 safe&&reversible 的写操作放成 auto）。
  const verdict = await judge({
    command: "ls",
    config: { ...BASE, reviewModel: "", builtinAllowlist: [] },
    cwd: "/tmp",
    model: "m/x",
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.hit, "default:ls");
});

test("I-R2 judge：把 rm 加进 builtinAllowlist 也不能让 rm -rf x 落到 allow（deny 先于 allow）", async () => {
  const review = reviewer();
  const verdict = await judge({
    command: "rm -rf x",
    config: { ...BASE, reviewModel: "", builtinAllowlist: ["rm", ...DEFAULT_BUILTIN_ALLOWLIST] },
    cwd: "/tmp",
    model: "m/x",
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.hit, "deny:rm");
  assert.equal(review.calls.length, 0, "审阅被关掉时不该去调审阅");
});
