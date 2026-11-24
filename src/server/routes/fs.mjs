// /api/fs/* 与 /api/hosts/:id/fs/* 的路由（TASK-V4-G §5.3 / §5.4）。
//
// 这一层只做「解析参数 → 调 local.mjs / sftp 封装 → 写响应」；
// token 门已经在 http.mjs 的 isApi 分支里过了，这里不再鉴权。
//
// 错误形状统一 `{code, userText}`，状态码按 code 映射（见 statusOf）。
// POST /api/fs/mkdir、/rename、/move、/api/hosts/:id/fs/* 的 JSON body 上限沿用
// http.mjs 的 64KB 读法（路径不长，够用）；PUT/上传走原始 body 的流式通道。
//
// TASK-FIX17-C R3：新增 `POST /api/fs/move`（批量移动，逐项独立，汇总
// `{moved, failed}`；跨盘 EXDEV 在 `local.mjs` 的 movePath 里降级）。

import { createReadStream } from "node:fs";
import path from "node:path";
import {
  MAX_UPLOAD_BYTES,
  deletionBlockedReason,
  guardPath,
  listDirectory,
  makeDirectory,
  makeFile,
  movePath,
  openDownloadStream,
  readTextFile,
  removePath,
  renamePath,
  statPath,
  writeFileAtomic,
  writeStreamAtomic,
} from "../../fs/local.mjs";
import {
  listRemoteDirectory,
  readRemoteFile,
  writeRemoteFile,
  mkdirRemote,
  renameRemote,
  removeRemote,
  statRemote,
  downloadRemote,
  uploadRemote,
} from "../../ssh/fs.mjs";

/** code → HTTP 状态码。没有列出来的走 400。 */
export function statusOf(code) {
  switch (code) {
    case "INVALID_PATH":
    case "BAD_BODY":
    case "MISSING_FILENAME":
      return 400;
    case "NOT_FOUND":
    case "HOST_NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
    case "TARGET_EXISTS":
    case "DIR_NOT_EMPTY":
    case "NOT_A_DIRECTORY":
    case "IS_A_DIRECTORY":
      return 409;
    case "FILE_TOO_LARGE":
      return 413;
    case "NOT_TEXT":
      return 415;
    case "NO_PERMISSION":
    case "FORBIDDEN_PATH":
      return 403;
    case "BUSY":
      return 423;
    case "UNKNOWN_HOST_KEY":
    case "SSH_SECRET_MISSING":
      return 400;
    default:
      // SFTP_* → 502（远端问题，不是我们的参数问题）。
      return typeof code === "string" && code.startsWith("SFTP_") ? 502 : 400;
  }
}

function writeJson(res, status, payload, cors) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...cors,
  });
  res.end(body);
}

/** 把异常翻成 {code, userText} + 状态码。 */
export function sendError(res, cors, err) {
  const code = err && typeof err.code === "string" && err.code.length > 0 ? err.code : "IO_FAILED";
  const userText =
    err && typeof err.userText === "string" && err.userText.length > 0
      ? err.userText
      : "文件操作失败（服务端没有给出原因）。";
  const extra = {};
  for (const key of ["size", "maxBytes", "limit", "count"]) {
    if (err && Number.isFinite(Number(err[key]))) extra[key] = Number(err[key]);
  }
  writeJson(res, statusOf(code), { code, userText, ...extra }, cors);
}

