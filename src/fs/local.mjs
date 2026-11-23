// 本地文件系统的受限操作面（TASK-V4-G §5.3）。
//
// 这一层只做「目录/文件的读写删」，**不做鉴权**（token 门在 http.mjs 的 isApi 分支里，
// 所有 /api/fs 请求都已经过了那道门）。但它必须自己把路径守死：
//   - 必须是绝对路径（`path.isAbsolute`）
//   - 不许含 NUL
//   - 先 resolve() 再用（`..` 归一，符号链接不展开 —— 与用户 shell 的视角一致）
//   - 删除的禁区：盘根、家目录根本身
//
// 错误一律抛 `{code, userText}`（中文人话），由路由层翻成 HTTP 状态码。

import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat as fsStat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 文本查看的默认上限（1 MB）。 */
export const MAX_READ_BYTES = 1024 * 1024;
/** 上传单文件上限（200 MB）。 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** 二进制检测窗口（前 8KB 有 NUL 就当二进制）。 */
export const SNIFF_BYTES = 8192;

function fsError(code, userText, extra) {
  const err = new Error(code);
  err.code = code;
  err.userText = userText;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * 把用户给的路径 normalize 成绝对路径；不合法就抛 400。
 *
 * 注意：不要求路径**存在**（新建文件/文件夹时它本来就不存在）。
 *
 * @param {unknown} input
 * @param {{label?: string}} [opts]
 * @returns {string}
 */
export function guardPath(input, opts = {}) {
  const label = opts.label || "路径";
  if (typeof input !== "string" || input.length === 0) {
    throw fsError("INVALID_PATH", `${label}不能是空的。`);
  }
  if (input.includes("\0")) {
    throw fsError("INVALID_PATH", `${label}里不能有空字符。`);
  }
  if (input.length > 4096) {
    throw fsError("INVALID_PATH", `${label}太长了（上限 4096 字符）。`);
  }
  if (!path.isAbsolute(input)) {
    throw fsError("INVALID_PATH", `${label}必须是绝对路径（例如 C:\\Users\\你\\某目录）。`);
  }
  const resolved = path.resolve(input);
  if (!resolved) {
    throw fsError("INVALID_PATH", `${label}解析不出绝对路径。`);
  }
  return resolved;
}

/**
 * 删除操作的禁区判定：盘根 / 家目录根本身 / 任何路径的父级是它自己。
 *
 * 返回一个中文原因（拒绝）或 null（允许）。
 *
 * @param {string} target 已经过 guardPath 的绝对路径
 * @returns {string|null}
 */
export function deletionBlockedReason(target) {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  // 盘根：`C:\`、`/`；parent === self 是根的另一条判据（保护 UNC / 挂载点）。
  if (parent === resolved) {
    return "这是盘根，不能删。";
  }
  const home = path.resolve(os.homedir());
  if (resolved === home) {
    return "这是你的家目录根本身，不能删。";
  }
  // Windows 上 `C:\` 的 resolve 结果带尾分隔符，dirname 会得到自己 —— 上面已覆盖；
  // 这里再兜一层「只有盘符」的写法（`C:` → `C:\`）。
  if (/^[A-Za-z]:[\\/]?$/.test(resolved)) {
    return "这是盘根，不能删。";
  }
  return null;
}

/** 统一的「路径不存在 / 没有权限」翻译。 */
function translateIoError(err, target, action) {
  const code = err && err.code ? err.code : null;
  if (code === "ENOENT") {
    return fsError("NOT_FOUND", `${action}失败：路径不存在（${target}）。`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return fsError("NO_PERMISSION", `${action}失败：没有权限（${target}）。`);
  }
  if (code === "ENOTDIR") {
    return fsError("NOT_A_DIRECTORY", `${action}失败：这不是一个目录（${target}）。`);
  }
  if (code === "EISDIR") {
    return fsError("IS_A_DIRECTORY", `${action}失败：这是一个目录（${target}）。`);
  }
  if (code === "ENOTEMPTY" || code === "EEXIST") {
    return fsError("DIR_NOT_EMPTY", `${action}失败：目录不是空的（${target}）。`);
  }
  if (code === "EBUSY") {
    return fsError("BUSY", `${action}失败：文件正被占用（${target}）。`);
  }
  return fsError("IO_FAILED", `${action}失败：${err && err.message ? err.message : "未知错误"}。`);
}

function typeOf(info) {
  if (info.isSymbolicLink && info.isSymbolicLink()) return "link";
  if (info.isDirectory()) return "dir";
  return "file";
}

/**
 * 列目录。目录在前、同类按名字升序（localeCompare，数字自然序）。
 * 隐藏文件也返回（前端自己决定显不显示）。
 *
 * @param {string} rawPath
 */
export async function listDirectory(rawPath) {
  const target = guardPath(rawPath);
  let info;
  try {
    info = await fsStat(target);
  } catch (err) {
    throw translateIoError(err, target, "列目录");
  }
  if (!info.isDirectory()) {
    throw fsError("NOT_A_DIRECTORY", "这不是一个目录，列不出内容。");
  }
  let names;
  try {
    names = await readdir(target, { withFileTypes: true });
  } catch (err) {
    throw translateIoError(err, target, "列目录");
  }
  const entries = [];
  for (const dirent of names) {
    const full = path.join(target, dirent.name);
    let st = null;
    try {
      st = await fsStat(full);
    } catch {
      // 断链 / 权限不足：仍然列出来，只是没有大小与时间。
      st = null;
    }
    entries.push({
      name: dirent.name,
      path: full,
      type: dirent.isSymbolicLink() ? "link" : dirent.isDirectory() ? "dir" : "file",
      size: st && Number.isFinite(st.size) ? st.size : 0,
      mtime: st && Number.isFinite(st.mtimeMs) ? Math.round(st.mtimeMs) : null,
    });
  }
  entries.sort(compareEntries);
  const parentRaw = path.dirname(target);
  return {
    path: target,
    parent: parentRaw === target ? null : parentRaw,
    entries,
  };
}

export function compareEntries(a, b) {
  if (a.type === "dir" && b.type !== "dir") return -1;
  if (a.type !== "dir" && b.type === "dir") return 1;
  return String(a.name).localeCompare(String(b.name), "en", { numeric: true, sensitivity: "base" });
}

/**
 * 读文本文件。
 *
 * - 超过 `maxBytes` → 抛 413 `FILE_TOO_LARGE`
 * - 前 8KB 有 NUL → 抛 415 `NOT_TEXT`
 *
 * @param {string} rawPath
 * @param {{maxBytes?:number}} [opts]
 * @returns {Promise<{path:string, content:string, size:number, truncated:boolean, mtime:number|null}>}
 */
export async function readTextFile(rawPath, opts = {}) {
  const target = guardPath(rawPath);
  const maxBytes =
    Number.isFinite(Number(opts.maxBytes)) && Number(opts.maxBytes) > 0
      ? Math.min(Number(opts.maxBytes), MAX_READ_BYTES)
      : MAX_READ_BYTES;
  let info;
  try {
    info = await fsStat(target);
  } catch (err) {
    throw translateIoError(err, target, "读取文件");
  }
  if (info.isDirectory()) {
    throw fsError("IS_A_DIRECTORY", "这是一个目录，不能当文本打开。");
  }
  if (info.size > maxBytes) {
    throw fsError(
      "FILE_TOO_LARGE",
      `文件太大（${formatBytes(info.size)}，上限 ${formatBytes(maxBytes)}），不适合在面板里查看。可以下载后用系统程序打开。`,
      { size: info.size, maxBytes },
    );
  }
  let buffer;
  try {
    buffer = await readFile(target);
  } catch (err) {
    throw translateIoError(err, target, "读取文件");
  }
  const sniff = buffer.subarray(0, Math.min(buffer.length, SNIFF_BYTES));
  if (sniff.includes(0)) {
    throw fsError("NOT_TEXT", "不是文本文件（内容里有二进制字节），不能当文本查看。可以下载后用系统程序打开。");
  }
  return {
    path: target,
    content: buffer.toString("utf8"),
    size: buffer.length,
    truncated: false,
    mtime: Number.isFinite(info.mtimeMs) ? Math.round(info.mtimeMs) : null,
  };
}

/**
 * 原子写文件：先写同目录的 `.tmp-<rand>`，再 rename 覆盖。
 * 父目录必须已经存在（不替你造目录）。
 *
 * @param {string} rawPath
 * @param {Buffer|string} data
 * @returns {Promise<{path:string, size:number}>}
 */
export async function writeFileAtomic(rawPath, data) {
  const target = guardPath(rawPath, { label: "目标路径" });
  const parent = path.dirname(target);
  let parentInfo;
  try {
    parentInfo = await fsStat(parent);
  } catch (err) {
    throw translateIoError(err, parent, "写文件");
  }
  if (!parentInfo.isDirectory()) {
    throw fsError("NOT_A_DIRECTORY", "目标文件的父路径不是一个目录。");
  }
  // 目标是目录：拒绝（避免把目录当成文件覆盖）。
  try {
    const existing = await fsStat(target);
    if (existing.isDirectory()) {
      throw fsError("IS_A_DIRECTORY", "目标是一个目录，不能当文件写。");
    }
  } catch (err) {
    if (err && err.code === "IS_A_DIRECTORY") throw err;
    // 不存在是正常情况（新建）。
  }
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
  const temp = path.join(
    parent,
    `.${path.basename(target)}.magpie-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(payload);
      await handle.sync().catch(() => {});
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (err) {
    try {
      await rm(temp, { force: true });
    } catch {
      // 忽略。
    }
    throw translateIoError(err, target, "写文件");
  }
  return { path: target, size: payload.length };
}

/**
 * 递归建目录（已存在不算错误）。
 * @param {string} rawPath
 */
export async function makeDirectory(rawPath) {
  const target = guardPath(rawPath);
  try {
    await mkdir(target, { recursive: true });
  } catch (err) {
    throw translateIoError(err, target, "新建文件夹");
  }
  return { path: target, created: true };
}

/**
 * 建一个空文件（父目录必须存在）。
 * @param {string} rawPath
 */
export async function makeFile(rawPath) {
  const target = guardPath(rawPath);
  const parent = path.dirname(target);
  try {
    await fsStat(parent);
  } catch (err) {
    throw translateIoError(err, parent, "新建文件");
  }
  try {
    // wx：已存在就报错，不悄悄清空别人的文件。
    const handle = await open(target, "wx");
    await handle.close();
  } catch (err) {
    if (err && err.code === "EEXIST") {
      // 已存在但有内容：不覆盖，交给用户自己决定。
      let info = null;
      try {
        info = await fsStat(target);
      } catch {
        info = null;
      }
      if (info && info.isDirectory()) {
        throw fsError("IS_A_DIRECTORY", "同名目录已经存在。");
      }
      return { path: target, created: false, existingSize: info ? info.size : 0 };
    }
    throw translateIoError(err, target, "新建文件");
  }
  return { path: target, created: true, existingSize: 0 };
}

/**
 * 重命名 / 移动。目标已存在时拒绝（不覆盖）。
 *
 * @param {string} rawFrom
 * @param {string} rawTo
 */
export async function renamePath(rawFrom, rawTo) {
  const from = guardPath(rawFrom, { label: "原路径" });
  const to = guardPath(rawTo, { label: "新路径" });
  if (from === to) {
    throw fsError("INVALID_PATH", "新名字和旧名字一样。");
  }
  const blocked = deletionBlockedReason(from);
  if (blocked) throw fsError("FORBIDDEN_PATH", `不能重命名：${blocked}`);
  try {
    await fsStat(from);
  } catch (err) {
    throw translateIoError(err, from, "重命名");
  }
  try {
    await fsStat(to);
    throw fsError("ALREADY_EXISTS", `目标已经存在：${to}`);
  } catch (err) {
    if (err && err.code === "ALREADY_EXISTS") throw err;
    // 不存在：正常。
  }
  try {
    await rename(from, to);
  } catch (err) {
    throw translateIoError(err, to, "重命名");
  }
  return { from, to };
}

/**
 * 删除。非空目录且 `recursive !== true` → 409 `DIR_NOT_EMPTY`。
 *
 * @param {string} rawPath
 * @param {{recursive?:boolean}} [opts]
 */
export async function removePath(rawPath, opts = {}) {
  const target = guardPath(rawPath);
  const blocked = deletionBlockedReason(target);
  if (blocked) throw fsError("FORBIDDEN_PATH", `不能删除：${blocked}`);
  let info;
  try {
    info = await fsStat(target);
  } catch (err) {
    throw translateIoError(err, target, "删除");
  }
  const recursive = opts.recursive === true;
  if (info.isDirectory() && !recursive) {
    let children = null;
    try {
      children = await readdir(target);
    } catch (err) {
      throw translateIoError(err, target, "删除");
    }
    if (children.length > 0) {
      throw fsError("DIR_NOT_EMPTY", `这个目录不是空的（${children.length} 项）。要连内容一起删就先勾选「递归删除」。`, {
        count: children.length,
      });
    }
  }
  try {
    if (info.isDirectory() && !recursive) {
      // Windows 上 `rm(dir)` 即使目录是空的也会报 EISDIR；空目录必须走 rmdir。
      await rmdir(target);
    } else {
      await rm(target, { recursive, force: false });
    }
  } catch (err) {
    throw translateIoError(err, target, "删除");
  }
  return { path: target, type: typeOf(info) };
}

/** @param {string} rawPath */
export async function statPath(rawPath) {
  const target = guardPath(rawPath);
  try {
    const info = await fsStat(target);
    return {
      path: target,
      name: path.basename(target),
      type: typeOf(info),
      size: info.size,
      mtime: Math.round(info.mtimeMs),
      atime: Math.round(info.atimeMs),
      mode: info.mode,
    };
  } catch (err) {
    throw translateIoError(err, target, "读取信息");
  }
}

/** 下载用的可读流；文件不存在 / 是目录都会先抛。 */
export async function openDownloadStream(rawPath) {
  const target = guardPath(rawPath);
  let info;
  try {
    info = await fsStat(target);
  } catch (err) {
    throw translateIoError(err, target, "下载");
  }
  if (info.isDirectory()) {
    throw fsError("IS_A_DIRECTORY", "目录不能直接下载（先打包或逐个下载里面的文件）。");
  }
  return { path: target, size: info.size, stream: createReadStream(target) };
}

/** 给上传用：把可读流写到目标文件（先 .tmp 再 rename）。 */
export async function writeStreamAtomic(rawPath, readable, opts = {}) {
  const target = guardPath(rawPath, { label: "目标路径" });
  const parent = path.dirname(target);
  try {
    const parentInfo = await fsStat(parent);
    if (!parentInfo.isDirectory()) throw fsError("NOT_A_DIRECTORY", "上传目标的父路径不是一个目录。");
  } catch (err) {
    if (err && err.code === "NOT_A_DIRECTORY") throw err;
    throw translateIoError(err, parent, "上传");
  }
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : MAX_UPLOAD_BYTES;
  const temp = path.join(
    parent,
    `.${path.basename(target)}.magpie-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let written = 0;
  const handle = await open(temp, "w");
  try {
    for await (const chunk of readable) {
      written += chunk.length;
      if (written > limit) {
        throw fsError("FILE_TOO_LARGE", `文件太大（上限 ${formatBytes(limit)}）。`, { limit });
      }
      await handle.write(chunk);
    }
    await handle.sync().catch(() => {});
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    if (err && err.code && err.userText) throw err;
    throw translateIoError(err, target, "上传");
  }
  await handle.close();
  try {
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw translateIoError(err, target, "上传");
  }
  return { path: target, size: written };
}

/** 写一个小文本文件（上传本地路径时内部用；不导出到路由）。 */
export async function writeTextFile(rawPath, text) {
  await writeFile(guardPath(rawPath), String(text ?? ""), "utf8");
  return { ok: true };
}

export function formatBytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
