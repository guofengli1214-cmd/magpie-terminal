// 远程会话注册表：方法签名与 `src/pty/session.mjs` 的 SessionManager 对齐
// （create / write / resize / close / get / size），事件名也对齐
// （session.created / pty.output / session.exited / session.failed）。
//
// 这样 ws.mjs 只需要「先查远程、再查本地」，帧的语义不用分叉。
//
// 与本地 PTY 的差异（必须显式记住）：
// - 建连是异步的：create() 同步返回一个 state="starting" 的会话壳，
//   连上后才 emit session.created；失败走 session.failed。
// - 写入归一化：前端发什么换行都行，这里统一成 CRLF（Windows sshd 用 cmd.exe 时
//   只认 \r\n，光 \n 不回显；Linux 远端 \r\n 就是回车，同样正确）。
// - cwd 是「远程」的：连上后跑一次 pwd/cd 取，取不到显示 `~`。

import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { getHostRecord, lookupKnownHost, readSecret, touchHost } from "../config/store.mjs";
import { connectClient, execCommand, mapSshError, openShell, probeHostKey } from "./client.mjs";
import { listViaClient } from "./sftp.mjs";

export const MIN_COLS = 20;
export const MIN_ROWS = 5;
export const MAX_COLS = 500;
export const MAX_ROWS = 200;
export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 30;
export const OUTPUT_BUFFER_CHARS = 20000;
/** 远程 cwd 探测的软超时：探不到就显示 `~`，不拖慢建连。 */
export const CWD_PROBE_TIMEOUT_MS = 3000;

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * 前端换行归一化：`\n` → `\r\n`，`\r\n` 原样保留，裸 `\r` 原样保留。
 * @param {string} data
 * @returns {string}
 */
