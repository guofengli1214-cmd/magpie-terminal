// HTTP 服务：路由表、静态资源、门禁、tokens 注入。
// 鉴权先于路由；未知 /api/* 也先鉴权再 404。

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOKEN_BYTES,
  checkHttpGate,
  checkToken,
  generateToken,
  isNavigationRequest,
  maskToken,
  readToken,
  tokenMetaTag,
} from "./auth.mjs";
import { buildHealth } from "./routes/health.mjs";
import { DEFAULT_MODEL, gatewayBaseUrl, probeGateway } from "../ai/gateway.mjs";
import {
  KNOWN_FIELDS,
  addHost,
  defaultDownloadDir,
  getHostRecord,
  listHosts,
  publicConfig,
  readConfig,
  rememberKnownHost,
  removeHost,
  saveSecret,
  updateConfig,
  updateHost,
  validateConfigPatch,
} from "../config/store.mjs";
import { z } from "zod";
import { RemoteRegistry, fingerprintForHost, listFiles, testHostConnection } from "../ssh/registry.mjs";
import { stat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { buildPolicy } from "./routes/policy.mjs";
import { handleAiPost } from "./routes/ai.mjs";
import { handleLocalFs, handleRemoteFs } from "./routes/fs.mjs";
import { isStaticPath, readAppFile, sendStatic } from "./static.mjs";
import { attachWebSocket } from "./ws.mjs";
import { LOG_FILE_NAME, LOG_ROTATED_NAME, createLogWriter, formatLogLine } from "./logger.mjs";
import { redactText } from "./log-redact.mjs";
import { saveTextToDir } from "../fs/export.mjs";
import { readMagpieSettings, normalizeAccent } from "../config/magpie-settings.mjs";
import { detectInstallKind } from "../config/install-kind.mjs";
import { checkForUpdate, normalizeRepository } from "../config/update-check.mjs";
import { TITLE_MAX, createSessionStore } from "../ai/sessions.mjs";
import { detectShell, loadNodePty, LOCKED_NODE_PTY_VERSION } from "../pty/bridge.mjs";
import { SessionManager } from "../pty/session.mjs";
import { detectShells, resolveShellById, resolveShellForRequest } from "../pty/shells.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";
const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

/**
 * 读 package.json 的版本三件套（TASK-FIX17-G R1）。
 *
 * 只在 `startServer()` 里读一次：版本/仓库地址在进程生命周期内不会变，
 * 而 `/api/version` 每次请求都读盘既无意义又会把「文件被临时改动」带进响应。
 * 读不到时回落到内置常量，服务照常起（绝不因为 package.json 坏了 500）。
 */
async function readPackageMetadata() {
  let data = null;
  try {
    data = JSON.parse(await readFile(PACKAGE_JSON_URL, "utf8"));
  } catch {
    data = null;
  }
  const source = data && typeof data === "object" ? data : {};
  return {
    version:
      typeof source.version === "string" && source.version.trim().length > 0
        ? source.version.trim()
        : VERSION,
    name:
      typeof source.name === "string" && source.name.trim().length > 0
        ? source.name.trim()
        : "magpie-terminal",
    repository: source.repository === undefined ? null : source.repository,
  };
}

export const MAX_BODY_BYTES = 64 * 1024;

/**
 * 重复告警的默认限流窗口（TASK-FIX17-E2 R3）：同一 `level|code|route` 60 秒内
 * 只落一条，其余只计数，窗口结束后的下一条带 `suppressed`。
 */
export const LOG_DEDUPE_WINDOW_MS = 60_000;

/**
 * CSP 的 connect-src 必须跟着实际端口走；3480 时与规范原文逐字一致。
 *
 * style-src 必须带 'unsafe-inline'（TASK.md §4.4）：
 * ① 服务端注入的 <style>:root{…tokens…}</style> 是内联样式，'self' 只管外链样式表，
 *    实测被拦后主题变量全部失效；
 * ② xterm.js 运行期自己 createElement("style") / setAttribute("style", …) / insertRule，
 *    nonce 方案拿不到 nonce，只有 'unsafe-inline' 可行。
 * 脚本仍然严格 'self'，不放宽。
 *
 * **绝对不能加 `frame-ancestors`**（第 6 轮实测）：
 * magpie 桌面窗口把插件页放进 `<iframe sandbox="allow-scripts">`，沙箱文档是
 * opaque origin，父页是 `http://wails.localhost`，跨源嵌框会被
 * `frame-ancestors 'self'` 拦下，浏览器直接显示 Chromium 错误页
 * （控制台原文：`Framing 'http://127.0.0.1:3480/' violates the following
 * Content Security Policy directive: "frame-ancestors 'self'"`）。
 * 也不要改成 `frame-ancestors http://wails.localhost` 之类的白名单：父页 host
 * 随平台/版本变化。官方 page-chat 的做法就是完全不发这条指令，这里跟随官方。
 */
export function buildCsp(port = 3480) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export const CSP = buildCsp(3480);

function timestamp() {
  return new Date().toISOString();
}

/**
 * 单行 JSON 日志；绝不记 token 原文与终端输入。
 *
 * TASK-FIX17-E：两条输出并列，缺一不可。
 *   ① stdout（`sink.log`）：宿主仍会收进它自己的 `app.log`，是「插件起来了」
 *      那条健康标志行（`plugin: [magpie-terminal] listening on …`）的来源，
 *      删了就等于拆掉现场排障的第 1 步；
 *   ② 自有文件（`%LOCALAPPDATA%\magpie\logs\show-terminal.log`）：带 2MB 轮转，
 *      可由设置页导出/清空。**写盘前已经过 `redact()`**，落地即安全。
 *
 * 写盘失败只 warn 一次（在 `createLogWriter` 里），绝不抛：日志是旁路，
 * 它不该有能力让服务退出。
 *
 * TASK-FIX17-E2 R3：**重复告警限流**。只作用于 `warn` / `error` 且带字符串
 * `code` 的条目（`info` 绝不限流——`SERVER_STARTED` 每次启动都必须有一行）。
 * 键 = `level|code|route`，窗口内同键只落**第一条**，其余只计数；窗口结束后的
 * 下一条落盘时追加 `suppressed: <上一窗口压掉的条数>`（没压掉就不加字段）。
 * 这样「日志被旧页面的 403 洪水滚掉」的问题消失，同时第一发与总量都还在。
 *
 * @param {Console|{log?:Function,warn?:Function}} [sink]
 * @param {{
 *   writer?: ReturnType<typeof createLogWriter>,
 *   file?: boolean,
 *   dedupeWindowMs?: number,
 *   now?: () => number,
 * }} [options]
 *   `dedupeWindowMs`：限流窗口（毫秒），默认 `LOG_DEDUPE_WINDOW_MS`；
 *   **`<= 0` 表示关闭限流**（探针要数原始 403 次数时用）。
 *   `now`：时钟注入，单测不真等 60 秒。
 */
export function makeLogger(sink = console, options = {}) {
  // `file: false` 给单测用：只打 stdout，不碰磁盘（也不会污染真实日志文件）。
  const writer =
    options.writer ||
    (options.file === false
      ? null
      : createLogWriter({
          warn: (message) => {
            if (sink && typeof sink.warn === "function") sink.warn(message);
            else console.warn(message);
          },
        }));
  // 限流窗口：默认 60s；`<= 0` 关闭（探针数原始条数用，见上面的注释）。
  const dedupeWindowMs = Number.isFinite(options.dedupeWindowMs)
    ? Number(options.dedupeWindowMs)
    : LOG_DEDUPE_WINDOW_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  /** @type {Map<string, {at:number, suppressed:number}>} */
  const dedupeState = new Map();

  function emit(entry) {
    // 同一份 `entry` 走两条路：stdout 与文件都用脱敏后的行。
    // 为什么 stdout 也脱敏：宿主那份 `app.log` 同样会被人导出去发给别人。
    const line = formatLogLine(entry, timestamp());
    if (typeof sink.log === "function") sink.log(line);
    if (writer) writer.write(line);
  }

  const log = function log(entry) {
    if (
      dedupeWindowMs > 0 &&
      entry &&
      (entry.level === "warn" || entry.level === "error") &&
      typeof entry.code === "string"
    ) {
      const key = `${entry.level}|${entry.code}|${entry.route || ""}`;
      const at = now();
      const state = dedupeState.get(key);
      if (state && at - state.at < dedupeWindowMs) {
        state.suppressed += 1;
        return;
      }
      // 新窗口（或首次出现）：把上一窗口压掉的条数带上，让「被折叠了多少」可查。
      const suppressed = state ? state.suppressed : 0;
      dedupeState.set(key, { at, suppressed: 0 });
      entry = suppressed > 0 ? { ...entry, suppressed } : entry;
    }
    emit(entry);
  };
  // 导出/清空/状态三个路由要用同一个 writer，挂在函数上而不是再建一个：
  // 两个 writer 各自缓存「目录已建」状态，会让轮转判断分叉。
  log.writer = writer;
  return log;
}

/**
 * CORS 头。规则与官方 page-chat 的 `corsHeaders()` 一致：
 *
 * - 沙箱 iframe 的 `Origin` 是字面量 `"null"` → 回 `access-control-allow-origin: null`
 *   （不能回 `*`：带 `null` origin 的请求要精确匹配，且我们不希望任意页面读取响应体）
 * - 自身 origin（`http://127.0.0.1:<port>` / `http://localhost:<port>`）→ 回自身
 * - 其他 Origin → 不回 ACAO（浏览器会按 CORS 失败处理）
 *
 * 为什么每个响应都要带：沙箱里 `type="module"` 的脚本是 CORS 请求，
 * 没有 ACAO 就被拦（控制台：`blocked by CORS policy: No
 * 'Access-Control-Allow-Origin' header`）。`app.js` 里的 `import "./core/…"`
 * 全是 module fetch，缺一个头就整页白屏。
 */
export function corsHeaders(req, port) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  const selfOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const headers = {
    "access-control-allow-headers": "content-type, x-magpie-term-token",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    vary: "Origin",
  };
  if (origin === "null") {
    headers["access-control-allow-origin"] = "null";
  } else if (typeof origin === "string" && selfOrigins.has(origin.toLowerCase())) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

function writeJson(res, status, payload, extraHeaders = {}, cors = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...cors,
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * 附件下载（`GET /api/logs/export`）。
 *
 * 与 `writeJson` 分开的原因：
 * - content-type 是纯文本，不能被 JSON 序列化；
 * - `Content-Disposition: attachment` + `filename` 是浏览器弹出下载对话框的
 *   唯一可靠信号（前端自己拼 blob 也行，但服务端给全了才能在 curl 里直接用）；
 * - 比 JSON 多两份头：`content-disposition` 与显式 `content-length`。
 */
function writeAttachment(res, body, filename, cors = {}) {
  const buffer = Buffer.from(body, "utf8");
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": buffer.length,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...cors,
  });
  res.end(buffer);
}

