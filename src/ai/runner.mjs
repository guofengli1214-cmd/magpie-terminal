// PTY 命令执行通道（PROTOCOL-AGENT.md §4）。
//
// 在用户真实 PTY 里执行，这样命令跟随用户 shell 的当前目录，用户也能在终端里看见。
//
// 三个必须做对的点（PROTOCOL §6.7）：
//   1. lastIndexOf(startMark) —— 终端的回显里也会出现 startMark。
//   2. 静默判定必须在「该命令自己的」输出 buffer 上算，不能被别的命令的输出刷新。
//   3. 输出截断到 4000 字符（头部 1000 + 尾部 3000），中间插省略标记。
//
// 铁律（PROTOCOL §4.5）：
//   - 日志里绝不出现完整命令（只打 commandLength + 前 40 字符）
//   - 绝不把 PTY 原始字节塞给模型（先 stripAnsi 再截断）
//   - 执行期间不改终端尺寸、不发 pty.resize

import crypto from "node:crypto";

/** 输出上限：头部 1000 + 尾部 3000 = 4000 字符（PROTOCOL §3.2）。 */
export const OUTPUT_HEAD_CHARS = 1000;
export const OUTPUT_TAIL_CHARS = 3000;
export const OUTPUT_MAX_CHARS = OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS;

/** 结束判定默认值（PROTOCOL §4.3）。 */
export const DEFAULT_QUIET_MS = 1000;
export const DEFAULT_MIN_WAIT_MS = 300;
export const DEFAULT_TIMEOUT_MS = 90000;

/**
 * 静默阈值的放缩倍数（TASK-V3-D-FIX1 修复 1）。
 *
 * 第一次静默判定的阈值 = quietMs * DEFAULT_QUIET_FACTOR（默认 1000 × 3 = 3000ms）。
 * 为什么要把原来的 1000ms 放大到 3000ms：
 *   - 命令启动后要第一条输出很慢（`node --test`、`npm install`、编译、`sleep 2; echo`），
 *     1 秒静默会把它们误判成「进入了交互模式」，直接切断输出、exitCode=null。
 *   - 输出中途停顿 1 秒也很常见（测试框架/包管理器的进度打印都有 1–2 秒空窗）。
 * 总超时（DEFAULT_TIMEOUT_MS = 90 秒）不放宽，它是兜底。
 */
export const DEFAULT_QUIET_FACTOR = 3;

/**
 * 静默阈值的天花板倍数（TASK-V3-D-FIX1 修复 1）。
 *
 * 3000ms 只是**第一次**静默判定点。到点但还没看到结束标记时，不立刻判死，
 * 而是把阈值升一档（×2）再等一轮，直到 `DEFAULT_QUIET_MS * DEFAULT_QUIET_MAX_FACTOR
 * = 16000ms` 才真的判 EXEC_QUIET。
 *
 * 为什么必须再加这一层（两个都来自真 PTY 实测，不是拍脑袋）：
 *   - 「还没收到任何输出」也会超 3000ms：`sleep 5; echo late` 的第一条输出在 5 秒。
 *   - 「已有输出但空窗」也会超 3000ms：本仓库跑 `node --test` 时，真 PTY 实测
 *     最长一次输出间隔 9031ms（某个用例整整跑了 9 秒才打下一行）。
 * 两种情形都按 3000ms 判死，就是核验报告里的 M1；只靠一个平坦的 3000ms 修不好。
 *
 * 卡住 / 等输入的命令仍然会很快给结论（默认配置下：3s → 6s → 12s → 16s 封顶），
 * 且总超时 90 秒是硬兜底——上限比总超时小一个量级，不会被静默放宽掩盖。
 */
export const DEFAULT_QUIET_MAX_FACTOR = 16;

/**
 * 「看到结束标记后再等一小段」的宽限（TASK-V3-D-FIX1 修复 3）。
 *
 * 修复 3 要求 endMark 取**最后一个**——但输出是一条条流进来的：若命令自己输出的
 * `__MT_E_<nonce>__99` 先进一个 chunk、真实的 `__MT_E_<nonce>__0` 晚一个 chunk 到，
 * 「最后一个匹配」当场还是 99。所以看到结束标记后不立刻 resolve，先等这一小段；
 * 期间有新输出（包含真实结束标记）就重取最后一个匹配。
 *
 * 代价：每条命令多等 120ms（真 PTY 实测 `echo hi` 仍在 1.5s 内）。
 */
