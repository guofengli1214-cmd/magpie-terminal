// 判级链（PROTOCOL-AGENT.md §5，TASK-FIX17-J R3 重排）。
//
// 严格按顺序，命中即返回：
//   0. 空命令                                               → confirm（noop）
//   1. 灾难级禁止（forbidden.catastrophicReason）            → confirm，**不调审阅**
//   2. 敏感路径读取（sensitive.sensitiveReadTarget）         → confirm（白名单也绕不过）
//   3. 用户白名单（config.allowlist）                        → auto
//   4. 内置只读白名单（classify）                            → 它说 auto 就 auto
//   5. 切不开的命令（unparsable / redirect / substitution …）→ confirm，不交审阅
//   6. reviewModel === ""（用户关掉审阅）                    → confirm
//   7. 第二 AI 审阅（带**全量**对话历史 + 目标事实）
//      7a. 失败 / 超时                                       → confirm（REVIEW_FAILED）
//      7b. risk === "danger"                                 → confirm
//      7c. autonomy === "strict"                             → confirm
//      7d. 普通黑名单层（blacklistReason 或 classify deny:*）
//          且 aligned === true 且 护栏通过                     → auto
//      7e. 破坏性命令但护栏不过                               → confirm（护栏是独立闸门）
//      7f. 其余按档位：balanced = safe && reversible；
//          loose 再加 caution && reversible                   → auto
//      其余                                                  → confirm
//
// 为什么第 1 级和第 7 级要分开（TASK-FIX17-J 的核心）：
//   以前「硬禁止」是一整张表，`chmod -R ./dist`、`git push --force`、`rm -rf ./build`
//   这类「用户自己就想要」的操作也被一刀切成永远人工，于是满屏没意义的确认。
//   现在只有**灾难级**（提权 / 格式化 / 关机 / 删根删家目录 / 管道进解释器 /
//   reg delete / 根目录权限 / 改所有权）永远人工；其余黑名单交给审阅按对话意图判定，
//   但**必须**再过一道不依赖 AI 的静态护栏（工作目录内，或对话里点名过）。
//
// 第 1 级与第 2 级任何档位、任何白名单都不能绕过 —— 这是 AC1 / AC6 的锁。

import { classify } from "../policy/classify.mjs";
import { builtinRulesFrom } from "../policy/allowlist.mjs";
import { blacklistReason, catastrophicReason } from "../policy/forbidden.mjs";
import { extractDestructiveTargets, guardTargets, targetFacts } from "../policy/destructive-targets.mjs";
import { sensitiveReadTarget } from "../policy/sensitive.mjs";
import { matchAllowlist } from "./allowlist.mjs";
import { reviewCommand, serializeHistoryForReview } from "./review.mjs";

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

/** `classify` 的 hit 以 deny: 开头 = 落在「默认要确认」的黑名单里。 */
function isDenyHit(builtin) {
  return Boolean(builtin && typeof builtin.hit === "string" && builtin.hit.startsWith("deny:"));
}

/**
 * 判级。
 *
 * @param {{command?: string, config?: object, cwd?: string, model?: string,
 *          review?: Function, log?: Function,
 *          history?: Array<{role:string, content:string}>|null,
 *          shell?: string, session?: object|null, signal?: AbortSignal|null}} input
 *   `review` 可注入假审阅函数（测试用），签名与 reviewCommand 相同。
 *   `log` 注入日志函数（测试用）；生产由 agent 传进来，每次审阅写一行 `[REVIEW]`。
 *   `history` 是与用户对话会话**同一份**全量历史（buildHistoryMessages 的结果）；
 *   没传 `history` 但传了 `session` 时，这里现算一次（等价，别让调用方漏传就丢上下文）。
 * @returns {Promise<{decision:"auto"|"confirm", reason:string, hit:string|null,
 *          risk:"safe"|"caution"|"danger"|null, effect:string|null, confirmWhy:string|null,
 *          reversible:boolean|null, reviewModel:string|null,
 *          aligned:boolean|null, justification:string|null, tier:string,
 *          guardOk:boolean, cachedTokens:number|null}>}
 */