/** 导出文件名：`show-terminal-logs-<YYYYMMDD-HHmmss>.log`（卡片逐字要求）。 */
export function exportLogFilename(at = new Date()) {  const pad = (value) => String(value).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `show-terminal-logs-${stamp}.log`;
}

/**
 * GET / PUT `/api/config` 的响应体（TASK-FIX17-L1 R1）。
 *
 * `downloadDirDefault` 每次现算（`os.homedir()`）：不写死用户名，也不缓存 ——
 * 换账户 / 改家目录后下一次 GET 就该是新值。
 */
function publicConfigPayload(view) {
  return {
    model: view.model || DEFAULT_MODEL,
    autonomy: view.autonomy,
    allowlist: view.allowlist,
    reviewModel: view.reviewModel,
    basePrompt: view.basePrompt,
    defaultShell: view.defaultShell,
    showApprovalEffect: view.showApprovalEffect === true,
    downloadDir: view.downloadDir,
    // TASK-FIX17-L4 R1：推理强度（publicConfig() 已归一，这里只负责带出去）。
    conversationReasoning: view.conversationReasoning,
    reviewReasoning: view.reviewReasoning,
    downloadDirDefault: defaultDownloadDir(),
  };
}

function writeForbidden(res, cors = {}) {
  // 响应体不区分失败原因，避免成为判定预言机。
  // 但 CORS 头必须给：否则沙箱页面只能看到「CORS 错误」，
  // 分不清「没权限」和「网络坏了」。
  const body = JSON.stringify({ code: "FORBIDDEN" });
  res.writeHead(403, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...cors,
  });
  res.end(body);
}

/**
 * 解 query 里的 `tokens`（base64 JSON）。
 *
 * TASK-FIX17-B R1：**接受裸键**并归一成 `--magpie-<key>`。
 * 修之前这条链是断的：`page/boot.js` 的 bridge 给的 tokens 键是裸的
 * （`bg` / `fg` / `card` …），这里只收 `/^--/` 开头的键 → 全部被丢弃，
 * 实测注入是空的 `{}`。
 *
 * 同时继续接受已带前缀的键（`--magpie-bg` / `--bg`），幂等不重复加前缀。
 * 键与值的白名单在 `sanitizeTokens()`，任何不合法一律丢弃。
 *
 * @param {unknown} raw
 * @returns {Record<string,string>|null} 归一后的 `--magpie-*` 表；整体不可解析时 null
 */
