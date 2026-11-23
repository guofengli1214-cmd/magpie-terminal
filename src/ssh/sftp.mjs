// SFTP 只读目录列表（TASK-V2-B §2.4 / §3：不做上传 / 下载 / 编辑）。
//
// 输出形状固定：`[{ name, path, type, size, mtime }]`
// - type 三值：`"dir" | "file" | "link"`（ssh2 给的是 `d`/`-`/`l` 前缀）
// - 目录在前，同类按名字排序（`localeCompare`，大小写不敏感、数字自然序）
// - `path` 由调用方给的目录 + 条目名拼出来，分隔符跟随父路径（Linux `/`，Windows `\`）

/**
 * 按父路径的分隔符风格拼子路径。
 * Windows 远端给的是 `C:\Users\x`，用 posix.join 会得到 `C:\Users\x/.agents`
 * （两种分隔符混用，用户看着像 bug，切目录时也不好回退）。
 * @param {string} parent
 * @param {string} name
 */
function joinRemote(parent, name) {
  const base = typeof parent === "string" && parent.length > 0 ? parent : "/";
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  return `${base}${sep}${name}`;
}

/** ssh2 的 longname 首字符 → 语义类型。
 *
 * 注意字段名：ssh2 的 readdir 条目是 `{ filename, longname, attrs }`
 * （不是 `attributes`）。拿错字段会让所有条目都变成 file —— 实测踩过。
 */
function typeOf(attrs, longname) {
  const mode = attrs && typeof attrs.mode === "number" ? attrs.mode : null;
  if (mode !== null) {
    // 用 POSIX mode bit 判断，比 longname 首字符可靠（某些服务端 longname 为空）。
    const fmt = mode & 0o170000;
    if (fmt === 0o040000) return "dir";
    if (fmt === 0o120000) return "link";
    if (fmt === 0o100000) return "file";
  }
  const text = typeof longname === "string" ? longname : "";
  if (text.startsWith("d")) return "dir";
  if (text.startsWith("l")) return "link";
  return "file";
}

function compareEntries(a, b) {
  if (a.type === "dir" && b.type !== "dir") return -1;
  if (a.type !== "dir" && b.type === "dir") return 1;
  return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
}

/**
 * 列一个远程目录。
 *
 * @param {import("ssh2").SFTPWrapper} sftp 已打开的 SFTP 会话
 * @param {string} dirPath 绝对远程路径（调用方负责校验）
 * @returns {Promise<Array<{name:string,path:string,type:"dir"|"file"|"link",size:number,mtime:number|null}>>}
 */
export function listDirectory(sftp, dirPath) {
  const target = typeof dirPath === "string" && dirPath.length > 0 ? dirPath : "/";
  return new Promise((resolve, reject) => {
    sftp.readdir(target, (err, list) => {
      if (err) {
        const wrapped = new Error("SFTP_READDIR_FAILED");
        wrapped.code = "SFTP_READDIR_FAILED";
        wrapped.userText = "列不出这个目录（不存在或没有权限）。";
        reject(wrapped);
        return;
      }
      const entries = [];
      for (const item of Array.isArray(list) ? list : []) {
        const name = item && typeof item.filename === "string" ? item.filename : null;
        if (!name || name === "." || name === "..") continue;
        // ssh2 的条目字段是 `attrs`（不是 attributes）。
        const attrs = item.attrs || {};
        entries.push({
          name,
          path: joinRemote(target, name),
          type: typeOf(attrs, item.longname),
          size: Number.isFinite(attrs.size) ? attrs.size : 0,
          // ssh2 给的是秒；这里统一成毫秒，前端好格式化。
          mtime: Number.isFinite(attrs.mtime) ? attrs.mtime * 1000 : null,
        });
      }
      entries.sort(compareEntries);
      resolve(entries);
    });
  });
}

/**
 * 在已建好的 SSH 连接上开一个 SFTP 会话、列目录、关掉。
 * 一次请求一个连接，不做连接池（本卡范围内目录树是低频操作）。
 *
 * @param {import("ssh2").Client} client
 * @param {string} dirPath
 */
export async function listViaClient(client, dirPath) {
  const sftp = await new Promise((resolve, reject) => {
    client.sftp((err, channel) => {
      if (err) {
        const wrapped = new Error("SFTP_OPEN_FAILED");
        wrapped.code = "SFTP_OPEN_FAILED";
        wrapped.userText = "这台主机不提供 SFTP（目录树不可用）。";
        reject(wrapped);
        return;
      }
      resolve(channel);
    });
  });
  try {
    return await listDirectory(sftp, dirPath);
  } finally {
    try {
      sftp.end();
    } catch {
      // 忽略。
    }
  }
}

/* ------------------------------------------------------------------ *
 * 读写操作（TASK-V4-G §5.4）
 *
 * 全部是「已打开的 SFTP 通道」上的薄封装；连接生命周期由 ssh/fs.mjs 管
 * （一次请求一条连接，用完即断 —— 与本文件上面 listViaClient 的策略一致）。
 *
 * 错误一律抛带 code / userText 的 Error，code 前缀 `SFTP_`，路由层映射成 502。
 * ------------------------------------------------------------------ */

function sftpError(code, userText) {
  const err = new Error(code);
  err.code = code;
  err.userText = userText;
  return err;
}

