// 本机可用 shell 的枚举 + 按 id 解析。
//
// TASK-FIX17-A（问题 1）：从「写死三个 id」改为**运行时发现**本机实际装了什么：
//   1. cmd          —— %COMSPEC%，回落 %SystemRoot%\System32\cmd.exe
//   2. bash         —— 复用 bridge.mjs 的 findMsysBash()（Git Bash / msys2），行为不变
//   3. pwsh         —— PowerShell 7（沿用 V4-F 的 detectPwsh 逻辑）
//   4. powershell   —— Windows PowerShell 5.1（沿用 V4-F 的逻辑）
//   5. wsl:<发行版> —— `wsl.exe -l -q` 的每一条，spawn 用 `wsl.exe -d <发行版>`
//   6. profile:<短名> —— Windows Terminal settings.json 里带 commandline 的 profile，
//                        **直接 spawn 它给出的可执行文件**（不是 spawn wt.exe）
//
// 约定（prd R1）：
// - 每个来源各自 try/catch：一个来源探测失败不影响其它来源，也不抛错；
// - 结果进程内缓存一次（shellsCache / resetShellsCache() 语义不变）；
// - 不可用的终端仍以 available:false 出现在清单里（UI 显示「未安装」）；
// - id 只允许 `[A-Za-z0-9:._-]`、总长 ≤ 64（与 config/store.mjs 的格式校验、
//   ws.mjs 帧校验的 max(64) 是同一套约束）。
//
// 与 bridge.mjs 的关系：`detectShell()` 保持不动（/api/health 还在用），
// 这里通过 `findMsysBash()` 复用同一套 git bash 探测，通过 `detectShell()`
// 复用同一套「默认 shell」判定，避免两套逻辑漂移。

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { detectShell, findMsysBash } from "./bridge.mjs";

/**
 * 内置四条 id 的固定顺序（UI 里排在清单最前面）。
 *
 * 这不是「全部可选项」：运行时清单还会追加 `wsl:<发行版>` 与 `profile:<短名>`。
 * 历史导出名 `SHELL_IDS` 保留成它的别名，避免外部一次性断链；本模块内部与
 * config/store.mjs 都不再用它做白名单（改用 isValidShellId 的格式校验）。
 */
export const BUILTIN_SHELL_IDS = Object.freeze(["cmd", "bash", "pwsh", "powershell"]);

/** @deprecated 用 BUILTIN_SHELL_IDS；它只是内置四项的顺序，不代表全部可选项。 */
export const SHELL_IDS = BUILTIN_SHELL_IDS;

/** id 总长上限（与 ws.mjs:51 的 z.string().max(64) 对齐）。 */
export const SHELL_ID_MAX = 64;
/** WT profile 派生 id 里「短名」部分的上限（给 `profile:` 前缀与去重后缀留空间）。 */
export const PROFILE_SLUG_MAX = 48;
/** id 允许的字符集：格式校验而不是固定白名单（cmd / wsl:* / profile:* 都要能存进配置）。 */
export const SHELL_ID_PATTERN = /^[A-Za-z0-9:._-]+$/;

const VERSION_TIMEOUT_MS = 3000;
/** WSL 探测超时：`wsl -l -q` 首次调用可能要拉起服务，给宽一点。 */
const WSL_TIMEOUT_MS = 5000;

/** 展示名。`session.created.shell.name` 直接用它（PowerShell 字样要在里面）。 */
const SHELL_NAMES = Object.freeze({
  cmd: "cmd",
  bash: "bash",
  pwsh: "PowerShell 7",
  powershell: "PowerShell 5",
});

