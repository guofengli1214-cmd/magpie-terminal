// 系统目录保护表（TASK-FIX17-K R1）。
//
// 为什么单独成文件：判「这条删除命令会不会端掉系统目录」需要一张**与命令头解耦**的
// 路径表。`forbidden.mjs`（灾难级规则）与 `destructive-targets.mjs`（静态护栏）
// 都要问同一张表，所以放在这里、两边 import；本模块**不 import 那两个模块**，
// 避免成环。
//
// 纯函数、零 IO、永不抛：拿不准一律返回 protected:false（由调用方按黑名单层兜底），
// 只有明确命中表项或系统变量写法才返回 protected:true。
//
// 表的设计（见 .trellis/tasks/11-25-task-k-protected-paths/design.md）：
//   - 子树保护：Windows 系统目录，删它任意子路径都等于动系统。
//   - 只保护本身：Users / POSIX 根一级目录。`C:\Users\<用户名>\...` 是用户自己的文件，
//     删自己的项目目录必须能过（J 批核心诉求），所以不把用户目录放进子树表。
//   - 盘根本身（`C:\`、`/`）已有 isDriveRoot 兜底，这里不重复（`/` 顺带保留一项，
//     因为 POSIX 根既是盘根又是表项，重复不会误伤）。

import path from "node:path";

/** 整棵子树都保护（含它自己）。Windows 路径统一用正斜杠书写，比较时再折大小写。 */
export const PROTECTED_SUBTREES = Object.freeze([
  "c:/windows",
  "c:/program files",
  "c:/program files (x86)",
  "c:/programdata",
]);

/** 只保护它本身，子目录照常交给审阅 + 护栏判。 */
export const PROTECTED_EXACT = Object.freeze([
  "c:/users",
  "/",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/dev",
  "/lib",
  "/lib64",
  "/var",
  "/home",
  "/root",
  "/opt",
  "/srv",
  "/sys",
  "/proc",
  "/System",
  "/Library",
  "/Applications",
  "/private",
]);

/** 系统目录的环境变量写法（只对删除 / 移动命令头生效，见 forbidden.mjs R2）。 */
const SYSTEM_VAR_TARGET_RE = /^(?:%systemroot%|%windir%|\$env:systemroot|\$\{env:systemroot\})(?:[\\/]|$)/i;

const WINDOWS_ABS_RE = /^[A-Za-z]:\//;
const POSIX_ABS_RE = /^\//;

/** 比较用的折叠：Windows 大小写不敏感，正反斜杠等价（反斜杠在归一化时已转正）。 */
function fold(text) {
  return String(text).toLowerCase();
}

/** 去首尾空白与成对引号（`'` `"` 与 PowerShell 的 `` ` ``）。 */
function stripQuotes(raw) {
  let text = String(raw === undefined || raw === null ? "" : raw).trim();
  for (;;) {
    if (text.length < 2) break;
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" || first === '"' || first === "`") && last === first) {
      text = text.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return text;
}

/**
 * 去掉尾随的 `*` 与 `/`（`C:\Windows\*` 与 `C:\Windows` 是同一件事）。
 * 盘根（`C:/`）与 POSIX 根（`/`）保持原样，不能被削成空串。
 */
function trimTrailingWildcards(text) {
  let out = text;
  for (;;) {
    const previous = out;
    if (out.length > 1 && out.endsWith("*")) out = out.slice(0, -1);
    if (out.length > 1 && out.endsWith("/") && !/^[A-Za-z]:\/$/.test(out)) out = out.slice(0, -1);
    if (out === previous) break;
  }
  return out;
}

/**
 * 把命令里的目标归一成可比较的形态（TASK-FIX17-K R1）。
 *
 * 顺序（与 prd 一致）：去引号 → 反斜杠转正斜杠 → 去尾随 `/` 与 `*` →
 * 相对路径按 cwd 解析 / 绝对路径折叠 `..` → 盘符小写。
 *
 * Windows 盘符路径用 path.win32 归一，POSIX 绝对路径用 path.posix 归一，
 * 这样同一份代码在 Windows 上也能判 `/etc`（不会被 path.resolve 折成 `C:\etc`），
 * 相对路径仍走 path.resolve(cwd, …)，`..` 不会靠字符串前缀判断。
 *
 * @param {unknown} raw 命令里的原始目标（可带引号）
 * @param {string} [cwd] 相对路径的基准目录
 * @returns {string} 归一后的路径（正斜杠）；读不出时返回空串
 */
export function normalizeTargetPath(raw, cwd) {
  let text = stripQuotes(raw);
  if (text.length === 0) return "";

  // 反斜杠统一成正斜杠（Windows 路径与 `/etc` 比较时同形）。
  text = text.replace(/\\/g, "/");
  text = trimTrailingWildcards(text);
  if (text.length === 0) return "";

  // Windows 绝对路径：用 win32 语义折叠 `..`，然后统一正斜杠、小写盘符。
  if (WINDOWS_ABS_RE.test(text)) {
    let resolved = path.win32.normalize(text).replace(/\\/g, "/");
    if (resolved.length > 3 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);
    return resolved[0].toLowerCase() + resolved.slice(1);
  }

  // POSIX 绝对路径：不能被 path.resolve(cwd, …) 折成 Windows 盘上的 `C:\etc`。
  if (POSIX_ABS_RE.test(text)) {
    let resolved = path.posix.normalize(text);
    if (resolved.length > 1 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);
    return resolved;
  }

  // 相对路径：按 cwd 解析，`..` 在解析阶段折叠。
  const base = typeof cwd === "string" && cwd.trim().length > 0 ? path.resolve(cwd) : process.cwd();
  let resolved = path.resolve(base, text).replace(/\\/g, "/");
  if (resolved.length > 1 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);
  if (WINDOWS_ABS_RE.test(resolved)) resolved = resolved[0].toLowerCase() + resolved.slice(1);
  return resolved;
}

/**
 * 这个目标是不是受保护的系统目录。
 *
 * @param {unknown} raw 命令里的原始目标（可带引号）
 * @param {string} [cwd]
 * @returns {{protected: boolean, reason: string|null, resolved: string}}
 */
export function isProtectedTarget(raw, cwd) {
  const original = stripQuotes(raw);
  if (original.length === 0) return { protected: false, reason: null, resolved: "" };

  // 系统变量写法读不出真实路径 → fail-closed 当系统目录（只由删除 / 移动规则调用）。
  if (SYSTEM_VAR_TARGET_RE.test(original)) {
    return {
      protected: true,
      reason: "系统目录（环境变量写法）",
      resolved: normalizeTargetPath(original, cwd),
    };
  }

  const resolved = normalizeTargetPath(original, cwd);
  if (resolved.length === 0) return { protected: false, reason: null, resolved };
  const folded = fold(resolved);

  for (const subtree of PROTECTED_SUBTREES) {
    const base = fold(subtree);
    if (folded === base || folded.startsWith(`${base}/`)) {
      return { protected: true, reason: `系统目录（${subtree} 及其子目录）`, resolved };
    }
  }

  for (const exact of PROTECTED_EXACT) {
    if (folded === fold(exact)) {
      return { protected: true, reason: `系统目录（${exact}）`, resolved };
    }
  }

  return { protected: false, reason: null, resolved };
}
