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
    if (verdict === null)
      return { risk: null, effect: null, confirmWhy: null, reversible: null, model: input.model };
    return {
      risk: verdict.risk,
      effect: verdict.effect === undefined ? "测试用效果：会改动一个文件" : verdict.effect,
      confirmWhy: verdict.confirmWhy === undefined ? "测试用理由" : verdict.confirmWhy,
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

test("AC6 / AC8：mkdir testdir —— strict → confirm，但审阅**确实被调用**（TASK-V4-H §5.3）", async () => {
  const review = reviewer({ risk: "caution", reversible: true });
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "strict" },
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(review.calls.length, 1, "strict 档也必须调审阅（旧行为是跳过）");
  assert.equal(verdict.risk, "caution", "strict 下审阅结论仍要透出（用于确认卡角标）");
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

test("AC8：审阅 safe + strict → 仍是 confirm（strict 绝不据此自动放行），但审阅被调用了", async () => {
  const review = reviewer({ risk: "safe", reversible: true });
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "strict" },
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(review.calls.length, 1, "strict 档必须调审阅，只是不能自动放行");
  assert.equal(verdict.risk, "safe");
  assert.equal(verdict.reversible, true);
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

test("兜底：classify 说 confirm 且审阅未知风险值 → confirm，且写 REVIEW_FAILED 日志", async () => {
  const logs = [];
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "loose" },
    review: async () => ({ risk: "maybe", effect: "?", confirmWhy: "?", reversible: true, model: "x" }),
    log: (line) => logs.push(line),
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE_REASON);
  const failed = logs.filter((line) => line.code === "REVIEW_FAILED");
  assert.equal(failed.length, 1, "审阅不可用必须写 REVIEW_FAILED，不许静默");
});

test("返回形状：文档化的五个字段 + effect/confirmWhy/reversible 都在，且类型正确", async () => {
  const verdict = await judge({
    command: "ls -la",
    config: { ...baseConfig },
    review: reviewer({ risk: "safe" }),
  });
  for (const key of ["decision", "reason", "hit", "risk", "reviewModel", "effect", "confirmWhy", "reversible"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(verdict, key), `缺少字段 ${key}`);
  }
  assert.equal(typeof verdict.decision, "string");
  assert.equal(typeof verdict.reason, "string");
});

test("审阅结论透出 effect / confirmWhy / reversible（agent.approval 帧要用，字段名按 PROTOCOL §3.2）", async () => {
  const verdict = await judge({
    command: "mkdir testdir",
    config: { ...baseConfig, autonomy: "balanced" },
    review: reviewer({
      risk: "caution",
      effect: "会在当前目录下建一个空的 testdir",
      confirmWhy: "建目录可撤销",
      reversible: true,
    }),
  });
  assert.equal(verdict.risk, "caution");
  assert.equal(verdict.effect, "会在当前目录下建一个空的 testdir");
  assert.equal(verdict.confirmWhy, "建目录可撤销");
  assert.equal(verdict.reversible, true);
  assert.equal(verdict.reviewModel, "review/model");
});

test("没走审阅时 effect / confirmWhy / reversible 都是 null", async () => {
  const verdict = await judge({ command: "ls -la", config: { ...baseConfig }, review: reviewer({ risk: "safe" }) });
  assert.equal(verdict.effect, null);
  assert.equal(verdict.confirmWhy, null);
  assert.equal(verdict.reversible, null);
});

test("每次审阅写一行 [REVIEW] 日志（含 risk/effect/confirmWhy/reversible/model/ms）", async () => {
  const logs = [];
  await judge({
    command: "npm run build",
    config: { ...baseConfig, autonomy: "balanced", reviewModel: "review/x" },
    review: reviewer({ risk: "safe", effect: "会构建产物", confirmWhy: "", reversible: true }),
    log: (line) => logs.push(line),
  });
  const reviews = logs.filter((line) => line.code === "REVIEW");
  assert.equal(reviews.length, 1);
  const line = reviews[0];
  assert.equal(line.msg, "[REVIEW]");
  assert.equal(line.risk, "safe");
  assert.equal(line.effect, "会构建产物");
  assert.equal(line.reversible, true);
  assert.equal(line.reviewModel, "review/x");
  assert.equal(typeof line.durationMs, "number");
  // 铁律：日志里不出现完整命令。
  assert.equal(Object.prototype.hasOwnProperty.call(line, "command"), false);
  assert.equal(line.commandLength, "npm run build".length);
});

test("AC8：三档都调审阅（strict / balanced / loose 各一次）", async () => {
  for (const autonomy of ["strict", "balanced", "loose"]) {
    const review = reviewer({ risk: "caution", reversible: true });
    await judge({ command: "mkdir testdir", config: { ...baseConfig, autonomy }, review });
    assert.equal(review.calls.length, 1, `${autonomy} 档必须调审阅`);
  }
});

test("AC9：审阅返回 risk:null（模型不存在 / 超时）→ 三档都 confirm + 角标 none + 协议原文 reason", async () => {
  for (const autonomy of ["strict", "balanced", "loose"]) {
    const logs = [];
    const verdict = await judge({
      command: "mkdir testdir",
      config: { ...baseConfig, autonomy },
      review: async () => ({ risk: null, effect: null, confirmWhy: null, reversible: null, model: "nope" }),
      log: (line) => logs.push(line),
    });
    assert.equal(verdict.decision, "confirm", `${autonomy} 档必须 confirm`);
    assert.equal(verdict.reason, REVIEW_UNAVAILABLE_REASON);
    assert.equal(verdict.risk, null, "risk=null 是角标置灰的依据");
    assert.equal(verdict.effect, null);
    assert.equal(verdict.confirmWhy, null);
    assert.equal(logs.filter((line) => line.code === "REVIEW_FAILED").length, 1);
  }
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

// ===========================================================================
// TASK-V4-S §6.3 S11 / §6.6 J1–J4
// ===========================================================================

test("S11：用户白名单写 cat 也不能自动放行读密钥（第 1.5 级）", async () => {
  const review = reviewer({ risk: "safe" });
  const config = {
    ...baseConfig,
    autonomy: "loose",
    allowlist: [{ pattern: "cat", mode: "prefix", enabled: true }],
  };
  const verdict = await judge({ command: "cat secrets.key", config, review });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.hit, "deny:sensitive-path");
  assert.equal(review.calls.length, 0, "敏感路径不该去调审阅");
});

test("S11b：敏感路径在任何档位都 confirm，且白名单命中不了", async () => {
  for (const autonomy of ["strict", "balanced", "loose"]) {
    const review = reviewer({ risk: "safe" });
    const config = {
      ...baseConfig,
      autonomy,
      allowlist: [{ pattern: "cat", mode: "prefix", enabled: true }],
    };
    const verdict = await judge({ command: "cat ~/.ssh/id_rsa", config, review });
    assert.equal(verdict.decision, "confirm", `${autonomy} 档必须 confirm`);
    assert.equal(verdict.hit, "deny:sensitive-path");
    assert.equal(review.calls.length, 0);
  }
});

test("J1：含换行的复合命令不许交给审阅（P1-3）", async () => {
  const review = reviewer({ risk: "safe" });
  const verdict = await judge({
    command: "echo hi\nrm -rf /x",
    config: { ...baseConfig, autonomy: "balanced" },
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.hit, "unparsable");
  assert.equal(review.calls.length, 0, "切不开的命令不该去调审阅");
});

test("J2：输出重定向不许交给审阅", async () => {
  const review = reviewer({ risk: "safe" });
  const verdict = await judge({
    command: "ls > out.txt",
    config: { ...baseConfig, autonomy: "balanced" },
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.hit, "redirect");
  assert.equal(review.calls.length, 0);
});

test("J3：命令替换不许交给审阅", async () => {
  const review = reviewer({ risk: "safe" });
  const verdict = await judge({
    command: "echo $(rm -rf x)",
    config: { ...baseConfig, autonomy: "balanced" },
    review,
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.hit, "substitution");
  assert.equal(review.calls.length, 0);
});

test("J3b：引号不闭合与后台执行也都不交审阅", async () => {
  for (const command of ['echo "unclosed', "ls & rm x", "echo hi \\"]) {
    const review = reviewer({ risk: "safe" });
    const verdict = await judge({ command, config: { ...baseConfig, autonomy: "balanced" }, review });
    assert.equal(verdict.decision, "confirm", `${command} 必须 confirm`);
    assert.equal(review.calls.length, 0, `${command} 不该调审阅（hit=${verdict.hit}）`);
  }
});

test("J4：正常命令照旧走审阅（不回退成 confirm-only）", async () => {
  const review = reviewer({ risk: "safe" });
  const verdict = await judge({
    command: "npm run build",
    config: { ...baseConfig, autonomy: "balanced" },
    review,
  });
  assert.equal(verdict.decision, "auto");
  assert.equal(review.calls.length, 1, "正常路径必须调一次审阅");
});

// ===========================================================================
// TASK-V4-S §6.5 P1-2：`rm -rf ~/` 归一后进硬禁止第 1 级，
// judge 在 forbiddenReason 就返回，永远走不到审阅。
// 修前：loose 档 + 假审阅 caution/reversible → auto（VERIFY-V4-G §4 P1-2 逐字复现）。
// ===========================================================================

test("P1-2：rm -rf ~/ 在宽松档 + 审阅 caution 下仍 confirm，且审阅未被调用", async () => {
  const review = reviewer({ risk: "caution", reversible: true, confirmWhy: "清理家目录里的临时文件" });
  const verdict = await judge({
    command: "rm -rf ~/",
    config: { ...baseConfig, autonomy: "loose", reviewModel: "some/model" },
    model: "m/x",
    review,
  });
  assert.equal(verdict.decision, "confirm", `实际 decision=${verdict.decision} reason=${verdict.reason}`);
  assert.ok(/硬性禁止/.test(verdict.reason), `reason 应以「硬性禁止」开头：${verdict.reason}`);
  assert.equal(review.calls.length, 0, "硬禁止不该去调审阅");
});

test("P1-2b：其余 P1-1 变体也都在第 1 级被拦（任何档位）", async () => {
  for (const command of [
    "rm -rf $HOME/",
    "rm -rf ~/.",
    "rm -rf //",
    "rm -rf /**",
    "rm -rf /./",
    "rm -rf /tmp/../..",
    "chmod 777 /",
    "rd /s /q C:\\",
    "Remove-Item -Recurse -Force C:\\",
    "del /f /s /q C:\\Users",
  ]) {
    for (const autonomy of ["strict", "balanced", "loose"]) {
      const review = reviewer({ risk: "caution", reversible: true });
      const verdict = await judge({
        command,
        config: { ...baseConfig, autonomy, reviewModel: "some/model" },
        model: "m/x",
        review,
      });
      assert.equal(verdict.decision, "confirm", `${command} @${autonomy} 必须 confirm`);
      assert.ok(/硬性禁止/.test(verdict.reason), `${command} @${autonomy} reason=${verdict.reason}`);
      assert.equal(review.calls.length, 0, `${command} @${autonomy} 不该调审阅`);
    }
  }
});
