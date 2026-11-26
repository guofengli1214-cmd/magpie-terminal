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
 *
 * `cors` 由调用方（http.mjs 的 corsHeaders）传入并原样写进响应头。
 * 这一层必须能带 CORS：magpie 的插件页在沙箱 iframe（opaque origin）里，
 * `/app.js` 与它 `import` 的 `/core/*`、`/ui/*` 都是 CORS 请求，
 * 缺 `access-control-allow-origin` 会被浏览器拦下，页面白屏。
 */
export async function sendStatic(res, pathname, cors = {}) {
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
    ...cors,
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

/**
 * 页面图标（`package.json` 的 `magpie.page.icon` = `page/icon.svg`）的绝对路径。
 *
 * 它**不在** `APP_ROOT`（`app/`）下，所以走不了 `resolveStatic`：那条路的职责是
 * 把 URL 关进 `app/` 的边界里，为一个图标放宽边界会让「路径穿越防护」多一个入口。
 * 这里改成写死一个常量路径 —— 只有这一个文件对外开放，没有可拼的输入。
 */
export const ICON_PATH = path.resolve(HERE, "..", "..", "page", "icon.svg");

/**
 * 直接把页面图标写进响应；文件不存在或读不出来返回 false（不写响应）。
 *
 * 头部与 `sendStatic` 保持一致（`no-store` + `nosniff` + CORS）：沙箱 iframe 里
 * 取图标也是跨源请求，缺 `access-control-allow-origin` 会被浏览器拦下。
 *
 * @param {import("node:http").ServerResponse} res
 * @param {Record<string,string>} [cors] `http.mjs` 的 `corsHeaders()` 结果，原样写进响应头
 * @returns {Promise<boolean>} 是否已把响应写出去
 */
export async function sendIcon(res, cors = {}) {
  let info;
  try {
    info = await stat(ICON_PATH);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  res.writeHead(200, {
    "content-type": "image/svg+xml",
    "content-length": info.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...cors,
  });
  await new Promise((resolve) => {
    const stream = createReadStream(ICON_PATH);
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