const WT_SETTINGS_CANDIDATES = () => {
  const list = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    // 稳态包（prd 指定路径）在前；预览版 / 非打包安装作为兜底来源。
    list.push(path.join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"));
    list.push(path.join(local, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"));
    list.push(path.join(local, "Microsoft", "Windows Terminal", "settings.json"));
  }
  return list;
};

let shellsCache = null;

/* ------------------------------------------------------------------ *
 * id / 去重的纯函数（单测覆盖；不碰进程与文件系统）
 * ------------------------------------------------------------------ */

/**
 * 形如 `bash` / `cmd` / `wsl:Ubuntu-24.04` / `profile:git-bash` 的合法 id。
 * 格式校验（prd R1）：字符串、1–64 字符、字符集 [A-Za-z0-9:._-]；null 不是合法 id
 * （调用方用 null 表示「不指定，回到自动探测」）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidShellId(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > SHELL_ID_MAX) return false;
  return SHELL_ID_PATTERN.test(value);
}

/**
 * 把任意展示名压成 id 里能用的短名：小写、`[a-z0-9_-]` 之外的字符换 `-`、
 * 合并连续 `-`、去掉首尾 `-`、截断到 PROFILE_SLUG_MAX。
 * 全是非 ASCII（例如中文 profile 名）时用名字的 sha1 前缀，保证「同一个 profile
 * 每次得到同一个 id」。
 *
 * @param {string} name
 * @returns {string}
 */
export function slugifyShellName(name) {
  const raw = typeof name === "string" ? name : "";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROFILE_SLUG_MAX);
  if (slug.length > 0) return slug;
  const digest = crypto.createHash("sha1").update(raw, "utf8").digest("hex").slice(0, 10);
  return `p${digest}`;
}

/**
 * 生成一个不冲突的 id：`<prefix>:<slug>`，撞车时加 `-2` / `-3`…，总长始终 ≤ 64。
 *
 * @param {string} prefix `"profile"` 之类（不含冒号）
 * @param {string} name 展示名
 * @param {Iterable<string>} taken 已占用的 id
 * @returns {string}
 */
export function uniqueShellId(prefix, name, taken) {
  const used = taken instanceof Set ? taken : new Set(taken || []);
  const base = `${prefix}:${slugifyShellName(name)}`;
  if (!used.has(base) && base.length <= SHELL_ID_MAX) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const cut = Math.max(1, SHELL_ID_MAX - suffix.length);
    const candidate = `${base.slice(0, cut)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  // 实际上到不了（999 个同名 profile）；保底返回一个稳定值。
  return `${base.slice(0, SHELL_ID_MAX - 9)}-${Date.now().toString(36).slice(-8)}`;
}

/** 去重键：可执行路径 + 参数，全部小写（Windows 路径大小写不敏感）。 */
export function shellDedupeKey(item) {
  const exe = String(item && item.path ? item.path : "").toLowerCase();
  const args = Array.isArray(item && item.args) ? item.args.map((arg) => String(arg).toLowerCase()) : [];
  return `${exe}\0${args.join("\0")}`;
}

/** 只按可执行路径判断「这个 exe 已经有人代表了」（WT profile 跳过用）。 */
export function shellPathKey(filePath) {
  return String(filePath || "").toLowerCase();
}

/**
 * 按 `path + args` 去重，并保证 id 不重复。先出现的胜出（顺序即 UI 顺序）。
 *
 * id 缺失/非法的项在这里补一个：`prefix` 为 `"profile"` 时生成 `profile:<短名>`，
 * 否则生成 `<prefix>:<短名>`。
 *
 * @template {{id:string, name?:string, path:string, args:string[]}} T
 * @param {T[]} list
 * @param {string} [prefix] 补 id 时用的前缀（默认 `"shell"`）
 * @returns {T[]}
 */
export function dedupeShells(list, prefix = "shell") {
  const seenKeys = new Set();
  const seenIds = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== "object") continue;
    const key = shellDedupeKey(item);
    if (seenKeys.has(key)) continue;
    // 不可用项（path 为空）不参与去重：它们代表「这个 id 本机没装」，
    // 两个都空路径的 pwsh/powershell 不是重复项。
    if (item.path) seenKeys.add(key);
    let id = String(item.id || "");
    if (!isValidShellId(id) || seenIds.has(id)) {
      id = uniqueShellId(item.group === "profile" ? "profile" : prefix, item.name || id || "x", seenIds);
    }
    seenIds.add(id);
    out.push({ ...item, id });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * WSL：输出是 UTF-16LE（实测 `wsl.exe -l -q` 28 字节 / 每字符 2 字节）
 * ------------------------------------------------------------------ */

/**
 * 解码 `wsl.exe` 的 stdout。
 *
 * 实测本机 `wsl -l -q` 输出 `55 00 62 00 75 00 …`（UTF-16LE，无 BOM）；
 * 有些 Windows 版本/区域设置下可能是 UTF-8。判定方式：ASCII 区间字符的
 * 高字节为 0 → 奇数位大量 0 字节 → UTF-16LE。BOM 优先级最高。
 *
 * @param {Buffer|Uint8Array|string} input
 * @returns {string}
 */
export function decodeWslOutput(input) {
  if (typeof input === "string") return input.replace(/\0/g, "");
  if (!input || typeof input.length !== "number" || input.length === 0) return "";
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le").replace(/\0/g, "");
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  let highBytesAtOdd = 0;
  let pairs = 0;
  for (let index = 0; index + 1 < sample.length; index += 2) {
    pairs += 1;
    if (sample[index + 1] === 0) highBytesAtOdd += 1;
  }
  const looksUtf16 = pairs > 0 && highBytesAtOdd >= Math.ceil(pairs * 0.6);
  return (looksUtf16 ? buffer.toString("utf16le") : buffer.toString("utf8")).replace(/\0/g, "");
}

/**
 * 把 `wsl.exe -l -q` 的原始输出拆成发行版名列表。
 * 去掉 `*`（默认发行版标记）、空行、只含控制字符的行。
 *
 * @param {Buffer|Uint8Array|string} input
 * @returns {string[]}
 */
export function parseWslDistroList(input) {
  const text = decodeWslOutput(input);
  const out = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/\0/g, "").replace(/^\*+\s*/, "").trim();
    // 过滤「无可用发行版」时的提示行与纯装饰行。
    if (!line) continue;
    if (/^(no installed distributions|没有已安装的分发)/i.test(line)) continue;
    if (/^\u2500+$|^-+$/.test(line)) continue;
    out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Windows Terminal settings.json（JSONC：允许 // 、/* *\/ 注释与尾逗号）
 * ------------------------------------------------------------------ */

/**
 * 剥掉 JSONC 的注释。用状态机而不是正则：字符串里的 `//`（路径、URL）不能被吃掉。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsoncComments(text) {
  const source = String(text || "");
  let out = "";
  let index = 0;
  let inString = false;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        // 转义序列整体复制，避免 `\"` 被当成字符串结尾。
        if (index + 1 < source.length) out += source[index + 1];
        index += 2;
        continue;
      }
      if (char === "\"") inString = false;
      index += 1;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * 剥掉尾逗号（`[1,2,]` / `{"a":1,}`），同样避开字符串内部。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTrailingCommas(text) {
  const source = String(text || "");
  let out = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (char === "\\") {
        if (index + 1 < source.length) out += source[index + 1];
        index += 1;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      // 向前看：下一个非空白字符是 } 或 ] 就是尾逗号。
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    out += char;
  }
  return out;
}

/**
 * 容错解析 JSONC。解析失败返回 null（调用方静默跳过整个来源）。
 *
 * @param {string} text
 * @returns {any|null}
 */
export function parseJsonc(text) {
  const stripped = stripTrailingCommas(stripJsoncComments(text));
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/** 展开 `%USERPROFILE%` / `%SystemRoot%` 这类型 Windows 环境变量引用。 */
export function expandEnvVars(text, env = process.env) {
  return String(text || "").replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === String(name).toLowerCase());
    return key && env[key] !== undefined ? String(env[key]) : whole;
  });
}

