// 远程文件操作（TASK-V4-G §5.4）：在 resolveHostCredentials + 指纹校验之后
// 开一条连接 + 一个 SFTP 通道，跑完即断。与 registry.listFiles 的策略一致
// （一次请求一条连接，不做连接池 —— 文件面板是低频操作）。
//
// 这里不重复 registry 的凭据逻辑：直接复用 resolveHostCredentials 与 credentialAvailable。

import { getHostRecord, lookupKnownHost, readSecret } from "../config/store.mjs";
import { connectClient } from "./client.mjs";
import { credentialAvailable } from "./registry.mjs";
import {
  createReadStream,
  createWriteStream,
  listDirectory,
  mkdir,
  openSftp,
  readFile,
  remove,
  rename,
  stat,
  writeFile,
} from "./sftp.mjs";

const DEFAULT_VIEW_LIMIT = 1024 * 1024;

function err(code, userText) {
  const e = new Error(code);
  e.code = code;
  e.userText = userText;
  return e;
}

/** 建连 + 开 SFTP；`fn(sftp)` 的返回值原样返回，结束时清干净。 */
export async function withSftp(hostId, fn) {
  const host = await getHostRecord(hostId);
  if (!host) throw err("HOST_NOT_FOUND", "没有这条主机。");
  const known = await lookupKnownHost(host.host, host.port);
  if (!known) throw err("UNKNOWN_HOST_KEY", "这台主机的指纹还没被信任过，先核对指纹。");
  const secret = await readSecret(host.id);
  if (!credentialAvailable(host, secret)) {
    throw err("SSH_SECRET_MISSING", "这条主机没有可用的凭据，先编辑主机重新填一次。");
  }
  let client = null;
  let sftp = null;
  try {
    const result = await connectClient({
      host: host.host,
      port: host.port,
      username: host.username,
      authType: host.authType,
      credentials: {
        password: secret && secret.password,
        privateKey: secret && secret.privateKey,
        privateKeyPath: host.privateKeyPath,
        passphrase: secret && secret.passphrase,
      },
      known,
    });
    client = result.client;
    sftp = await openSftp(client);
    return await fn(sftp, { host, client });
  } finally {
    try {
      if (sftp) sftp.end();
    } catch {
      // 忽略。
    }
    try {
      if (client) client.end();
    } catch {
      // 忽略。
    }
  }
}

/** 远端没有 `path.dirname` 的语义差异（Windows 远端用 `\`）；这里按分隔符风格推父级。 */
export function remoteParent(target) {
  const text = String(target || "");
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (index <= 0) return null;
  const parent = text.slice(0, index);
  // `C:` 这种盘根没有父级。
  if (/^[A-Za-z]:$/.test(parent)) return null;
  return parent;
}

function joinRemote(dir, name) {
  const base = typeof dir === "string" && dir.length > 0 ? dir : "/";
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  return `${base}${sep}${name}`;
}

/** 与本地 listDirectory 同形：{ path, parent, entries } */
export async function listRemoteDirectory(hostId, remotePath = ".") {
  const wanted = typeof remotePath === "string" && remotePath.length > 0 ? remotePath : ".";
  return withSftp(hostId, async (sftp) => {
    let target = wanted;
    if (!target.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(target)) {
      // 相对路径 / `~`：落回登录目录。SFTP 的 realpath(".") 就是登录目录。
      target = await new Promise((resolve, reject) => {
        sftp.realpath(wanted === "." || wanted === "~" ? "." : wanted, (error, resolved) => {
          if (error) reject(err("SFTP_LIST_FAILED", "列不出这个远程目录。"));
          else resolve(resolved);
        });
      });
    }
    const entries = await listDirectory(sftp, target);
    return { path: target, parent: remoteParent(target), entries };
  });
}

export async function readRemoteFile(hostId, remotePath) {
  if (!remotePath) throw err("INVALID_PATH", "路径不能是空的。");
  return withSftp(hostId, async (sftp) => {
    const result = await readFile(sftp, remotePath, DEFAULT_VIEW_LIMIT);
    return { path: remotePath, ...result };
  });
}

export async function writeRemoteFile(hostId, remotePath, data) {
  if (!remotePath) throw err("INVALID_PATH", "路径不能是空的。");
  return withSftp(hostId, async (sftp) => {
    const result = await writeFile(sftp, remotePath, data);
    return { path: remotePath, ...result };
  });
}

