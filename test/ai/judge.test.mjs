// 五级判级链的行为锁（PROTOCOL-AGENT.md §5，AC5 / AC6）。
//
// 审阅函数全部注入假实现：真网关的可用性不该让单元测试变红。
// 真网关的实测走 scripts/review-probe.mjs（AC7）。

import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_UNAVAILABLE_REASON, judge } from "../../src/ai/judge.mjs";

const baseConfig = {
  model: null,
  autonomy: "balanced",
  allowlist: [],
  reviewModel: null,
  basePrompt: null,
};

/** 造一个固定回固定结论的假审阅函数，并记录调用次数。 */
function reviewer(verdict) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    if (verdict === null) return { risk: null, why: "审阅服务不可用", reversible: null, model: input.model };
    return {
      risk: verdict.risk,
      why: verdict.why === undefined ? "测试用理由" : verdict.why,
      reversible: verdict.reversible === undefined ? true : verdict.reversible,
      model: input.model || "review/model",
    };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------- 第 1 级

test("AC5：硬禁止在 loose + 白名单命中下仍然 confirm", async () => {
  const review = reviewer({ risk: "safe" });
  const config = {
    ...baseConfig,
    autonomy: "loose",
    allowlist: [{ pattern: "sudo", mode: "prefix", enabled: true }],
    reviewModel: null,
  };
  const verdict = await judge({ command: "sudo rm -rf /", config, cwd: "/tmp", model: "m/x", review });
  assert.equal(verdict.decision, "confirm");
  assert.ok(/硬性禁止/.test(verdict.reason), `reason 应说明硬性禁止：${verdict.reason}`);
  assert.equal(review.calls.length, 0, "硬禁止不该去调审阅");
});

test("AC5（V03 的另一半）：judge(\"sudo ls\") 也是 confirm，白名单加 sudo 也不行", async () => {
  const config = {
    ...baseConfig,
    autonomy: "loose",
    allowlist: [{ pattern: "sudo", mode: "prefix", enabled: true }],
  };
  const verdict = await judge({ command: "sudo ls", config, review: reviewer({ risk: "safe" }) });
  assert.equal(verdict.decision, "confirm");
});

test("硬禁止的命令即使内置只读白名单会放行也 confirm", async () => {
  // `git reset --hard` 命中硬禁止；classify 对 git reset 本来就是 confirm，这条锁链的顺序。
  const verdict = await judge({
    command: "git reset --hard HEAD~1",
    config: { ...baseConfig, autonomy: "loose" },
    review: reviewer({ risk: "safe" }),
  });
  assert.equal(verdict.decision, "confirm");
});

// ---------------------------------------------------------------- 第 2 级

test("第 2 级：用户白名单命中 → auto，reason 是「你的白名单」", async () => {
  const review = reviewer({ risk: "danger" });
  const verdict = await judge({
    command: "mkdir a b",
    config: { ...baseConfig, allowlist: [{ pattern: "mkdir", mode: "prefix", enabled: true }] },
    review,
  });
  assert.equal(verdict.decision, "auto");
  assert.equal(verdict.reason, "你的白名单");
  assert.equal(verdict.hit, "mkdir");
  assert.equal(review.calls.length, 0, "白名单命中不该调审阅");
});

test("第 2 级：白名单 enabled:false 不生效", async () => {
  const verdict = await judge({
    command: "mkdir a b",
    config: { ...baseConfig, allowlist: [{ pattern: "mkdir", mode: "prefix", enabled: false }] },
    review: reviewer({ risk: "caution", reversible: false }),
  });
  assert.equal(verdict.decision, "confirm");
});

// ---------------------------------------------------------------- 第 3 级

test("AC6：ls -la 走内置只读 → 三档都 auto，且不调审阅", async () => {
  for (const autonomy of ["strict", "balanced", "loose"]) {
    const review = reviewer({ risk: "danger" });
    const verdict = await judge({
      command: "ls -la",
      config: { ...baseConfig, autonomy },
      review,
    });
    assert.equal(verdict.decision, "auto", `autonomy=${autonomy} 应当 auto`);
    assert.equal(review.calls.length, 0, `autonomy=${autonomy} 不该调审阅`);
    assert.equal(verdict.risk, null);
    assert.equal(verdict.reviewModel, null);
  }
});

test("第 3 级：内置只读命中时不受 reviewModel 关闭影响", async () => {
  const verdict = await judge({
    command: "pwd",
    config: { ...baseConfig, reviewModel: "", autonomy: "strict" },
  });
  assert.equal(verdict.decision, "auto");
});

// ---------------------------------------------------------------- 第 4 级

test("AC6：mkdir testdir —— strict → confirm，且不调审阅", async () => {
  const review = reviewer({ risk: "caution", reversible: true });
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "strict" },
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(review.calls.length, 0, "strict 档必须跳过审阅");
});