export const DEFAULT_TAIL_GRACE_MS = 120;

/** 静默超时 / 总超时的中文说明（逐字来自 PROTOCOL §4.3）。 */
export const USER_TEXT_QUIET =
  "命令没有按预期结束，可能进入了交互模式（比如等待输入）。";
export const USER_TEXT_TIMEOUT = "命令超过 90 秒还没结束，已放弃等待。";
export const USER_TEXT_UNSUPPORTED =
  "这个终端不支持自动执行（可能是 Windows 的 cmd.exe），我把命令列给你，你复制到终端里运行。";

/** PROTOCOL §4.2 指定的 stripAnsi 正则。 */
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * 去 ANSI 控制序列。
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  if (typeof text !== "string") return "";
  return text.replace(ANSI_RE, "");
}

/**
 * 截断到 4000 字符：头部 1000 + 尾部 3000，中间插省略标记。
 * @param {string} text
 * @returns {{output: string, truncated: boolean}}
 */
export function truncateOutput(text) {
  const value = typeof text === "string" ? text : "";
  if (value.length <= OUTPUT_MAX_CHARS) return { output: value, truncated: false };
  const head = value.slice(0, OUTPUT_HEAD_CHARS);
  const tail = value.slice(value.length - OUTPUT_TAIL_CHARS);
  const omitted = value.length - OUTPUT_MAX_CHARS;
  return {
    output: `${head}\n…（中间省略 ${omitted} 字符）…\n${tail}`,
    truncated: true,
  };
}

/** 生成一次执行用的标记对。 */
export function makeMarks(nonce) {
  const value = nonce || crypto.randomBytes(6).toString("hex");
  return {
    nonce: value,
    startMark: `__MT_S_${value}__`,
    endMark: `__MT_E_${value}__`,
  };
}

/** PROTOCOL §4.1 的包装串，逐字。 */
export function buildPayload(command, startMark, endMark) {
  return `printf '\\n%s\\n' '${startMark}'; ( ${command}\n ) 2>&1; printf '${endMark}%s\\n' "$?"\n`;
}

/**
 * PROTOCOL §4.4 的能力探测串。
 *
 * 协议原文只给了这一行命令、没写行尾；写进 PTY 时必须补一个 `\n` 才会被 shell
 * 提交执行（不补的话那行一直停在提示行上，探测永远等不到回显）。与 §4.1 的
 * buildPayload 末尾带换行是同一个理由。
 */
export function buildProbePayload(nonce) {
  return `printf '__MT_PROBE_${nonce}__%s\\n' "ok"\n`;
}

/**
 * 从（已 stripAnsi 的）buffer 里切出最后一次命令的输出。
 *
 * @param {string} buffer
 * @param {string} startMark
 * @param {string} endMark
 * @returns {{found:boolean, finished:boolean, exitCode:number|null, output:string}}
 */
