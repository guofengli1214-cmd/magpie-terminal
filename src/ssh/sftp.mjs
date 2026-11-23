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
