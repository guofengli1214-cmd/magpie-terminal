// 五级判级链（PROTOCOL-AGENT.md §5，TASK-V4-H §5.3）。
//
// 严格按顺序，命中即返回：
//   1. 硬禁止（src/policy/forbidden.mjs）      → 永远 confirm
//   1.5 敏感路径读取（src/policy/sensitive.mjs）→ 永远 confirm（白名单也绕不过）
//   2. 用户白名单（config.allowlist，§2 语义） → auto
//   3. 内置只读白名单（src/policy/classify.mjs）→ 它说 auto 就 auto
//   3.5 切不开的命令（unparsable / redirect / substitution …）→ 直接 confirm，不交审阅
//   4. 第二 AI 审阅（src/ai/review.mjs）        → **三个档位都强制执行**
//   5. 兜底                                     → confirm
//
// TASK-V4-H §5.3（用户明确要求「审阅全档位」）：
//   - 删掉了「strict 跳过审阅」的分支。三档都必须调审阅，档位只决定
//     「审阅结论怎么用」（PROTOCOL §5 第 4 步逐字为准）：
//       strict  ：结论只用于展示与日志，绝不据此自动放行（能 auto 的只有第 2/3 级）
//       balanced：risk === "safe" 且 reversible === true → auto
//       loose   ：在 balanced 基础上，risk === "caution" 且 reversible === true → auto
//       risk === "danger"：任何档位都不 auto
//   - 审阅失败 / 超时（8s）→ 任何档位都 confirm，reason 是协议原文，
//     角标置灰（risk=null），日志写 REVIEW_FAILED（不许静默）。
//
// 第 1 级与 1.5 级任何档位、任何白名单都不能绕过 —— 这是 AC5 / AC6 的锁。

import { classify } from "../policy/classify.mjs";
import { forbiddenReason } from "../policy/forbidden.mjs";
import { sensitiveReadTarget } from "../policy/sensitive.mjs";
import { matchAllowlist } from "./allowlist.mjs";
import { reviewCommand } from "./review.mjs";

/** 审阅服务不可用时给用户看的原因（PROTOCOL §5 第 4 级原文）。 */
export const REVIEW_UNAVAILABLE_REASON = "审阅服务不可用，按需要确认处理";

/**
 * 这些 hit 说明「命令根本切不开」，不能交给 AI 审阅。
 *
 * 为什么：审阅模型只看得到命令文本，`echo hi\nrm -rf /` 这种它往往只瞄到
 * 第一行无害片段就回 safe，于是 judge 把一条复合命令放成 auto
 * （VERIFY-V4-G §4 P1-3 已逐字复现）。
 */
const UNREVIEWABLE_HITS = new Set(["unparsable", "substitution", "redirect", "exception", "invalid-input"]);

/**
 * 判级。
 *
 * @param {{command: string, config?: object, cwd?: string, model?: string,
 *          review?: Function, log?: Function}} input
 *   `review` 可注入假审阅函数（测试用），签名与 reviewCommand 相同。
 *   `log` 注入日志函数（测试用）；生产由 agent 传进来，每次审阅写一行 `[REVIEW]`。
 * @returns {Promise<{decision:"auto"|"confirm", reason:string, hit:string|null,
 *          risk:"safe"|"caution"|"danger"|null, effect:string|null, confirmWhy:string|null,
 *          reversible:boolean|null, reviewModel:string|null}>}
 */
