// 会话注册表：id -> { pty, cwd, shell, cols, rows, state }。
// 负责 resize 暖场排队、onExit 无条件 kill、进程退出时的同步清理。
//
// TASK-FIX17-A（问题 2）：resize 之后**不再向 pty 注入任何可见字节**。
// 暖场窗口（WARMUP_MS）保留，语义从「发垃圾回车 + 等它吃掉」变成纯输入延迟窗口：
// 窗口内的真实按键先入 inputQueue，窗口结束按序冲刷，一个字节都不丢。

import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnPty } from "./bridge.mjs";
import { createSentinelSession } from "./sentinel.mjs";
import { createOsc7Scanner, decodeOsc7 } from "./osc7.mjs";
import { withOsc7Injection } from "./osc7-inject.mjs";

/**
 * 暖场窗口（毫秒）：resize 之后「输入先排队、稍后按序冲刷」的时长。
 *
 * **必须与前端 `app/core/constants.js` 的 `INPUT_LOCK_MS` 保持一致**（两边同为 350）：
 * 前端在 resize 后按同一时长封锁 onData，服务端再把窗口内到达的字节排队。
 * 只改一边会让「排队 — 冲刷」错位：前端比这里短 → 服务端仍在排队（无副作用）；
 * 前端比这里长 → 前端多封一段（只是延迟）。**改任何一边都要同步另一边并在此注清。**
 *
 * 历史：TASK-V4-F 时这个窗口是为了等 resize 后那个裸 `\r` 被 ConPTY 吃掉；
 * TASK-FIX17-A 删了那个 `\r`（它会在用户终端上多出一个空行），实测不再需要，
 * 但窗口本身仍然是「resize 后立刻输入不丢字符」的保险（见 scripts/probe-resize-blank.mjs）。
 */
export const WARMUP_MS = 350;

export const MIN_COLS = 20;
export const MIN_ROWS = 5;
export const MAX_COLS = 500;
export const MAX_ROWS = 200;
export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 30;
export const OUTPUT_BUFFER_CHARS = 20000;

/** 只认真正的绝对路径：POSIX `/x` 或 Windows `C:\x` / `C:/x` / 盘根 `C:`。 */
function isAbsolutePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/")) return true;
  return /^[A-Za-z]:([\\/]|$)/.test(value);
}

/* ------------------------------------------------------------------ *
 * MSYS 的 POSIX 路径（`/tmp/x`、`/usr/x`）在 Windows 上不是绝对路径。
 * 面板要拿它去 `path.resolve()`，结果会变成 `C:\tmp\x`（不存在）。
 * 所以带一次 `cygpath -w`（Git for Windows 自带）的尽力转换：
 * - 只对「非盘符开头」的 POSIX 路径做；结果缓存，不重复起子进程；
 * - cygpath 找不到 / 报错 / 超时就返回 null（调用方保持旧 cwd，只是不跟随）。
 * ------------------------------------------------------------------ */
const cygpathCache = new Map();
let cygpathPath;

function findCygpath() {
  if (cygpathPath !== undefined) return cygpathPath;
  const candidates = [];
  const pf = process.env.ProgramFiles;
  const pf86 = process.env["ProgramFiles(x86)"];
  const local = process.env.LOCALAPPDATA;
  for (const base of [pf, pf86, local ? `${local}\\Programs` : null]) {
    if (!base) continue;
    candidates.push(path.join(base, "Git", "usr", "bin", "cygpath.exe"));
    candidates.push(path.join(base, "Git", "bin", "cygpath.exe"));
  }
  for (const dir of String(process.env.PATH || "").split(";")) {
    if (!dir) continue;
    candidates.push(path.join(dir, "cygpath.exe"));
  }
  cygpathPath = candidates.find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;
  return cygpathPath;
}

