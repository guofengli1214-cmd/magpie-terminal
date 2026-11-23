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
  maskToken,
  readToken,
  tokenMetaTag,
} from "./auth.mjs";
import { buildHealth } from "./routes/health.mjs";
import { DEFAULT_MODEL, gatewayBaseUrl, probeGateway } from "../ai/gateway.mjs";
import {
  KNOWN_FIELDS,
  addHost,
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
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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

async function renderAppIndex(tokens, token) {
  const raw = await readAppFile("index.html");
  const style = buildRootStyle(tokens);
  const meta = token ? tokenMetaTag(token) : "";
  const injected = meta ? meta + "\n" + style : style;
  // 在注释占位处注入；没有占位则插到 </head> 前。
  const marker = "<!-- 服务端在此处注入 <style>:root{…tokens…}</style> -->";
  if (raw.includes(marker)) return raw.replace(marker, injected);
  return raw.replace("</head>", injected + "\n" + "</head>");
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
  const token = options.token || generateToken();

  const shell = detectShell({ shell: options.shell });
  const ptyLoad = loadNodePty();
  const mode = ptyLoad.ok ? "native" : "sentinel";
  const sessions = new SessionManager({ shell, ptyLoad, mode });
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
      const tokens = decodeTokens(url.searchParams.get("tokens"));
      const html = await renderAppIndex(tokens, token);
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

      // GET /api/config：只暴露已知字段；文件缺失/损坏时返回默认值。
      if (req.method === "GET" && pathname === "/api/config") {
        const { config } = await readConfig();
        const view = publicConfig(config);
        const model = view.model || DEFAULT_MODEL;
        writeJson(
          res,
          200,
          {
            model,
            autonomy: view.autonomy,
            allowlist: view.allowlist,
            reviewModel: view.reviewModel,
            basePrompt: view.basePrompt,
          },
          {},
          cors,
        );
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
        writeJson(
          res,
          200,
          {
            model: view.model || DEFAULT_MODEL,
            autonomy: view.autonomy,
            allowlist: view.allowlist,
            reviewModel: view.reviewModel,
            basePrompt: view.basePrompt,
          },
          {},
          cors,
        );
        return;
      }

      if (req.method === "GET" && pathname === "/api/policy") {
        writeJson(res, 200, buildPolicy(), {}, cors);
        return;
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

  wsHandle = attachWebSocket({ server, port, token, sessions, remote, log });

  const handle = {
    port,
    host,
    token,
    tokenInfo: maskToken(token),
    server,
    sessions,
    remote,
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
