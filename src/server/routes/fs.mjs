// /api/fs/* 与 /api/hosts/:id/fs/* 的路由（TASK-V4-G §5.3 / §5.4）。
//
// 这一层只做「解析参数 → 调 local.mjs / sftp 封装 → 写响应」；
// token 门已经在 http.mjs 的 isApi 分支里过了，这里不再鉴权。
//
// 错误形状统一 `{code, userText}`，状态码按 code 映射（见 statusOf）。
// POST /api/fs/mkdir、/rename、/api/hosts/:id/fs/* 的 JSON body 上限沿用
// http.mjs 的 64KB 读法（路径不长，够用）；PUT/上传走原始 body 的流式通道。

import { createReadStream } from "node:fs";
import path from "node:path";
import {
  MAX_UPLOAD_BYTES,
  deletionBlockedReason,
  guardPath,
  listDirectory,
  makeDirectory,
  makeFile,
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
