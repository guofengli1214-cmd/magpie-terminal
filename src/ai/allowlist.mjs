// 用户白名单匹配（PROTOCOL-AGENT.md §2）。
//
// 语义原文：
//   pattern 已 trim；大小写敏感；不做通配符展开
//   prefix 模式：command.startsWith(pattern) && (剩下的第一个字符是空白或结尾)
//     → 可以写 "mkdir"，命中 "mkdir a b"，不命中 "mkdirx"
//   exact 模式：command.trim() === pattern.trim()
//
// 多个条目按数组顺序，命中第一个 enabled: true 的即算命中；enabled: false 跳过。
//
// 纯函数、零 IO、永不抛：配置被人手改坏（null / 数字 / 缺字段）时一律视为不命中。
//
// TASK-V4-S §6.2（P0-2）：prefix 判定**不再作用于整条命令**，而是先切段、逐段判定。
// 之前只看 `command.startsWith(pattern)`，于是 `mkdir -p /tmp/x && rm -rf /tmp/victim`
// 因为「以 mkdir 开头」被整条自动执行（VERIFY-V4-G §4 P0-2 已逐字复现）。

import { splitSegments } from "../policy/segments.mjs";

/** pattern 长度上限（PROTOCOL §1 校验规则）。 */
export const ALLOWLIST_MAX_ENTRIES = 200;
export const ALLOWLIST_PATTERN_MIN = 1;
export const ALLOWLIST_PATTERN_MAX = 500;

/**
 * 单条 pattern 是否合法（§1 的校验规则里同名的那部分）。
 * @param {unknown} pattern
 * @returns {boolean}
 */
export function isValidAllowlistPattern(pattern) {
  if (typeof pattern !== "string") return false;
  if (pattern.length < ALLOWLIST_PATTERN_MIN || pattern.length > ALLOWLIST_PATTERN_MAX) return false;
  return !/[\r\n]/.test(pattern);
}

/**
 * 单条白名单条目是否合法。
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isValidAllowlistEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (!isValidAllowlistPattern(entry.pattern)) return false;
  if (entry.mode !== "prefix" && entry.mode !== "exact") return false;
  if (typeof entry.enabled !== "boolean") return false;
  return true;
}

/**
 * 按 §2 语义匹配一条命令。
 *
 * **整条命令必须能被安全切分成 N 段，且每一段都命中同一条 enabled 条目**，
 * 才算命中。这样 `mkdir -p a && rm -rf b` 不会因为「以 mkdir 开头」被放行。
 *
 * 切不开（含换行 / 重定向 / 命令替换 / 引号不闭合 / 空段）→ 一律不命中（fail-closed）。
 *
 * @param {unknown} command
 * @param {unknown} allowlist
 * @returns {{hit: string}|null} 命中返回 `{hit: pattern}`，否则 null
 */
export function matchAllowlist(command, allowlist) {
  try {
    if (typeof command !== "string" || command.length === 0) return null;
    if (!Array.isArray(allowlist)) return null;
    const split = splitSegments(command);
    if (!split || split.ok !== true || !Array.isArray(split.segments) || split.segments.length === 0) {
      return null;
    }
    for (const entry of allowlist) {
      if (!isValidAllowlistEntry(entry)) continue;
      if (entry.enabled !== true) continue;
      const pattern = entry.pattern.trim();
      if (pattern.length === 0) continue;
      let allHit = true;
      for (const segment of split.segments) {
        if (!segmentMatches(segment, pattern, entry.mode)) {
          allHit = false;
          break;
        }
      }
      if (allHit) return { hit: pattern };
    }
    return null;
  } catch {
    return null;
  }
}

/** 单段匹配：exact 比整段 trim 后相等；prefix 比开头 + 词边界。 */
function segmentMatches(segment, pattern, mode) {
  const text = segment.trim();
  if (text.length === 0) return false;
  if (mode === "exact") return text === pattern;
  if (!text.startsWith(pattern)) return false;
  const rest = text.slice(pattern.length);
  return rest.length === 0 || /^\s/.test(rest);
}