export async function judge({ command, config, cwd, model, review, log, history, shell, session, signal } = {}) {
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
    aligned: extra && typeof extra.aligned === "boolean" ? extra.aligned : null,
    justification:
      extra && typeof extra.justification === "string" && extra.justification.length > 0
        ? extra.justification
        : null,
    tier: extra && typeof extra.tier === "string" ? extra.tier : "normal",
    guardOk: extra && typeof extra.guardOk === "boolean" ? extra.guardOk : true,
    cachedTokens:
      extra && typeof extra.cachedTokens === "number" && Number.isFinite(extra.cachedTokens)
        ? extra.cachedTokens
        : null,
  });

  const text = typeof command === "string" ? command : "";

  // 0. 空命令 / 非字符串：不调审阅，直接确认（与 classify 的 noop 分支一致）。
  if (text.trim().length === 0) {
    return result("confirm", "空命令不执行", "noop", null, null, { tier: "normal" });
  }

  // 1. 灾难级：任何档位、任何白名单、AI 审阅都不能自动放行。
  //    这里**不调审阅**（灾难级不在审阅的放行范围内，调了也只是白花钱）。
  const catastrophic = catastrophicReason(text);
  if (catastrophic) {
    return result("confirm", `硬性禁止：${catastrophic}`, catastrophic, null, null, {
      tier: "catastrophic",
      guardOk: false,
    });
  }

  // 2. 敏感路径读取：用户白名单也不能自动放行读密钥的操作。
  //     否则用户在设置页写一条 `cat` 的 prefix 白名单，`cat secrets.key`
  //     就又变成 auto 了（P0-3 的另一条腿）。
  const sensitiveHit = sensitiveReadTarget(text);
  if (sensitiveHit) {
    return result("confirm", "这条命令会读出密钥或凭据文件，需要你确认", "deny:sensitive-path", null, null, {
      tier: "normal",
    });
  }

  // 3. 用户白名单。
  const allowHit = matchAllowlist(text, conf.allowlist);
  if (allowHit) {
    return result("auto", "你的白名单", allowHit.hit, null, null, { tier: "normal" });
  }

  // 4. 内置只读白名单。
  //    TASK-FIX17-I R2：清单来自配置（`builtinAllowlist`，设置页可增/删/改）。
  //    缺字段 → `builtinRulesFrom` 返回默认
  //    `DEFAULT_ALLOWLIST`，所以老配置与以前逐字一致。
  //    **黑名单 / 危险参数表 / 参数级允许集仍然硬编码**（由 classify 内部保证）。
  const builtin = classify(text, { allowlist: builtinRulesFrom(conf.builtinAllowlist) });
  if (builtin && builtin.decision === "auto") {
    return result(
      "auto",
      builtin.reason || "内置只读白名单",
      builtin.hit === undefined ? null : builtin.hit,
      null,
      null,
      { tier: "normal" },
    );
  }

  // 5. 切不开的命令不许交给审阅（P1-3）。
  //     命令切不开（换行 / 重定向 / 命令替换 / 引号不闭合 / 空段）时，
  //     审阅模型看到的往往是「第一行看起来无害」的片段，会误判成 safe。
  //     这类命令一律直接确认，不给审阅开口子的机会。
  if (builtin && UNREVIEWABLE_HITS.has(String(builtin.hit))) {
    return result("confirm", builtin.reason || "这条命令无法静态判定，需要你确认", builtin.hit, null, null, {
      tier: "normal",
    });
  }

  // 6. 审阅被用户关掉（设置页里 reviewModel === ""）。
  //    那是用户明确的全局开关（PROTOCOL §1 的 reviewModel 语义），不是档位差异；
  //    关掉以后等于「全都要确认」，同样不会自动放行任何命令。
  if (reviewModelSetting === "") {
    return result(
      "confirm",
      builtin && builtin.reason ? `${builtin.reason}（审阅已关闭，一律确认）` : "需要你确认（审阅已关闭）",
      builtin ? builtin.hit : null,
      null,
      null,
      { tier: "normal" },
    );
  }

  // 7. 送审前把「上下文 + 黑名单层级 + 静态护栏」都算好（一次 tokenize 的成果复用）。
  const blacklistHit = blacklistReason(text);
  // 破坏性命令头（rm/rmdir/del/erase/mv/move/cp/copy）也算「黑名单层」：
  // 它们要么在 allowlist 的 DENY_HEADS 里（rm/mv/del/cp → deny:*），要么是同一家族
  // （rmdir/erase/move/copy → classify 只给 default:*）。不归到这一层的话，`rmdir 空目录`
  // （模型删空文件夹最常用的写法）永远只能 confirm，正好违背用户那句「删空文件夹一定要放行」。
  const destructive = extractDestructiveTargets(text);
  const blacklistish = Boolean(blacklistHit) || isDenyHit(builtin) || destructive.heads;
  const tier = blacklistish ? "blacklist" : "normal";

  let effectiveHistory = Array.isArray(history) ? history : null;
  if (effectiveHistory === null && session && typeof session === "object") {
    // 没传 history 就从会话现算（动态 import：agent.mjs 依赖本模块，静态 import 会成环）。
    try {
      const agentModule = await import("./agent.mjs");
      effectiveHistory = agentModule.buildHistoryMessages(session);
    } catch {
      effectiveHistory = [];
    }
  }
  const historyText = serializeHistoryForReview(effectiveHistory || []);

  // 破坏性命令才解析目标 / stat（非破坏性命令零 IO）。
  const guard = destructive.heads
    ? guardTargets({
        targets: destructive.targets,
        cwd,
        historyText,
        targetsUnresolved: destructive.targetsUnresolved,
      })
    : { ok: true, reason: null, blocked: [] };
  const facts = destructive.heads ? targetFacts(destructive.targets, cwd) : null;

  const reviewModelId =
    typeof reviewModelSetting === "string" && reviewModelSetting.trim().length > 0
      ? reviewModelSetting.trim()
      : conversationModel || null;

  const doReview = typeof review === "function" ? review : reviewCommand;
  const reviewStartedAt = Date.now();

  let verdict;
  let failure = null;
  try {
    verdict = await doReview({
      command: text,
      model: reviewModelId,
      cwd,
      history: effectiveHistory || [],
      shell,
      targetFacts: facts,
      signal,
      // TASK-FIX17-L4 R3：审阅模型的推理强度（null = 不指定，不传 reasoning_effort）。
      reasoning: conf.reviewReasoning === undefined ? null : conf.reviewReasoning,
      // 降级日志（REASONING_SKIPPED）用同一个 log：审阅失败日志已经在这里落。
      log: logFn,
    });
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
      tier,
      guardOk: guard.ok,
      historyChars: historyText.length,
      durationMs: Date.now() - reviewStartedAt,
    });
    return result("confirm", REVIEW_UNAVAILABLE_REASON, null, null, null, {
      tier,
      guardOk: guard.ok,
    });
  }

  const risk = verdict.risk;
  const effect = typeof verdict.effect === "string" ? verdict.effect : "";
  const confirmWhy = typeof verdict.confirmWhy === "string" ? verdict.confirmWhy : "";
  const reversible = verdict.reversible === true;
  const aligned = typeof verdict.aligned === "boolean" ? verdict.aligned : null;
  const justification = typeof verdict.justification === "string" ? verdict.justification.trim() : "";
  const resolvedModel = typeof verdict.model === "string" && verdict.model.length > 0 ? verdict.model : reviewModelId;
  const cachedTokens =
    typeof verdict.cachedTokens === "number" && Number.isFinite(verdict.cachedTokens) ? verdict.cachedTokens : null;
  const extra = {
    effect: effect || null,
    confirmWhy: confirmWhy || null,
    reversible,
    aligned,
    justification: justification || null,
    tier,
    guardOk: guard.ok,
    cachedTokens,
  };

  // 每次审阅写一行独立日志（PROTOCOL §5.3：risk / effect / confirmWhy / reversible / model / ms
  // + TASK-FIX17-J 新增 aligned / justification / guardOk / cachedTokens / historyChars / tier）。
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
    reversible,
    aligned,
    justification: justification || null,
    guardOk: guard.ok,
    guardReason: guard.ok ? null : guard.reason,
    cachedTokens,
    historyChars: historyText.length,
    tier,
    reviewModel: resolvedModel,
    reviewReasoning: conf.reviewReasoning === undefined ? null : conf.reviewReasoning,
    autonomy,
    durationMs: Date.now() - reviewStartedAt,
  });

  // 放行时的理由是「为什么这条符合你的意图」；要确认时优先说「为什么需要你点」。
  const autoReason = justification
    ? `AI 审阅：${justification}`
    : confirmWhy
      ? `AI 审阅：${confirmWhy}`
      : effect
        ? `AI 审阅：${effect}`
        : "AI 审阅";
  const reason = confirmWhy
    ? `AI 审阅：${confirmWhy}`
    : justification
      ? `AI 审阅：${justification}`
      : effect
        ? `AI 审阅：${effect}`
        : "AI 审阅";

  if (risk === "danger") {
    // danger 任何档位都不 auto（含 loose）。
    return result("confirm", reason, null, risk, resolvedModel, extra);
  }

  if (autonomy === "strict") {
    // 严格档：审阅只用于展示与日志，绝不据此自动放行。
    return result("confirm", reason, null, risk, resolvedModel, extra);
  }

  // 7d：普通黑名单层只能走这一条放行路：审阅说「这正是用户要做的事」+ 护栏通过。
  //     这是「删掉我自己建错的文件」「删一个空文件夹」不再弹确认的那条路。
  //     黑名单层**不许**落到 7f 的档位兜底 —— 否则 `git push --force` 在
  //     aligned=false 时也会因为 risk=safe 被放掉，等于绕开审阅。
  if (blacklistish) {
    if (aligned === true && guard.ok) {
      return result("auto", autoReason, null, risk, resolvedModel, extra);
    }
    if (!guard.ok) {
      // 护栏与审阅是两道独立闸门：审阅说符合意图也不能替护栏开口子。
      return result("confirm", `AI 审阅：${guard.reason}`, null, risk, resolvedModel, {
        ...extra,
        confirmWhy: guard.reason,
      });
    }
    return result("confirm", reason, null, risk, resolvedModel, extra);
  }

  // 7e：非黑名单的破坏性命令，但目标不在工作目录内、对话里也没提过 → 护栏拦下。
  if (destructive.heads && !guard.ok) {
    return result("confirm", `AI 审阅：${guard.reason}`, null, risk, resolvedModel, {
      ...extra,
      confirmWhy: guard.reason,
    });
  }

  // 7f：其余按档位（balanced：safe && reversible；loose 再加 caution && reversible）。
  if (risk === "safe" && reversible) {
    return result("auto", autoReason, null, risk, resolvedModel, extra);
  }

  if (autonomy === "loose" && risk === "caution" && reversible) {
    return result("auto", autoReason, null, risk, resolvedModel, extra);
  }

  // 兜底：其余全部 confirm。
  return result("confirm", reason, null, risk, resolvedModel, extra);
}