function wrapErr(code, userText) {
  return (err) => {
    const wrapped = sftpError(code, userText);
    wrapped.cause = err || null;
    // 远端报「没有这个文件」时把 404 语义带出去（http 层认 NOT_FOUND）。
    const message = String((err && err.message) || "");
    if (/no such file/i.test(message) || (err && err.code === 2)) {
      wrapped.code = "NOT_FOUND";
      wrapped.userText = "远端没有这个路径。";
    } else if (/permission denied/i.test(message) || (err && err.code === 3)) {
      wrapped.code = "NO_PERMISSION";
      wrapped.userText = "远端拒绝了这个操作（没有权限）。";
    }
    return wrapped;
  };
}

/** 打开 SFTP 通道；调用方负责 end()。 */
export function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((err, channel) => {
      if (err) {
        const wrapped = sftpError("SFTP_OPEN_FAILED", "这台主机不提供 SFTP（文件面板不可用）。");
        wrapped.cause = err || null;
        reject(wrapped);
        return;
      }
      resolve(channel);
    });
  });
}

/** 读整个文件（上限 maxBytes）。 */
export function readFile(sftp, filePath, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    sftp.stat(filePath, (statErr, stats) => {
      if (statErr) {
        reject(wrapErr("SFTP_READ_FAILED", "读不到这个远端文件。")(statErr));
        return;
      }
      if (stats && Number.isFinite(stats.size) && stats.size > maxBytes) {
        const err = sftpError(
          "FILE_TOO_LARGE",
          `文件太大（${(stats.size / 1024 / 1024).toFixed(1)} MB，上限 ${(maxBytes / 1024 / 1024).toFixed(1)} MB），不适合在面板里查看。`,
        );
        err.size = stats.size;
        err.maxBytes = maxBytes;
        reject(err);
        return;
      }
      sftp.readFile(filePath, (err, buffer) => {
        if (err) {
          reject(wrapErr("SFTP_READ_FAILED", "读不到这个远端文件。")(err));
          return;
        }
        const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ""), "utf8");
        const sniff = data.subarray(0, Math.min(data.length, 8192));
        if (sniff.includes(0)) {
          reject(sftpError("NOT_TEXT", "不是文本文件（内容里有二进制字节），不能当文本查看。"));
          return;
        }
        resolve({
          content: data.toString("utf8"),
          size: data.length,
          mtime: stats && Number.isFinite(stats.mtime) ? stats.mtime * 1000 : null,
        });
      });
    });
  });
}

/** 原子写（远端没有 rename 的原子保证，写完直接生效）。 */
export function writeFile(sftp, filePath, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
  return new Promise((resolve, reject) => {
    sftp.writeFile(filePath, buffer, (err) => {
      if (err) {
        reject(wrapErr("SFTP_WRITE_FAILED", "写不进这个远端文件。")(err));
        return;
      }
      resolve({ size: buffer.length });
    });
  });
}

/** mkdir（不递归：SFTP 的 mkdir 一次只建一级）。 */
export function mkdir(sftp, dirPath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(dirPath, (err) => {
      if (err) {
        reject(wrapErr("SFTP_MKDIR_FAILED", "建不了这个远端目录。")(err));
        return;
      }
      resolve({ path: dirPath });
    });
  });
}

export function rename(sftp, from, to) {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => {
      if (err) {
        reject(wrapErr("SFTP_RENAME_FAILED", "远端重命名失败（目标可能已存在）。")(err));
        return;
      }
      resolve({ from, to });
    });
  });
}

/** 删文件或**空**目录（SFTP rmdir 对非空目录会自己失败）。 */
export function remove(sftp, target) {
  return new Promise((resolve, reject) => {
    sftp.stat(target, (statErr, stats) => {
      if (statErr) {
        reject(wrapErr("SFTP_REMOVE_FAILED", "远端没有这个路径。")(statErr));
        return;
      }
      const isDir = stats && typeof stats.mode === "number" && (stats.mode & 0o170000) === 0o040000;
      const done = (err) => {
        if (err) {
          const message = String((err && err.message) || "");
          // rmdir 在非空目录上失败：给 409 的语义（而不是笼统的 502）。
          if (isDir && /not empty|notempty|failure/i.test(message)) {
            reject(sftpError("DIR_NOT_EMPTY", "这个远程目录不是空的，远程只能删空目录。"));
            return;
          }
          reject(wrapErr("SFTP_REMOVE_FAILED", "删不掉这个远端路径（目录可能不是空的）。")(err));
          return;
        }
        resolve({ path: target, type: isDir ? "dir" : "file" });
      };
      if (isDir) sftp.rmdir(target, done);
      else sftp.unlink(target, done);
    });
  });
}

export function stat(sftp, target) {
  return new Promise((resolve, reject) => {
    sftp.stat(target, (err, stats) => {
      if (err) {
        reject(wrapErr("SFTP_STAT_FAILED", "读不到这个远端路径的信息。")(err));
        return;
      }
      const mode = stats && typeof stats.mode === "number" ? stats.mode : 0;
      const fmt = mode & 0o170000;
      resolve({
        path: target,
        type: fmt === 0o040000 ? "dir" : fmt === 0o120000 ? "link" : "file",
        size: stats && Number.isFinite(stats.size) ? stats.size : 0,
        mtime: stats && Number.isFinite(stats.mtime) ? stats.mtime * 1000 : null,
        mode,
      });
    });
  });
}

/** 下载：给一个可读流（调用方负责在结束时 end 掉通道）。 */
export function createReadStream(sftp, target) {
  return sftp.createReadStream(target);
}

/** 上传：给一个可写流（调用方负责在结束时 end 掉通道）。 */
export function createWriteStream(sftp, target) {
  return sftp.createWriteStream(target);
}
