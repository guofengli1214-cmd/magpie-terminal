// 四层门禁的实现：Host / Origin / token。
// 所有路由与 WS 升级都必须走这里，禁止在别处再实现一份。

import crypto from "node:crypto";

// 口令的三种传输方式里，cookie 已被彻底删除：magpie 把插件页放在
// <iframe sandbox="allow-scripts"> 里，文档是 opaque origin，
// 该环境里 `document.cookie = …` 会抛 SecurityError（实测），
// 且跨源请求根本不会带上我们的 cookie。所以只用「请求头」与「query」。
export const TOKEN_HEADER = "x-magpie-term-token";
export const TOKEN_META_NAME = "magpie-term-token";
export const TOKEN_QUERY = "token";
export const TOKEN_BYTES = 32;

/** 生成 64 位 hex token；只存进程内存。 */
export function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

export function maskToken(token) {
  if (typeof token !== "string" || token.length === 0) return "none";
  return `${token.slice(0, 4)}…(${token.length})`;
}

function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

function allowedOrigins(port) {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

/**
 * Host 校验。返回 {ok:boolean, code?:string}
 */
export function checkHost(hostHeader, port) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return { ok: false, code: "AUTH_HOST_MISSING" };
  }
  if (!allowedHosts(port).has(hostHeader.toLowerCase())) {
    return { ok: false, code: "AUTH_HOST_MISMATCH" };
  }
  return { ok: true };
}

/**
 * Origin 校验：缺省、字面量 "null"、自身 origin 三种放行。
 * "null" 必须按字面量比较，不能当成「没有 Origin」。
 */
export function checkOrigin(originHeader, port) {
  if (originHeader === undefined) return { ok: true };
  if (typeof originHeader !== "string") return { ok: false, code: "AUTH_ORIGIN_MISMATCH" };
  if (originHeader === "null") return { ok: true };
  if (!allowedOrigins(port).has(originHeader.toLowerCase())) {
    return { ok: false, code: "AUTH_ORIGIN_MISMATCH" };
  }
  return { ok: true };
}

/**
 * token 校验：先比长度，再 timingSafeEqual。
 */
export function checkToken(candidate, expected) {
  if (typeof candidate !== "string") return { ok: false, code: "AUTH_TOKEN_MISSING" };
  if (typeof expected !== "string" || expected.length === 0) {
    return { ok: false, code: "AUTH_TOKEN_MISMATCH" };
  }
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, code: "AUTH_TOKEN_MISMATCH" };
  try {
    if (!crypto.timingSafeEqual(a, b)) return { ok: false, code: "AUTH_TOKEN_MISMATCH" };
  } catch {
    return { ok: false, code: "AUTH_TOKEN_MISMATCH" };
  }
  return { ok: true };
}

/**
 * 按 header → query 的顺序取 token。
 *
 * 没有 cookie 分支：沙箱 iframe 是 opaque origin，浏览器不会把我们的 cookie
 * 发过来（实测服务端看到的永远是 `cookie=none`），留着只会制造「以为能用」的假象。
 */
export function readToken(req, url) {
  const fromHeader = req.headers[TOKEN_HEADER];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;
  const fromQuery = url.searchParams.get(TOKEN_QUERY);
  if (fromQuery) return fromQuery;
  return null;
}

/**
 * 注入到应用页 <head> 的口令 meta 标签。
 * 官方 page-chat 用的是同一套做法（`<meta name="magpie-chat-token">`），
 * 因为沙箱里读不到 cookie、也不该把口令写进 URL 的历史记录。
 */
export function tokenMetaTag(token) {
  return `<meta name="${TOKEN_META_NAME}" content="${token}">`;
}

/**
 * 完整的 HTTP 门禁：Host + Origin（token 由调用方按路由决定是否必需）。
 */
export function checkHttpGate(req, port) {
  const host = checkHost(req.headers.host, port);
  if (!host.ok) return host;
  return checkOrigin(req.headers.origin, port);
}

/**
 * 完整的 WS 升级门禁：Host + Origin + token。
 */
export function checkWsGate(req, url, port, expectedToken) {
  const gate = checkHttpGate(req, port);
  if (!gate.ok) return gate;
  return checkToken(readToken(req, url), expectedToken);
}
