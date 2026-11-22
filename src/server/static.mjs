// 静态资源：只服务 app/ 下的文件，路径穿越一律 404。
// 开发期统一 Cache-Control: no-store。

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, "..", "..", "app");

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".woff2", "font/woff2"],
  [".map", "application/json; charset=utf-8"],
]);

export const STATIC_PREFIXES = ["/app.js", "/core/", "/ui/", "/styles/", "/vendor/"];

export function isStaticPath(pathname) {
  if (pathname === "/app.js") return true;
  return STATIC_PREFIXES.some((prefix) => prefix.endsWith("/") && pathname.startsWith(prefix));
}

export function mimeFor(filePath) {
  return MIME.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

/**
 * 解析静态路径到绝对文件路径；越界或非法返回 null。
 */
export function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded.replace(/^\/+/, "");
  const target = path.resolve(APP_ROOT, relative);
  const rootWithSep = APP_ROOT.endsWith(path.sep) ? APP_ROOT : APP_ROOT + path.sep;
  if (target !== APP_ROOT && !target.startsWith(rootWithSep)) return null;
  return target;
}

/**
 * 直接把文件写进响应；文件不存在返回 false。
 */
export async function sendStatic(res, pathname) {
  const target = resolveStatic(pathname);
  if (!target) return false;
  let info;
  try {
    info = await stat(target);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  res.writeHead(200, {
    "content-type": mimeFor(target),
    "content-length": info.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  await new Promise((resolve) => {
    const stream = createReadStream(target);
    stream.on("error", () => {
      res.destroy();
      resolve();
    });
    stream.on("end", resolve);
    stream.pipe(res);
  });
  return true;
}

export async function readAppFile(relative) {
  const { readFile } = await import("node:fs/promises");
  const target = path.resolve(APP_ROOT, relative);
  const rootWithSep = APP_ROOT.endsWith(path.sep) ? APP_ROOT : APP_ROOT + path.sep;
  if (target !== APP_ROOT && !target.startsWith(rootWithSep)) {
    throw new Error("path escapes app root");
  }
  return readFile(target, "utf8");
}