/** SFTP 的 mkdir 不递归：这里逐级建（已存在的层级忽略 EEXIST/失败）。 */
export async function mkdirRemote(hostId, remotePath) {
  if (!remotePath) throw err("INVALID_PATH", "路径不能是空的。");
  return withSftp(hostId, async (sftp) => {
    const normalized = remotePath.replace(/[\\/]+$/, "");
    const sep = normalized.includes("\\") && !normalized.includes("/") ? "\\" : "/";
    const parts = normalized.split(/[\\/]/);
    const isAbsolute = normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized);
    let current = isAbsolute ? (normalized.startsWith("/") ? "" : parts.shift()) : "";
    for (const part of parts) {
      if (!part || part === "." || part === "..") continue;
      current = current === "" ? `${sep}${part}` : `${current}${sep}${part}`;
      try {
        await mkdir(sftp, current);
      } catch (error) {
        // 已存在是正常路径（逐级建目录的必然结果）；其它错误上抛。
        if (error && error.code === "SFTP_MKDIR_FAILED") continue;
        throw error;
      }
    }
    return { path: normalized };
  });
}

export async function renameRemote(hostId, from, to) {
  if (!from || !to) throw err("INVALID_PATH", "原路径与新路径都不能是空的。");
  return withSftp(hostId, async (sftp) => rename(sftp, from, to));
}

export async function removeRemote(hostId, remotePath) {
  if (!remotePath) throw err("INVALID_PATH", "路径不能是空的。");
  return withSftp(hostId, async (sftp) => remove(sftp, remotePath));
}

export async function statRemote(hostId, remotePath) {
  if (!remotePath) throw err("INVALID_PATH", "路径不能是空的。");
  return withSftp(hostId, async (sftp) => stat(sftp, remotePath));
}

/**
 * 下载：`withSftp` 会在 finally 里 end 掉通道 —— 那样流会被提前掐断。
 * 所以下载单独開一条连接，把「流的结束」当成关闭时机。
 */
export async function downloadRemote(hostId, remotePath) {
  if (!remotePath) throw err("INVALID_PATH", "路径不能是空的。");
  const host = await getHostRecord(hostId);
  if (!host) throw err("HOST_NOT_FOUND", "没有这条主机。");
  const known = await lookupKnownHost(host.host, host.port);
  if (!known) throw err("UNKNOWN_HOST_KEY", "这台主机的指纹还没被信任过，先核对指纹。");
  const secret = await readSecret(host.id);
  if (!credentialAvailable(host, secret)) {
    throw err("SSH_SECRET_MISSING", "这条主机没有可用的凭据，先编辑主机重新填一次。");
  }
  const { client } = await connectClient({
    host: host.host,
    port: host.port,
    username: host.username,
    authType: host.authType,
    credentials: {
      password: secret && secret.password,
      privateKey: secret && secret.privateKey,
      privateKeyPath: host.privateKeyPath,
      passphrase: secret && secret.passphrase,
    },
    known,
  });
  const closeAll = () => {
    try {
      sftp.end();
    } catch {
      // 忽略。
    }
    try {
      client.end();
    } catch {
      // 忽略。
    }
  };
  let sftp;
  try {
    sftp = await new Promise((resolve, reject) => {
      client.sftp((error, channel) => {
        if (error) {
          reject(err("SFTP_OPEN_FAILED", "这台主机不提供 SFTP（文件面板不可用）。"));
          return;
        }
        resolve(channel);
      });
    });
    const info = await stat(sftp, remotePath);
    if (info.type === "dir") {
      throw err("IS_A_DIRECTORY", "目录不能直接下载（先逐个下载里面的文件）。");
    }
    const stream = createReadStream(sftp, remotePath);
    stream.on("close", closeAll);
    stream.on("error", closeAll);
    return { path: remotePath, size: info.size, stream };
  } catch (error) {
    closeAll();
    throw error;
  }
}

/** 上传：把 body 流写进远端文件。 */
export async function uploadRemote(hostId, dir, fileName, readable) {
  if (!dir) throw err("INVALID_PATH", "目标目录不能是空的。");
  const target = joinRemote(dir, fileName);
  return withSftp(hostId, async (sftp, { client }) => {
    const stream = createWriteStream(sftp, target);
    const done = new Promise((resolve, reject) => {
      stream.on("close", resolve);
      stream.on("error", (error) => {
        const wrapped = err("SFTP_WRITE_FAILED", "上传失败：写不进远端文件。");
        wrapped.cause = error || null;
        reject(wrapped);
      });
    });
    let written = 0;
    const limit = 200 * 1024 * 1024;
    try {
      for await (const chunk of readable) {
        written += chunk.length;
        if (written > limit) {
          stream.destroy();
          throw err("FILE_TOO_LARGE", "文件太大（上限 200 MB）。");
        }
        if (!stream.write(chunk)) {
          await new Promise((resolve) => stream.once("drain", resolve));
        }
      }
      stream.end();
    } catch (error) {
      try {
        stream.destroy();
      } catch {
        // 忽略。
      }
      try {
        client; // 保持引用，连接由 withSftp 关
      } catch {
        // 忽略。
      }
      throw error;
    }
    await done;
    return { path: target, size: written };
  });
}
