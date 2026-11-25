// 网关客户端：只有 HTTP 调用，不执行命令，不决定命令是否安全。
// 必须用 fetch：curl/python-urllib 会被网关按浏览器签名拒掉（403）。

import { extractCommand } from "./extract.mjs";
import { buildContext } from "./context.mjs";

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3425";
export const DEFAULT_MODEL = "commandcode/deepseek/deepseek-v4.1-flash";
export const DEFAULT_TIMEOUT_MS = 20000;
export const MAX_TOKENS = 2048;

export function gatewayBaseUrl() {
  const fromEnv = process.env.MAGPIE_TERMINAL_GATEWAY_URL;
  if (fromEnv && /^https?:\/\//.test(fromEnv)) return fromEnv.replace(/\/+$/, "");
  return DEFAULT_GATEWAY_URL;
}

export function gatewayTimeoutMs() {
  const fromEnv = Number(process.env.MAGPIE_TERMINAL_GATEWAY_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TIMEOUT_MS;
}

function buildSystemPrompt() {
  return [
    "你是一个终端命令助手。根据用户的中文意图，给出**一条**可在当前终端直接执行的命令。",
    "只输出 JSON，不要输出任何解释性文字。格式固定：",
    '{"command":"…","reason":"…"}',
    "command 必须是单行、可直接执行的命令；如果无法给出命令，command 用空字符串。",
    // TASK.md §4.11 / D10：这一句以前写的是「不要执行破坏性操作」，
    // 模型会据此自我审查，把 `rm keepme.txt` 变成 {"command":""}，
    // 前端只能报 AI_BAD_JSON，确认卡永远不会出现。
    // 本设计里安全关口是确认卡，不是模型的自我审查。
    "你自己不执行任何命令。应用只会自动执行只读白名单里的命令，",
    "其余命令（包括 rm / mv 这类删除、移动）都会放进确认卡，由用户亲自点「执行」后才会运行。",
    "因此请照常给出用户要的那条命令，包括 rm / mv；不要因为它是破坏性操作就返回空 command。",
    "反例（必须避免）：用户说「删掉这个文件」，不要回 {\"command\":\"\",\"reason\":\"破坏性操作\"}。",
    '正例：用户说「删掉这个文件」→ 应当给出 {"command":"rm <文件名>","reason":"删除文件"}。',
    "唯一绝对不给的是 sudo（提权是硬性禁止，不是普通确认）。",
    // TASK.md §4.11：find 已不在只读白名单（参数空间太大，-fprint/-exec 都能写盘）。
    // 必须在提示词里说清楚，否则模型会一直给 find，用户每条都弹确认。
    "不要使用 find。文件检索用 rg -n（搜内容）、rg --files（列文件）或 ls。",
    "查看 HTTP 头用 curl -I；不要用 curl 下载或上传（-o/-O/-T/-d/-K 一律会被拦截）。",
  ].join("\n");
}

/**
 * 提示词的回归锁：导出它，测试才能断言「不得自我审查」这类约束。
 * 生产路径用 buildSystemPrompt()，两者是同一个函数。
 */
export function systemPrompt() {
  return buildSystemPrompt();
}

function buildUserMessage(question, context) {
  const ctx = buildContext(context);
  return [
    `当前工作目录：${ctx.cwd}`,
    `当前 shell：${ctx.shell}`,
    ctx.recentOutput ? `终端最近输出：\n${ctx.recentOutput}` : "终端最近没有输出。",
    "",
    `用户意图：${typeof question === "string" ? question : ""}`,
  ].join("\n");
}

class GatewayError extends Error {
  constructor(code, message, userText) {
    super(message);
    this.code = code;
    this.userText = userText;
  }
}

async function requestJson(path, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${gatewayBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text, durationMs: Date.now() - startedAt };
  } catch (err) {
    if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
      throw new GatewayError("GATEWAY_TIMEOUT", "gateway request timed out", "AI 网关响应超时，请稍后重试。");
    }
    throw new GatewayError(
      "GATEWAY_UNREACHABLE",
      `gateway unreachable: ${err && err.message ? err.message : String(err)}`,
      "连不上本机 AI 网关（127.0.0.1:3425），请确认 magpie 网关在运行。",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 询问网关并返回 {command, reason, model, durationMs}。
 * 失败一律抛 GatewayError（带 code / userText）。
 */
export async function askGateway({ question, context, model } = {}) {
  const timeoutMs = gatewayTimeoutMs();
  const chosenModel = model || process.env.MAGPIE_TERMINAL_MODEL || DEFAULT_MODEL;

  const body = {
    model: chosenModel,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserMessage(question, context) },
    ],
  };

  const result = await requestJson(
    "/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );

  if (result.status !== 200) {
    const err = new GatewayError(
      `GATEWAY_HTTP_${result.status}`,
      `gateway returned ${result.status}`,
      `AI 网关返回错误（HTTP ${result.status}），命令仍可手动输入。`,
    );
    rememberModelFailure(chosenModel, err);
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    const err = new GatewayError("GATEWAY_BAD_JSON", "gateway body is not json", "AI 网关返回了无法解析的内容。");
    rememberModelFailure(chosenModel, err);
    throw err;
  }

  const content =
    parsed &&
    Array.isArray(parsed.choices) &&
    parsed.choices[0] &&
    parsed.choices[0].message &&
    typeof parsed.choices[0].message.content === "string"
      ? parsed.choices[0].message.content
      : "";

  const extracted = extractCommand(content);
  if (!extracted.ok) {
    // 不是三种「模型不可用」错误码之一：模型回话了，只是没给出可解析的命令。
    // 这种失败不记进失败记忆（否则用户问错一句就把模型标灰 10 分钟）。
    throw new GatewayError("AI_BAD_JSON", "no command in model reply", "AI 没能给出可解析的命令，请换个说法。");
  }

  clearModelFailure(chosenModel);
  return {
    command: extracted.command,
    reason: extracted.reason,
    model: chosenModel,
    durationMs: result.durationMs,
  };
}

// ---------------------------------------------------------------------------
// 模型清单 + 「失败后记忆」
//
// 为什么不做启动探测：6 个模型逐个打一遍最坏要 34 秒（每个都可能等到超时），
// 页面会一直空白。改为「真正调用失败之后才记一笔」，TTL 10 分钟，成功一次即清除。
// 记忆只在进程内存里：重启丢失是可接受的（重启后本来就要重新验证）。
// ---------------------------------------------------------------------------

/** 失败记忆的 TTL（TASK-V2-A §2.3）。 */
export const MODEL_FAILURE_TTL_MS = 10 * 60 * 1000;

/** 哪些错误码代表「这个模型本身不可用」，值得记一笔。 */
export const REMEMBERED_FAILURE_CODES = Object.freeze([
  "GATEWAY_HTTP_404",
  "GATEWAY_HTTP_502",
  "GATEWAY_BAD_JSON",
]);

/** modelId -> { note, at } */
const modelFailures = new Map();

function pruneFailures(now = Date.now()) {
  for (const [id, entry] of modelFailures) {
    if (now - entry.at >= MODEL_FAILURE_TTL_MS) modelFailures.delete(id);
  }
}

/**
 * 记录一次模型失败。只在 REMEMBERED_FAILURE_CODES 之内记。
 * @param {string} modelId
 * @param {{code:string, userText:string}} err
 */
export function rememberModelFailure(modelId, err) {
  if (typeof modelId !== "string" || modelId.length === 0) return;
  if (!err || !REMEMBERED_FAILURE_CODES.includes(err.code)) return;
  pruneFailures();
  const note = `${err.userText || err.code}（${err.code}）`;
  modelFailures.set(modelId, { note, at: Date.now() });
}

/** 成功一次即清除记忆。 */
export function clearModelFailure(modelId) {
  if (typeof modelId !== "string") return;
  modelFailures.delete(modelId);
}

/** 当前失败记忆的只读快照（测试与 /api/models 用）。 */
export function modelFailuresSnapshot() {
  pruneFailures();
  return new Map([...modelFailures].map(([id, entry]) => [id, { ...entry }]));
}

/** 仅供测试：清空全部记忆。 */
export function resetModelFailures() {
  modelFailures.clear();
}

function toModelEntry(raw) {
  const id = raw && typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;
  const label =
    typeof raw.magpie_label === "string" && raw.magpie_label.trim().length > 0
      ? raw.magpie_label
      : id;
  const contextLength = Number.isFinite(raw.context_length) ? raw.context_length : null;
  // TASK-FIX17-L4 R2：推理能力透传给前端（下拉选项的唯一来源）。
  // `reasoning_levels` 是网关给的真实档位（例如 ["low","high","max"]），
  // 不过滤空串以外的判断：只收非空字符串，其余一律丢掉 → 没有就是 []。
  const reasoningLevels = Array.isArray(raw.reasoning_levels)
    ? raw.reasoning_levels.filter((level) => typeof level === "string" && level.trim().length > 0)
    : [];
  return {
    id,
    label,
    contextLength,
    reasoningLevels,
    supportsReasoning: raw.reasoning === true,
  };
}

/**
 * 推理支持信息的缓存时长（TASK-FIX17-L4 R3）。
 *
 * 为什么需要缓存：生成前要回答「这个模型支持推理吗」，唯一可靠来源是网关的
 * `/v1/models`（`reasoning` + `reasoning_levels`）。每次生成都探一次会在
 * 用户每句提问前白等一个往返；60 秒足够覆盖一段连续对话，又不会把刚换的模型
 * 能力记错一分钟以上。
 */
export const REASONING_SUPPORT_TTL_MS = 60 * 1000;

/** { at:number, byId:Map<string,{supportsReasoning:boolean, reasoningLevels:string[]}> } */
let reasoningSupportCache = null;

/** 仅供测试：清空推理能力缓存（换 stub 网关时必须调，否则上一轮的清单会污染）。 */
export function resetReasoningSupportCache() {
  reasoningSupportCache = null;
}

/**
 * 查一个模型的推理能力。永不抛错。
 *
 * @param {string} modelId
 * @returns {Promise<{known:boolean, supportsReasoning:boolean, reasoningLevels:string[]}>}
 *   `known:false` = 网关不可达 / 清单里没有这个 id。此时**不做降级判断**
 *   （宁可按用户选的值发：用户明确设了档，静默丢弃比网关报错更让人困惑）。
 */
export async function reasoningSupportFor(modelId) {
  const id = typeof modelId === "string" ? modelId : "";
  const now = Date.now();
  if (!reasoningSupportCache || now - reasoningSupportCache.at >= REASONING_SUPPORT_TTL_MS) {
    try {
      const probe = await probeGateway();
      const byId = new Map();
      for (const model of probe.models) {
        byId.set(model.id, {
          supportsReasoning: model.supportsReasoning === true,
          reasoningLevels: Array.isArray(model.reasoningLevels) ? model.reasoningLevels : [],
        });
      }
      reasoningSupportCache = { at: Date.now(), byId };
    } catch {
      // 网关不可达：缓存一段「不知道」，别让每句提问都白等 5 秒 probes。
      reasoningSupportCache = { at: Date.now(), byId: new Map() };
      return { known: false, supportsReasoning: true, reasoningLevels: [] };
    }
  }
  const hit = reasoningSupportCache.byId.get(id);
  if (!hit) return { known: false, supportsReasoning: true, reasoningLevels: [] };
  return { known: true, ...hit };
}

/**
 * 把「用户选的档位」解成「这次请求该发的 reasoningEffort」。
 *
 * TASK-FIX17-L4 R3 的两条硬规则：
 *   1. 没设（null / ""）→ 返回 null，调用方**整块不给 providerOptions**
 *      （请求体里连 `reasoning_effort: null` 都不出现）。
 *   2. 模型明确不支持（`reasoning !== true`）但用户设了值 → 降级为不传，
 *      记一条 `code:"REASONING_SKIPPED"` warn（不阻断这次生成）。
 *
 * @param {{level?:string|null, modelId?:string, log?:Function, where?:string}} input
 * @returns {Promise<string|null>}
 */
export async function resolveReasoningEffort({ level, modelId, log, where } = {}) {
  if (typeof level !== "string" || level.trim().length === 0) return null;
  const wanted = level.trim();
  const support = await reasoningSupportFor(modelId);
  if (support.known && !support.supportsReasoning) {
    if (typeof log === "function") {
      log({
        level: "warn",
        code: "REASONING_SKIPPED",
        msg: "model does not support reasoning; effort dropped",
        model: typeof modelId === "string" ? modelId : null,
        requested: wanted,
        where: typeof where === "string" ? where : null,
      });
    }
    return null;
  }
  return wanted;
}

/**
 * 探活 + 拉模型清单：GET /v1/models。
 *
 * 保留 `count` / `durationMs` 给现有调用方（test/pty/session.test.mjs）。
 * 新增 `models: [{id,label,contextLength,available,note}]` 与 `baseUrl`。
 *
 * 网关可达但清单为空 → 抛 GATEWAY_UNREACHABLE（与旧行为一致，现有测试依赖）。
 */
export async function probeGateway() {
  const timeoutMs = Math.min(gatewayTimeoutMs(), 5000);
  const result = await requestJson("/v1/models", { method: "GET" }, timeoutMs);
  if (result.status !== 200) {
    throw new GatewayError(
      `GATEWAY_HTTP_${result.status}`,
      `gateway models returned ${result.status}`,
      `AI 网关不可用（HTTP ${result.status}）。`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new GatewayError("GATEWAY_BAD_JSON", "models body is not json", "AI 网关返回了无法解析的模型清单。");
  }
  if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0) {
    throw new GatewayError("GATEWAY_UNREACHABLE", "models list empty", "AI 网关没有返回任何模型。");
  }
  const failures = modelFailuresSnapshot();
  const models = parsed.data
    .map(toModelEntry)
    .filter(Boolean)
    .map((model) => {
      const failure = failures.get(model.id);
      return {
        ...model,
        available: !failure,
        note: failure ? failure.note : null,
      };
    });
  return {
    count: models.length,
    durationMs: result.durationMs,
    baseUrl: gatewayBaseUrl(),
    models,
  };
}
