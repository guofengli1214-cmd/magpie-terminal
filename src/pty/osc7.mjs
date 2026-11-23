// OSC 7（当前工作目录）增量解析器（TASK-V4-G §5.1）。
//
// 终端里的 shell 通过下面两种结束符之一发一条 OSC 7：
//   ESC ] 7 ; file://HOST/PATH BEL      （\x07）
//   ESC ] 7 ; file://HOST/PATH ESC \    （ST）
// 还有 8 位 ST（0x9c），少见但要认。
//
// 必须容忍 ANSI 序列被拆到两个 chunk 里（ConPTY 会随意切）：
// 找不到结束符时把**从序列开头起**的尾巴留在缓冲区，等下一个 chunk。
// 缓冲上限 4KB：超了就当这条是垃圾，丢掉（否则一条没有结束符的序列会一直吃内存）。
//
// 只做解析，不碰会话状态；session.mjs 负责把结果写进 session.cwd。

/** 未完成序列的保留上限（字节 / UTF-16 code unit，实际按长度算）。 */
export const MAX_PENDING = 4096;

const ESC = "\x1b";
const BEL = "\x07";
const OSC7_INTRO = `${ESC}]7;`;

/**
 * 把 OSC 7 的正文（`file://HOST/PATH`）解成一个本机/远端都可用的绝对路径。
 *
 * 支持的形态：
 * - `file://host/home/user/x`        → `/home/user/x`
 * - `file:///C:/Users/x`             → `C:\Users\x`（Windows）
 * - `file://host/C:/Users/x`         → `C:\Users\x`
 * - `file://host/c/Users/x`（MSYS bash 的 `$PWD` 是 `/c/Users/x`）→ `C:\Users\x`
 * - 百分号编码：`/tmp/a%20b` → `/tmp/a b`
 *
 * 不合法的正文返回 null（调用方直接丢弃这条）。
 *
 * @param {string} payload
 * @param {{windows?: boolean, platform?: string}} [opts]
 * @returns {string|null}
 */
export function decodeOsc7(payload, opts = {}) {
  if (typeof payload !== "string" || payload.length === 0) return null;
  const text = payload.trim();
  if (!/^file:\/\//i.test(text)) return null;
  const rest = text.slice("file://".length);
  const slash = rest.indexOf("/");
  // 没有路径段（只有 host）：无从得知目录。
  if (slash < 0) return null;

  let rawPath = rest.slice(slash);
  // 去掉 query / fragment（某些 shell 会带 ?host=…）。
  const cut = rawPath.search(/[?#]/);
  if (cut >= 0) rawPath = rawPath.slice(0, cut);

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.includes("\0")) return null;

  const platform = opts.platform || process.platform;
  const windows = typeof opts.windows === "boolean" ? opts.windows : platform === "win32";
  if (!windows) return decoded;

  return toWindowsPath(decoded);
}

/**
 * MSYS / Git Bash 的路径还原：
 *   `/C:/Users/x` → `C:\Users\x`
 *   `/c/Users/x`  → `C:\Users\x`
 * 其余（`/tmp/x`）原样保留：它在 Windows 上不是绝对路径，由上层判非法。
 *
 * @param {string} value
 * @returns {string}
 */
export function toWindowsPath(value) {
  // `/C:/Users/x` 或 `/C:\Users\x`
  const driveWithColon = /^\/([A-Za-z]):(?:[\\/]|$)/.exec(value);
  if (driveWithColon) {
    const rest = value.slice(driveWithColon[0].length - 1); // 保留分隔符
    return `${driveWithColon[1].toUpperCase()}:${rest}`.replace(/\//g, "\\");
  }
  // `/c/Users/x` 或 `/c`（MSYS 的单字母盘符挂载点）
  const msysDrive = /^\/([A-Za-z])(\/[^/].*)?$/.exec(value);
  if (msysDrive) {
    const rest = msysDrive[2] || "\\";
    return `${msysDrive[1].toUpperCase()}:${rest}`.replace(/\//g, "\\");
  }
  return value;
}

/**
 * 增量扫描器。`push(chunk)` 返回本 chunk 里**完整**的 OSC 7 正文数组。
 *
 * @returns {{push:(chunk:string)=>string[], reset:()=>void, pending:()=>string}}
 */
export function createOsc7Scanner() {
  let buffer = "";

  function push(chunk) {
    const found = [];
    if (typeof chunk === "string" && chunk.length > 0) buffer += chunk;
    if (buffer.length === 0) return found;

    for (;;) {
      const start = buffer.indexOf(OSC7_INTRO);
      if (start < 0) {
        // 没有序列开头：只保留末尾几字节（跨 chunk 的半条 ESC ] 7 ;）。
        if (buffer.length > 8) buffer = buffer.slice(-8);
        break;
      }
      if (start > 0) buffer = buffer.slice(start);

      // 找结束符：BEL / ESC \ / 0x9c。
      let end = -1;
      let endLen = 1;
      for (let i = OSC7_INTRO.length; i < buffer.length; i += 1) {
        const ch = buffer[i];
        if (ch === BEL || ch === "\x9c") {
          end = i;
          endLen = 1;
          break;
        }
        if (ch === ESC) {
          if (i + 1 >= buffer.length) break; // ESC 落在 chunk 末尾，等下一个
          if (buffer[i + 1] === "\\") {
            end = i;
            endLen = 2;
            break;
          }
          // 不是 ST：这一条已经坏了（新的 ESC 开始），丢弃到下一个序列头。
          end = -1;
          break;
        }
      }

      if (end < 0) {
        // 还没收完：留整条尾巴等下一个 chunk；超过上限直接放弃。
        if (buffer.length > MAX_PENDING) {
          buffer = "";
          break;
        }
        break;
      }

      found.push(buffer.slice(OSC7_INTRO.length, end));
      buffer = buffer.slice(end + endLen);
      if (buffer.length === 0) break;
      // 缓冲区里可能还有下一条。
    }

    if (buffer.length > MAX_PENDING) buffer = buffer.slice(-8);
    return found;
  }

  return {
    push,
    reset() {
      buffer = "";
    },
    pending() {
      return buffer;
    },
  };
}

/**
 * 一次性解析（测试 / 探针方便用；会话里请用 createOsc7Scanner）。
 * @param {string} data
 * @param {{windows?: boolean, platform?: string}} [opts]
 * @returns {string[]} 解出来的绝对路径（顺序即出现顺序）
 */
export function extractOsc7Paths(data, opts = {}) {
  const scanner = createOsc7Scanner();
  const out = [];
  for (const payload of scanner.push(String(data || ""))) {
    const decoded = decodeOsc7(payload, opts);
    if (decoded) out.push(decoded);
  }
  return out;
}
