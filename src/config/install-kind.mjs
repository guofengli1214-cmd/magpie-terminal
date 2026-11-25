// 本插件是怎么装进 magpie 的：本地目录 / 版本包（registry）/ 判断不了。
//
// 为什么需要它（TASK-FIX17-G R1）：
//   `magpie plugin update` 只对**带版本的 spec** 重新解析；本机把插件以裸路径
//   （`C:\Users\41807\magpie-terminal`）挂在 `~/.config/magpie/plugins.json` 里，
//   这种 spec 原地不动，所以「装完就不管」的用户永远收不到更新。设置页必须能
//   说清「你这份是怎么装的」，否则「如何更新」的说明会指错路。
//
// 三条硬约束：
//   1. 只读。绝不写 magpie 的 plugins.json（那是宿主的文件）。
//   2. 永不抛。文件缺失 / 不是 JSON / 结构不对 → 一律 `unknown`。
//   3. 路径可注入。测试用 `MAGPIE_PLUGINS_PATH`（或显式传 `pluginsPath`）
//      指到临时文件，绝不读写真实的 `~/.config/magpie/plugins.json`。
//
// 判定是启发式的（PRD 已承认「无法 100% 判定」）：
//   1. spec 是绝对路径（盘符 / `/` / `\\` 开头）且解析后等于本插件根目录 → local-path
//   2. spec 带 `@版本` 且包名是本插件 → registry
//   3. 文件里只有一条 spec 时，按这条 spec 的形状判定（临时测试夹具通常如此）
//   4. 文件里只有一条裸路径 spec（其它都是 registry）时，把它当作本插件 → local-path
//   5. 其余（找不到 / 多条冲突）→ unknown

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 环境变量覆盖路径：只给测试与探针用，生产不设。 */
export const PLUGINS_PATH_ENV = "MAGPIE_PLUGINS_PATH";

/** 三种安装方式（顺序即 UI 里的优先级，不要随意改）。 */
export const INSTALL_KINDS = Object.freeze(["local-path", "registry", "unknown"]);

/** 本插件的包名（package.json 的 name）。 */
export const DEFAULT_PLUGIN_NAME = "magpie-terminal";

/** 仓库根目录（本文件在 <root>/src/config/ 下）。 */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * magpie 的 plugins.json 绝对路径。
 * @returns {string}
 */
export function pluginsPath() {
  const override = process.env[PLUGINS_PATH_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".config", "magpie", "plugins.json");
}

/**
 * spec 是不是「裸路径」。盘符（`C:\` / `C:/`）、`/`、`\\`（UNC）都算。
 * @param {unknown} spec
 * @returns {boolean}
 */
export function isLocalPathSpec(spec) {
  if (typeof spec !== "string") return false;
  return /^(?:[A-Za-z]:[\\/]|[/\\])/.test(spec.trim());
}

/**
 * 拆 npm spec：`@scope/name@^1.2.3` → `{name:"@scope/name", range:"^1.2.3", hasVersion:true}`。
 * 只用于判定「带不带版本」，不做完整的 npm 语义解析。
 * @param {unknown} spec
 * @returns {{name:string, range:string, hasVersion:boolean}|null}
 */
export function splitSpec(spec) {
  if (typeof spec !== "string") return null;
  const text = spec.trim();
  if (text.length === 0) return null;
  const at = text.lastIndexOf("@");
  // at === 0 是 scoped 包的前导 `@`，不是版本分隔符；at 在末尾也不是有效版本。
  const hasVersion = at > 0 && at < text.length - 1;
  return {
    name: hasVersion ? text.slice(0, at) : text,
    range: hasVersion ? text.slice(at + 1) : "",
    hasVersion,
  };
}

/** Windows 路径大小写不敏感；比较前统一 resolve + lower-case。 */
function comparablePath(value) {
  return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
}

/**
 * 从 plugins.json 的条目数组里判定本插件的安装方式（纯函数，方便表驱动单测）。
 *
 * @param {unknown} entries `data.plugins` 或整个数组
 * @param {{pluginRoot?:string, pluginName?:string}} [options]
 * @returns {"local-path"|"registry"|"unknown"}
 */
export function resolveInstallKindFromPlugins(entries, options = {}) {
  if (!Array.isArray(entries)) return "unknown";
  const pluginRoot = typeof options.pluginRoot === "string" ? options.pluginRoot : PLUGIN_ROOT;
  const pluginName = typeof options.pluginName === "string" ? options.pluginName : DEFAULT_PLUGIN_NAME;

  const candidates = entries
    .map((entry) => (typeof entry === "string" ? { spec: entry } : entry))
    .filter((entry) => entry && typeof entry.spec === "string" && entry.spec.trim().length > 0)
    .map((entry) => entry.spec.trim());
  if (candidates.length === 0) return "unknown";

  let wantedRoot;
  try {
    wantedRoot = comparablePath(pluginRoot);
  } catch {
    return "unknown";
  }

  // 1) 精确匹配：裸路径等于本插件根目录。
  for (const spec of candidates) {
    if (!isLocalPathSpec(spec)) continue;
    try {
      if (comparablePath(spec) === wantedRoot) return "local-path";
    } catch {
      // 路径解析失败（非法字符等）→ 换下一条。
    }
  }

  // 2) 精确匹配：带版本的本插件包名。
  // 允许 `magpie-terminal@latest` 与 `@scope/magpie-terminal@latest`：
  // 后者是将来发布到市场的常见形态，按最后一段包名匹配。
  for (const spec of candidates) {
    if (isLocalPathSpec(spec)) continue;
    const parsed = splitSpec(spec);
    if (!parsed || !parsed.hasVersion) continue;
    if (parsed.name === pluginName || parsed.name.endsWith(`/${pluginName}`)) return "registry";
  }

  // 3) 唯一候选的回退：测试夹具 / 新装环境里 plugins.json 可能只有一条。
  //    这时没有「和谁冲突」的问题，按形状判定比 unknown 更有用。
  if (candidates.length === 1) {
    const only = candidates[0];
    if (isLocalPathSpec(only)) return "local-path";
    const parsed = splitSpec(only);
    if (parsed && parsed.hasVersion) return "registry";
    return "unknown";
  }

  // 4) 本插件是文件里唯一的裸路径安装（其它都是 registry）→ 多半就是它。
  const localSpecs = candidates.filter((spec) => isLocalPathSpec(spec));
  if (localSpecs.length === 1) return "local-path";

  return "unknown";
}

/**
 * 读 plugins.json 判定本插件的安装方式。**只读、永不抛。**
 *
 * @param {{pluginsPath?:string, pluginRoot?:string, pluginName?:string}} [options]
 *   `pluginsPath` 显式覆盖路径（优先于 `MAGPIE_PLUGINS_PATH`），测试只传临时文件。
 * @returns {Promise<"local-path"|"registry"|"unknown">}
 */
export async function detectInstallKind(options = {}) {
  let file;
  try {
    file = options.pluginsPath
      ? path.resolve(String(options.pluginsPath))
      : pluginsPath();
  } catch {
    return "unknown";
  }

  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return "unknown";
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return "unknown";
  }

  const entries = Array.isArray(data)
    ? data
    : data && Array.isArray(data.plugins)
      ? data.plugins
      : null;
  if (!entries) return "unknown";

  return resolveInstallKindFromPlugins(entries, options);
}
