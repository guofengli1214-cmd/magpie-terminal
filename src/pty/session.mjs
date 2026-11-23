// 会话注册表：id -> { pty, cwd, shell, cols, rows, state }。
// 负责 resize 暖场排队、onExit 无条件 kill、进程退出时的同步清理。

import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import os from "node:os";
import { spawnPty } from "./bridge.mjs";
import { createSentinelSession } from "./sentinel.mjs";

export const WARMUP_MS = 350;
export const MIN_COLS = 20;
export const MIN_ROWS = 5;
export const MAX_COLS = 500;
export const MAX_ROWS = 200;
export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 30;
export const OUTPUT_BUFFER_CHARS = 20000;

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** PTY 就绪前不能把 resize/write 交给 node-pty：
 * 它会把调用排进 _deferreds，等首次 data 时再执行。
 * 如果 shell 在那之前就退了，那些回调会抛
 * "Cannot resize a pty that has already exited"，而且是从 socket 回调里抛，
 * 试图 catch 抓不到。 */
function libraryReady(handle) {
  if (!handle) return false;
  try {
    return handle._isReady !== false;
  } catch {
    return true;
  }
}

/** ConPTY 的 pid 要等 connect 回调才就位，这里在需要时补读一次。 */
function refreshPid(session) {
  if (!session || session.pid) return;
  try {
    const pid = session.handle && session.handle.pid;
    if (Number.isFinite(pid) && pid > 0) session.pid = pid;
  } catch {
    // 句柄已释放，保持 null。
  }
}

/**
 * 事件名：session.created / pty.output / session.exited / session.failed
 */