function toWindowsNative(posixPath) {
  if (process.platform !== "win32") return posixPath;
  if (!posixPath.startsWith("/")) return posixPath;
  if (/^\/[A-Za-z](\/|$)/.test(posixPath)) return posixPath; // 已被 toWindowsPath 处理成盘符
  if (cygpathCache.has(posixPath)) return cygpathCache.get(posixPath);
  const tool = findCygpath();
  let result = null;
  if (tool) {
    try {
      const out = execFileSync(tool, ["-w", posixPath], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (/^[A-Za-z]:[\\/]/.test(out)) result = out.replace(/\//g, "\\");
    } catch {
      result = null;
    }
  }
  cygpathCache.set(posixPath, result);
  return result;
}

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
 * 幂等 kill：同一会话只允许关一次 pseudoconsole。
 *
 * 为什么需要：close() 先 kill 一次，node-pty 随后仍会触发 onExit → handleExit()
 * 又 kill 一次。Windows 上两次 ClosePseudoConsole 之间 handle 还没被 exit watcher
 * 摘掉，会重复关同一个 pseudoconsole（node-pty #989），诱发
 * `BaseObject::decrease_refcount` / `HandleScope::CreateHandle` 原生崩溃。
 */
function killOnce(session) {
  if (!session) return;
  if (session.killed) return;
  session.killed = true;
  try {
    if (session.handle) session.handle.kill();
  } catch {
    // kill 幂等：已退出则忽略。
  }
}

/** 会话真正结束（onExit 到了）时唤醒等待者；重复调用无副作用。 */
function markExited(session) {
  if (!session || !session.resolveExit) return;
  const resolve = session.resolveExit;
  session.resolveExit = null;
  resolve();
}

/**
 * 事件名：session.created / pty.output / session.exited / session.failed / session.cwd
 *
 * TASK-V4-G §5.1：`session.cwd` 由 handleOutput 里的 OSC 7 增量解析器 emit，
 * 形如 `{ id, cwd }`；ws.mjs 直接翻成同名的下行帧。
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

    // TASK-V4-G §5.2：bash 走临时 rc（--rcfile … -i）、PowerShell 走临时 prompt 覆盖，
    // **绝不改用户的 ~/.bashrc / $PROFILE**。注入失败时 args 保持原样（只记日志）。
    const injection = withOsc7Injection(useShell, { log: (entry) => this.emit("log", entry) });
    const runShell = injection.shell;

    const session = {
      id,
      shell: runShell,
      cwd: workdir,
      // OSC 7 增量扫描器 + 临时 rc 的清理函数（会话结束 / 进程退出时调）。
      osc7: createOsc7Scanner(),
      cleanupShellInjection: injection.cleanup,
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
      // 会话是否已被我方 kill 过：Windows ConPTY 二次 kill 会重复关 pseudoconsole
      // （node-pty #989），close() 之后 handleExit() 还会再 kill 一次，必须幂等。
      killed: false,
      // onExit 真正到了才 resolve：测试 teardown 靠它「等 kill 落定再退进程」。
      // ConPTY 的 kill 是异步的，kill 完立刻 process.exit 会撞上原生 teardown。
      exitPromise: null,
      resolveExit: null,
    };
    session.exitPromise = new Promise((resolve) => {
      session.resolveExit = resolve;
    });

    this.sessions.set(id, session);

    try {
      if (this.mode === "native") {
        const handle = spawnPty(this.ptyLoad.module, runShell, {
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
          shell: runShell,
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
      markExited(session);
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
        name: runShell.name,
        version: runShell.version,
        path: runShell.path,
        fallback: runShell.fallback,
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
    this.handleOsc7(session, data);
    this.emit("pty.output", { id: session.id, data });
  }

  /**
   * 增量扫 OSC 7 并更新 session.cwd（TASK-V4-G §5.1）。
   * 解析器自己保留跨 chunk 的半条序列，这里只处理完整的那些。
   */
  handleOsc7(session, data) {
    const scanner = session.osc7;
    if (!scanner) return;
    let payloads;
    try {
      payloads = scanner.push(data);
    } catch {
      return;
    }
    if (payloads.length === 0) return;
    let next = null;
    for (const payload of payloads) {
      const decoded = decodeOsc7(payload);
      if (!decoded) continue;
      // Windows 上 MSYS 给的 `/tmp/x` 需要 cygpath 还原成真绝对路径；
      // 转不了就不跟随（宁可不跳，也不要让面板去看一个不存在的目录）。
      const native = toWindowsNative(decoded);
      if (native && isAbsolutePath(native)) next = native;
    }
    if (!next || next === session.cwd) return;
    session.cwd = next;
    this.emit("session.cwd", { id: session.id, cwd: next });
  }

  /** 会话结束时删掉临时 rc 文件（幂等）。 */
  cleanupInjection(session) {
    if (!session || !session.cleanupShellInjection) return;
    const fn = session.cleanupShellInjection;
    session.cleanupShellInjection = null;
    try {
      fn();
    } catch {
      // 忽略。
    }
  }

  handleExit(session, exitCode, signal) {
    if (!session) return;
    this.cleanupInjection(session);
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
    killOnce(session);
    if (this.sessions.has(session.id)) {
      this.sessions.delete(session.id);
      this.emit("session.exited", {
        id: session.id,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        signal: signal || null,
      });
    }
    session.state = "closed";
    markExited(session);
  }

  handleFailure(session, err) {
    if (!session) return;
    this.sessions.delete(session.id);
    markExited(session);
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
    } catch {
      return false;
    }
    // TASK-FIX17-A（问题 2）：resize 之后**不再往 pty 写任何可见字节**。
    // 旧实现（V4-F，坑 1 的 canonical 对策）在这里写一个裸 `\r` 来吸收
    // Windows ConPTY「resize 后第一个输入字节被吞」的缺陷，代价是每次 resize
    // 都在用户终端上凭空多一个空行/多一个提示符（开合文件面板、拖窗口、AI 执行
    // 命令都会触发）。实测（scripts/probe-resize-blank.mjs）本机 resize 后立刻输入
    // 都不丢字符（正对照 6/6 通过，负对照 10 次 resize 多出 10 条提示符行），
    // 所以改成「只排队、不写字节」：
    // 暖场窗口退化为纯输入延迟窗口，语义与前端 INPUT_LOCK_MS 完全一致。
    // **绝对不要把 write("\r") 加回来**。
    this.armWarmup(session);
    return true;
  }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.cleanupInjection(session);
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
    killOnce(session);
    this.sessions.delete(id);
    this.emit("session.exited", {
      id: session.id,
      exitCode: null,
      signal: null,
    });
    session.state = "closed";
    return true;
  }

  /**
   * 等会话真正退出（node-pty 的 onExit 到达）。已退出立即返回 true，超时 false。
   *
   * ConPTY 的 kill 是异步的：kill() 返回时 pseudoconsole 还没关完，
   * 此时销毁进程/立刻建下一批 PTY 会撞上原生 teardown（见 VERIFY-V4-PTY.md）。
   */
  async whenExited(session, timeoutMs = 5000) {
    if (!session || !session.exitPromise) return true;
    let timer = null;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      return await Promise.race([session.exitPromise.then(() => true), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 同步：只允许在 process.on('exit') 里调用。 */
  killAllSync() {
    for (const session of this.sessions.values()) {
      this.cleanupInjection(session);
      if (session.pidTimer) {
        clearTimeout(session.pidTimer);
        session.pidTimer = null;
      }
      if (session.warmupTimer) {
        clearTimeout(session.warmupTimer);
        session.warmupTimer = null;
      }
      killOnce(session);
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