/**
 * 把 WT profile 的 `commandline` 拆成「可执行文件 + 参数」。
 *
 * 支持的形态（WT 的 commandline 是自由字符串）：
 *   `"C:\\Program Files\\x\\y.exe" --flag "a b"`
 *   `C:\\Windows\\System32\\cmd.exe`
 * 引号内的内容原样保留，反斜杠**不**当转义（Windows 路径），只把 `""` 当字面引号。
 *
 * @param {string} commandline
 * @param {object} [env]
 * @returns {{path:string, args:string[]}|null}
 */
export function parseCommandline(commandline, env = process.env) {
  if (typeof commandline !== "string") return null;
  const expanded = expandEnvVars(commandline, env).trim();
  if (!expanded) return null;
  const tokens = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;
  for (let index = 0; index < expanded.length; index += 1) {
    const char = expanded[index];
    if (char === "\"") {
      if (inQuotes && expanded[index + 1] === "\"") {
        current += "\"";
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (hasToken || current.length > 0) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (hasToken || current.length > 0) tokens.push(current);
  if (tokens.length === 0) return null;
  const [exe, ...args] = tokens;
  return { path: exe, args };
}

/** 真正的绝对路径（Windows 盘符 / UNC / POSIX）。 */
function isAbsoluteExePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/")) return true;
  if (value.startsWith("\\\\")) return true;
  return /^[A-Za-z]:[\\/]/.test(value);
}

function fileExists(filePath) {
  try {
    return Boolean(filePath) && existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 从 WT settings.json 的文本派生候选 shell（纯函数：不读盘、不 spawn，便于单测）。
 *
 * 规则（prd R1 / design.md）：
 * - `hidden === true` 跳过；
 * - `commandline` 不是字符串跳过（动态生成的 profile 没有固定命令行）；
 * - 解析出的可执行文件必须是绝对路径且存在于磁盘；
 * - 去重：与已发现项 path+args 完全相同的跳过；可执行路径已被内置四条
 *   （cmd/bash/pwsh/powershell）覆盖的也跳过 —— 同一个 exe 再来一条没有意义。
 *   只按路径跳过内置项、不按路径跳过 wsl.exe：`wsl.exe -d Other` 是**另一个发行版**，
 *   它不该因为路径相同被吃掉（只有 path+args 完全相同才算重复）。
 *
 * @param {string} settingsText
 * @param {{env?: object, coveredPaths?: Iterable<string>, coveredKeys?: Iterable<string>, coveredExact?: Iterable<{path:string,args:string[]}>, exists?: (p:string)=>boolean}} [opts]
 * @returns {Array<{name:string, path:string, args:string[], commandline:string}>}
 */
export function deriveWtProfileShells(settingsText, opts = {}) {
  const env = opts.env || process.env;
  const exists = typeof opts.exists === "function" ? opts.exists : fileExists;
  const coveredPaths = new Set(Array.from(opts.coveredPaths || [], (item) => shellPathKey(item)));
  const coveredKeys = new Set(Array.from(opts.coveredKeys || [], (item) => String(item).toLowerCase()));
  for (const item of opts.coveredExact || []) {
    if (item) coveredKeys.add(shellDedupeKey(item));
  }
  const parsed = parseJsonc(settingsText);
  const list = parsed && parsed.profiles && Array.isArray(parsed.profiles.list) ? parsed.profiles.list : [];
  const out = [];
  const seen = new Set();
  for (const profile of list) {
    try {
      if (!profile || typeof profile !== "object") continue;
      if (profile.hidden === true) continue;
      const spec = parseCommandline(profile.commandline, env);
      if (!spec) continue;
      if (!isAbsoluteExePath(spec.path)) continue;
      if (!exists(spec.path)) continue;
      const key = shellDedupeKey(spec);
      if (coveredKeys.has(key) || coveredPaths.has(shellPathKey(spec.path)) || seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : path.basename(spec.path),
        path: spec.path,
        args: spec.args,
        commandline: String(profile.commandline),
      });
    } catch {
      // 单个 profile 出错不影响其它 profile。
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 进程探测
 * ------------------------------------------------------------------ */

function runCommand(commandPath, args, options = {}) {
  try {
    return execFileSync(commandPath, args, {
      timeout: options.timeoutMs || VERSION_TIMEOUT_MS,
      encoding: options.encoding || "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    // 超时 / 非零退出都只当作「读不到版本」：stdout/stderr 里可能已有一半结果。
    return options.encoding === "buffer"
      ? (err && (err.stdout || err.stderr)) || Buffer.alloc(0)
      : (err && (err.stdout || err.stderr)) || "";
  }
}

function parseVersion(text) {
  const match = /(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/.exec(String(text || ""));
  return match ? match[1] : "unknown";
}

/** `pwsh` 的三个候选位置（卡片 §5.1 的顺序）+ PATH 兜底。
 *  这里不预先过滤不存在/不可 stat 的路径：可用性靠「试跑能不能拿到版本号」判（见 detectPwsh）。 */
function pwshCandidates() {
  const list = [];
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  if (local) list.push(`${local}\\Microsoft\\WindowsApps\\pwsh.exe`);
  if (pf) list.push(`${pf}\\PowerShell\\7\\pwsh.exe`);
  const pathValue = process.env.PATH || "";
  for (const dir of pathValue.split(";")) {
    if (!dir) continue;
    const candidate = `${dir.replace(/[\\/]+$/, "")}\\pwsh.exe`;
    if (!list.includes(candidate)) list.push(candidate);
  }
  return list;
}

function detectBash() {
  const found = findMsysBash();
  if (!found) {
    return {
      id: "bash",
      name: SHELL_NAMES.bash,
      version: "unknown",
      path: "",
      args: [],
      available: false,
      group: "local",
    };
  }
  return {
    id: "bash",
    name: SHELL_NAMES.bash,
    version: found.version,
    path: found.path,
    args: [],
    available: true,
    group: "local",
  };
}

function detectCmd() {
  const win = process.env.SystemRoot || "C:\\Windows";
  const fallback = `${win}\\System32\\cmd.exe`;
  const comspec = typeof process.env.COMSPEC === "string" && process.env.COMSPEC.trim() ? process.env.COMSPEC.trim() : "";
  const candidates = [comspec, fallback].filter(Boolean);
  const existing = candidates.find((candidate) => fileExists(candidate));
  const commandPath = existing || candidates[candidates.length - 1];
  if (!commandPath) {
    return {
      id: "cmd",
      name: SHELL_NAMES.cmd,
      version: "unknown",
      path: "",
      args: [],
      available: false,
      group: "local",
    };
  }
  if (!existing) {
    return {
      id: "cmd",
      name: SHELL_NAMES.cmd,
      version: "unknown",
      path: commandPath,
      args: [],
      available: false,
      group: "local",
    };
  }
  // `cmd /d /c ver` 的输出是 OEM 码页（「版本」两个字是乱码），但版本号是 ASCII。
  const out = runCommand(commandPath, ["/d", "/c", "ver"]);
  return {
    id: "cmd",
    name: SHELL_NAMES.cmd,
    version: parseVersion(out),
    path: commandPath,
    args: [],
    // 文件在就算可用：读不到版本号只是 version=unknown（与 powershell 分支同一口径）。
    available: true,
    group: "local",
  };
}

function detectPowerShell() {
  const win = process.env.SystemRoot || "C:\\Windows";
  const commandPath = `${win}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (!fileExists(commandPath)) {
    return {
      id: "powershell",
      name: SHELL_NAMES.powershell,
      version: "unknown",
      path: commandPath,
      args: ["-NoLogo"],
      available: false,
      group: "local",
    };
  }
  const out = runCommand(commandPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()",
  ]);
  const version = parseVersion(out);
  return {
    id: "powershell",
    name: SHELL_NAMES.powershell,
    version,
    path: commandPath,
    args: ["-NoLogo"],
    // 探测超时 / 失败时版本是 unknown，但可执行文件在 → 仍算可用（卡片：失败不抛）。
    available: true,
    group: "local",
  };
}

function detectPwsh() {
  for (const candidate of pwshCandidates()) {
    // 不能用 existsSync 筛：WindowsApps 里的 pwsh.exe 是「应用执行别名」，
    // existsSync / stat 会报 EACCES，但 execFileSync 能正常跑。
    // 所以直接试跑一次：拿得到版本号才算可用。
    const out = runCommand(candidate, [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ]);
    const version = parseVersion(out);
    if (version === "unknown") continue;
    return {
      id: "pwsh",
      name: SHELL_NAMES.pwsh,
      version,
      path: candidate,
      args: ["-NoLogo"],
      available: true,
      group: "local",
    };
  }
  return {
    id: "pwsh",
    name: SHELL_NAMES.pwsh,
    version: "unknown",
    path: "",
    args: ["-NoLogo"],
    available: false,
    group: "local",
  };
}

function findWslExe() {
  const win = process.env.SystemRoot || "C:\\Windows";
  const candidates = [`${win}\\System32\\wsl.exe`, `${win}\\Sysnative\\wsl.exe`];
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * WSL 发行版 → shell 记录。`wsl.exe` 不存在 / 没有发行版 / 任何异常 → 返回 []（静默跳过）。
 *
 * 可用性判定：出现在 `wsl -l -q` 里就说明该发行版已注册 → available:true。
 * 版本**不**逐条跑 `wsl -d <distro> -- uname -r`（每个 1s+），统一用一次
 * `wsl --version` 里的 WSL 版本号；读不到就是 "unknown"。
 *
 * 参数注入（exePath / listOutput / versionOutput）只给单测用：单测不能依赖本机装没装 WSL。
 *
 * @param {{exePath?: string|null, listOutput?: Buffer|string, versionOutput?: Buffer|string}} [injected]
 */
export function detectWsl(injected = {}) {
  const wslExe = injected.exePath === undefined ? findWslExe() : injected.exePath;
  if (!wslExe) return [];
  let listRaw;
  try {
    listRaw =
      injected.listOutput !== undefined
        ? injected.listOutput
        : runCommand(wslExe, ["-l", "-q"], { timeoutMs: WSL_TIMEOUT_MS, encoding: "buffer" });
  } catch {
    return [];
  }
  let distros;
  try {
    distros = parseWslDistroList(listRaw);
  } catch {
    return [];
  }
  if (distros.length === 0) return [];
  let version = "unknown";
  try {
    const versionRaw =
      injected.versionOutput !== undefined
        ? injected.versionOutput
        : runCommand(wslExe, ["--version"], { timeoutMs: WSL_TIMEOUT_MS, encoding: "buffer" });
    version = parseVersion(decodeWslOutput(versionRaw));
  } catch {
    version = "unknown";
  }
  return distros.map((distro) => ({
    id: `wsl:${distro}`,
    name: `WSL · ${distro}`,
    version,
    path: wslExe,
    args: ["-d", distro],
    // 出现在 wsl -l -q 里 = 已注册（wsl.exe 已证明能列出它）。
    available: true,
    group: "wsl",
    detail: distro,
  }));
}

/**
 * WT settings.json → shell 记录。文件不存在 / JSONC 解析失败 / 任何异常 → 返回 []。
 *
 * @param {{localPaths?: Iterable<string>, coveredKeys?: Iterable<string>}} [covered]
 * @param {{settingsPaths?: string[], settingsText?: string}} [injected] 只给单测用
 */
export function detectWtProfiles(covered = {}, injected = {}) {
  const files = injected.settingsPaths || WT_SETTINGS_CANDIDATES();
  const out = [];
  for (const file of files) {
    try {
      if (!fileExists(file)) continue;
      const text = injected.settingsText !== undefined ? String(injected.settingsText) : readFileSync(file, "utf8");
      const derived = deriveWtProfileShells(text, {
        coveredPaths: covered.localPaths || [],
        coveredKeys: covered.coveredKeys || [],
      });
      for (const item of derived) {
        out.push({
          id: "", // 由 detectShells() 统一生成（要跨来源去重）
          name: item.name,
          version: "unknown",
          path: item.path,
          args: item.args,
          // derive 阶段已经要求 exe 存在，所以可用。
          available: true,
          group: "profile",
          detail: item.name,
          commandline: item.commandline,
        });
      }
      // 只用第一份存在的 settings.json（预览版与稳态版不会同时生效）。
      break;
    } catch {
      // 整个来源失败：静默跳过，不影响内置四条与 WSL。
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

/**
 * 本机可用终端的实测清单（进程内缓存一次）。
 *
 * 顺序：内置四条（cmd, bash, pwsh, powershell）→ WSL → WT profile 派生。
 * 不可用的内置项也保留（available:false），UI 据此显示「未安装」。
 *
 * @returns {Array<{id:string, name:string, version:string, path:string, args:string[], available:boolean, group:"local"|"wsl"|"profile", detail?:string}>}
 */
export function detectShells() {
  if (shellsCache) return shellsCache;
  // 内置四条：任何一个探测抛错都不能带崩整个清单。
  const builtins = [];
  for (const detector of [detectCmd, detectBash, detectPwsh, detectPowerShell]) {
    try {
      builtins.push(detector());
    } catch {
      // 跳过（不中断其它来源）。
    }
  }
  // 顺序按 BUILTIN_SHELL_IDS 归一，不受探测顺序影响；缺失项补一条不可用记录。
  const orderedBuiltins = BUILTIN_SHELL_IDS.map((id) => {
    const found = builtins.find((item) => item.id === id);
    return (
      found || {
        id,
        name: SHELL_NAMES[id] || id,
        version: "unknown",
        path: "",
        args: [],
        available: false,
        group: "local",
      }
    );
  });

  // WT profile 需要「内置四条已覆盖的可执行路径」与「全部已发现项的 path+args」来去重。
  const localPaths = new Set();
  for (const item of orderedBuiltins) {
    if (item.path) localPaths.add(shellPathKey(item.path));
  }

  let wsl = [];
  try {
    wsl = detectWsl();
  } catch {
    wsl = [];
  }
  const coveredKeys = new Set([...orderedBuiltins, ...wsl].filter((item) => item.path).map((item) => shellDedupeKey(item)));

  let profiles = [];
  try {
    profiles = detectWtProfiles({ localPaths, coveredKeys });
  } catch {
    profiles = [];
  }

  const merged = dedupeShells([...orderedBuiltins, ...wsl, ...profiles]);
  shellsCache = merged;
  return shellsCache;
}

/** 单条 shell 的原始记录（可能 available:false）。 */
export function shellRecord(id) {
  return detectShells().find((item) => item.id === id) || null;
}

/**
 * 按 id 解析出一个能 spawn 的 shell。不可用 / 不认识的 id → null。
 * @param {string} id
 */
export function resolveShellById(id) {
  if (typeof id !== "string" || id.length === 0) return null;
  const record = shellRecord(id);
  if (!record || !record.available) return null;
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    path: record.path,
    args: record.args,
    // 与 bridge.detectShell() 的返回形状对齐：SessionManager / health 都读这个字段。
    fallback: false,
  };
}

/** 自动探测的默认 shell（与 /api/health 的 shell 同一来源）。 */
export function detectDefaultShell() {
  const detected = detectShell({});
  const plainName = String(detected && detected.name ? detected.name : "");
  let id = null;
  if (/bash/i.test(plainName)) id = "bash";
  else if (/powershell|pwsh/i.test(plainName)) {
    // bridge 的回退分支只产出 PowerShell 5（pwsh 不在它的候选里）。
    id = /7/.test(plainName) ? "pwsh" : "powershell";
  }
  return {
    id,
    name: detected.name,
    version: detected.version,
    path: detected.path,
    args: detected.args || [],
    fallback: Boolean(detected.fallback),
  };
}

/**
 * 解析「这次创建会话该用哪个 shell」。
 *
 * 顺序（卡片 §5.2）：`shellId` → `config.defaultShell` → `MAGPIE_TERMINAL_SHELL`
 * → `detectShell()`。后两者由 `detectDefaultShell()` 一起兜住（bridge 自己认环境变量）。
 *
 * 显式给了 `shellId` 但不可用 → `{ok:false, code:"PTY_UNKNOWN_SHELL"}`（由 ws 层
 * 翻成 session.failed）。配置里的 defaultShell 不可用时**不报错**，退回自动探测：
 * 换机器 / 卸掉 pwsh 不该让用户连终端都开不出来。
 *
 * @param {{shellId?: string|null, defaultShell?: string|null}} [input]
 * @returns {{ok:true, shell:object}|{ok:false, code:string, userText:string}}
 */
export function resolveShellForRequest(input = {}) {
  const shellId = input ? input.shellId : null;
  if (typeof shellId === "string" && shellId.length > 0) {
    const shell = resolveShellById(shellId);
    if (shell) return { ok: true, shell };
    return {
      ok: false,
      code: "PTY_UNKNOWN_SHELL",
      userText: `没有可用的 ${shellId}，或本机没装这个 shell。`,
    };
  }

  const configured = input ? input.defaultShell : null;
  if (typeof configured === "string" && configured.length > 0) {
    const shell = resolveShellById(configured);
    if (shell) return { ok: true, shell };
  }

  return { ok: true, shell: detectDefaultShell() };
}

/** 给测试用：清空探测缓存（环境变量 / 安装状态变化后重新读）。 */
export function resetShellsCache() {
  shellsCache = null;
}

/** 给测试用：直接注入一份探测结果并写入缓存（避免单测依赖本机安装状态）。 */
export function setShellsCache(list) {
  shellsCache = Array.isArray(list) ? list : null;
}
