// 保留功能的本地路径护栏：/api/fs/reveal 与导出链路用（本机文件面板已删）。

import { realpath, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { isSensitivePath } from "../policy/sensitive.mjs";

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
function guardPath(input, opts = {}) {
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
    throw fsError("INVALID_PATH", `${label}必须是绝对路径（例如 /home/你/某目录 或 C:\\Users\\你\\某目录）。`);
  }
  const resolved = path.resolve(input);
  if (!resolved) {
    throw fsError("INVALID_PATH", `${label}解析不出绝对路径。`);
  }
  return resolved;
}

/**
 * 取真实路径（展开符号链接 / junction）。
 *
 * 目标还不存在时（新建文件 / 新建文件夹 / 第一次上传）返回原路径：
 * 这种场景没有「链接后面藏着什么」的问题，调用方会再对父目录做一次真实路径检查。
 *
 * @param {string} target 已经过 guardPath 的绝对路径
 * @returns {Promise<string>}
 */
async function realPathOf(target) {
  try {
    return await realpath(target);
  } catch {
    // ENOENT（目标还不存在）/ EACCES（父目录不可读）：按「就是它自己」处理。
    return target;
  }
}

/**
 * 读操作（列目录 / 读文件 / 下载 / stat）的敏感路径判定。
 *
 * 用真实路径判，而不是用户给的字符串：junction / 符号链接会把 `C:	mp\link`
 * 指到家目录，只比字符串就全漏。
 *
 * @param {string} real 真实路径
 * @returns {string|null} 拒绝原因（中文）或 null
 */
function sensitiveBlockedReason(real) {
  if (isSensitivePath(real)) return "这个位置是密钥或凭据目录，不能通过文件面板访问。";
  return null;
}

function typeOf(info) {
  if (info.isSymbolicLink && info.isSymbolicLink()) return "link";
  if (info.isDirectory()) return "dir";
  return "file";
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

/** @param {string} rawPath */
async function statPath(rawPath) {
  const target = guardPath(rawPath);
  const realStat = await realPathOf(target);
  const statBlocked = sensitiveBlockedReason(realStat);
  if (statBlocked) throw fsError("FORBIDDEN_PATH", statBlocked);
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

export { guardPath, statPath, realPathOf, sensitiveBlockedReason };
