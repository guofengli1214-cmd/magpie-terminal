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
    throw new GatewayError(
      `GATEWAY_HTTP_${result.status}`,
      `gateway returned ${result.status}`,
      `AI 网关返回错误（HTTP ${result.status}），命令仍可手动输入。`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new GatewayError("AI_BAD_JSON", "gateway body is not json", "AI 网关返回了无法解析的内容。");
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
    throw new GatewayError("AI_BAD_JSON", "no command in model reply", "AI 没能给出可解析的命令，请换个说法。");
  }

  return {
    command: extracted.command,
    reason: extracted.reason,
    model: chosenModel,
    durationMs: result.durationMs,
  };
}

/** 探活：GET /v1/models。 */
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
  const parsed = JSON.parse(result.text);
  if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0) {
    throw new GatewayError("GATEWAY_UNREACHABLE", "models list empty", "AI 网关没有返回任何模型。");
  }
  return { count: parsed.data.length, durationMs: result.durationMs };
}
