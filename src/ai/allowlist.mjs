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
 * @param {unknown} command
 * @param {unknown} allowlist
 * @returns {{hit: string}|null} 命中返回 `{hit: pattern}`，否则 null
 */
export function matchAllowlist(command, allowlist) {
  try {
    if (typeof command !== "string" || command.length === 0) return null;
    if (!Array.isArray(allowlist)) return null;
    const target = command;
    for (const entry of allowlist) {
      if (!isValidAllowlistEntry(entry)) continue;
      if (entry.enabled !== true) continue;
      const pattern = entry.pattern.trim();
      if (pattern.length === 0) continue;
      if (entry.mode === "exact") {
        if (target.trim() === pattern) return { hit: pattern };
        continue;
      }
      // prefix
      if (!target.startsWith(pattern)) continue;
      const rest = target.slice(pattern.length);
      if (rest.length === 0 || /^\s/.test(rest)) return { hit: pattern };
    }
    return null;
  } catch {
    return null;
  }
}