test("AC6：mkdir testdir —— balanced + 审阅 caution + 不可逆 → confirm", async () => {
  const review = reviewer({ risk: "caution", reversible: false });
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "balanced" },
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.risk, "caution");
  assert.equal(review.calls.length, 1);
});

test("AC6：mkdir testdir —— loose + 审阅 caution + reversible=true → auto", async () => {
  const review = reviewer({ risk: "caution", reversible: true });
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "loose" },
    review,
  });
  assert.equal(verdict.decision, "auto");
  assert.equal(verdict.risk, "caution");
});

test("第 4 级：审阅 safe + balanced → auto", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "balanced" },
    review: reviewer({ risk: "safe" }),
  });
  assert.equal(verdict.decision, "auto");
});

test("第 4 级：审阅 safe + strict → 仍是 confirm（strict 在第 4 级之前就返回了）", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "strict" },
    review: reviewer({ risk: "safe" }),
  });
  assert.equal(verdict.decision, "confirm");
});

test("第 4 级：审阅 danger + loose → confirm（只有 caution+reversible 才在 loose 放行）", async () => {
  const verdict = await judge({
    command: "rm -rf build",
    config: { ...baseConfig, autonomy: "loose" },
    review: reviewer({ risk: "danger", reversible: false }),
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.risk, "danger");
});

test("第 4 级：caution + loose + reversible=false → confirm", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "loose" },
    review: reviewer({ risk: "caution", reversible: false }),
  });
  assert.equal(verdict.decision, "confirm");
});

test("第 4 级：caution + balanced + reversible=true → confirm（balanced 不放行写操作）", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "balanced" },
    review: reviewer({ risk: "caution", reversible: true }),
  });
  assert.equal(verdict.decision, "confirm");
});

test("审阅失败（risk:null）→ confirm，reason 是协议原文", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "loose" },
    review: reviewer(null),
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE_REASON);
  assert.equal(verdict.risk, null);
  assert.equal(verdict.reviewModel, null);
});

test("审阅抛错 → confirm（不往外抛）", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "loose" },
    review: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE_REASON);
});

test("reviewModel === \"\" 关闭审阅：不调审阅，直接 confirm", async () => {
  const review = reviewer({ risk: "safe" });
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "loose", reviewModel: "" },
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(review.calls.length, 0);
});

test("reviewModel 指定的模型透传给审阅函数", async () => {
  const review = reviewer({ risk: "safe" });
  await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, reviewModel: "review/special" },
    review,
  });
  assert.equal(review.calls[0].model, "review/special");
});

test("reviewModel 为 null 时回落到对话模型", async () => {
  const review = reviewer({ risk: "safe" });
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, reviewModel: null, autonomy: "loose" },
    model: "conversation/model",
    review,
  });
  assert.equal(review.calls[0].model, "conversation/model");
  assert.equal(verdict.reviewModel, "conversation/model");
});

// ---------------------------------------------------------------- 兜底 / 形状

test("兜底：classify 说 confirm 且审阅未知风险值 → confirm", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "loose" },
    review: async () => ({ risk: "maybe", why: "?", reversible: true, model: "x" }),
  });
  assert.equal(verdict.decision, "confirm");
});

test("返回形状：文档化的五个字段都在，且类型正确", async () => {
  const verdict = await judge({
    command: "ls -la",
    config: { ...baseConfig },
    review: reviewer({ risk: "safe" }),
  });
  for (const key of ["decision", "reason", "hit", "risk", "reviewModel"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(verdict, key), `缺少字段 ${key}`);
  }
  assert.equal(typeof verdict.decision, "string");
  assert.equal(typeof verdict.reason, "string");
});

test("审阅结论透出 reviewWhy / reversible（agent.approval 帧要用，字段名取自 PROTOCOL §3.2）", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "balanced" },
    review: reviewer({ risk: "caution", why: "建目录可撤销", reversible: true }),
  });
  assert.equal(verdict.risk, "caution");
  assert.equal(verdict.reviewWhy, "建目录可撤销");
  assert.equal(verdict.reversible, true);
  assert.equal(verdict.reviewModel, "review/model");
});

test("没走审阅时 reviewWhy / reversible 都是 null", async () => {
  const verdict = await judge({ command: "ls -la", config: { ...baseConfig }, review: reviewer({ risk: "safe" }) });
  assert.equal(verdict.reviewWhy, null);
  assert.equal(verdict.reversible, null);
});

test("非字符串命令不抛错，落到 confirm", async () => {
  const verdict = await judge({ command: 12345, config: { ...baseConfig }, review: reviewer({ risk: "safe" }) });
  assert.equal(verdict.decision, "confirm");
});

test("autonomy 非法值按 balanced 处理", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "yolo" },
    review: reviewer({ risk: "caution", reversible: true }),
  });
  assert.equal(verdict.decision, "confirm", "balanced 不放行 caution");
});

test("config 缺失也不抛错", async () => {
  const verdict = await judge({ command: "ls -la", review: reviewer({ risk: "safe" }) });
  assert.equal(verdict.decision, "auto");
});