export async function judge({ command, config, cwd, model, review, log } = {}) {
  const conf = config && typeof config === "object" ? config : {};
  const autonomy = conf.autonomy === "strict" || conf.autonomy === "loose" ? conf.autonomy : "balanced";
  const reviewModelSetting = conf.reviewModel === undefined ? null : conf.reviewModel;
  const conversationModel = typeof model === "string" && model.length > 0 ? model : null;
  const logFn = typeof log === "function" ? log : () => {};

  const result = (decision, reason, hit, risk, reviewModel, extra) => ({
    decision,
    reason,
    hit: hit === undefined ? null : hit,
    risk: risk === undefined ? null : risk,
    reviewModel: reviewModel === undefined ? null : reviewModel,
    effect: extra && typeof extra.effect === "string" && extra.effect.length > 0 ? extra.effect : null,
    confirmWhy:
      extra && typeof extra.confirmWhy === "string" && extra.confirmWhy.length > 0
        ? extra.confirmWhy
        : null,
    reversible: extra && typeof extra.reversible === "boolean" ? extra.reversible : null,
  });

  const text = typeof command === "string" ? command : "";

  // 空命令 / 非字符串：不调审阅，直接确认（与 classify 的 noop 分支一致）。
  if (text.trim().length === 0) {
    return result("confirm", "空命令不执行", "noop", null, null);
  }

  // 1. 硬禁止：任何档位、任何白名单都拦不住它的「自动」。硬禁止只影响「自动」，
  //    不阻止用户在确认卡上点执行 —— 那是用户的决定。
  const forbidden = forbiddenReason(text);
  if (forbidden) {
    return result("confirm", `硬性禁止：${forbidden}`, forbidden, null, null);
  }

  // 1.5 敏感路径读取：用户白名单也不能自动放行读密钥的操作。
  //     否则用户在设置页写一条 `cat` 的 prefix 白名单，`cat secrets.key`
  //     就又变成 auto 了（P0-3 的另一条腿）。
  const sensitiveHit = sensitiveReadTarget(text);
  if (sensitiveHit) {
    return result("confirm", "这条命令会读出密钥或凭据文件，需要你确认", "deny:sensitive-path", null, null);
  }

  // 2. 用户白名单。
  const allowHit = matchAllowlist(text, conf.allowlist);
  if (allowHit) {
    return result("auto", "你的白名单", allowHit.hit, null, null);
  }

  // 3. 内置只读白名单。
  const builtin = classify(text);
  if (builtin && builtin.decision === "auto") {
    return result("auto", builtin.reason || "内置只读白名单", builtin.hit === undefined ? null : builtin.hit, null, null);
  }

  // 3.5 切不开的命令不许交给审阅（P1-3）。
  //     命令切不开（换行 / 重定向 / 命令替换 / 引号不闭合 / 空段）时，
  //     审阅模型看到的往往是「第一行看起来无害」的片段，会误判成 safe。
  //     这类命令一律直接确认，不给审阅开口子的机会。
  if (builtin && UNREVIEWABLE_HITS.has(String(builtin.hit))) {
    return result("confirm", builtin.reason || "这条命令无法静态判定，需要你确认", builtin.hit, null, null);
  }

  // 4. 第二 AI 审阅 —— **三个档位都跑，没有任何档位跳过这一步**（TASK-V4-H §5.3）。
  //
  // 这里只保留一个出口：`reviewModel === ""`（设置页的「关闭审阅」）。
  // 那是用户明确的全局开关（PROTOCOL §1 的 reviewModel 语义），不是档位差异；
  // 关掉以后等于「全都要确认」，同样不会自动放行任何命令。
  if (reviewModelSetting === "") {
    return result(
      "confirm",
      builtin && builtin.reason ? `${builtin.reason}（审阅已关闭，一律确认）` : "需要你确认（审阅已关闭）",
      builtin ? builtin.hit : null,
      null,
      null,
    );
  }

  const reviewModelId =
    typeof reviewModelSetting === "string" && reviewModelSetting.trim().length > 0
      ? reviewModelSetting.trim()
      : conversationModel || null;

  const doReview = typeof review === "function" ? review : reviewCommand;
  const reviewStartedAt = Date.now();

  let verdict;
  let failure = null;
  try {
    verdict = await doReview({ command: text, model: reviewModelId, cwd });
  } catch (err) {
    verdict = null;
    failure = err && err.code ? String(err.code) : "REVIEW_THREW";
  }

  const riskOk = verdict && (verdict.risk === "safe" || verdict.risk === "caution" || verdict.risk === "danger");
  if (!riskOk) {
    if (!failure) failure = "REVIEW_NO_VERDICT";
    // 审阅不可用：任何档位都 confirm，角标置灰（risk=null）。
    // 日志写 REVIEW_FAILED（不许静默降级）。
    logFn({
      level: "warn",
      code: "REVIEW_FAILED",
      msg: "[REVIEW_FAILED] 审阅服务不可用，按需要确认处理",
      commandLength: text.length,
      commandHead: text.slice(0, 40),
      autonomy,
      reviewModel: reviewModelId,
      reason: failure,
      durationMs: Date.now() - reviewStartedAt,
    });
    return result("confirm", REVIEW_UNAVAILABLE_REASON, null, null, null);
  }

  const risk = verdict.risk;
  const effect = typeof verdict.effect === "string" ? verdict.effect : "";
  const confirmWhy = typeof verdict.confirmWhy === "string" ? verdict.confirmWhy : "";
  const reversible = verdict.reversible === true;
  const resolvedModel = typeof verdict.model === "string" && verdict.model.length > 0 ? verdict.model : reviewModelId;
  const extra = { effect: effect || null, confirmWhy: confirmWhy || null, reversible: verdict.reversible === true };

  // 每次审阅写一行独立日志（卡片 §5.3 逐字：`[REVIEW] {command, risk, effect, confirmWhy, reversible, model, ms}`）。
  // 完整命令不进日志（PROTOCOL §4.5 铁律），只留前 40 字符 + 长度。
  logFn({
    level: "info",
    code: "REVIEW",
    msg: "[REVIEW]",
    commandLength: text.length,
    commandHead: text.slice(0, 40),
    // classify 的 note 只作排查用（`2>&1` 一类被剥离过）；不影响 decision。
    note: builtin && typeof builtin.note === "string" ? builtin.note : null,
    risk,
    effect: effect || null,
    confirmWhy: confirmWhy || null,
    reversible: verdict.reversible === true,
    reviewModel: resolvedModel,
    autonomy,
    durationMs: Date.now() - reviewStartedAt,
  });

  // 档位只决定「结论怎么用」。
  const reason = confirmWhy ? `AI 审阅：${confirmWhy}` : effect ? `AI 审阅：${effect}` : "AI 审阅";

  if (risk === "danger") {
    // danger 任何档位都不 auto（含 loose）。
    return result("confirm", reason, null, risk, resolvedModel, extra);
  }

  if (autonomy === "strict") {
    // 严格档：审阅只用于展示与日志，绝不据此自动放行。
    return result("confirm", reason, null, risk, resolvedModel, extra);
  }

  if (risk === "safe" && reversible) {
    return result("auto", reason, null, risk, resolvedModel, extra);
  }

  if (autonomy === "loose" && risk === "caution" && reversible) {
    return result("auto", reason, null, risk, resolvedModel, extra);
  }

  // 5. 兜底：其余全部 confirm。
  return result("confirm", reason, null, risk, resolvedModel, extra);
}