export class SessionManager extends EventEmitter {
  /**
   * @param {{shell?: object, ptyLoad: {ok:boolean, module:any, version:string|null}, mode?: "native"|"sentinel", resolveShell?: (id:string)=>object|null}} opts
   *
   * TASK-V4-F：`shell` 仍是「默认 shell」（不带 shellId 时用它），
   * `resolveShell(shellId)` 可选，用来按 id 现取每个会话自己的 shell。
   */
  constructor(opts) {
    super();
    this.shell = opts.shell;
    this.ptyLoad = opts.ptyLoad;
    this.mode = opts.mode || (opts.ptyLoad.ok ? "native" : "sentinel");
    // 不传就退回「只认默认 shell」（保持旧构造签名可用）。
    this.resolveShell = typeof opts.resolveShell === "function" ? opts.resolveShell : () => null;
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

  create({ cols, rows, cwd, shell } = {}) {
    const id = crypto.randomUUID();
    const startCols = clampInt(cols, MIN_COLS, MAX_COLS) || DEFAULT_COLS;
    const startRows = clampInt(rows, MIN_ROWS, MAX_ROWS) || DEFAULT_ROWS;
    const workdir = cwd && typeof cwd === "string" ? cwd : os.homedir();
    // 每会话自己的 shell（TASK-V4-F）：`shell` 参数优先，其次默认。
    const useShell = shell && typeof shell === "object" ? shell : this.shell;

    const session = {
      id,
      shell: useShell,
      cwd: workdir,
      cols: startCols,
      rows: startRows,
      state: "starting",
      // 该会话实际运行的 PTY 模式（native / sentinel），session.resumed 要用。
      mode: this.mode,
      pid: null,
      recentOutput: "",
      warmupTimer: null,
      inputQueue: [],
      handle: null,
      pidTimer: null,
      // node-pty 在首次 data 之前会把 resize/write 排队，排队项在 PTY 已退出时
      // 会异步抛错（Cannot resize a pty that has already exited），try/catch 抓不到。
      // 因此自己记录就绪状态，未就绪时不把调用交给库。
      ready: false,
      pendingCols: null,
      pendingRows: null,
    };

    this.sessions.set(id, session);

    try {
      if (this.mode === "native") {
        const handle = spawnPty(this.ptyLoad.module, useShell, {
          cols: startCols,
          rows: startRows,
          cwd: workdir,
        });
        session.handle = handle;
        session.pid = handle.pid || null;
        // Windows ConPTY 的 pid 在 connect 回调里才就位，spawn 当下可能是 0。
        session.pidTimer = setTimeout(() => {
          session.pidTimer = null;
          refreshPid(session);
        }, 500);
        handle.onData((data) => this.handleOutput(session, data));
        handle.onExit(({ exitCode, signal }) => this.handleExit(session, exitCode, signal));
      } else {
        const handle = createSentinelSession({
          shell: useShell,
          cwd: workdir,
          onData: (data) => this.handleOutput(session, data),
          onExit: ({ exitCode, signal }) => this.handleExit(session, exitCode, signal),
          onError: (err) => this.handleFailure(session, err),
        });
        session.handle = handle;
        session.pid = handle.pid;
        // 哨兵法走管道，没有「首次 data 才算就绪」的概念，创建即可写。
        session.ready = true;
      }
    } catch (err) {
      session.state = "failed";
      this.sessions.delete(id);
      this.emit("session.failed", {
        id,
        code: "PTY_SPAWN_FAILED",
        userText: `无法启动终端：${useShell.name}（${err && err.message ? err.message : "spawn failed"}）`,
        err,
      });
      return null;
    }

    session.state = "running";
    this.emit("session.created", {
      id,
      shell: {
        name: useShell.name,
        version: useShell.version,
        path: useShell.path,
        fallback: useShell.fallback,
      },
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      pty: this.mode,
    });
    return session;
  }

  handleOutput(session, data) {
    if (!session || !this.sessions.has(session.id)) return;
    refreshPid(session);
    if (!session.ready) {
      session.ready = true;
      // 先补 resize（它会开启暖场窗口），再冲刷就绪前排队的输入。
      this.flushPendingResize(session);
      this.flushPendingInput(session);
    }
    session.recentOutput += data;
    if (session.recentOutput.length > OUTPUT_BUFFER_CHARS) {
      session.recentOutput = session.recentOutput.slice(-OUTPUT_BUFFER_CHARS);
    }
    this.emit("pty.output", { id: session.id, data });
  }

  handleExit(session, exitCode, signal) {
    if (!session) return;
    if (session.pidTimer) {
      clearTimeout(session.pidTimer);
      session.pidTimer = null;
    }
    if (session.warmupTimer) {
      clearTimeout(session.warmupTimer);
      session.warmupTimer = null;
    }
    session.inputQueue.length = 0;
    session.state = "closing";
    try {
      if (session.handle) session.handle.kill();
    } catch {
      // kill 幂等：已退出则忽略。
    }
    if (this.sessions.has(session.id)) {
      this.sessions.delete(session.id);
      this.emit("session.exited", {
        id: session.id,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        signal: signal || null,
      });
    }
    session.state = "closed";
  }

  handleFailure(session, err) {
    if (!session) return;
    this.sessions.delete(session.id);
    this.emit("session.failed", {
      id: session.id,
      code: "PTY_SPAWN_FAILED",
      userText: `无法启动终端：${session.shell ? session.shell.name : this.shell.name}`,
      err,
    });
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  getLatest() {
    let latest = null;
    for (const session of this.sessions.values()) latest = session;
    return latest;
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.state !== "running") return false;
    if (typeof data !== "string" || data.length === 0) return false;
    if (session.warmupTimer) {
      session.inputQueue.push(data);
      return true;
    }
    // 首次 data 之前 node-pty 会把写入排队；此时写已退出的 PTY 会异步抛错。
    // 排队到自己这里更安全，就绪后按序冲刷。
    if (!session.ready || !libraryReady(session.handle)) {
      session.inputQueue.push(data);
      return true;
    }
    try {
      session.handle.write(data);
      return true;
    } catch {
      return false;
    }
  }

  /** PTY 就绪后先把「就绪前排队」的输入按序写出。 */
  flushPendingInput(session) {
    if (!session || session.warmupTimer || session.inputQueue.length === 0) return;
    const queued = session.inputQueue.slice();
    session.inputQueue.length = 0;
    for (const chunk of queued) {
      try {
        session.handle.write(chunk);
      } catch {
        break;
      }
    }
  }

  /** PTY 就绪后才把排队的 resize 交给 node-pty。 */
  flushPendingResize(session) {
    if (!session || session.pendingCols === null || session.pendingRows === null) return;
    const cols = session.pendingCols;
    const rows = session.pendingRows;
    session.pendingCols = null;
    session.pendingRows = null;
    if (cols === session.cols && rows === session.rows) return;
    session.cols = cols;
    session.rows = rows;
    try {
      session.handle.resize(cols, rows);
      session.handle.write("\r");
    } catch {
      return;
    }
    this.armWarmup(session);
  }

  armWarmup(session) {
    if (session.warmupTimer) clearTimeout(session.warmupTimer);
    session.warmupTimer = setTimeout(() => {
      session.warmupTimer = null;
      if (!this.sessions.has(session.id)) return;
      const queued = session.inputQueue.slice();
      session.inputQueue.length = 0;
      for (const chunk of queued) {
        try {
          session.handle.write(chunk);
        } catch {
          break;
        }
      }
    }, WARMUP_MS);
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session || session.state !== "running") return false;
    const nextCols = clampInt(cols, MIN_COLS, MAX_COLS);
    const nextRows = clampInt(rows, MIN_ROWS, MAX_ROWS);
    if (nextCols === null || nextRows === null) return false;
    if (nextCols === session.cols && nextRows === session.rows) return true;

    if (!session.ready || !libraryReady(session.handle)) {
      // 未就绪：记住目标尺寸，等第一次输出后再应用（spawn 时的尺寸已是初始值）。
      session.pendingCols = nextCols;
      session.pendingRows = nextRows;
      return true;
    }

    session.cols = nextCols;
    session.rows = nextRows;
    try {
      session.handle.resize(nextCols, nextRows);
      // 坑 1：resize 后立即写一个垃圾回车，并进入暖场窗口。
      session.handle.write("\r");
    } catch {
      return false;
    }
    this.armWarmup(session);
    return true;
  }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.pidTimer) {
      clearTimeout(session.pidTimer);
      session.pidTimer = null;
    }
    refreshPid(session);
    if (session.warmupTimer) {
      clearTimeout(session.warmupTimer);
      session.warmupTimer = null;
    }
    session.inputQueue.length = 0;
    session.state = "closing";
    try {
      session.handle.kill();
    } catch {
      // 幂等。
    }
    this.sessions.delete(id);
    this.emit("session.exited", {
      id: session.id,
      exitCode: null,
      signal: null,
    });
    session.state = "closed";
    return true;
  }

  /** 同步：只允许在 process.on('exit') 里调用。 */
  killAllSync() {
    for (const session of this.sessions.values()) {
      if (session.pidTimer) {
        clearTimeout(session.pidTimer);
        session.pidTimer = null;
      }
      if (session.warmupTimer) {
        clearTimeout(session.warmupTimer);
        session.warmupTimer = null;
      }
      try {
        session.handle.kill();
      } catch {
        // 幂等。
      }
    }
    this.sessions.clear();
  }

  pids() {
    const list = [];
    for (const session of this.sessions.values()) {
      refreshPid(session);
      if (session.pid) list.push(session.pid);
    }
    return list;
  }
}