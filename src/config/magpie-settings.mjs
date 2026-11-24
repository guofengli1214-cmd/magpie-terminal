// 只读 magpie 自己的设置：~/.config/magpie/settings.json（theme / accent / textSize / lang）。
//
// 为什么需要它（TASK-FIX17-B R1）：
//   带路页（page/boot.js）在 sandbox iframe 里能读 window.magpie，但**跳转后**
//   应用页（我们自己 3480 发出的页面）读不到 bridge —— window.magpie 是 undefined。
//   所以「运行中 magpie 换了主题，插件页面跟着变」不可能靠 bridge，只能由服务端
//   去读 magpie 的落盘设置。这份文件就是那条只读通道。
//
// 三条硬约束：
//   1. 只读。绝不写 magpie 的配置（那是宿主的文件）。
//   2. 永不抛。文件缺失 / 不是 JSON / 字段类型不对 → 一律回落默认值。
//      magpie 没装、或用的是便携版设置路径，插件也必须能跑。
//   3. 路径可注入。测试用 MAGPIE_SETTINGS_PATH 指到临时文件，模块级缓存
//      按「真实路径」区分，两次测试不会互相污染（同 store.mjs 的做法）。
//
// 缓存策略：按 mtimeMs + size 判断是否重读。magpie 改设置时是原子替换
// （临时文件 + rename），mtime 一定变；文件消失时缓存作废，回落默认值。

import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 环境变量覆盖路径：只给测试与探针用，生产不设。 */
export const SETTINGS_PATH_ENV = "MAGPIE_SETTINGS_PATH";

/** theme 的三个合法取值（magpie 设置里的 `theme`）。 */
export const THEME_MODES = Object.freeze(["system", "light", "dark"]);

/** textSize 的合法区间（百分比）。超出按边界夹住，不是丢弃。 */
export const TEXT_SIZE_MIN = 80;
export const TEXT_SIZE_MAX = 160;

/** 未设 / 读不到时的值：对齐全仓库「跟随系统」的既有行为。 */
export const DEFAULT_MAGPIE_SETTINGS = Object.freeze({
  theme: "system",
  accent: null,
  textSize: 100,
  lang: "system",
});

/**
 * magpie 设置文件绝对路径。
 * @returns {string}
 */
export function magpieSettingsPath() {
  const override = process.env[SETTINGS_PATH_ENV];
  if (typeof override === "string" && override.trim().length > 0) return path.resolve(override.trim());
  return path.join(os.homedir(), ".config", "magpie", "settings.json");
}

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`；也接受 `rgb()/rgba()/hsl()/hsla()`。 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%°,\s/]+\)$/;

/**
 * 归一 accent 值。非法、空白、过长 → null（调用方用 tokens.css 的兜底）。
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeAccent(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 64) return null;
  if (HEX_COLOR.test(text)) return text;
  if (FUNC_COLOR.test(text)) return text;
  return null;
}

/**
 * 归一整份设置。永远返回一个可直接用的对象。
 * @param {unknown} raw
 * @returns {{theme:string, accent:string|null, textSize:number, lang:string}}
 */
export function normalizeMagpieSettings(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const theme = typeof source.theme === "string" ? source.theme.trim().toLowerCase() : "";
  // 注意：`Number(null)` 是 0、`Number("")` 也是 0，两者都会被夹到 80，
  // 而不是回落 100 —— 那不是「用户设了 0%」，是「没设」。所以先判原始类型。
  const hasTextSize = typeof source.textSize === "number" ||
    (typeof source.textSize === "string" && source.textSize.trim() !== "");
  const textSizeRaw = hasTextSize ? Number(source.textSize) : Number.NaN;
  const textSize = Number.isFinite(textSizeRaw)
    ? Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, Math.round(textSizeRaw)))
    : DEFAULT_MAGPIE_SETTINGS.textSize;
  const lang = typeof source.lang === "string" && source.lang.trim() ? source.lang.trim().slice(0, 32) : DEFAULT_MAGPIE_SETTINGS.lang;
  return {
    theme: THEME_MODES.includes(theme) ? theme : DEFAULT_MAGPIE_SETTINGS.theme,
    accent: normalizeAccent(source.accent),
    textSize,
    lang,
  };
}

/**
 * 进程内缓存的读取。键是文件的绝对路径。
 *
 * @typedef {{mtimeMs:number, size:number, value:object, ok:boolean, reason:string|null}} CacheEntry
 * @type {Map<string, CacheEntry>}
 */
const cache = new Map();

/**
 * 读一份（已归一化的）magpie 设置。
 *
 * @returns {Promise<{ok:boolean, reason:string|null, settings:object, path:string}>}
 *   ok=false 表示读不到 / 坏文件，settings 仍是可用默认值（reason: missing | corrupt | unreadable）。
 */
export async function readMagpieSettings() {
  const file = magpieSettingsPath();
  let info;
  try {
    info = await stat(file);
  } catch (err) {
    cache.delete(file);
    return {
      ok: false,
      reason: err && err.code === "ENOENT" ? "missing" : "unreadable",
      settings: { ...DEFAULT_MAGPIE_SETTINGS },
      path: file,
      mtimeMs: null,
    };
  }

  const cached = cache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return { ok: cached.ok, reason: cached.reason, settings: cached.value, path: file, mtimeMs: info.mtimeMs };
  }

  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    cache.delete(file);
    return { ok: false, reason: "unreadable", settings: { ...DEFAULT_MAGPIE_SETTINGS }, path: file, mtimeMs: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const value = { ...DEFAULT_MAGPIE_SETTINGS };
    cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, value, ok: false, reason: "corrupt" });
    return { ok: false, reason: "corrupt", settings: value, path: file, mtimeMs: info.mtimeMs };
  }

  const value = normalizeMagpieSettings(parsed);
  cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, value, ok: true, reason: null });
  return { ok: true, reason: null, settings: value, path: file, mtimeMs: info.mtimeMs };
}

/** 清缓存：只给测试用。 */
export function clearMagpieSettingsCache() {
  cache.clear();
}
