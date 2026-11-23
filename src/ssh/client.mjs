// SSH 建连层：唯一碰 ssh2 的地方（registry / sftp / http 都走这里）。
//
// 设计约束（TASK-V2-B §2.3 / §2.4）：
// - **永不跳过指纹校验**。没有「忽略并继续」的开关，也没有默认信任。
// - 指纹用 ssh-keyscan 风格：`SHA256:` + base64(sha256(hostkey)) 去掉尾部 `=`。
// - 建连超时 15s、keepalive 15s × 3 次。
// - 所有错误映射成稳定大写下划线 code + 中文 userText。
// - 日志/错误里永不出现密码、私钥正文、passphrase（这里连日志都不打）。

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "ssh2";

/** 建连（含握手）总超时。 */
export const READY_TIMEOUT_MS = 15000;
/** keepalive：每 15s 一次，连续 3 次没回应才判死。 */
export const KEEPALIVE_INTERVAL_MS = 15000;
export const KEEPALIVE_COUNT_MAX = 3;

/**
 * SSH 主机公钥 blob 的前 4 字节是算法名长度，随后是算法名。
 * @param {Buffer} key
 * @returns {string}
 */
export function keyAlgorithm(key) {
  try {
    if (!Buffer.isBuffer(key) || key.length < 8) return "unknown";
    const length = key.readUInt32BE(0);
    if (length <= 0 || length > 64 || 4 + length > key.length) return "unknown";
    return key.toString("utf8", 4, 4 + length);
  } catch {
    return "unknown";
  }
}

/**
 * `SHA256:…` 指纹（与 `ssh-keyscan` / `ssh -o FingerprintHash=sha256` 同款）。
 * @param {Buffer} key
 * @returns {string}
 */
export function fingerprintOf(key) {
  const digest = crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

function sshError(code, userText, extra) {
  const err = new Error(code);
  err.code = code;
  err.userText = userText;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * 把 ssh2 的错误映射成本项目的稳定 code。
 * 绝不把原始 message 放进 userText（里面可能含用户名/路径，也可能含库内部信息）。
 */
export function mapSshError(err, fallback = "SSH_CONNECT_FAILED") {
  if (err && typeof err.code === "string" && /^[A-Z_]+$/.test(err.code) && err.userText) {
    return err;
  }
  const level = err && err.level;
  if (level === "client-authentication") {
    return sshError("SSH_AUTH_FAILED", "认证失败：用户名、密码或私钥不对。");
  }
  if (level === "client-timeout") {
    return sshError("SSH_CONNECT_TIMEOUT", `连接超时（${Math.round(READY_TIMEOUT_MS / 1000)} 秒内没完成握手）。`);
  }
  if (level === "client-socket") {
    return sshError("SSH_CONNECT_FAILED", "连不上主机：地址/端口不对，或对端没有 SSH 服务。");
  }
  if (err && err.code === "ENOTFOUND") {
    return sshError("SSH_HOST_NOT_FOUND", "解析不到这个主机名。");
  }
  if (err && err.code === "ECONNREFUSED") {
    return sshError("SSH_CONNECT_REFUSED", "主机拒绝连接：端口上没有 SSH 服务。");
  }
  if (err && err.code === "ETIMEDOUT") {
    return sshError("SSH_CONNECT_TIMEOUT", "连接超时：网络不通或被防火墙拦了。");
  }
  return sshError(fallback, "SSH 连接失败。");
}

/**
 * 读私钥：路径优先，其次内联字符串。
 * 失败 → `SSH_KEY_UNREADABLE`（不把文件内容回给调用方）。
 */
async function loadPrivateKey(source) {
  if (typeof source.privateKey === "string" && source.privateKey.length > 0) {
    return Buffer.from(source.privateKey, "utf8");
  }
  if (typeof source.privateKeyPath === "string" && source.privateKeyPath.length > 0) {
    try {
      return await readFile(source.privateKeyPath);
    } catch {
      throw sshError("SSH_KEY_UNREADABLE", "读不到私钥文件（路径不对或没有权限）。");
    }
  }
  throw sshError("SSH_KEY_MISSING", "这条主机没有可用的私钥。");
}

/**
 * 建连。这是唯一会创建 ssh2 Client 的函数。
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.username
 * @param {"password"|"privateKey"} options.authType
 * @param {{password?:string, privateKey?:string, privateKeyPath?:string, passphrase?:string}} options.credentials
 * @param {{algo:string,fingerprint:string}|null} [options.known] 已存指纹；null = 从未连过
 * @param {boolean} [options.allowUnknownHostKey] 只给「探指纹」用：握手成功即返回，不认证
 * @param {(info:{algo:string,fingerprint:string})=>void} [options.onHostKey] 拿到指纹时回调（探指纹用）
 * @returns {Promise<{client: import("ssh2").Client, hostKey: {algo:string,fingerprint:string}}>}
 */
export async function connectClient(options) {
  const {
    host,
    port,
    username,
    authType,
    credentials = {},
    known = null,
    allowUnknownHostKey = false,
    onHostKey,
  } = options;

  let privateKey = null;
  if (authType === "privateKey" && !allowUnknownHostKey) {
    privateKey = await loadPrivateKey({
      privateKey: credentials.privateKey,
      privateKeyPath: credentials.privateKeyPath,
    });
  }

  const client = new Client();
  let hostKey = null;

  const config = {
    host,
    port,
    username,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    // 不让 ssh2 自己算 hash：原始的 key blob 才能同时给出算法名与 base64 指纹。
    hostVerifier: (key) => {
      const algo = keyAlgorithm(key);
      const fingerprint = fingerprintOf(key);
      hostKey = { algo, fingerprint };
      if (typeof onHostKey === "function") onHostKey(hostKey);
      // 探指纹：只要握手，不认证。拒绝掉就在 auth 之前断开，省一次无谓的认证失败。
      if (allowUnknownHostKey) return true;
      if (!known) return false;
      const sameAlgo = known.algo === algo || !known.algo;
      return sameAlgo && known.fingerprint === fingerprint;
    },
  };

  if (!allowUnknownHostKey) {
    if (authType === "password") {
      if (typeof credentials.password !== "string" || credentials.password.length === 0) {
        throw sshError("SSH_SECRET_MISSING", "这条主机没有存密码，先编辑主机补上。");
      }
      config.password = credentials.password;
    } else if (authType === "privateKey") {
      config.privateKey = privateKey;
      if (typeof credentials.passphrase === "string" && credentials.passphrase.length > 0) {
        config.passphrase = credentials.passphrase;
      }
    } else {
      throw sshError("SSH_AUTH_UNSUPPORTED", "不认识的认证方式。");
    }
  }

  return await new Promise((resolve, reject) => {
    let settled = false;

    const finishError = (err) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        // 忽略。
      }
      if (allowUnknownHostKey && hostKey) {
        // 探测模式：握手阶段已经拿到指纹就算成功（后面的认证失败是预期的）。
        resolve({ client: null, hostKey });
        return;
      }
      if (!known && hostKey) {
        reject(
          sshError("UNKNOWN_HOST_KEY", "这台主机的指纹还没被信任过。", {
            hostKey,
          }),
        );
        return;
      }
      if (known && hostKey && known.fingerprint !== hostKey.fingerprint) {
        reject(
          sshError("HOST_KEY_MISMATCH", "主机指纹和上次记录的不一样，连接已中止。", {
            hostKey,
            knownFingerprint: known.fingerprint,
            knownAlgo: known.algo,
          }),
        );
        return;
      }
      reject(mapSshError(err));
    };

    // 常驻 error 处理：握手完成后的 socket 错误（ECONNRESET 之类）也必须有人接，
    // 否则 EventEmitter 会把它抛成 unhandled 'error' 把进程带崩。
    // 已 settled 时只记一笔（不重复 reject）。
    client.on("error", (err) => {
      if (settled) return;
      finishError(err);
    });
    client.once("ready", () => {
      if (settled) return;
      settled = true;
      resolve({ client, hostKey });
    });
    client.once("close", () => {
      if (!settled) finishError(sshError("SSH_CONNECT_CLOSED", "主机在握手完成前断开了连接。"));
    });

    try {
      client.connect(config);
    } catch (err) {
      finishError(err);
    }
  });
}

