// HTTP 服务：路由表、静态资源、门禁、tokens 注入。
// 鉴权先于路由；未知 /api/* 也先鉴权再 404。

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOKEN_BYTES,
  checkHttpGate,
  checkToken,
  cookieHeader,
  generateToken,
  maskToken,
  readToken,
} from "./auth.mjs";
import { buildHealth } from "./routes/health.mjs";
import { buildPolicy } from "./routes/policy.mjs";
import { handleAiPost } from "./routes/ai.mjs";
import { isStaticPath, readAppFile, sendStatic } from "./static.mjs";
import { attachWebSocket } from "./ws.mjs";
import { detectShell, loadNodePty, LOCKED_NODE_PTY_VERSION } from "../pty/bridge.mjs";
import { SessionManager } from "../pty/session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";

export const MAX_BODY_BYTES = 64 * 1024;

/**
 * CSP 的 connect-src 必须跟着实际端口走；3480 时与规范原文逐字一致。
 *
 * style-src 必须带 'unsafe-inline'（TASK.md §4.4）：
 * ① 服务端注入的 <style>:root{…tokens…}</style> 是内联样式，'self' 只管外链样式表，
 *    实测被拦后主题变量全部失效；
 * ② xterm.js 运行期自己 createElement("style") / setAttribute("style", …) / insertRule，
 *    nonce 方案拿不到 nonce，只有 'unsafe-inline' 可行。
 * 脚本仍然严格 'self'，不放宽。
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
    "frame-ancestors 'self'",
  ].join("; ");
}

export const CSP = buildCsp(3480);

function timestamp() {
  return new Date().toISOString();
}

/**
 * 单行 JSON 日志；绝不记 token 原文与终端输入。
 */
export function makeLogger(sink = console) {
  return function log(entry) {
    const record = { ts: timestamp(), level: "info", ...entry };
    if (record.msg === undefined) record.msg = "";
    const line = JSON.stringify(record, (key, value) => {
      if (key === "err" && value && typeof value === "object") {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      return value;
    });
    if (typeof sink.log === "function") sink.log(line);
  };
}

function writeJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

function writeForbidden(res) {
  // 响应体不区分失败原因，避免成为判定预言机。
  const body = JSON.stringify({ code: "FORBIDDEN" });
  res.writeHead(403, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function decodeTokens(raw) {
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
  const clean = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^--[A-Za-z0-9_-]+$/.test(key)) continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim();
    if (!text) continue;
    // 防注入：值里不许出现尖括号、花括号、分号。
    if (/[<>{};]/.test(text)) continue;
    clean[key] = text;
  }
  return clean;
}

function buildRootStyle(tokens) {
  if (!tokens) return "";
  const lines = Object.entries(tokens).map(([key, value]) => `  ${key}: ${value};`);
  if (lines.length === 0) return "";
  // 选择器必须是 `html:root` 而不是 `:root`：
  // 这段 <style> 注入在 <head> 最前（theme-tokens.md 要求「首帧不闪」），
  // 但 tokens.css 里也有 `:root { --magpie-bg: Canvas; … }` 兜底值。
  // 同特异性下后出现的 rules 胜出 → 注入值会被兜底值盖掉（真浏览器实测
  // getComputedStyle 读回 `Canvas`，D7-2 失败）。
  // `html:root` 比 `:root` 多一个类型选择器（0,1,1 > 0,1,0），无论顺序都胜出。
  return `<style>html:root {\n${lines.join("\n")}\n}</style>`;
}

async function renderAppIndex(tokens) {
  const raw = await readAppFile("index.html");
  const style = buildRootStyle(tokens);
  // 在注释占位处注入；没有占位则插到 </head> 前。
  const marker = "<!-- 服务端在此处注入 <style>:root{…tokens…}</style> -->";
  if (raw.includes(marker)) return raw.replace(marker, style);
  return raw.replace("</head>", `${style}\n</head>`);
}

/** 读取请求体，超过上限返回 null 并已经回应 413。 */
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const token = options.token || generateToken();

  const shell = detectShell({ shell: options.shell });
  const ptyLoad = loadNodePty();
  const mode = ptyLoad.ok ? "native" : "sentinel";
  const sessions = new SessionManager({ shell, ptyLoad, mode });
  sessions.ensureExitHook();

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

    // L2 + L3：所有请求都先过 Host / Origin。
    const gate = checkHttpGate(req, port);
    if (!gate.ok) {
      log({ level: "warn", code: gate.code, msg: "request forbidden", route: `${req.method} ${pathname}` });
      writeForbidden(res);
      return;
    }

    const isApi = pathname === "/api" || pathname.startsWith("/api/");

    // 根路径：带路页跳进来的入口。先下发 mt cookie 再返回应用页。
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const tokens = decodeTokens(url.searchParams.get("tokens"));
      const html = await renderAppIndex(tokens);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": buildCsp(port),
        "referrer-policy": "no-referrer",
        "set-cookie": cookieHeader(token),
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
        writeForbidden(res);
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
        );
        return;
      }

      if (req.method === "GET" && pathname === "/api/policy") {
        writeJson(res, 200, buildPolicy());
        return;
      }

      if (req.method === "POST" && pathname === "/api/ai") {
        await readBody(req, res);
        if (!res.writableEnded) handleAiPost(req, res);
        return;
      }

      writeJson(res, 404, { code: "NOT_FOUND", userText: "没有这个接口。" });
      return;
    }

    // 静态资源：只认白名单前缀，其余 404。
    if (req.method === "GET" && isStaticPath(pathname)) {
      const sent = await sendStatic(res, pathname);
      if (!sent) writeJson(res, 404, { code: "NOT_FOUND", userText: "资源不存在。" });
      return;
    }

    writeJson(res, 404, { code: "NOT_FOUND", userText: "资源不存在。" });
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

  wsHandle = attachWebSocket({ server, port, token, sessions, log });

  const handle = {
    port,
    host,
    token,
    tokenInfo: maskToken(token),
    server,
    sessions,
    shell,
    mode,
    nodePtyVersion,
    log,
    close: async () => {
      wsHandle.close();
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
