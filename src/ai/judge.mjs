// 五级判级链（PROTOCOL-AGENT.md §5）。
//
// 严格按顺序，命中即返回：
//   1. 硬禁止（src/policy/forbidden.mjs）      → 永远 confirm
//   1.5 敏感路径读取（src/policy/sensitive.mjs）→ 永远 confirm（白名单也绕不过）
//   2. 用户白名单（config.allowlist，§2 语义） → auto
//   3. 内置只读白名单（src/policy/classify.mjs）→ 它说 auto 就 auto
//   3.5 切不开的命令（unparsable / redirect / substitution …）→ 直接 confirm，不交审阅
//   4. 第二 AI 审阅（src/ai/review.mjs）        → 按 autonomy 映射
//   5. 兜底                                     → confirm
//
// `autonomy === "strict"` 时跳过第 4 级（不调审阅，直接 confirm）。
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
 *          review?: Function}} input
 *   `review` 可注入假审阅函数（测试用），签名与 reviewCommand 相同。
 * @returns {Promise<{decision:"auto"|"confirm", reason:string, hit:string|null,
 *          risk:"safe"|"caution"|"danger"|null, reviewModel:string|null}>}
 */
export async function judge({ command, config, cwd, model, review } = {}) {
  const conf = config && typeof config === "object" ? config : {};
  const autonomy = conf.autonomy === "strict" || conf.autonomy === "loose" ? conf.autonomy : "balanced";
  const reviewModelSetting = conf.reviewModel === undefined ? null : conf.reviewModel;
  const conversationModel = typeof model === "string" && model.length > 0 ? model : null;

  // 文档化的五个字段之外额外带上 `reviewWhy` / `reversible`：
  // 前者是审阅原话（agent.approval 帧要单独展示），后者是审阅的「可撤销」结论。
  // 没有审阅时两者都是 null。这两个是新增键，没有改名、没有替代任何文档化字段。
  const result = (decision, reason, hit, risk, reviewModel, extra) => ({
    decision,
    reason,
    hit: hit === undefined ? null : hit,
    risk: risk === undefined ? null : risk,
    reviewModel: reviewModel === undefined ? null : reviewModel,
    reviewWhy: extra && typeof extra.reviewWhy === "string" ? extra.reviewWhy : null,
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

  // 审阅关闭（reviewModel === ""）或严格档：不调审阅，直接确认。
  if (reviewModelSetting === "") {
    return result("confirm", builtin && builtin.reason ? builtin.reason : "需要你确认", builtin ? builtin.hit : null, null, null);
  }
  if (autonomy === "strict") {
    return result("confirm", builtin && builtin.reason ? builtin.reason : "严格档：需要你确认", builtin ? builtin.hit : null, null, null);
  }

  // 4. 第二 AI 审阅。
  const reviewModelId =
    typeof reviewModelSetting === "string" && reviewModelSetting.trim().length > 0
      ? reviewModelSetting.trim()
      : conversationModel || null;

  const doReview = typeof review === "function" ? review : reviewCommand;

  let verdict;
  try {
    verdict = await doReview({ command: text, model: reviewModelId, cwd });
  } catch {
    verdict = null;
  }

  if (!verdict || (verdict.risk !== "safe" && verdict.risk !== "caution" && verdict.risk !== "danger")) {
    return result("confirm", REVIEW_UNAVAILABLE_REASON, null, null, null);
  }

  const risk = verdict.risk;
  const why = typeof verdict.why === "string" && verdict.why.length > 0 ? verdict.why : "";
  const reversible = verdict.reversible === true;
  const resolvedModel = typeof verdict.model === "string" && verdict.model.length > 0 ? verdict.model : reviewModelId;

  const extra = { reviewWhy: why || null, reversible: verdict.reversible === true };

  if (risk === "safe") {
    return result("auto", why ? `AI 审阅：${why}` : "AI 审阅：只读操作", null, risk, resolvedModel, extra);
  }
  if (risk === "caution" && autonomy === "loose" && reversible === true) {
    return result("auto", why ? `AI 审阅：${why}` : "AI 审阅：可撤销的写操作", null, risk, resolvedModel, extra);
  }

  // 5. 兜底：其余全部 confirm。
  return result("confirm", why ? `AI 审阅：${why}` : "需要你确认", null, risk, resolvedModel, extra);
}