export function normalizeInput(data) {
  if (typeof data !== "string" || data.length === 0) return "";
  return data.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

/**
 * 一条主机是否具备可用凭据。
 *
 * 私钥认证有两种凭据来源：
 * 1. 路径（config.json 里的 privateKeyPath，明文路径、文件本身在磁盘上）；
 * 2. 内联正文 / passphrase（secrets.json 里的密文）。
 * 所以「secrets 里没东西」不等于没凭据 —— 私钥路径主机本来就不需要 secrets。
 */
export function credentialAvailable(host, secret) {
  if (secret && (typeof secret.password === "string" || typeof secret.privateKey === "string")) {
    return true;
  }
  return (
    host &&
    host.authType === "privateKey" &&
    typeof host.privateKeyPath === "string" &&
    host.privateKeyPath.length > 0
  );
}

/** 把 exec 的输出变成一行可展示的 cwd；失败/空 → null。 */
async function probeRemoteCwd(client) {
  for (const command of ["pwd", "cd"]) {
    try {
      const { stdout, code } = await execCommand(client, command, CWD_PROBE_TIMEOUT_MS);
      if (code !== 0 && code !== null) continue;
      const first = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (first && /^([A-Za-z]:[\\/]|\/|~)/.test(first)) return first;
    } catch {
      // 命令不存在（Windows 的 pwd）→ 试下一个。
    }
  }
  return null;
}

export class RemoteRegistry extends EventEmitter {
  /**
   * @param {{log?: (entry:object)=>void,
   *          openShell?: typeof openShell,
   *          probeRemoteCwd?: typeof probeRemoteCwd}} [opts]
   *   openShell / probeRemoteCwd 能在测试里换成假实现（不打真网络）。
   */
  constructor(opts = {}) {
    super();
    this.log = typeof opts.log === "function" ? opts.log : () => {};
    this.openShell = typeof opts.openShell === "function" ? opts.openShell : openShell;
    this.probeCwd = typeof opts.probeRemoteCwd === "function" ? opts.probeRemoteCwd : probeRemoteCwd;
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    this.exitHookInstalled = false;
  }

  ensureExitHook() {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.on("exit", () => {
      this.killAllSync();
    });
  }

  get size() {
    return this.sessions.size;
  }

  /**
   * 建一个远程会话。同步返回会话壳，连接在后台完成。
   *
   * @param {{hostId:string, cols?:number, rows?:number}} request
   * @returns {object|null} 会话壳（id 立刻可用）；主机不存在返回 null
   */
  create({ hostId, cols, rows } = {}) {
    const id = crypto.randomUUID();
    const startCols = clampInt(cols, MIN_COLS, MAX_COLS) || DEFAULT_COLS;
    const startRows = clampInt(rows, MIN_ROWS, MAX_ROWS) || DEFAULT_ROWS;

    const session = {
      id,
      kind: "remote",
      hostId: typeof hostId === "string" ? hostId : "",
      hostName: "",
      host: "",
      port: 22,
      username: "",
      shell: { name: "ssh", version: null, path: null, fallback: false },
      cwd: "~",
      cols: startCols,
      rows: startRows,
      state: "starting",
      mode: "remote",
      pid: null,
      recentOutput: "",
      client: null,
      stream: null,
      closed: false,
      startedAt: Date.now(),
    };
    this.sessions.set(id, session);

    // 后台建连：不阻塞 ws 的消息处理（本地 create 是同步的，远程不能假装同步）。
    void this.connect(session).catch((err) => {
      this.fail(session, mapSshError(err, "SSH_CONNECT_FAILED"));
    });

    return session;
  }

  async connect(session) {
    const host = await getHostRecord(session.hostId);
    if (!host) {
      const err = new Error("HOST_NOT_FOUND");
      err.code = "HOST_NOT_FOUND";
      err.userText = "这条主机已经被删掉了。";
      throw err;
    }
    session.hostName = host.name;
    session.host = host.host;
    session.port = host.port;
    session.username = host.username;
    session.shell = {
      name: `ssh ${host.username}@${host.host}`,
      version: null,
      path: null,
      fallback: false,
    };

    const known = await lookupKnownHost(host.host, host.port);
    if (!known) {
      const err = new Error("UNKNOWN_HOST_KEY");
      err.code = "UNKNOWN_HOST_KEY";
      err.userText = "这台主机的指纹还没被信任过，先核对指纹再连接。";
      throw err;
    }

    const secret = await readSecret(host.id);
    if (!credentialAvailable(host, secret)) {
      const err = new Error("SSH_SECRET_MISSING");
      err.code = "SSH_SECRET_MISSING";
      err.userText = "这条主机没有可用的凭据（可能密钥文件丢了），先编辑主机重新填一次。";
      throw err;
    }

    if (session.closed) return;

    const { client, stream } = await this.openShell({
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
      cols: session.cols,
      rows: session.rows,
    });

    if (session.closed) {
      try {
        client.end();
      } catch {
        // 忽略。
      }
      return;
    }

    session.client = client;
    session.stream = stream;

    const remoteCwd = await this.probeCwd(client);
    if (remoteCwd) session.cwd = remoteCwd;
    if (session.closed) return;

    session.state = "running";
    stream.on("data", (chunk) => this.handleOutput(session, chunk.toString("utf8")));
    stream.stderr.on("data", (chunk) => this.handleOutput(session, chunk.toString("utf8")));
    stream.on("close", () => this.handleExit(session, null, null));
    stream.on("error", () => this.handleExit(session, null, null));
    client.on("error", (err) => {
      // 认证之后的连接错误（keepalive 超限、对端断开）也算会话结束。
      if (session.state === "running") {
        this.log({
          level: "warn",
          code: (err && err.code) || "SSH_CONNECTION_ERROR",
          msg: "remote connection error",
          sessionId: session.id,
        });
        this.handleExit(session, null, "connection-lost");
      }
    });
    client.on("close", () => this.handleExit(session, null, null));

    try {
      await touchHost(host.id);
    } catch {
      // lastConnectedAt 只是展示信息，写失败不影响会话。
    }

    this.emit("session.created", {
      id: session.id,
      kind: "remote",
      hostId: session.hostId,
      hostName: session.hostName,
      host: session.host,
      port: session.port,
      username: session.username,
      shell: session.shell,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      pty: "remote",
    });
    this.log({
      level: "info",
      code: "REMOTE_SESSION_CREATED",
      msg: "remote session created",
      sessionId: session.id,
      hostId: session.hostId,
      host: session.host,
      port: session.port,
      durationMs: Date.now() - session.startedAt,
    });
  }

  handleOutput(session, data) {
    if (!session || !this.sessions.has(session.id)) return;
    if (typeof data !== "string" || data.length === 0) return;
    session.recentOutput += data;
    if (session.recentOutput.length > OUTPUT_BUFFER_CHARS) {
      session.recentOutput = session.recentOutput.slice(-OUTPUT_BUFFER_CHARS);
    }
    this.emit("pty.output", { id: session.id, data });
  }

  handleExit(session, exitCode, signal) {
    if (!session || session.closed) return;
    if (!this.sessions.has(session.id)) return;
    this.teardown(session);
    this.emit("session.exited", {
      id: session.id,
      exitCode: typeof exitCode === "number" ? exitCode : null,
      signal: signal || null,
    });
  }

  /** 只清理资源、不改状态表以外的东西；幂等。 */
  teardown(session) {
    session.closed = true;
    session.state = "closed";
    this.sessions.delete(session.id);
    try {
      if (session.stream) session.stream.close();
    } catch {
      // 忽略。
    }
    try {
      if (session.client) session.client.end();
    } catch {
      // 忽略。
    }
    session.stream = null;
    session.client = null;
  }

  fail(session, err) {
    if (!session || !this.sessions.has(session.id)) return;
    this.teardown(session);
    const mapped = mapSshError(err, "SSH_CONNECT_FAILED");
    this.emit("session.failed", {
      id: session.id,
      code: mapped.code || "SSH_CONNECT_FAILED",
      userText: mapped.userText || "SSH 连接失败。",
    });
    this.log({
      level: "warn",
      code: mapped.code || "SSH_CONNECT_FAILED",
      msg: "remote session failed",
      sessionId: session.id,
      hostId: session.hostId || null,
    });
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  has(id) {
    return this.sessions.has(id);
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.state !== "running") return false;
    const text = normalizeInput(data);
    if (text.length === 0) return false;
    try {
      session.stream.write(text);
      return true;
    } catch {
      return false;
    }
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session || session.state !== "running") return false;
    const nextCols = clampInt(cols, MIN_COLS, MAX_COLS);
    const nextRows = clampInt(rows, MIN_ROWS, MAX_ROWS);
    if (nextCols === null || nextRows === null) return false;
    if (nextCols === session.cols && nextRows === session.rows) return true;
    session.cols = nextCols;
    session.rows = nextRows;
    try {
      session.stream.setWindow(nextRows, nextCols, 0, 0);
      return true;
    } catch {
      return false;
    }
  }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.teardown(session);
    this.emit("session.exited", { id: session.id, exitCode: null, signal: null });
    return true;
  }

  /** 同步：只允许在 process.on('exit') 里调用。 */
  killAllSync() {
    for (const session of [...this.sessions.values()]) {
      session.closed = true;
      try {
        if (session.client) session.client.end();
      } catch {
        // 忽略。
      }
    }
    this.sessions.clear();
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 路由用的独立操作（每次一个连接，用完就断）
 * ------------------------------------------------------------------ */

/** 取主机 + 凭据；缺少时抛带 code 的错误（http 层映射成 400/404）。 */
export async function resolveHostCredentials(hostId) {
  const host = await getHostRecord(hostId);
  if (!host) {
    const err = new Error("HOST_NOT_FOUND");
    err.code = "HOST_NOT_FOUND";
    err.userText = "没有这条主机。";
    throw err;
  }
  const secret = await readSecret(host.id);
  return { host, secret };
}

/**
 * 只建连、不开 shell。成功 → {ok:true, durationMs}；失败 → {ok:false, code, userText}。
 * 失败是正常结果，不抛给 HTTP 层。
 */
export async function testHostConnection(hostId) {
  const startedAt = Date.now();
  let client = null;
  try {
    const { host, secret } = await resolveHostCredentials(hostId);
    const known = await lookupKnownHost(host.host, host.port);
    if (!known) {
      const err = new Error("UNKNOWN_HOST_KEY");
      err.code = "UNKNOWN_HOST_KEY";
      err.userText = "这台主机的指纹还没被信任过，先核对指纹。";
      throw err;
    }
    if (!credentialAvailable(host, secret)) {
      const err = new Error("SSH_SECRET_MISSING");
      err.code = "SSH_SECRET_MISSING";
      err.userText = "这条主机没有可用的凭据，先编辑主机重新填一次。";
      throw err;
    }
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
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (err) {
    const mapped = mapSshError(err, "SSH_CONNECT_FAILED");
    return {
      ok: false,
      code: mapped.code || "SSH_CONNECT_FAILED",
      userText: mapped.userText || "连接失败。",
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (client) {
      try {
        client.end();
      } catch {
        // 忽略。
      }
    }
  }
}

/**
 * 取主机当前的主机公钥指纹（不认证），并告诉调用方两件事：
 * - `known`：这个指纹是否与已记录的**完全一致**（首连 / 改过 / 不一致都是 false）；
 * - `recorded`：已记录的那条（没有就是 null）。
 *
 * 不能只回 `known:false` 了事：前端要区分「从没连过（弹首次核对卡）」，
 * 与「有记录但对不上（弹新旧指纹对比卡，且**不给忽略按钮**）」。
 *
 * @returns {Promise<{algo:string, fingerprint:string, known:boolean,
 *   recorded:{algo:string,fingerprint:string}|null}>}
 */
export async function fingerprintForHost(hostId) {
  const host = await getHostRecord(hostId);
  if (!host) {
    const err = new Error("HOST_NOT_FOUND");
    err.code = "HOST_NOT_FOUND";
    err.userText = "没有这条主机。";
    throw err;
  }
  const probed = await probeHostKey({ host: host.host, port: host.port, username: host.username });
  const recorded = await lookupKnownHost(host.host, host.port);
  return {
    algo: probed.algo,
    fingerprint: probed.fingerprint,
    known: Boolean(recorded && recorded.fingerprint === probed.fingerprint),
    recorded: recorded || null,
  };
}

/**
 * 列远程目录（单独建连，列完即断）。
 * @returns {Promise<Array<object>>}
 */
export async function listFiles(hostId, remotePath = ".") {
  const { host, secret } = await resolveHostCredentials(hostId);
  const known = await lookupKnownHost(host.host, host.port);
  if (!known) {
    const err = new Error("UNKNOWN_HOST_KEY");
    err.code = "UNKNOWN_HOST_KEY";
    err.userText = "这台主机的指纹还没被信任过，先核对指纹。";
    throw err;
  }
  if (!credentialAvailable(host, secret)) {
    const err = new Error("SSH_SECRET_MISSING");
    err.code = "SSH_SECRET_MISSING";
    err.userText = "这条主机没有可用的凭据，先编辑主机重新填一次。";
    throw err;
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
  try {
    // 相对路径或 `~` → 先落回登录后的家目录（pwd 的输出）。
    let target = typeof remotePath === "string" && remotePath.trim().length > 0 ? remotePath.trim() : ".";
    if (!target.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(target)) {
      const probed = await probeRemoteCwd(client);
      if (probed) target = target === "." || target === "~" ? probed : `${probed}/${target}`;
      else if (target === "~") target = ".";
    }
    const entries = await listViaClient(client, target);
    return { path: target, entries };
  } finally {
    try {
      client.end();
    } catch {
      // 忽略。
    }
  }
}
