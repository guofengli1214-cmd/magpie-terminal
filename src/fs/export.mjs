// 「下载 / 导出到指定目录」的落盘逻辑（TASK-FIX17-L1 R2 / R3 / R5）。
//
// 为什么单独一个模块而不是塞进 routes/fs.mjs：
// - 重名策略（`name (1).ext`）是**纯逻辑**，必须能脱离 HTTP 单测；
// - 本模块现在只服务远程 sftp 下载：写入下载目录、撞名与错误映射。
//
// 三条硬约束：
//   ① **绝不覆盖已有文件**：`name` 被占用就退到 `name (1).ext`，最多 999 次；
//   ② **错误形状统一** `{code, userText}`，与 routes/fs.mjs 的 statusOf 对齐；
//   ③ **不把完整路径写进日志**：本模块只返回结果，日志由调用方记 `{bytes,name}`。

import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { downloadRemote } from "../ssh/fs.mjs";

/** 撞名时最多试到 `name (999).ext`；再撞就报错，不无限循环。 */
export const UNIQUE_MAX_TRIES = 999;

/**
 * 造一个带 `code` / `userText` 的错误（与 `src/fs/guard.mjs` 的 fsError 同形）。
 * @param {string} code
 * @param {string} userText
 * @param {object} [extra]
 */
export function exportError(code, userText, extra) {
  const err = new Error(code);
  err.code = code;
  err.userText = userText;
  if (extra) Object.assign(err, extra);
  return err;
}

/** 未设置下载目录（HTTP 层：`/api/fs/save` 回 200 {ok:false,…}，日志导出回 400）。 */
export function noDownloadDirError() {
  return exportError("NO_DOWNLOAD_DIR", "还没有设置下载目录");
}

/** 目录建不出来 / 写不进去（权限、只读盘、磁盘满）。`userText` 里带完整目录，用户要能照着改。 */
export function downloadDirUnwritableError(dir, cause) {
  const err = exportError(
    "DOWNLOAD_DIR_UNWRITABLE",
    `下载目录写不进去：${dir}`,
    cause && typeof cause.code === "string" ? { reason: cause.code } : undefined,
  );
  return err;
}

/** 这些 errno 都归「目录写不进去」，其它 io 错误是传输失败。 */
const DIR_ERRNOS = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "ENOTDIR", "EEXIST", "EMFILE"]);

function asDirError(err, dir) {
  if (err && DIR_ERRNOS.has(err.code)) return downloadDirUnwritableError(dir, err);
  return null;
}

/**
 * 拆文件名：`a.tar.gz` → `{stem:"a.tar", ext:".gz"}`；
 * `.bashrc`（无主名的点文件）→ `{stem:".bashrc", ext:""}`。
 * @param {string} name
 */
export function splitFileName(name) {
  const text = String(name || "");
  const index = text.lastIndexOf(".");
  if (index <= 0) return { stem: text, ext: "" };
  return { stem: text.slice(0, index), ext: text.slice(index) };
}

/**
 * 第 n 个候选名：n=0 原名，n≥1 是 `stem (n).ext`。
 * @param {string} name
 * @param {number} index
 */
export function candidateName(name, index) {
  if (index <= 0) return String(name || "");
  const { stem, ext } = splitFileName(name);
  return `${stem} (${index})${ext}`;
}

/** 目标是否已存在（O(1) 一次 stat，不抛）。 */
async function fileExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 `dir` 里给 `name` 找一个不撞名的绝对路径。
 *
 * `exists` 可注入：单测里用一个 Set 即可验证 999 次上限与命名规则，
 * 不必真造 999 个文件。
 *
 * @param {string} dir 已归一的绝对目录
 * @param {string} name 源文件名（不含路径）
 * @param {{exists?:(target:string)=>Promise<boolean>, maxTries?:number}} [deps]
 * @returns {Promise<{target:string, name:string}>}
 */
export async function resolveUniqueTarget(dir, name, deps = {}) {
  const exists = typeof deps.exists === "function" ? deps.exists : fileExists;
  const maxTries = Number.isFinite(deps.maxTries) && deps.maxTries > 0 ? deps.maxTries : UNIQUE_MAX_TRIES;
  for (let index = 0; index < maxTries; index += 1) {
    const candidate = candidateName(name, index);
    const target = path.join(dir, candidate);
    if (!(await exists(target))) return { target, name: candidate };
  }
  throw exportError(
    "TOO_MANY_DUPLICATES",
    `这个目录里已经有 ${maxTries} 个同名文件，先清理一下再下载。`,
  );
}

/** 建下载目录（幂等）；失败映射成 DOWNLOAD_DIR_UNWRITABLE。 */
async function ensureDownloadDir(dir, mkdirImpl) {
  try {
    await mkdirImpl(dir, { recursive: true });
  } catch (err) {
    throw asDirError(err, dir) || downloadDirUnwritableError(dir, err);
  }
}

/** 下载目录必须是非空字符串（调用方已经判过「有没有设置」，这里是兜底）。 */
function requireDir(downloadDir) {
  if (typeof downloadDir !== "string" || downloadDir.trim().length === 0) {
    throw noDownloadDirError();
  }
  return downloadDir;
}