/**
 * 只握手、不认证，取主机指纹（首次连接核对卡 / 二次确认用）。
 * @returns {Promise<{algo:string, fingerprint:string}>}
 */
export async function probeHostKey({ host, port, username }) {
  const { hostKey } = await connectClient({
    host,
    port,
    username,
    authType: "password",
    credentials: {},
    known: null,
    allowUnknownHostKey: true,
  });
  if (!hostKey) throw sshError("SSH_NO_HOST_KEY", "主机没有给出有效的公钥。");
  return hostKey;
}

/**
 * 建连 + 开 shell 的便捷组合（registry 用），shell 用 xterm-256color 全尺寸。
 */
export async function openShell(options) {
  const { client } = await connectClient(options);
  const { cols, rows } = options;
  try {
    const stream = await new Promise((resolve, reject) => {
      client.shell(
        {
          term: "xterm-256color",
          cols: cols || 80,
          rows: rows || 24,
        },
        (err, channel) => {
          if (err) reject(mapSshError(err, "SSH_SHELL_FAILED"));
          else resolve(channel);
        },
      );
    });
    return { client, stream };
  } catch (err) {
    try {
      client.end();
    } catch {
      // 忽略。
    }
    throw err;
  }
}

/**
 * 在已建好的连接上跑一条命令，收集 stdout。超时/非零退出都 reject。
 * @returns {Promise<{stdout:string, stderr:string, code:number|null}>}
 */
export function execCommand(client, command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(sshError("SSH_EXEC_TIMEOUT", "远程命令超时。"));
    }, timeoutMs);
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        if (!done) {
          done = true;
          reject(mapSshError(err, "SSH_EXEC_FAILED"));
        }
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("close", (code) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        resolve({ stdout, stderr, code: typeof code === "number" ? code : null });
      });
      stream.on("error", () => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        reject(sshError("SSH_EXEC_FAILED", "远程命令执行失败。"));
      });
    });
  });
}