function parseJson(buffer) {
  if (!buffer || buffer.length === 0) return null;
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** `Content-Disposition: attachment; filename*=UTF-8''…`（纯 ASCII 名也走同一套）。 */
export function contentDisposition(fileName) {
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

function baseName(p) {
  const text = String(p || "");
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return index >= 0 ? text.slice(index + 1) : text;
}

/**
 * 一批最多移动多少项（见 parseMoveBody）。
 *
 * 与 500 配套的两个事实上限：
 *   - `http.mjs` 的 JSON body 上限是 64KB（超了 413 BODY_TOO_LARGE）；
 *   - 文件面板一屏最多几百条（FULL_RENDER_LIMIT = 400）。
 * 所以前端批量移动按 `MOVE_CHUNK` 分批发（见 file-panel.js），这里只是手写
 * 请求的硬天花板，不靠它做正常路径的限制。
 */
export const MAX_MOVE_ITEMS = 500;

/** 原始 body（非 JSON）按流拿去写盘；超过上限在 writeStreamAtomic 里抛 413。 */
function rawBodyStream(req) {
  return req; // Node 的 IncomingMessage 本身就是 async iterable
}

/**
 * 处理 `/api/fs/*`。返回 true 表示已经处理（响应已写）。
 *
 * @param {{req, res, url, cors, readBody}} ctx
 */
export async function handleLocalFs(ctx) {
  const { req, res, url, cors, readBody } = ctx;
  const action = url.pathname.slice("/api/fs".length).replace(/^\//, "");

  if (req.method === "GET" && (action === "" || action === "list")) {
    try {
      const listing = await listDirectory(url.searchParams.get("path") || "");
      writeJson(res, 200, listing, cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "GET" && action === "read") {
    try {
      const maxBytes = url.searchParams.get("maxBytes");
      const result = await readTextFile(url.searchParams.get("path") || "", {
        maxBytes: maxBytes ? Number(maxBytes) : undefined,
      });
      writeJson(res, 200, result, cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "GET" && action === "stat") {
    try {
      writeJson(res, 200, await statPath(url.searchParams.get("path") || ""), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "GET" && action === "download") {
    return handleDownload(req, res, cors, url.searchParams.get("path") || "", null);
  }

  if (req.method === "PUT" && action === "write") {
    try {
      const target = guardPath(url.searchParams.get("path") || "", { label: "目标路径" });
      const result = await writeStreamAtomic(target, rawBodyStream(req), {
        limit: MAX_UPLOAD_BYTES,
      });
      writeJson(res, 200, result, cors);
    } catch (err) {
      // 写失败前可能已经读了 body；这时不能再用 sendError 写 JSON 之外的补救。
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "POST" && action === "mkdir") {
    const body = parseJson(await readBody(req, res));
    if (res.writableEnded) return true;
    if (!body) {
      writeJson(res, 400, { code: "BAD_BODY", userText: "请求体必须是 JSON 对象（{path}）。" }, cors);
      return true;
    }
    try {
      writeJson(res, 201, await makeDirectory(body.path), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "POST" && action === "newfile") {
    const body = parseJson(await readBody(req, res));
    if (res.writableEnded) return true;
    if (!body) {
      writeJson(res, 400, { code: "BAD_BODY", userText: "请求体必须是 JSON 对象（{path}）。" }, cors);
      return true;
    }
    try {
      writeJson(res, 201, await makeFile(body.path), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "POST" && action === "rename") {
    const body = parseJson(await readBody(req, res));
    if (res.writableEnded) return true;
    if (!body) {
      writeJson(res, 400, { code: "BAD_BODY", userText: "请求体必须是 JSON 对象（{from,to}）。" }, cors);
      return true;
    }
    try {
      writeJson(res, 200, await renamePath(body.from, body.to), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "POST" && action === "move") {
    const body = parseJson(await readBody(req, res));
    if (res.writableEnded) return true;
    const parsed = parseMoveBody(body);
    if (!parsed.ok) {
      writeJson(res, 400, { code: parsed.code, userText: parsed.userText }, cors);
      return true;
    }
    const result = await runMoveItems(parsed.items, parsed.overwrite);
    writeJson(res, 200, result, cors);
    return true;
  }

  if (req.method === "POST" && action === "upload") {
    return handleUpload(req, res, cors, url, null);
  }

  if (req.method === "DELETE" && action === "") {
    const recursive = ["1", "true", "yes"].includes(String(url.searchParams.get("recursive") || ""));
    try {
      writeJson(res, 200, await removePath(url.searchParams.get("path") || "", { recursive }), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  writeJson(res, 404, { code: "NOT_FOUND", userText: "没有这个文件接口。" }, cors);
  return true;
}

/**
 * 解析 `POST /api/fs/move` 的请求体。
 *
 * `items` 上限 `MAX_MOVE_ITEMS`：加个上限是为了不让一个手写的请求把事件循环
 * 占死（每项都要 stat 两次 + rename）。
 *
 * @param {unknown} body
 * @returns {{ok:true, items:Array<{from:string,to:string}>, overwrite:boolean} | {ok:false, code:string, userText:string}}
 */
export function parseMoveBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "BAD_BODY", userText: "请求体必须是 JSON 对象（{items:[{from,to}]}）。" };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, code: "BAD_BODY", userText: "items 必须是非空数组。" };
  }
  if (body.items.length > MAX_MOVE_ITEMS) {
    return {
      ok: false,
      code: "TOO_MANY_ITEMS",
      userText: `一次最多移动 ${MAX_MOVE_ITEMS} 项（本次 ${body.items.length} 项）。`,
    };
  }
  const items = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, code: "BAD_BODY", userText: "items 里每一项都必须是 {from,to} 对象。" };
    }
    if (typeof raw.from !== "string" || typeof raw.to !== "string") {
      return { ok: false, code: "BAD_BODY", userText: "items 里每一项的 from / to 都必须是字符串。" };
    }
    items.push({ from: raw.from, to: raw.to });
  }
  return { ok: true, items, overwrite: body.overwrite === true };
}

/**
 * 逐项移动：**单项失败不影响其它项**，汇总成 `{moved, failed}`。
 *
 * 为什么不整体 4xx/5xx：批量移动是「10 个里有 1 个撞名」的典型场景，
 * 一次就中断会让用户重试时前面成功的那些又得跳过。所以状态码固定 200，
 * 失败明细逐条给 code + 中文 userText，前端自己汇总提示。
 *
 * @param {Array<{from:string,to:string}>} items
 * @param {boolean} overwrite
 */
export async function runMoveItems(items, overwrite) {
  const moved = [];
  const failed = [];
  for (const item of items) {
    try {
      const result = await movePath(item.from, item.to, { overwrite: overwrite === true });
      moved.push({ from: result.from, to: result.to, via: result.via });
    } catch (err) {
      failed.push({
        from: item.from,
        to: item.to,
        code: err && typeof err.code === "string" ? err.code : "E_MOVE",
        userText:
          err && typeof err.userText === "string" && err.userText.length > 0
            ? err.userText
            : "移动失败（服务端没有给出原因）。",
      });
    }
  }
  return { moved, failed };
}

async function handleDownload(req, res, cors, target, remoteOpener) {
  let opened;
  try {
    opened = remoteOpener ? await remoteOpener() : await openDownloadStream(target);
  } catch (err) {
    sendError(res, cors, err);
    return true;
  }
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": opened.size,
    "content-disposition": contentDisposition(baseName(opened.path || target)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...cors,
  });
  await new Promise((resolve) => {
    const stream = opened.stream;
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
 * 上传：原始 body + `x-filename` 头（URL 编码）+ `?path=<目标目录>`。
 * 目标文件 = path + sep + filename；单文件上限 200 MB。
 */
async function handleUpload(req, res, cors, url, remoteUploader) {
  let fileName = "";
  try {
    fileName = decodeURIComponent(String(req.headers["x-filename"] || ""));
  } catch {
    fileName = "";
  }
  if (!fileName) {
    writeJson(res, 400, { code: "MISSING_FILENAME", userText: "缺少文件名（x-filename 头）。" }, cors);
    // 必须把 body 读掉，否则连接会被客户端看到 reset。
    req.resume();
    return true;
  }
  if (/[\\/]/.test(fileName) || fileName === "." || fileName === "..") {
    writeJson(res, 400, { code: "INVALID_PATH", userText: "文件名里不能带路径分隔符。" }, cors);
    req.resume();
    return true;
  }
  const dirRaw = url.searchParams.get("path") || "";
  try {
    if (remoteUploader) {
      const result = await remoteUploader(dirRaw, fileName, req);
      writeJson(res, 201, result, cors);
      return true;
    }
    const dir = guardPath(dirRaw, { label: "目标目录" });
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : path.sep;
    const target = guardPath(`${dir}${sep}${fileName}`, { label: "目标文件" });
    const result = await writeStreamAtomic(target, rawBodyStream(req), {
      limit: MAX_UPLOAD_BYTES,
    });
    writeJson(res, 201, result, cors);
  } catch (err) {
    req.resume();
    sendError(res, cors, err);
  }
  return true;
}

/**
 * 处理 `/api/hosts/:id/fs/*`。返回 true 表示已处理。
 *
 * 远程的形态与本地同名同形；差异（写在 REPORT 里）：
 * - 远程删除只允许空目录（不递归），`recursive=1` 直接 400；
 * - 远程 write/upload 没有原子 rename 的保证（SFTP 写完即生效）。
 */
export async function handleRemoteFs(ctx) {
  const { req, res, url, cors, readBody, hostId } = ctx;
  const prefix = `/api/hosts/${hostId}/fs`;
  const action = url.pathname.slice(prefix.length).replace(/^\//, "");

  if (req.method === "GET" && (action === "" || action === "list")) {
    try {
      writeJson(res, 200, await listRemoteDirectory(hostId, url.searchParams.get("path") || "."), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "GET" && action === "read") {
    try {
      const result = await readRemoteFile(hostId, url.searchParams.get("path") || "");
      writeJson(res, 200, result, cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "GET" && action === "stat") {
    try {
      writeJson(res, 200, await statRemote(hostId, url.searchParams.get("path") || ""), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "GET" && action === "download") {
    const target = url.searchParams.get("path") || "";
    return handleDownload(req, res, cors, target, () => downloadRemote(hostId, target));
  }

  if (req.method === "PUT" && action === "write") {
    try {
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_UPLOAD_BYTES) {
          writeJson(res, 413, { code: "FILE_TOO_LARGE", userText: "文件太大（上限 200 MB）。" }, cors);
          req.resume();
          return true;
        }
        chunks.push(chunk);
      }
      const result = await writeRemoteFile(hostId, url.searchParams.get("path") || "", Buffer.concat(chunks));
      writeJson(res, 200, result, cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "POST" && action === "mkdir") {
    const body = parseJson(await readBody(req, res));
    if (res.writableEnded) return true;
    if (!body) {
      writeJson(res, 400, { code: "BAD_BODY", userText: "请求体必须是 JSON 对象（{path}）。" }, cors);
      return true;
    }
    try {
      writeJson(res, 201, await mkdirRemote(hostId, body.path), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "POST" && action === "rename") {
    const body = parseJson(await readBody(req, res));
    if (res.writableEnded) return true;
    if (!body) {
      writeJson(res, 400, { code: "BAD_BODY", userText: "请求体必须是 JSON 对象（{from,to}）。" }, cors);
      return true;
    }
    try {
      writeJson(res, 200, await renameRemote(hostId, body.from, body.to), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  if (req.method === "POST" && action === "move") {
    // 远程批量移动（R3）：SFTP 侧本批未实现（\`src/ssh/fs.mjs\` 没有递归复制），
    // 所以**明确拒绝**而不是让前端假装成功。每一项都回 NOT_SUPPORTED，
    // 形状与本地一致（{moved, failed}），前端只需按 failed 汇总即可。
    const body = parseJson(await readBody(req, res));
    if (res.writableEnded) return true;
    const parsed = parseMoveBody(body);
    if (!parsed.ok) {
      writeJson(res, 400, { code: parsed.code, userText: parsed.userText }, cors);
      return true;
    }
    writeJson(
      res,
      200,
      {
        moved: [],
        failed: parsed.items.map((item) => ({
          from: item.from,
          to: item.to,
          code: "NOT_SUPPORTED",
          userText: "远程主机暂不支持批量移动。",
        })),
      },
      cors,
    );
    return true;
  }

  if (req.method === "POST" && action === "upload") {
    return handleUpload(req, res, cors, url, (dir, fileName, stream) =>
      uploadRemote(hostId, dir, fileName, stream),
    );
  }

  if (req.method === "DELETE" && action === "") {
    const recursive = ["1", "true", "yes"].includes(String(url.searchParams.get("recursive") || ""));
    if (recursive) {
      writeJson(
        res,
        400,
        { code: "INVALID_PATH", userText: "远程目录不递归删除（只允许删空目录）。先在里面逐个删干净。" },
        cors,
      );
      return true;
    }
    try {
      writeJson(res, 200, await removeRemote(hostId, url.searchParams.get("path") || ""), cors);
    } catch (err) {
      sendError(res, cors, err);
    }
    return true;
  }

  writeJson(res, 404, { code: "NOT_FOUND", userText: "没有这个远程文件接口。" }, cors);
  return true;
}

export { createReadStream, deletionBlockedReason };