export function splitBuffer(buffer, startMark, endMark) {
  const text = typeof buffer === "string" ? buffer : "";
  // 回显里也会出现 startMark（它就写在 printf 的参数里）→ 必须取最后一次。
  const startAt = text.lastIndexOf(startMark);
  if (startAt < 0) return { found: false, finished: false, exitCode: null, output: "" };
  const afterStart = text.slice(startAt + startMark.length);

  // endMark 也必须取**最后一次**（与 startMark 的 lastIndexOf 同思路）。
  // 命令输出里可能本身就含本命令的 endMark + 数字（`set -x`、`bash -x`、`history`、
  // `cat` 了自己的脚本），取第一个会把输出截空、还会拿到伪造的 exitCode。
  const endRe = new RegExp(`${escapeRegExp(endMark)}(\\d+)`, "g");
  let match = null;
  for (let found = endRe.exec(afterStart); found !== null; found = endRe.exec(afterStart)) {
    match = found;
  }
  if (!match) {
    return { found: true, finished: false, exitCode: null, output: afterStart.trim() };
  }
  const output = afterStart.slice(0, match.index).trim();
  const exitCode = Number.parseInt(match[1], 10);
  return {
    found: true,
    finished: true,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    output,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 创建命令执行器。
 *
 * @param {object} opts
 * @param {object} opts.sessions 本地 SessionManager（提供 on/off/write/get）
 * @param {object} [opts.remote] 远程 RemoteRegistry（同接口）
 * @param {(entry:object)=>void} [opts.log]
 * @param {number} [opts.quietMs] 基础静默阈值（实际阈值 = quietMs * quietFactor）
 * @param {number} [opts.minWaitMs]
 * @param {number} [opts.timeoutMs] 总超时（兜底，不随静默阈值放宽）
 * @param {number} [opts.quietFactor] 静默阈值倍数，默认 DEFAULT_QUIET_FACTOR
 *        （环境变量 MAGPIE_TERMINAL_QUIET_FACTOR 可覆盖，仅用于本机实测/排障）
 * @param {number} [opts.maxQuietMs] 静默阈值的上限（宽限后的天花板），
 *        默认 quietMs × DEFAULT_QUIET_MAX_FACTOR（即 1000 × 16 = 16000ms）
 * @param {number} [opts.tailGraceMs] 看到结束标记后再等多久才 resolve（默认 120ms），
 *        用于「输出里的伪造 endMark 先到、真实结束标记后到」的情形
 */
export function createCommandRunner(opts = {}) {
  const sessions = opts.sessions;
  const remote = opts.remote;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const envFactor = Number.parseFloat(process.env.MAGPIE_TERMINAL_QUIET_FACTOR || "");
  const factorInput = Number.isFinite(opts.quietFactor) ? opts.quietFactor : envFactor;
  const quietFactor = Number.isFinite(factorInput) && factorInput > 0 ? factorInput : DEFAULT_QUIET_FACTOR;
  const defaultQuietMs = Number.isFinite(opts.quietMs) ? opts.quietMs : DEFAULT_QUIET_MS;
  const defaultTimeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const defaultMinWaitMs = Number.isFinite(opts.minWaitMs) ? opts.minWaitMs : DEFAULT_MIN_WAIT_MS;
  const defaultMaxQuietMs = Number.isFinite(opts.maxQuietMs) ? opts.maxQuietMs : null;
  const defaultTailGraceMs = Number.isFinite(opts.tailGraceMs) ? opts.tailGraceMs : DEFAULT_TAIL_GRACE_MS;

  /** sessionId -> "local" | "remote" | null（由 ws.mjs 注入） */
  let sessionResolver = () => null;

  /** sessionId -> "ok" | "unsupported"（能力探测缓存，PROTOCOL §4.4） */
  const capabilities = new Map();

  /** sessionId -> 正在执行的那条命令的上下文（同一会话不并发跑两条） */
  const active = new Map();

  function setSessionResolver(fn) {
    sessionResolver = typeof fn === "function" ? fn : () => null;
  }

  function registryFor(sessionId) {
    const kind = sessionResolver(sessionId);
    if (kind === "remote" && remote) return remote;
    if (kind === "local" && sessions) return sessions;
    // resolver 没给答案时退化为「谁有这个会话就用谁」。
    if (remote && typeof remote.get === "function" && remote.get(sessionId)) return remote;
    if (sessions && typeof sessions.get === "function" && sessions.get(sessionId)) return sessions;
    return null;
  }

  function attach(sessionId, onOutput) {
    const registry = registryFor(sessionId);
    if (!registry || typeof registry.on !== "function") return null;
    registry.on("pty.output", onOutput);
    return () => {
      if (typeof registry.off === "function") registry.off("pty.output", onOutput);
    };
  }

  /** 把命令写进 PTY：本地 sessions.write，远程 remote.write（PROTOCOL §4.1）。 */
  function writeTo(sessionId, payload) {
    const registry = registryFor(sessionId);
    if (!registry || typeof registry.write !== "function") return false;
    registry.write(sessionId, payload);
    return true;
  }

  /**
   * 能力探测：每个会话一次，结果按 sessionId 缓存。
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async function probe(sessionId) {
    const cached = capabilities.get(sessionId);
    if (cached === "ok") return true;
    if (cached === "unsupported") return false;

    const nonce = crypto.randomBytes(6).toString("hex");
    const marker = `__MT_PROBE_${nonce}__ok`;
    const payload = buildProbePayload(nonce);

    const supported = await new Promise((resolve) => {
      let buffer = "";
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (detach) detach();
        resolve(value);
      };
      const onOutput = (info) => {
        if (!info || info.id !== sessionId) return;
        buffer += typeof info.data === "string" ? info.data : "";
        if (stripAnsi(buffer).includes(marker)) finish(true);
      };
      const detach = attach(sessionId, onOutput);
      const timer = setTimeout(() => finish(false), defaultTimeoutMs > 5000 ? 5000 : defaultTimeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      if (!writeTo(sessionId, payload)) finish(false);
    });

    capabilities.set(sessionId, supported ? "ok" : "unsupported");
    if (!supported) {
      log({
        level: "warn",
        code: "EXEC_UNSUPPORTED",
        msg: "pty sentinel probe failed",
        sessionId,
      });
    }
    return supported;
  }

  /**
   * 执行一条命令。
   *
   * @param {{sessionId: string, command: string, quietMs?: number, timeoutMs?: number,
   *          minWaitMs?: number}} input
   * @returns {Promise<{ok: boolean, exitCode: number|null, output: string,
   *          truncated: boolean, userText?: string, code?: string}>}
   */
  async function run({ sessionId, command, quietMs, timeoutMs, minWaitMs } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { ok: false, code: "SESSION_GONE", exitCode: null, output: "", truncated: false, userText: "会话已经结束。" };
    }
    if (typeof command !== "string" || command.trim().length === 0) {
      return { ok: false, code: "EMPTY_COMMAND", exitCode: null, output: "", truncated: false, userText: "没有要执行的命令。" };
    }
    if (active.has(sessionId)) {
      return {
        ok: false,
        code: "BUSY_SESSION",
        exitCode: null,
        output: "",
        truncated: false,
        userText: "这个终端里还有一条命令没跑完，等它结束。",
      };
    }

    const registry = registryFor(sessionId);
    if (!registry || (typeof registry.get === "function" && !registry.get(sessionId))) {
      return {
        ok: false,
        code: "SESSION_GONE",
        exitCode: null,
        output: "",
        truncated: false,
        userText: "这个终端的会话已经结束。",
      };
    }

    const supported = await probe(sessionId);
    if (!supported) {
      return {
        ok: false,
        code: "EXEC_UNSUPPORTED",
        exitCode: null,
        output: "",
        truncated: false,
        userText: USER_TEXT_UNSUPPORTED,
      };
    }

    // 静默阈值：基础值 × 倍数（默认 1000 × 3 = 3000ms）作为**第一次**判定点；
    // 到点但没结束标记就逐次 ×2 宽限，直到 quietCap（默认 1000 × 16 = 16000ms）。
    // 总超时（默认 90 秒）不随静默阈值放宽，始终是最后的硬兜底。
    const baseQuiet = (Number.isFinite(quietMs) ? quietMs : defaultQuietMs) * quietFactor;
    const quiet = baseQuiet;
    const quietCap =
      defaultMaxQuietMs !== null
        ? Math.max(baseQuiet, defaultMaxQuietMs)
        : Math.max(baseQuiet, (Number.isFinite(quietMs) ? quietMs : defaultQuietMs) * DEFAULT_QUIET_MAX_FACTOR);
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeoutMs;
    const minWait = Number.isFinite(minWaitMs) ? minWaitMs : defaultMinWaitMs;

    const { startMark, endMark } = makeMarks();
    const payload = buildPayload(command, startMark, endMark);
    // 日志里绝不出现完整命令（PROTOCOL §4.5）。
    log({
      level: "info",
      code: "COMMAND_RUN_START",
      msg: "running command in pty",
      sessionId,
      commandLength: command.length,
      commandHead: command.slice(0, 40),
    });

    const startedAt = Date.now();
    let buffer = "";
    let lastDataAt = startedAt;
    let finished = false;

    return await new Promise((resolve) => {
      let quietTimer = null;
      let totalTimer = null;

      const cleanup = () => {
        finished = true;
        active.delete(sessionId);
        if (quietTimer) clearTimeout(quietTimer);
        if (totalTimer) clearTimeout(totalTimer);
        if (tailTimer) clearTimeout(tailTimer);
        quietTimer = null;
        totalTimer = null;
        tailTimer = null;
        if (detach) detach();
      };

      const settle = (rawOutput, exitCode, extra) => {
        if (finished) return;
        cleanup();
        const stripped = stripAnsi(rawOutput);
        const { output, truncated } = truncateOutput(stripped);
        const durationMs = Date.now() - startedAt;
        log({
          level: "info",
          code: "COMMAND_RUN_END",
          msg: "command finished",
          sessionId,
          exitCode,
          durationMs,
          outputLength: output.length,
          truncated,
        });
        resolve({
          ok: true,
          exitCode,
          output,
          truncated,
          durationMs,
          ...(extra || {}),
        });
      };

      // 当前生效的静默阈值：从 quiet（默认 3000ms）开始，每次「到点但仍无结束标记」
      // 就升一档（×2）直到 quietCap（默认 16000ms），到天花板才真的判 EXEC_QUIET。
      // 这样既不切断慢启动命令（`sleep 5; echo late` 第一条输出在 5s），也不切断
      // 长空窗命令（真 PTY 实测 `node --test` 的输出间隔最长 9031ms），
      // 而真正卡住 / 等输入的命令按默认配置 16 秒内给结论，总超时 90 秒仍是硬兜底。
      let quietThreshold = quiet;
      // 看到结束标记后的小宽限（修复 3）：让真实结束标记有机会追上伪造的那一条。
      let tailTimer = null;

      const settleFromLastMark = () => {
        const split = splitBuffer(buffer, startMark, endMark);
        if (!split.finished) return;
        settle(split.output, split.exitCode, {});
      };

      const checkQuiet = () => {
        if (finished) return;
        const elapsed = Date.now() - startedAt;
        const idle = Date.now() - lastDataAt;
        // 静默判定只在本命令自己的 buffer/时间戳上算（PROTOCOL §6.7 第 2 点）。
        // elapsed 是「从写完命令到现在」，idle 是「距上次输出」。两者都过阈值才判静默，
        // 且必须有 startMark（否则连通都没通，交给总超时兜底）。
        const split = splitBuffer(buffer, startMark, endMark);
        if (elapsed >= minWait && idle >= quietThreshold && split.found) {
          if (quietThreshold < quietCap) {
            // 到点但没看到结束标记：升一档再等，不立刻判死（修复 1）。
            quietThreshold = Math.min(quietCap, quietThreshold * 2);
            quietTimer = setTimeout(checkQuiet, Math.max(20, quietThreshold - idle));
            if (quietTimer && typeof quietTimer.unref === "function") quietTimer.unref();
            return;
          }
          settle(split.output, null, { userText: USER_TEXT_QUIET, code: "EXEC_QUIET" });
          return;
        }
        if (!finished) {
          quietTimer = setTimeout(checkQuiet, Math.max(20, quietThreshold - idle));
          if (quietTimer && typeof quietTimer.unref === 'function') quietTimer.unref();
        }
      };

      const onOutput = (info) => {
        if (!info || info.id !== sessionId) return;
        const chunk = typeof info.data === "string" ? info.data : "";
        if (chunk.length === 0) return;
        buffer += chunk;
        lastDataAt = Date.now();
        const split = splitBuffer(buffer, startMark, endMark);
        if (split.finished && !tailTimer) {
          // 先不 resolve：等 tailGraceMs 后再取一次最后一个 endMark（修复 3）。
          tailTimer = setTimeout(settleFromLastMark, defaultTailGraceMs);
          if (tailTimer && typeof tailTimer.unref === "function") tailTimer.unref();
        }
      };

      active.set(sessionId, { command, startedAt });
      const detach = attach(sessionId, onOutput);

      totalTimer = setTimeout(() => {
        if (finished) return;
        const split = splitBuffer(buffer, startMark, endMark);
        settle(split.output, null, { userText: USER_TEXT_TIMEOUT, code: "EXEC_TIMEOUT" });
      }, limit);
      if (totalTimer && typeof totalTimer.unref === "function") totalTimer.unref();

      quietTimer = setTimeout(checkQuiet, Math.max(minWait, quietThreshold));
      if (quietTimer && typeof quietTimer.unref === "function") quietTimer.unref();

      if (!writeTo(sessionId, payload)) {
        settle("", null, { userText: "这个终端的会话已经结束。", code: "SESSION_GONE" });
      }
    });
  }

  /** 会话关闭时清缓存（PROTOCOL §6.7）。 */
  function dispose(sessionId) {
    capabilities.delete(sessionId);
    active.delete(sessionId);
  }

  /** 仅供测试：清空全部缓存。 */
  function reset() {
    capabilities.clear();
    active.clear();
  }

  return { setSessionResolver, run, probe, dispose, reset };
}