export function decodeTokens(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  if (buffer.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return sanitizeTokens(parsed).tokens;
}

/* ------------------------------------------------------------------ *
 * 主题令牌（TASK-FIX17-B R1 / R2 / R3）
 *
 * 三层数据，优先级从高到低：
 *   1. bridge 缓存（page/boot.js 跳转前 POST 来的 magpie 真实令牌）——最准
 *   2. ~/.config/magpie/settings.json（theme / accent / textSize / lang）
 *      → `src/config/magpie-settings.mjs` 只读地读它
 *   3. MAGPIE_PALETTE 的兜底调色板（从宿主二进制里取到的浅/深两套实测值）
 *
 * `tokens` 是观感数据、**不是凭据**（theme-tokens.md §5）；口令是另一回事。
 * ------------------------------------------------------------------ */

/** bridge 上报的令牌里我们认得的键（其余原样保留，不猜语义也不丢）。 */
export const KNOWN_TOKEN_KEYS = Object.freeze([
  "bg",
  "fg",
  "fg-2",
  "line",
  "accent",
  "accent-fg",
  "accent-soft",
  "card",
  "sub",
  "muted",
  "surface",
  "surface-2",
  "edge",
  "warn",
  "bad",
  "ok",
  "ring",
  "font",
  "code",
]);

/**
 * magpie 的实测调色板（从宿主二进制的样式表里取到的两套值）。
 * 只作为兜底：bridge 或 `accent` 设置一给出真值，就用真值。
 */
export const MAGPIE_PALETTE = Object.freeze({
  light: Object.freeze({
    bg: "#f4f4f6",
    fg: "#1c1c21",
    "fg-2": "#4b4b53",
    card: "#ffffff",
    line: "#e3e3e8",
    // muted 是「最弱的一档文字」（`--term-muted` 在全仓用了 60 次）。
    // 它必须**两套都有值**：只给浅色一套的话，深色主题下会拿浅色的灰去配深底，
    // 对比度只有 3.6:1（实测），那些说明文字会发虚。
    muted: "#6b7280",
    accent: "#4f46e5",
    "accent-fg": "#ffffff",
  }),
  dark: Object.freeze({
    bg: "#1a1a1e",
    fg: "#ededf1",
    "fg-2": "#b9b9c1",
    card: "#232327",
    line: "#333339",
    muted: "#9aa4b0",
    accent: "#a5b4fc",
    "accent-fg": "#14142a",
  }),
});

/** accent 未设且 bridge 没给时的兜底色（浅色）。 */
export const DEFAULT_ACCENT = "#2563eb";

/* ---- 键 / 值白名单（安全项，AC10） ----
 *
 * 值是「用户可控字符串」，会拼进 <style> 与 JSON。所以用**允许集**：
 *   键  ^--[a-z0-9-]+$
 *   值  [#a-zA-Z0-9(),.%/ +-] 且不含 < > ; { } \ " ' 与换行
 * 任一不合法 → 该键丢弃，不报错（记一条不带原值的 warn）。
 */

/** 归一后的键。 */
const TOKEN_KEY_PATTERN = /^--[a-z0-9-]{1,42}$/;
/** 裸键（bridge 的 tokens 键不带前缀）。 */
const TOKEN_BARE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;
/** 值允许的字符集（允许集，不是黑名单）。 */
const TOKEN_VALUE_PATTERN = /^[#a-zA-Z0-9(),.%/+ -]{1,64}$/;
/** 值里绝不允许出现的字符（双保险）。 */
const TOKEN_VALUE_FORBIDDEN = /[<>{};\\"'\r\n]/;
/** 键长度上限（含前缀）。 */
const TOKEN_KEY_MAX = 44;

/**
 * 判断一个键是否合法，并给出归一后的名字。
 *
 * 归一规则（R1）：
 *   `bg`            → `--magpie-bg`
 *   `--bg`         → `--magpie-bg`   （裸键带 `--` 前缀的形态）
 *   `--magpie-bg` → `--magpie-bg`   （已经归一过，幂等）
 *
 * 为什么没有「原样保留 magpie 自有变量」的分支：bridge 的 `paint()` 对每个
 * token 都执行 `root.style.setProperty("--magpie-" + k, v)`（宿主二进制里的原文），
 * 所以页面上的变量名**永远**是 `--magpie-<裸键>`。一个 `--font` 输入的真意
 * 就是 magpie 的 `font` 令牌 → `--magpie-font`。留一个「原样透传 `--font`」的
 * 分支只会产生两份名字不同、语义相同的变量（实测不可达，已删）。
 *
 * @param {unknown} key
 * @returns {string|null} 归一后的键；不合法返回 null
 */
export function normalizeTokenKey(key) {
  if (typeof key !== "string") return null;
  const text = key.trim();
  if (!text || text.length > TOKEN_KEY_MAX) return null;
  // 已经归一过的：幂等返回（校验形状）。
  if (/^--magpie-[a-z0-9-]+$/.test(text)) return TOKEN_KEY_PATTERN.test(text) ? text : null;
  // 裸键：补 magpie- 前缀。
  if (TOKEN_BARE_KEY_PATTERN.test(text)) return `--magpie-${text}`;
  // `--bg` 这种「只带前缀的裸键」：同样补 magpie- 前缀。
  if (text.startsWith("--")) {
    const body = text.slice(2);
    if (TOKEN_BARE_KEY_PATTERN.test(body)) return `--magpie-${body}`;
  }
  return null;
}

/**
 * 判断一个值是否安全（可拼进 <style>）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeTokenValue(value) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const text = String(value).trim();
  if (!text || text.length > 64) return false;
  if (TOKEN_VALUE_FORBIDDEN.test(text)) return false;
  return TOKEN_VALUE_PATTERN.test(text);
}

/**
 * 归一 + 过滤一份「键 → 值」表。
 *
 * @param {unknown} raw
 * @returns {{tokens:Record<string,string>, dropped:number}}
 *   dropped 是丢弃的键数（只计数，绝不回显原值——它可能是注入串）。
 */
export function sanitizeTokens(raw) {
  const tokens = {};
  let dropped = 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { tokens, dropped };
  for (const [key, value] of Object.entries(raw)) {
    const name = normalizeTokenKey(key);
    if (!name || !isSafeTokenValue(value)) {
      dropped += 1;
      continue;
    }
    tokens[name] = String(value).trim();
  }
  return { tokens, dropped };
}

/**
 * 解析 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` 为 `[r,g,b]`。
 * @param {unknown} value
 * @returns {[number,number,number]|null}
 */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(text);
  if (hex) {
    const body = hex[1];
    const expand = (s) => Number.parseInt(s.length === 1 ? s + s : s, 16);
    if (body.length === 3 || body.length === 4) return [expand(body[0]), expand(body[1]), expand(body[2])];
    if (body.length === 6 || body.length === 8) {
      return [
        Number.parseInt(body.slice(0, 2), 16),
        Number.parseInt(body.slice(2, 4), 16),
        Number.parseInt(body.slice(4, 6), 16),
      ];
    }
    return null;
  }
  const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
  if (fn) {
    return [
      Math.min(255, Math.max(0, Math.round(Number(fn[1])))),
      Math.min(255, Math.max(0, Math.round(Number(fn[2])))),
      Math.min(255, Math.max(0, Math.round(Number(fn[3])))),
    ];
  }
  return null;
}

/**
 * sRGB 相对亮度（WCAG 定义，gamma 展开后再加权）。
 * @param {[number,number,number]} rgb
 * @returns {number} 0（黑）… 1（白）
 */
export function relativeLuminance(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return 0;
  const channel = (value) => {
    const c = Math.min(255, Math.max(0, Number(value))) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** 判定阈值：与 design.md 一致（0.45）。 */
export const DARK_LUMINANCE_THRESHOLD = 0.45;

/**
 * 由背景色判定是深色还是浅色。
 * @param {string} bg
 * @param {{theme?:string}} [hint]
 * @returns {"dark"|"light"}
 */
export function resolveScheme(bg, hint = {}) {
  // magpie 的 theme 设置是唯一权威（theme-tokens.md §4）；`system` 时才看亮度。
  const theme = typeof hint.theme === "string" ? hint.theme : "";
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  const rgb = parseColor(bg);
  if (!rgb) return "light";
  return relativeLuminance(rgb) < DARK_LUMINANCE_THRESHOLD ? "dark" : "light";
}

/**
 * 合成一套主题。
 *
 * 三种数据来源的优先级（theme-tokens.md §4「magpie 是唯一权威」）：
 *   1. `settings.theme === "dark"|"light"` → **直接决定**深浅色；bridge 报的
 *      旧令牌只有当时深浅色与现在一致时才拿来用（否则会得到另一套配色）。
 *   2. `settings.theme === "system"` → 跟随「已知的系统深浅色」。这个时候有两个可能
 *      的信号：bridge 上报的 `dark`（magpie 自己在启动时按操作系统算好的结果）与
 *      浏览器现读的 `prefers-color-scheme`。**bridge 优先**：theme-tokens.md §4 写明
 *      窗口主题可能被用户手动覆盖过，prefers-color-scheme 只反映操作系统，
 *      二者常常不一致；而且带路页给的 `?theme=` / `?tokens=` 正是映射到 bridgeScheme 的。
 *      没 bridge 时才用 prefer（在普通浏览器里直接开插件页的那种情况）。
 *   3. 都没有 → 浅色兜底。
 *
 * @param {object} input
 * @param {Record<string,string>} [input.bridgeTokens] 已归一过的 bridge 令牌
 * @param {"dark"|"light"|null} [input.bridgeScheme] bridge 上报时的深浅色
 * @param {object} [input.settings] magpie 设置（readMagpieSettings().settings）
 * @param {"dark"|"light"|null} [input.prefer] 调用方给的系统深浅色提示
 * @returns {{
 *   scheme:"dark"|"light",
 *   theme:string,
 *   source:string,
 *   textSize:number,
 *   lang:string,
 *   tokens:Record<string,string>,
 * }}
 */
export function composeTheme(input = {}) {
  const bridge = input.bridgeTokens && typeof input.bridgeTokens === "object" ? input.bridgeTokens : {};
  const settings = input.settings && typeof input.settings === "object" ? input.settings : {};
  const theme = typeof settings.theme === "string" ? settings.theme : "system";
  const bridgeScheme =
    input.bridgeScheme === "dark" || input.bridgeScheme === "light" ? input.bridgeScheme : null;
  const prefer = input.prefer === "dark" || input.prefer === "light" ? input.prefer : null;

  // 1) 定深浅色。
  let scheme;
  if (theme === "dark" || theme === "light") scheme = theme;
  // bridge 优先于浏览器现读的 matchMedia（理由见上面第 2 条）。
  else scheme = bridgeScheme || prefer || "light";

  // 2) bridge 令牌只在「同一套深浅色」下可用：magpie 改了主题而令牌还是旧的时，
  // 继续用旧令牌会得到「半套深色半套浅色」—— 正是本卡要修的症状。
  const bridgeUsable = bridgeScheme === scheme;
  const palette = MAGPIE_PALETTE[scheme];
  const accentSetting = normalizeAccent(settings.accent);
  const pick = (name, fallback) => (bridgeUsable && bridge[`--magpie-${name}`]) || fallback;

  const bg = pick("bg", palette.bg);
  // 拿到背景后再复核一次：背景亮度与设置冲突时以**背景亮度**为准（防「设置说深、颜色是浅」）。
  const finalScheme = resolveScheme(bg, theme === "system" ? {} : { theme });
  const finalPalette = MAGPIE_PALETTE[finalScheme];

  const accent = pick("accent", accentSetting || finalPalette.accent || DEFAULT_ACCENT);
  const accentFg = pick("accent-fg", finalPalette["accent-fg"] || "#ffffff");

  const tokens = {
    "--magpie-bg": bg,
    "--magpie-fg": pick("fg", finalPalette.fg),
    "--magpie-fg-2": pick("fg-2", finalPalette["fg-2"]),
    "--magpie-muted": pick("muted", finalPalette.muted),
    "--magpie-line": pick("line", finalPalette.line),
    "--magpie-card": pick("card", finalPalette.card),
    "--magpie-accent": accent,
    "--magpie-accent-fg": accentFg,
  };

  // 3) bridge 报了、我们没枚举到的键：原样透传（不猜语义，也不丢）。
  if (bridgeUsable) {
    for (const [key, value] of Object.entries(bridge)) {
      if (Object.prototype.hasOwnProperty.call(tokens, key)) continue;
      if (!normalizeTokenKey(key)) continue;
      tokens[key] = value;
    }
  }

  return {
    scheme: finalScheme,
    theme,
    // source 说明这一套是打哪儿来的，便于 curl / 报告里判断链路是否真的通了。
    source: bridgeUsable && bridge["--magpie-bg"] ? "bridge" : theme === "system" ? "system" : "settings",
    textSize: Number.isFinite(Number(settings.textSize)) ? Number(settings.textSize) : 100,
    lang: typeof settings.lang === "string" && settings.lang ? settings.lang : "system",
    tokens,
  };
}

/**
 * 把令牌表渲染成注入用的 `<style>`。
 *
 * 选择器必须是 `html:root` 而不是 `:root`：
 * 这段 <style> 注入在 <head> 最前（theme-tokens.md 要求「首帧不闪」），
 * 但 tokens.css 里也有 `:root { … }` 兜底值。同特异性下后出现的 rules 胜出
 * → 注入值会被兜底值盖掉（真浏览器实测 getComputedStyle 读回兜底色，D7-2 失败）。
 * `html:root` 比 `:root` 多一个类型选择器（0,1,1 > 0,1,0），无论顺序都胜出。
 *
 * 拼字符串之前再过一遍白名单：这是把字符串塞进 `<style>` 的最后一道关。
 *
 * @param {Record<string,string>|null} tokens
 * @returns {string}
 */
export function buildRootStyle(tokens) {
  if (!tokens || typeof tokens !== "object") return "";
  const lines = [];
  for (const [key, value] of Object.entries(tokens)) {
    if (!TOKEN_KEY_PATTERN.test(key)) continue;
    if (!isSafeTokenValue(value)) continue;
    lines.push(`  ${key}: ${String(value).trim()};`);
  }
  if (lines.length === 0) return "";
  return `<style>html:root {\n${lines.join("\n")}\n}</style>`;
}

/**
 * magpie 的 `textSize`（百分比）→ 根字号（px）。与 app.js 的 `fontPxForTextSize`
 * 必须给出同一个值（两边都是 13px 基准，夹在 80…160%）。
 *
 * @param {unknown} percent
 * @returns {number}
 */
export function fontPxForTextSize(percent) {
  const value = Number(percent);
  const clamped = Number.isFinite(value) ? Math.min(160, Math.max(80, value)) : 100;
  return Math.round(13 * (clamped / 100) * 100) / 100;
}

/**
 * 首屏字号注入（AC7）。
 *
 * 为什么不能只靠 app.js 行内写：`app.js` 是 module，天然 defer，首帧会先按 13px
 * 画一屏再跳字号（暗色窗口里尤其明显）。
 *
 * 为什么没有 `tokens` 里：AC1 要求 `tokens` 的键**全部**是 `--magpie-*` 形态，
 * 字号不属于 magpie 的令牌。所以另起一条 `html:root` 规则（同样特异性 0,1,1，
 * 能压过 tokens.css / layout.css）。
 *
 * @param {number} textSize
 * @returns {string}
 */
export function buildFontStyle(textSize) {
  const px = fontPxForTextSize(textSize);
  const scale = Math.round((px / 13) * 1000) / 1000;
  if (px === 13) return "";
  return `<style>html:root {\n  --mt-font-scale: ${scale};\n  font-size: ${px}px;\n}</style>`;
}

async function renderAppIndex(tokens, token, scheme, textSize) {
  const raw = await readAppFile("index.html");
  const style = buildRootStyle(tokens) + buildFontStyle(textSize);
  const meta = token ? tokenMetaTag(token) : "";
  const injected = meta ? meta + "\n" + style : style;
  // 首帧就要带 `is-dark` / `is-light`：ANSI 16 色与两套语义色都挂在这个类上
  // （AC6）。如果等 app.js 跑到才加，暗色窗口里的终端会先白一帧。
  // 同时也写 `data-mt-served`，告诉 tokens.css 「变量已经由服务端给过」，
  // 那条兜底底色就不应该再生效。
  const classes = scheme === "dark" || scheme === "light" ? `is-${scheme}` : "";
  const withClass =
    classes === "" ? raw : raw.replace("<html ", `<html class="${classes}" data-mt-served="1" `);
  // 在注释占位处注入；没有占位则插到 </head> 前。
  const marker = "<!-- 服务端在此处注入 <style>:root{…tokens…}</style> -->";
  if (withClass.includes(marker)) return withClass.replace(marker, injected);
  return withClass.replace("</head>", injected + "\n" + "</head>");
}

/** 读请求体，超过上限返回 null 并已经回应 413。 */
function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        writeJson(res, 413, { code: "BODY_TOO_LARGE", userText: "请求体超过 64KB 上限。" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      aborted = true;
      resolve(null);
    });
  });
}

/** 从已读好的 body 里解析 JSON 对象；失败返回 null。 */
function parseJsonBody(buffer) {
  if (!buffer || buffer.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * 主机接口的校验（TASK-V2-B §2.5）
 *
 * 防注入是硬要求：host 不许出现 `/` `;` `$()` 等任何能当命令用的字符，
 * 所以用**允许集**而不是黑名单（与 security-model §5.4.1 同一原则）。
 * ------------------------------------------------------------------ */

/** host 只允许字母数字、点、减号（IPv4 / 域名 / 本机别名都覆盖）。 */
export const HOST_PATTERN = /^[A-Za-z0-9.-]+$/;
/** username 只允许字母数字、点、下划线、减号。 */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export const HostCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  host: z.string().trim().min(1).max(253).regex(HOST_PATTERN),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(64).regex(USERNAME_PATTERN),
  authType: z.enum(["password", "privateKey"]),
  password: z.string().max(4096).optional(),
  privateKey: z.string().max(200000).optional(),
  privateKeyPath: z.string().max(4096).optional(),
  passphrase: z.string().max(4096).optional(),
});

/** PUT 可以只改几个字段，但给了的字段要合法。 */
export const HostUpdateSchema = HostCreateSchema.partial();

/** 远程路径参数：只要不是空的就行（真正的路径语义交给远端）。 */
export const FilesQuerySchema = z.string().min(1).max(4096);

function invalidHost(res, cors, detail, log) {
  if (log) {
    log({ level: "warn", code: "INVALID_HOST", msg: "invalid host payload", detail });
  }
  writeJson(
    res,
    400,
    { code: "INVALID_HOST", userText: detail || "主机信息不合法。" },
    {},
    cors,
  );
}

/** privateKeyPath 必须是绝对路径且文件存在（§2.5）。 */
async function checkPrivateKeyPath(value) {
  if (!isAbsolute(value)) return "私钥路径必须是绝对路径。";
  try {
    const info = await stat(value);
    if (!info.isFile()) return "私钥路径不是一个文件。";
  } catch {
    return "私钥路径不存在。";
  }
  return null;
}

/**
 * 启动服务。返回进程内句柄（含 token），供 doctor / 测试直接使用。
 * 端口被占：抛带 code=PORT_IN_USE 的错误，不做 +1 顺延。
 */
export async function startServer(options = {}) {
  const port = Number.isFinite(Number(options.port)) && Number(options.port) > 0
    ? Number(options.port)
    : 3480;
  const host = "127.0.0.1";
  const log = options.log || makeLogger();
  /**
   * 日志 writer（TASK-FIX17-E）：三个 `/api/logs*` 路由与 logger 用同一个实例。
   *
   * 注入的 `options.log`（测试/doctor 的静默 logger）没有 writer 时就返回 null，
   * 三个路由退化成「空日志 / 状态全0 / 清空0个」——**不**额外建一个：
   * 否则跑一遍单测就会在用户真实日志目录里凭空造文件。
   */
  const logWriter = () => (log && log.writer ? log.writer : null);
  /**
   * 当前下载目录（TASK-FIX17-L1 R1/R2）：每次请求现读配置文件。
   *
   * 不做进程内缓存：`PUT /api/config` 改完目录、下一次下载就得落在新目录；
   * 缓存反而会让「改了没生效」成为默认行为。读一份小 JSON 的开销可以忽略。
   *
   * @returns {Promise<string|null>}
   */
  const readDownloadDir = async () => {
    try {
      const { config } = await readConfig();
      return publicConfig(config).downloadDir;
    } catch {
      return null;
    }
  };
  const token = options.token || generateToken();
  // TASK-FIX17-G：版本信息与更新检查的注入点。
  // `packageInfo` 让单测不必临时改 package.json；`updateCheck` 让单测不必真连 GitHub。
  const packageInfo =
    options.packageInfo && typeof options.packageInfo === "object"
      ? {
          version:
            typeof options.packageInfo.version === "string" && options.packageInfo.version.length > 0
              ? options.packageInfo.version
              : VERSION,
          name:
            typeof options.packageInfo.name === "string" && options.packageInfo.name.length > 0
              ? options.packageInfo.name
              : "magpie-terminal",
          repository: options.packageInfo.repository ?? null,
        }
      : await readPackageMetadata();
  const updateCheckOptions =
    options.updateCheck && typeof options.updateCheck === "object" ? options.updateCheck : {};

  const shell = detectShell({ shell: options.shell });
  const ptyLoad = loadNodePty();
  const mode = ptyLoad.ok ? "native" : "sentinel";
  // TASK-V4-F：默认 shell 仍由 detectShell() 决定（/api/health 不变）；
  // 每个会话可以用 shellId 现取自己的 shell。
  const sessions = new SessionManager({ shell, ptyLoad, mode, resolveShell: resolveShellById });
  sessions.ensureExitHook();

  // 远程 SSH 会话层（TASK-V2-B）。与本地 SessionManager 并存，互不影响。
  const remote = new RemoteRegistry({ log });
  remote.ensureExitHook();

  const nodePtyVersion = ptyLoad.ok ? ptyLoad.version : null;
  if (mode === "sentinel") {
    log({
      level: "error",
      code: "PTY_UNAVAILABLE",
      msg: "native pty module unavailable, running in sentinel mode",
      reason: ptyLoad.reason,
    });
  } else if (nodePtyVersion !== LOCKED_NODE_PTY_VERSION) {
    log({
      level: "error",
      code: "PTY_VERSION_MISMATCH",
      msg: "native pty module version mismatch",
      expected: LOCKED_NODE_PTY_VERSION,
      actual: nodePtyVersion,
    });
  }

  const server = http.createServer();
  let wsHandle = null;
  // TASK-V4-H §5.1：AI 会话存储（REST 与 WS 共用一个实例，写链才能串行）。
  const aiSessions = options.aiSessions || createSessionStore({ log });

  /**
   * bridge 上报的主题令牌缓存（`POST /api/theme/bridge` 写，`GET /api/theme` 读）。
   *
   * 为什么必须缓存：带路页跳转之后 `window.magpie` 在应用页是 undefined
   * （page/index.html:29 → boot.js:98），bridge 的 `onTheme` 就没人收了。
   * 所以 boot 页在跳转**之前**把最新令牌 POST 给自己的服务，服务端存内存。
   * 只存内存不落盘：令牌是观感数据（不是凭据），重启重走一遍带路页即可。
   *
   * @type {{tokens:Record<string,string>, scheme:"dark"|"light"|null, at:number}|null}
   */
  let bridgeTheme = options.bridgeTheme || null;

  /** 取出当前主题（设置文件 + bridge 缓存），附上调用方的系统深浅色提示。 */
  /**
   * 取出当前主题（设置文件 + bridge 缓存），附上调用方的系统深浅色提示。
   *
   * **新鲜度规则（很关键）**：bridge 缓存是「页面被打开那一刻」的快照。用户之后
   * 在 magpie 里改了主题，写的是 `settings.json`（mtime 会变新）。如果继续信快照，
   * 页面就永远看不到变化——那正是本卡要修的「不刷新就不变色」。
   * 所以：settings.json 的 mtime 比快照新时，**整份快照作废**（令牌与 scheme 都不再用）。
   * 只丢 scheme 不行：旧令牌里的 `--magpie-bg` 是旧那一套配色，会得到「浅色主题
   * + 深色背景」的半套色。丢了之后走 `MAGPIE_PALETTE`（magpie 自己的实测调色板），
   * 颜色不会比用户自定义主题更差到哪里去，但至少深浅一致。
   */
  async function currentTheme(prefer) {
    const { settings, ok, reason, mtimeMs } = await readMagpieSettings();
    const bridgeIsFresh = Boolean(
      bridgeTheme && (mtimeMs === null || mtimeMs === undefined || bridgeTheme.at >= mtimeMs),
    );
    const theme = composeTheme({
      // 快照比设置文件旧 → 整份作废（只丢 scheme 不行：旧 bg 会得到半套色）。
      bridgeTokens: bridgeIsFresh && bridgeTheme ? bridgeTheme.tokens : null,
      bridgeScheme: bridgeIsFresh && bridgeTheme ? bridgeTheme.scheme : null,
      settings,
      prefer,
    });
    return { ...theme, settingsOk: ok, settingsReason: reason };
  }

  server.on("request", (req, res) => {
    handleRequest(req, res).catch((err) => {
      log({
        level: "error",
        code: "REQUEST_FAILED",
        msg: "request handler failed",
        err,
      });
      if (!res.headersSent) writeJson(res, 500, { code: "INTERNAL", userText: "服务内部错误。" });
      else res.destroy();
    });
  });

  /**
   * AI 会活的 REST 路由（TASK-V4-H §5.4）。
   *
   *   GET    /api/ai/sessions      → { sessions: 摘要[] }（不返回全文）
   *   GET    /api/ai/sessions/:id  → 全文（含 messages / steps）
   *   PATCH  /api/ai/sessions/:id  → { title }（≤80 字）
   *   DELETE /api/ai/sessions/:id  → 204；正在跑的会话 409 SESSION_BUSY
   *
   * token 门在 isApi 分支里已经验过，这里不再鉴权。
   * 返回 true 表示已处理（与 handleHostsRequest 同一约定）。
   */
  async function handleAiSessionsRequest(req, res, url, cors) {
    const match = /^\/api\/ai\/sessions(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return false;
    const store = aiSessions;

    // GET /api/ai/sessions?current=<id>
    if (!match[1] && req.method === "GET") {
      const currentId = url.searchParams.get("current") || null;
      writeJson(res, 200, { sessions: await store.listSessions({ currentId }) }, {}, cors);
      return true;
    }

    if (!match[1]) {
      writeJson(res, 405, { code: "METHOD_NOT_ALLOWED", userText: "这个接口只支持 GET。" }, {}, cors);
      return true;
    }

    const id = decodeURIComponent(match[1]);

    if (req.method === "GET") {
      const session = await store.getSession(id);
      if (!session) {
        writeJson(res, 404, { code: "SESSION_NOT_FOUND", userText: "没有这个会话。" }, {}, cors);
        return true;
      }
      writeJson(res, 200, session, {}, cors);
      return true;
    }

    if (req.method === "PATCH") {
      const body = await readBody(req, res);
      if (res.writableEnded) return true;
      const parsed = parseJsonBody(body);
      if (!parsed) {
        writeJson(res, 400, { code: "BAD_BODY", userText: "请求体必须是 JSON 对象。" }, {}, cors);
        return true;
      }
      if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) {
        writeJson(res, 400, { code: "INVALID_TITLE", userText: "标题必须是非空字符串。" }, {}, cors);
        return true;
      }
      if (parsed.title.trim().length > TITLE_MAX) {
        writeJson(res, 400, { code: "INVALID_TITLE", userText: `标题最多 ${TITLE_MAX} 个字。` }, {}, cors);
        return true;
      }
      const updated = await store.renameSession(id, parsed.title);
      if (!updated) {
        writeJson(res, 404, { code: "SESSION_NOT_FOUND", userText: "没有这个会话。" }, {}, cors);
        return true;
      }
      log({ level: "info", code: "AI_SESSION_RENAMED", msg: "ai session renamed", sessionId: id });
      writeJson(res, 200, { id: updated.id, title: updated.title, updatedAt: updated.updatedAt }, {}, cors);
      return true;
    }

    if (req.method === "DELETE") {
      const result = await store.deleteSession(id);
      if (result.ok) {
        res.writeHead(204, cors);
        res.end();
        return true;
      }
      const status = result.code === "SESSION_BUSY" ? 409 : result.code === "SESSION_NOT_FOUND" ? 404 : 500;
      writeJson(res, status, { code: result.code, userText: result.userText }, {}, cors);
      return true;
    }

    writeJson(res, 405, { code: "METHOD_NOT_ALLOWED", userText: "这个接口不支持这个方法。" }, {}, cors);
    return true;
  }

  async function handleHostsRequest(req, res, url, cors, log) {
    const pathname = url.pathname;
    const segments = pathname.split("/").filter(Boolean); // ["api","hosts", id?, action?]
    const id = segments[2] || null;
    const action = segments[3] || null;

    // GET /api/hosts
    if (req.method === "GET" && pathname === "/api/hosts") {
      writeJson(res, 200, { hosts: await listHosts() }, {}, cors);
      return true;
    }

    // POST /api/hosts
    if (req.method === "POST" && pathname === "/api/hosts") {
      const body = await readBody(req, res);
      if (res.writableEnded) return true;
      const parsed = parseJsonBody(body);
      if (!parsed) {
        writeJson(res, 400, { code: "INVALID_HOST", userText: "请求体必须是 JSON 对象。" }, {}, cors);
        return true;
      }
      const check = HostCreateSchema.safeParse(parsed);
      if (!check.success) {
        invalidHost(res, cors, "主机字段不合法（名称/主机/端口/用户名/认证方式）。", log);
        return true;
      }
      const input = check.data;
      if (input.authType === "privateKey") {
        const hasInline = typeof input.privateKey === "string" && input.privateKey.length > 0;
        if (!hasInline && !(typeof input.privateKeyPath === "string" && input.privateKeyPath.length > 0)) {
          invalidHost(res, cors, "私钥认证需要 privateKey 或 privateKeyPath。", log);
          return true;
        }
        if (!hasInline) {
          const bad = await checkPrivateKeyPath(input.privateKeyPath);
          if (bad) {
            invalidHost(res, cors, bad, log);
            return true;
          }
        }
      } else if (typeof input.password !== "string" || input.password.length === 0) {
        invalidHost(res, cors, "密码认证需要 password。", log);
        return true;
      }

      const created = await addHost({
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        authType: input.authType,
        privateKeyPath: input.privateKeyPath,
      });
      const hasSecret =
        input.authType === "password"
          ? true
          : typeof input.privateKey === "string" && input.privateKey.length > 0
            ? true
            : false;
      if (hasSecret) {
        await saveSecret(created.id, {
          password: input.password,
          privateKey: input.privateKey,
          passphrase: input.passphrase,
        });
      }
      const fresh = await getHostRecord(created.id);
      writeJson(res, 201, { host: fresh || created }, {}, cors);
      log({ level: "info", code: "HOST_CREATED", msg: "host created", route: "POST /api/hosts" });
      return true;
    }

    // POST /api/hosts/:id/trust
    //
    // §2.3 要求「用户点了信任并记住后才写入 known_hosts.json」。卡片 §2.5 的接口
    // 表里没有这一条，但前端没有别的写入途径，所以必须有。它是一个**额外的**
    // 必要路由（报告里写明）。防 TOCTOU：服务端重新取一次指纹，必须与前端展示的
    // 那条完全一致才落盘 —— 不信任客户端传来的「我看到的指纹」。
    if (req.method === "POST" && action === "trust") {
      const body = await readBody(req, res);
      if (res.writableEnded) return true;
      const parsed = parseJsonBody(body);
      if (!parsed || typeof parsed.fingerprint !== "string" || parsed.fingerprint.length === 0) {
        writeJson(res, 400, { code: "INVALID_FINGERPRINT", userText: "要信任的指纹缺失。" }, {}, cors);
        return true;
      }
      const host = await getHostRecord(id);
      if (!host) {
        writeJson(res, 404, { code: "HOST_NOT_FOUND", userText: "没有这条主机。" }, {}, cors);
        return true;
      }
      let probed;
      try {
        probed = await fingerprintForHost(id);
      } catch (err) {
        writeJson(
          res,
          502,
          { code: (err && err.code) || "SSH_FINGERPRINT_FAILED", userText: (err && err.userText) || "取不到主机指纹。" },
          {},
          cors,
        );
        return true;
      }
      if (probed.fingerprint !== parsed.fingerprint.trim()) {
        writeJson(
          res,
          409,
          {
            code: "HOST_KEY_CHANGED",
            userText: "指纹在核对期间变了，连接已中止。请重新连接重新核对。",
            algo: probed.algo,
            fingerprint: probed.fingerprint,
          },
          {},
          cors,
        );
        return true;
      }
      // 已有记录且与新指纹不一致 → **拒绝覆盖**。
      // 卡片 §2.3 的语义是「只能用户自己去删掉那条记录」，接口层也不能给一条
      // 「覆盖旧指纹」的捷径（那等于把「忽略」换了个名字）。
      if (probed.recorded && probed.recorded.fingerprint !== probed.fingerprint) {
        writeJson(
          res,
          409,
          {
            code: "HOST_KEY_MISMATCH",
            userText: "这台主机的指纹与已记录的不一样，不能直接覆盖。先删掉这条主机并重新添加。",
            knownFingerprint: probed.recorded.fingerprint,
            knownAlgo: probed.recorded.algo,
            algo: probed.algo,
            fingerprint: probed.fingerprint,
          },
          {},
          cors,
        );
        return true;
      }
      await rememberKnownHost(host.host, host.port, probed.algo, probed.fingerprint);
      writeJson(res, 200, { algo: probed.algo, fingerprint: probed.fingerprint, known: true }, {}, cors);
      log({ level: "info", code: "HOST_KEY_TRUSTED", msg: "host key trusted", route: "POST /api/hosts/:id/trust" });
      return true;
    }

    if (!id) return false;

    // PUT /api/hosts/:id
    if (req.method === "PUT" && !action) {
      const existing = await getHostRecord(id);
      if (!existing) {
        writeJson(res, 404, { code: "HOST_NOT_FOUND", userText: "没有这条主机。" }, {}, cors);
        return true;
      }
      const body = await readBody(req, res);
      if (res.writableEnded) return true;
      const parsed = parseJsonBody(body);
      if (!parsed) {
        writeJson(res, 400, { code: "INVALID_HOST", userText: "请求体必须是 JSON 对象。" }, {}, cors);
        return true;
      }
      const check = HostUpdateSchema.safeParse(parsed);
      if (!check.success) {
        invalidHost(res, cors, "主机字段不合法。", log);
        return true;
      }
      const patch = check.data;
      const nextAuth = patch.authType || existing.authType;
      if (patch.authType === "privateKey" && !patch.privateKey && !patch.privateKeyPath) {
        // 切到私钥但没给路径/正文：只有原来已经有可用私钥才算合法。
        if (!existing.privateKeyPath && !existing.hasInlineKey) {
          invalidHost(res, cors, "私钥认证需要 privateKey 或 privateKeyPath。", log);
          return true;
        }
      }
      if (patch.privateKeyPath) {
        const bad = await checkPrivateKeyPath(patch.privateKeyPath);
        if (bad) {
          invalidHost(res, cors, bad, log);
          return true;
        }
      }
      if (patch.password !== undefined && patch.password.length === 0) {
        invalidHost(res, cors, "password 不能是空串（不改密码就别传这个字段）。", log);
        return true;
      }

      const updated = await updateHost(id, {
        name: patch.name,
        host: patch.host,
        port: patch.port,
        username: patch.username,
        authType: patch.authType,
        privateKeyPath: patch.privateKeyPath,
        hasInlineKey: typeof patch.privateKey === "string" && patch.privateKey.length > 0,
      });
      if (!updated) {
        writeJson(res, 404, { code: "HOST_NOT_FOUND", userText: "没有这条主机。" }, {}, cors);
        return true;
      }
      if (
        typeof patch.password === "string" ||
        typeof patch.privateKey === "string" ||
        typeof patch.passphrase === "string"
      ) {
        await saveSecret(id, {
          password: patch.password,
          privateKey: patch.privateKey,
          passphrase: patch.passphrase,
        });
      }
      // 换主机名/端口后旧指纹不再适用于新目标：让它自己重新走一次核对。
      if ((patch.host && patch.host !== existing.host) || (patch.port && patch.port !== existing.port)) {
        // 不自动写 known_hosts：用户必须重新核对。旧记录保留（只按新 host:port 查找不会命中）。
      }
      const fresh = await getHostRecord(id);
      writeJson(res, 200, { host: fresh || updated }, {}, cors);
      log({ level: "info", code: "HOST_UPDATED", msg: "host updated", route: "PUT /api/hosts/:id" });
      return true;
    }

    // DELETE /api/hosts/:id
    if (req.method === "DELETE" && !action) {
      const removed = await removeHost(id);
      if (!removed) {
        writeJson(res, 404, { code: "HOST_NOT_FOUND", userText: "没有这条主机。" }, {}, cors);
        return true;
      }
      res.writeHead(204, cors);
      res.end();
      log({ level: "info", code: "HOST_DELETED", msg: "host deleted", route: "DELETE /api/hosts/:id" });
      return true;
    }

    // POST /api/hosts/:id/test
    if (req.method === "POST" && action === "test") {
      await readBody(req, res);
      if (res.writableEnded) return true;
      const result = await testHostConnection(id);
      // 失败也是 200：连不上是正常结果，不是服务端错误。
      writeJson(res, 200, result, {}, cors);
      return true;
    }

    // GET /api/hosts/:id/fingerprint
    if (req.method === "GET" && action === "fingerprint") {
      try {
        const info = await fingerprintForHost(id);
        writeJson(res, 200, info, {}, cors);
      } catch (err) {
        const code = err && err.code ? err.code : "SSH_FINGERPRINT_FAILED";
        const status = code === "HOST_NOT_FOUND" ? 404 : 502;
        writeJson(
          res,
          status,
          { code, userText: (err && err.userText) || "取不到主机指纹。" },
          {},
          cors,
        );
      }
      return true;
    }

    // GET /api/hosts/:id/files?path=/var/log
    if (req.method === "GET" && action === "files") {
      const rawPath = url.searchParams.get("path") || ".";
      const pathCheck = FilesQuerySchema.safeParse(rawPath);
      if (!pathCheck.success) {
        writeJson(res, 400, { code: "INVALID_PATH", userText: "路径不合法。" }, {}, cors);
        return true;
      }
      try {
        const listing = await listFiles(id, pathCheck.data);
        writeJson(res, 200, listing, {}, cors);
      } catch (err) {
        const code = err && err.code ? err.code : "SFTP_LIST_FAILED";
        const status = code === "HOST_NOT_FOUND" ? 404 : 502;
        writeJson(
          res,
          status,
          { code, userText: (err && err.userText) || "列不出远程目录。" },
          {},
          cors,
        );
      }
      return true;
    }

    return false;
  }

  async function handleRequest(req, res) {
    const startedAt = Date.now();
    let url;
    try {
      url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    } catch {
      writeJson(res, 400, { code: "BAD_URL", userText: "请求地址格式不正确。" });
      return;
    }
    const pathname = url.pathname;
    const cors = corsHeaders(req, port);

    // L2：Host 先行。Host 不对时连 CORS 头都不给（不是我们可以服务的对象）。
    // L3：Origin；L4：token（在 /api/* 与 WS 升级处）。
    const gate = checkHttpGate(req, port);
    if (!gate.ok) {
      log({ level: "warn", code: gate.code, msg: "request forbidden", route: `${req.method} ${pathname}` });
      // Origin 不合法时不回 ACAO（否则等于告诉恶意页面「你能读」）；
      // Host 不合法时同理。其余 403 场景会带 CORS。
      const isOriginIssue = gate.code === "AUTH_ORIGIN_MISMATCH";
      writeForbidden(res, isOriginIssue ? {} : cors);
      return;
    }

    // CORS 预检：必须在 token 检查之前。
    // 浏览器发 OPTIONS 时不会带自定义口令头，所以这里不能要求 token。
    // 顺序与官方 page-chat 一致：host → origin → OPTIONS 204 → 其余。
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const isApi = pathname === "/api" || pathname.startsWith("/api/");

    // 根路径：带路页跳进来的入口。
    // 不再下发 cookie（沙箱 opaque origin 收不到也用不了）；口令注入 HTML 的 <meta>。
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      // P0-1（TASK-V4-S §6.1）：首页 HTML 里注入口令，所以只服务「用户真在打开页面」的
      // 导航请求。`Origin: null`（沙箱 iframe 的 fetch）与 cors 模式一律不给 HTML。
      if (!isNavigationRequest(req)) {
        // 不给 HTML，也不给 ACAO：让恶意页连响应体都读不到。
        // 这里刻意不用 writeForbidden（它带 cors），否则沙箱 fetch 能通过 CORS 读到 body。
        log({
          level: "warn",
          code: "AUTH_NOT_NAVIGATION",
          msg: "root html refused for non-navigation request",
          route: `GET ${pathname}`,
        });
        writeJson(res, 403, { code: "FORBIDDEN" });
        return;
      }
      const queryTokens = decodeTokens(url.searchParams.get("tokens"));
      // 首屏：query 的 bridge 令牌（如果有）+ magpie 设置文件（theme / accent）。
      // 两路合起来才能保证「刷新一次页面、bridge 没给令牌」时颜色也对。
      // 优先级：`?theme=dark|light`（带路页给的）> 设置文件的 theme > bridge > 兜底。
      const queryTheme = url.searchParams.get("theme");
      const preferRaw = url.searchParams.get("prefer");
      const prefer = preferRaw === "dark" || preferRaw === "light" ? preferRaw : null;
      const { settings } = await readMagpieSettings();
      const queryScheme = queryTheme === "dark" || queryTheme === "light" ? queryTheme : null;
      // bridge 令牌顺手存进进程内缓存：带路页跳转后 window.magpie 就没了
      // （bridge 只注入到带路页那个 origin），这是唯一能把它们带过来的通道。
      // 只存「确实解出了东西」的那次，避免手敲一个空 query 把好缓存抹掉。
      if (queryTokens && Object.keys(queryTokens).length > 0) {
        bridgeTheme = {
          tokens: queryTokens,
          scheme: queryScheme || resolveScheme(queryTokens["--magpie-bg"] || "", {}),
          at: Date.now(),
        };
      }
      const effectiveSettings = queryScheme ? { ...settings, theme: queryScheme } : settings;
      const composed = composeTheme({
        bridgeTokens: queryTokens,
        bridgeScheme: queryScheme || (queryTokens ? resolveScheme(queryTokens["--magpie-bg"] || "", {}) : null),
        settings: effectiveSettings,
        prefer,
      });
      const html = await renderAppIndex(composed.tokens, token, composed.scheme, composed.textSize);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": buildCsp(port),
        "referrer-policy": "no-referrer",
        ...cors,
      });
      res.end(html);
      log({
        level: "info",
        code: "PAGE_SERVED",
        msg: "app page served",
        route: "GET /",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (isApi) {
      // L4：/api/* 一律要求 token，且先于路由（未知路径也是 403 而不是 404）。
      const gateToken = checkToken(readToken(req, url), token);
      if (!gateToken.ok) {
        log({
          level: "warn",
          code: gateToken.code,
          msg: "api forbidden",
          route: `${req.method} ${pathname}`,
        });
        writeForbidden(res, cors);
        return;
      }

      if (req.method === "GET" && pathname === "/api/health") {
        writeJson(
          res,
          200,
          buildHealth({
            version: VERSION,
            port,
            shell,
            pty: mode,
            nodePtyVersion,
            sessions: sessions.size,
          }),
          {},
          cors,
        );
        return;
      }

      // GET /api/version（TASK-FIX17-G R1）：当前版本 / 仓库地址 / 安装方式。
      // 安装方式每次现读 plugins.json（只读、可注入），用户换了装法不必重启服务。
      if (req.method === "GET" && pathname === "/api/version") {
        const repository = normalizeRepository(packageInfo.repository);
        const installKind = await detectInstallKind();
        writeJson(
          res,
          200,
          {
            version: packageInfo.version,
            name: packageInfo.name,
            repository: repository ? repository.url : null,
            installKind,
            // PRD R1：仓库存在且安装方式不是 unknown 才「支持检查」。
            updateSupported: Boolean(repository) && installKind !== "unknown",
          },
          {},
          cors,
        );
        return;
      }

      // GET /api/update/check（TASK-FIX17-G R1/R3）：GitHub releases/latest。
      // 失败也回 200 + {hasUpdate:false, error}：这是「查询没成功」，不是服务坏了。
      if (req.method === "GET" && pathname === "/api/update/check") {
        const installKind = await detectInstallKind();
        const result = await checkForUpdate({
          ...updateCheckOptions,
          repository: packageInfo.repository,
          installKind,
          currentVersion: packageInfo.version,
        });
        if (result.error) {
          log({
            level: "warn",
            code: "UPDATE_CHECK_FAILED",
            msg: "update check failed",
            route: "GET /api/update/check",
            reason: result.error,
          });
        }
        writeJson(res, 200, result, {}, cors);
        return;
      }

      // GET /api/models：网关可达时给真实清单，不可达时仍 200（前端据此显示重试）。
      // 与 /api/health 走同一道 token 门（上面的 isApi 分支），不做例外。
      if (req.method === "GET" && pathname === "/api/models") {
        const { config } = await readConfig();
        const configured = typeof config.model === "string" ? config.model : null;
        let payload;
        try {
          const probe = await probeGateway();
          const ids = probe.models.map((model) => model.id);
          const fallback = ids.length > 0 ? ids[0] : DEFAULT_MODEL;
          const preferred =
            configured && ids.includes(configured)
              ? configured
              : ids.includes(DEFAULT_MODEL)
                ? DEFAULT_MODEL
                : fallback;
          payload = {
            gateway: { reachable: true, durationMs: probe.durationMs, baseUrl: probe.baseUrl },
            default: preferred,
            models: probe.models,
          };
        } catch (err) {
          log({
            level: "warn",
            code: err && err.code ? err.code : "GATEWAY_UNREACHABLE",
            msg: "models probe failed",
            route: "GET /api/models",
            durationMs: Date.now() - startedAt,
          });
          payload = {
            gateway: { reachable: false, durationMs: Date.now() - startedAt, baseUrl: gatewayBaseUrl() },
            // 网关不可达时 default 仍要给出：前端下拉不能是空的。
            default: configured || DEFAULT_MODEL,
            models: [],
          };
        }
        writeJson(res, 200, payload, {}, cors);
        return;
      }

      // GET /api/shells：本机可用 shell 清单（TASK-V4-F §5.3，TASK-FIX17-A 扩成动态发现）。
      // 与 /api/models 同级：走同一道 token 门，不做例外。
      //
      // 字段契约（AC10）：id / name / version / path / available 一个都不许改名或删除，
      // 只允许新增。TASK-FIX17-A 新增 group（local|wsl|profile）与 detail（发行版/WT profile 名）。
      if (req.method === "GET" && pathname === "/api/shells") {
        const { config } = await readConfig();
        const view = publicConfig(config);
        const shells = detectShells().map((item) => ({
          id: item.id,
          name: item.name,
          version: item.version,
          path: item.path,
          available: Boolean(item.available),
          // ---- TASK-FIX17-A 新增（只增不改）----
          group: item.group || "local",
          ...(item.detail ? { detail: item.detail } : {}),
        }));
        const fallbackDefault = resolveShellForRequest({ defaultShell: null });
        writeJson(
          res,
          200,
          {
            shells,
            // 实际生效的默认（config.defaultShell 不可用时也回真实生效的那个）。
            default: (view.defaultShell && resolveShellById(view.defaultShell) ? view.defaultShell : null) ||
              (fallbackDefault.ok && fallbackDefault.shell ? fallbackDefault.shell.id : null),
            configured: view.defaultShell,
          },
          {},
          cors,
        );
        return;
      }

      // GET /api/config：只暴露已知字段；文件缺失/损坏时返回默认值。
      if (req.method === "GET" && pathname === "/api/config") {
        const { config } = await readConfig();
        writeJson(res, 200, publicConfigPayload(publicConfig(config)), {}, cors);
        return;
      }

      // PUT /api/config：只接受已知字段（TASK-V3-D 起是 model + agent 四字段）。
      // 可以只提交其中一部分：出现哪个字段就只校验/只写哪个字段。
      if (req.method === "PUT" && pathname === "/api/config") {
        const body = await readBody(req, res);
        if (res.writableEnded) return;
        const parsed = parseJsonBody(body);
        if (!parsed) {
          writeJson(res, 400, { code: "BAD_BODY", userText: "请求体必须是 JSON 对象。" }, {}, cors);
          return;
        }
        const unknown = Object.keys(parsed).filter((key) => !KNOWN_FIELDS.includes(key));
        // 只接受已知字段：出现未知字段直接拒绝，避免前端把拼错的名字当成「存住了」。
        if (unknown.length > 0) {
          writeJson(
            res,
            400,
            { code: "UNKNOWN_FIELD", userText: `不认识的配置字段：${unknown.join(", ")}。` },
            {},
            cors,
          );
          return;
        }
        const hasModel = Object.prototype.hasOwnProperty.call(parsed, "model");
        let wanted = null;
        if (hasModel) {
          if (typeof parsed.model !== "string" || parsed.model.trim().length === 0) {
            writeJson(res, 400, { code: "INVALID_MODEL", userText: "model 必须是非空字符串。" }, {}, cors);
            return;
          }
          wanted = parsed.model.trim();
        }

        // agent 四字段先做纯形状校验（不打网络）。
        const invalid = validateConfigPatch(parsed);
        if (invalid) {
          writeJson(res, 400, invalid, {}, cors);
          return;
        }

        if (hasModel) {
          let known;
          try {
            const probe = await probeGateway();
            known = probe.models.map((model) => model.id);
          } catch (err) {
            writeJson(
              res,
              502,
              {
                code: "GATEWAY_UNAVAILABLE",
                userText: "网关不可用，无法确认这个模型是否存在于清单里。",
              },
              {},
              cors,
            );
            log({
              level: "warn",
              code: "CONFIG_MODEL_UNVERIFIED",
              msg: "put config while gateway unreachable",
              reason: err && err.code ? err.code : "GATEWAY_UNREACHABLE",
            });
            return;
          }
          // model 必须是 /api/models 里出现过的 id；否则 400。
          if (!known.includes(wanted)) {
            writeJson(res, 400, { code: "INVALID_MODEL", userText: "这个模型不在网关模型清单里。" }, {}, cors);
            return;
          }
        }

        const patch = {};
        for (const field of KNOWN_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(parsed, field)) patch[field] = parsed[field];
        }
        if (hasModel) patch.model = wanted;

        let saved;
        try {
          saved = await updateConfig(patch);
        } catch (err) {
          writeJson(
            res,
            500,
            { code: "CONFIG_WRITE_FAILED", userText: "配置没存住（写入配置文件失败）。" },
            {},
            cors,
          );
          log({ level: "error", code: "CONFIG_WRITE_FAILED", msg: "config write failed", err });
          return;
        }
        const view = publicConfig(saved);
        writeJson(res, 200, publicConfigPayload(view), {}, cors);
        return;
      }

      /* --------------------------------------------------------- *
       * 主题（TASK-FIX17-B R1）
       *
       *   GET  /api/theme?prefer=dark|light   当前主题（变量表 + 深浅色 + 字号）
       *   POST /api/theme/bridge              bridge 令牌上报（boot 页跳转前调）
       *
       * token 已在上面的 isApi 分支验过；与 /api/models 同级，不做例外。
       *
       * 为什么需要 GET /api/theme：magpie 改了主题后，页面不能刷——`page/boot.js`
       * 已经跳走了，`window.magpie` 在这个 origin 是 undefined，bridge 的 onTheme
       * 收不到事件。唯一的冷态通道就是服务端现读 magpie 的设置文件。
       * --------------------------------------------------------- */
      if (req.method === "GET" && pathname === "/api/theme") {
        const preferRaw = url.searchParams.get("prefer");
        const prefer = preferRaw === "dark" || preferRaw === "light" ? preferRaw : null;
        const payload = await currentTheme(prefer);
        writeJson(res, 200, payload, {}, cors);
        return;
      }

      if (pathname === "/api/theme/bridge") {
        if (req.method !== "POST") {
          writeJson(res, 405, { code: "METHOD_NOT_ALLOWED", userText: "这个接口只支持 POST。" }, {}, cors);
          return;
        }
        const body = await readBody(req, res);
        if (res.writableEnded) return;
        const parsed = parseJsonBody(body);
        if (!parsed) {
          writeJson(res, 400, { code: "BAD_BODY", userText: "请求体必须是 JSON 对象。" }, {}, cors);
          return;
        }
        // 令牌与深浅色都要过白名单：这是唯一一个「进程外写入主题」的入口。
        const { tokens, dropped } = sanitizeTokens(parsed.tokens);
        const rawScheme = parsed.dark === true ? "dark" : parsed.dark === false ? "light" : null;
        const scheme = rawScheme || resolveScheme(tokens["--magpie-bg"] || "", {});
        bridgeTheme = { tokens, scheme, at: Date.now() };
        log({
          level: "info",
          code: "THEME_BRIDGE",
          msg: "bridge theme stored",
          route: "POST /api/theme/bridge",
          tokenCount: Object.keys(tokens).length,
          // 只记丢弃的数量，**不记原值**（它可能是注入串）。
          dropped,
          scheme,
        });
        writeJson(res, 200, { ok: true, stored: Object.keys(tokens).length, dropped, scheme }, {}, cors);
        return;
      }

      if (req.method === "GET" && pathname === "/api/policy") {
        writeJson(res, 200, buildPolicy(), {}, cors);
        return;
      }

      /* --------------------------------------------------------- *
       * 本地文件面板（TASK-V4-G §5.3）
       * token 已在上面的 isApi 分支里验过了。
       * --------------------------------------------------------- */
      if (pathname === "/api/fs" || pathname.startsWith("/api/fs/")) {
        const handled = await handleLocalFs({
          req,
          res,
          url,
          cors,
          readBody,
          // TASK-FIX17-L1：save / reveal 要用到；其它 action 不看这两个字段。
          readDownloadDir,
          log,
          revealSpawn: options.revealSpawn,
          exportDeps: options.exportDeps,
        });
        if (handled) return;
      }

      /* --------------------------------------------------------- *
       * 远程文件面板（TASK-V4-G §5.4）：/api/hosts/:id/fs/*
       * 放在主机路由之前：handleHostsRequest 不认 fs 分支。
       * --------------------------------------------------------- */
      const remoteFsMatch = /^\/api\/hosts\/([^/]+)\/fs(\/.*)?$/.exec(pathname);
      if (remoteFsMatch) {
        const handled = await handleRemoteFs({
          req,
          res,
          url,
          cors,
          readBody,
          hostId: decodeURIComponent(remoteFsMatch[1]),
          readDownloadDir,
          log,
          exportDeps: options.exportDeps,
        });
        if (handled) return;
      }

      /* --------------------------------------------------------- *
       * 主机（TASK-V2-B §2.5）
       * 全部已在上面过了 token 门；此处只管校验与落盘。
       * --------------------------------------------------------- */
      if (pathname === "/api/hosts" || pathname.startsWith("/api/hosts/")) {
        const handled = await handleHostsRequest(req, res, url, cors, log);
        if (handled) return;
      }

      if (req.method === "POST" && pathname === "/api/ai") {
        await readBody(req, res);
        if (!res.writableEnded) handleAiPost(req, res);
        return;
      }

      /* --------------------------------------------------------- *
       * 日志（TASK-FIX17-E R4）：导出 / 状态 / 清空。
       * 和其它 `/api/*` 一样过了 L2/L3/L4 三道门（没 token 先 403）。
       *
       * 三个路由都只碰**本插件自己的** `show-terminal.log`：宿主那份
       * `app.log` 里混着别的插件，我们不读也不导（超出本卡范围）。
       * --------------------------------------------------------- */
      if (pathname === "/api/logs/export" && req.method === "GET") {
        const writer = logWriter();
        // 双保险：写入时已脱敏，导出前整文再过一遍（历史文件可能是旧版本落的）。
        const body = writer ? redactText(writer.readAll()) : "";
        writeAttachment(res, body, exportLogFilename(), cors);
        log({
          level: "info",
          code: "LOGS_EXPORTED",
          msg: "logs exported",
          route: "GET /api/logs/export",
          bytes: Buffer.byteLength(body),
        });
        return;
      }

      /* TASK-FIX17-L1 R5：导出日志到 downloadDir。
       * 与上面的 `GET /api/logs/export` **同源**（同一个 writer.readAll() +
       * 同一次 redactText），区别只是「写到目录」而不是「作为附件回给浏览器」。
       * 未设置目录 → 400（前端据此回落 blob 下载）；写失败 → 500，不带 stack。 */
      if (pathname === "/api/logs/export-to-dir" && req.method === "POST") {
        await readBody(req, res);
        if (res.writableEnded) return;
        const dir = await readDownloadDir();
        if (!dir) {
          writeJson(res, 400, { code: "NO_DOWNLOAD_DIR", userText: "还没有设置下载目录" }, {}, cors);
          return;
        }
        const writer = logWriter();
        const body = writer ? redactText(writer.readAll()) : "";
        try {
          const result = await saveTextToDir(
            body,
            dir,
            exportLogFilename(),
            options.exportDeps || {},
          );
          log({
            level: "info",
            code: "LOGS_EXPORTED_TO_DIR",
            msg: "logs exported to download dir",
            route: "POST /api/logs/export-to-dir",
            // 只记字节数与文件名（完整路径不进日志）。
            bytes: result.bytes,
            name: result.name,
          });
          writeJson(
            res,
            200,
            { ok: true, savedPath: result.savedPath, bytes: result.bytes, name: result.name },
            {},
            cors,
          );
        } catch (err) {
          // 不泄 stack / 路径：只把服务端的 reason 记到日志（脱敏后），响应只给人话。
          log({
            level: "error",
            code: "LOGS_EXPORT_FAILED",
            msg: "logs export to dir failed",
            route: "POST /api/logs/export-to-dir",
            reason: err && typeof err.reason === "string" ? err.reason : "E_WRITE",
          });
          writeJson(
            res,
            500,
            { code: "LOGS_EXPORT_FAILED", userText: "日志没写进下载目录（目录不可写或磁盘满）。" },
            {},
            cors,
          );
        }
        return;
      }

      if (pathname === "/api/logs/status" && req.method === "GET") {
        const writer = logWriter();
        const status = writer ? writer.status() : { bytes: 0, mtime: null, maxBytes: null };
        writeJson(
          res,
          200,
          {
            file: LOG_FILE_NAME,
            rotatedFile: LOG_ROTATED_NAME,
            bytes: status.bytes,
            mtime: status.mtime,
            rotatedBytes: status.rotatedBytes || 0,
            maxBytes: status.maxBytes,
            // 导出时 `.1` 会拼在主文件之前，界面上需要能如实提示总量。
            totalBytes: (status.bytes || 0) + (status.rotatedBytes || 0),
            writable: status.writable !== false,
          },
          {},
          cors,
        );
        return;
      }

      if (pathname === "/api/logs" && req.method === "DELETE") {
        const writer = logWriter();
        const cleared = writer ? writer.clear() : 0;
        log({
          level: "info",
          code: "LOGS_CLEARED",
          msg: "logs cleared",
          route: "DELETE /api/logs",
          files: cleared,
        });
        writeJson(res, 200, { ok: true, cleared }, {}, cors);
        return;
      }

      /* --------------------------------------------------------- *
       * AI 会话（TASK-V4-H §5.4）：列 / 全文 / 重命名 / 删除。
       * 放在其他 /api 分支之后，不影响已有路由。
       * --------------------------------------------------------- */
      if (pathname === "/api/ai/sessions" || pathname.startsWith("/api/ai/sessions/")) {
        const handled = await handleAiSessionsRequest(req, res, url, cors);
        if (handled) return;
      }

      writeJson(res, 404, { code: "NOT_FOUND", userText: "没有这个接口。" }, {}, cors);
      return;
    }

    // 静态资源：只认白名单前缀，其余 404。
    // CORS 头必须带：沙箱里 /app.js 与它 import 的 /core/* /ui/* 全是 module fetch。
    if (req.method === "GET" && isStaticPath(pathname)) {
      const sent = await sendStatic(res, pathname, cors);
      if (!sent) writeJson(res, 404, { code: "NOT_FOUND", userText: "资源不存在。" }, {}, cors);
      return;
    }

    writeJson(res, 404, { code: "NOT_FOUND", userText: "资源不存在。" }, {}, cors);
  }

  // 端口绑定：EADDRINUSE 映射为 PORT_IN_USE，不重试、不顺延。
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      if (err && err.code === "EADDRINUSE") {
        const wrapped = new Error("port in use");
        wrapped.code = "PORT_IN_USE";
        wrapped.port = port;
        reject(wrapped);
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });

  wsHandle = attachWebSocket({
    server,
    port,
    token,
    sessions,
    remote,
    log,
    aiSessions,
    // TASK-V4-F §5.2：每次 pty.create 现读 config.defaultShell（不重启就生效）。
    getDefaultShell: async () => {
      try {
        const { config } = await readConfig();
        return config && typeof config.defaultShell === "string" ? config.defaultShell : null;
      } catch {
        return null;
      }
    },
  });

  const handle = {
    port,
    host,
    token,
    tokenInfo: maskToken(token),
    server,
    sessions,
    remote,
    aiSessions,
    shell,
    mode,
    nodePtyVersion,
    log,
    close: async () => {
      wsHandle.close();
      try {
        remote.killAllSync();
      } catch {
        // 忽略。
      }
      // TASK-V4-F-FIX1：本地 PTY 也必须杀。node-pty 的原生句柄不随 server.close()
      // 释放，漏杀会让 Node 进程永远退不出去（`node --test` 挂死的根因）。
      try {
        sessions.killAllSync();
      } catch {
        // 忽略。
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };

  log({
    level: "info",
    code: "SERVER_STARTED",
    msg: "listening",
    port,
    pty: mode,
    nodePtyVersion,
    token: handle.tokenInfo,
    tokenBytes: TOKEN_BYTES,
  });

  return handle;
}

export { VERSION };
