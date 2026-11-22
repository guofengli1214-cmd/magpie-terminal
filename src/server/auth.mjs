// 四层门禁的实现：Host / Origin / token。
// 所有路由与 WS 升级都必须走这里，禁止在别处再实现一份。

import crypto from "node:crypto";

export const TOKEN_COOKIE = "mt";
export const TOKEN_HEADER = "x-magpie-term-token";
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

/** 从 cookie 头里取 mt 的值。 */
export function readCookie(cookieHeader, name = TOKEN_COOKIE) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return part.slice(index + 1).trim();
  }
  return null;
}

/** 按 header → query → cookie 的顺序取 token。 */
export function readToken(req, url) {
  const fromHeader = req.headers[TOKEN_HEADER];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;
  const fromQuery = url.searchParams.get(TOKEN_QUERY);
  if (fromQuery) return fromQuery;
  const fromCookie = readCookie(req.headers.cookie);
  if (fromCookie) return fromCookie;
  return null;
}

export function cookieHeader(token) {
  return `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
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