/** 远程错误 → 本接口的形状：连不上统一 502 HOST_UNREACHABLE，其余原样（404 之类）。 */
function mapRemoteError(err) {
  const code = err && typeof err.code === "string" ? err.code : "";
  if (code === "ENOENT" || code === "SFTP_NO_SUCH_FILE") {
    return exportError("NOT_FOUND", "远端找不到这个文件。");
  }
  if (
    code === "HOST_NOT_FOUND" ||
    code === "NOT_FOUND" ||
    code === "NO_PERMISSION" ||
    code === "INVALID_PATH" ||
    code === "IS_A_DIRECTORY" ||
    code === "IS_DIRECTORY" ||
    code === "UNKNOWN_HOST_KEY" ||
    code === "SSH_SECRET_MISSING" ||
    code === "SSH_AUTH_FAILED" ||
    code === "SSH_KEY_MISSING" ||
    code === "SSH_KEY_UNREADABLE"
  ) {
    return err;
  }
  return exportError("HOST_UNREACHABLE", "连不上这台主机，文件没有下载。", {
    reason: code || "SSH_FAILED",
  });
}

/**
 * 远程文件保存到下载目录（R3）：先写 `<dir>/.<name>.part`，再 rename 成最终名。
 *
 * 为什么要 `.part`：sftp 流可能中途断（远端 kill / 网络抖动）。直接写最终名会留下
 * 一个「看起来下载成功、其实截断」的文件，用户拿它当真结果用。
 *
 * 跨设备 rename 失败（EXDEV，例如下载目录是另一个挂载点上的符号链接目标）时
 * 退回「把 `.part` 复制成最终名再删掉 `.part`」，不重新下载一遍。
 *
 * @param {string} hostId
 * @param {string} remotePath 远端文件路径
 * @param {string} downloadDir
 * @param {{downloadRemote?, mkdir?, rename?, rm?, copyFile?, exists?, createWriteStream?}} [deps]
 */
export async function saveRemoteFile(hostId, remotePath, downloadDir, deps = {}) {
  const dir = requireDir(downloadDir);
  const openRemote = deps.downloadRemote || downloadRemote;
  const mkdirImpl = deps.mkdir || mkdir;
  const renameImpl = deps.rename || rename;
  const rmImpl = deps.rm || rm;
  const copyImpl = deps.copyFile || copyFile;
  const streamFactory = deps.createWriteStream || createWriteStream;

  const remoteText = String(remotePath || "");
  const remoteName = remoteText.split(/[\\/]/).filter((part) => part.length > 0).pop() || "";
  if (remoteName.length === 0) throw exportError("INVALID_PATH", "远端路径不能是空的。");

  let opened;
  try {
    opened = await openRemote(hostId, remoteText);
  } catch (err) {
    throw mapRemoteError(err);
  }

  await ensureDownloadDir(dir, mkdirImpl);
  const partPath = path.join(dir, `.${remoteName}.part`);
  try {
    const sink = streamFactory(partPath);
    await pipeline(opened.stream, sink);
  } catch (err) {
    await rmImpl(partPath, { force: true }).catch(() => {});
    const mapped = asDirError(err, dir);
    if (mapped) throw mapped;
    throw exportError("TRANSFER_FAILED", "下载中断了，没有留下半截文件。", {
      reason: err && err.code ? String(err.code) : "E_TRANSFER",
    });
  }

  const { target, name } = await resolveUniqueTarget(dir, remoteName, deps);
  try {
    await renameImpl(partPath, target);
  } catch (err) {
    // EXDEV / EPERM：跨设备或目标被占用 → 复制一份最终名，再清掉 .part。
    try {
      await copyImpl(partPath, target);
      await rmImpl(partPath, { force: true });
    } catch (copyErr) {
      await rmImpl(partPath, { force: true }).catch(() => {});
      const mapped = asDirError(copyErr, dir);
      if (mapped) throw mapped;
      throw exportError("TRANSFER_FAILED", "写进下载目录失败（跨设备移动不通）。", {
        reason: copyErr && copyErr.code ? String(copyErr.code) : "E_RENAME",
      });
    }
  }
  return { savedPath: target, bytes: Number(opened.size) || 0, name };
}

/**
 * 文本（日志导出）写到下载目录（R5）。
 *
 * @param {string} text 已脱敏的全文
 * @param {string} downloadDir
 * @param {string} fileName `show-terminal-logs-YYYYMMDD-HHmmss.log`
 * @param {{writeFile?, mkdir?, exists?}} [deps]
 * @returns {Promise<{savedPath:string, bytes:number, name:string}>}
 */
export async function saveTextToDir(text, downloadDir, fileName, deps = {}) {
  const dir = requireDir(downloadDir);
  const writeImpl = deps.writeFile || writeFile;
  const mkdirImpl = deps.mkdir || mkdir;
  const body = typeof text === "string" ? text : "";
  await ensureDownloadDir(dir, mkdirImpl);
  const { target, name } = await resolveUniqueTarget(dir, fileName, deps);
  try {
    await writeImpl(target, body, "utf8");
  } catch (err) {
    const mapped = asDirError(err, dir);
    if (mapped) throw mapped;
    throw exportError("LOGS_EXPORT_FAILED", "日志没写进下载目录。", {
      reason: err && err.code ? String(err.code) : "E_WRITE",
    });
  }
  return { savedPath: target, bytes: Buffer.byteLength(body, "utf8"), name };
}
