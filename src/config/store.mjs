// 用户配置的落盘层：~/.config/magpie-terminal/config.json
//
// 规则（TASK-V2-A §2.3）：
// - 目录 700、文件 600；
// - 写入用「临时文件 + rename」原子替换；
// - 文件不存在 / 损坏 → 返回默认值，不抛错；
// - 读-改-写：未知字段原样保留（下一张卡要往里加 hosts）。
//
// 本模块只做「形状合法」的事，不做业务校验（例如 model 是否在网关清单里）：
// 那需要网络，归 src/server/http.mjs 的路由处理。
//
// 路径用 `configPath()` 现算而不是模块级常量：测试通过
// MAGPIE_TERMINAL_CONFIG_PATH 指到临时目录，模块级缓存会让两次测试互相污染。

import crypto from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BUILTIN_ALLOWLIST, builtinRulesFrom } from "../policy/allowlist.mjs";

/** 环境变量覆盖路径：只给测试用，生产不设。 */
export const CONFIG_PATH_ENV = "MAGPIE_TERMINAL_CONFIG_PATH";

/**
 * 已知字段（`updateConfig` 的补丁白名单 + `PUT /api/config` 的字段白名单）。
 *
 * TASK-V3-D 按 docs/PROTOCOL-AGENT.md §1 从 `["model"]` 扩成五项：
 * `hosts` 仍然不从这里走，它由下面的 `addHost/updateHost/removeHost` 直接
 * 读-改-写整份配置（未知字段本来就是原样保留的，所以两者不会互相踩）。
 *
 * 老配置里的「本机默认 shell」字段现在被静默忽略（未知字段原样保留，不报错）。
 */
export const KNOWN_FIELDS = Object.freeze([
  "model",
  "autonomy",
  "allowlist",
  "reviewModel",
  "basePrompt",
  // TASK-V4-H §6：确认卡上常显 AI 的效果评估（默认关）。
  "showApprovalEffect",
  // TASK-FIX17-L1 R1：下载 / 导出目录（绝对路径；null = 用浏览器默认下载）。
  "downloadDir",
  // TASK-FIX17-L4 R1：对话 / 审阅模型的推理强度（null = 不指定，网关用自身默认）。
  "conversationReasoning",
  "reviewReasoning",
  // TASK-FIX17-I R1：内置只读白名单（用户可增/删/改；缺字段 = 用默认清单）。
  "builtinAllowlist",
]);

/**
 * 推理强度档位（TASK-FIX17-L4 R1）。
 *
 * 与网关 `reasoning_effort` 的合法值逐字一致（实测：别的值一律 400，
 * 错误串里会列出这六个）。`null` 表示「不指定」，此时请求体里**不出现**该键。
 * 冻结数组：调用方只读，避免某处 push 把校验面改掉。
 */
export const REASONING_LEVELS = Object.freeze(["off", "low", "medium", "high", "xhigh", "max"]);

/** 自动执行档位（PROTOCOL §1）。 */
export const AUTONOMY_LEVELS = Object.freeze(["strict", "balanced", "loose"]);

/** 白名单上限（PROTOCOL §1）。 */
export const ALLOWLIST_MAX_ENTRIES = 200;
/** 单条 pattern 长度上限（PROTOCOL §1）。 */
export const ALLOWLIST_PATTERN_MAX = 500;
/** reviewModel 长度上限（PROTOCOL §1）。 */
export const REVIEW_MODEL_MAX = 200;
/** basePrompt 长度上限（PROTOCOL §1）。 */
export const BASE_PROMPT_MAX = 8000;

/**
 * 下载目录长度上限（TASK-FIX17-L1 R1）。
 *
 * 512 与 `ALLOWLIST_PATTERN_MAX` 同级：Windows 上 MAX_PATH 是 260，长路径前缀
 * `\\?\` 下能到 32767，但 512 已经覆盖任何真实下载目录，再长只会是粘贴事故。
 */
export const DOWNLOAD_DIR_MAX = 512;

/**
 * 内置只读白名单的条数 / 单条长度上限（TASK-FIX17-I R1）。
 *
 * 300 而不是 `ALLOWLIST_MAX_ENTRIES`（200）：内置清单本身就是 60+ 条
 * （23 个命令头 + 40 个只读子命令），再给用户留出扩充余地。
 * 64 是单条上限：最长的默认项 `docker container ls` 才 19 个字符。
 */
export const BUILTIN_ALLOWLIST_MAX_ENTRIES = 300;
export const BUILTIN_ALLOWLIST_ENTRY_MAX = 64;

/** 主机认证方式（TASK-V2-B §2.2）。 */
export const AUTH_TYPES = Object.freeze(["password", "privateKey"]);

/** 与本模块同目录的状态文件名（全部在 .gitignore 里）。 */
export const SECRETS_FILE = "secrets.json";
export const SECRETS_KEY_FILE = "secrets.key";
export const KNOWN_HOSTS_FILE = "known_hosts.json";

/** 文件不存在 / 损坏时返回的值。调用方可以再与网关清单求默认。 */
export const DEFAULT_CONFIG = Object.freeze({
  model: null,
  autonomy: "balanced",
  allowlist: [],
  reviewModel: null,
  basePrompt: null,
  // TASK-V4-H §6：确认卡上是否常显「执行后会发生什么」，默认关。
  showApprovalEffect: false,
  // TASK-FIX17-L1 R1：null = 未设置 → 下载/导出回落浏览器默认目录。
  downloadDir: null,
  // TASK-FIX17-L4 R1：null = 不指定，交给网关自己的默认强度（不要默认 medium：
  // 不同模型对 medium 的解释并不一致）。
  conversationReasoning: null,
  reviewReasoning: null,
  // TASK-FIX17-I R1：默认 = 内置清单（`DEFAULT_BUILTIN_ALLOWLIST` 是唯一数据源）。
  builtinAllowlist: DEFAULT_BUILTIN_ALLOWLIST,
});

/**
 * 配置文件绝对路径。
 * @returns {string}
 */
export function configPath() {
  const override = process.env[CONFIG_PATH_ENV];
  if (typeof override === "string" && override.trim().length > 0) return path.resolve(override.trim());
  return path.join(os.homedir(), ".config", "magpie-terminal", "config.json");
}

/**
 * 状态目录：config.json 所在目录。
 * 凭据与 known_hosts 都放这里，而不是各自再算一次 `~/.config/...`：
 * 测试用 MAGPIE_TERMINAL_CONFIG_PATH 指到临时目录时，三个文件必须一起跟着走。
 * @returns {string}
 */
export function stateDir() {
  return path.dirname(configPath());
}

/** @returns {string} secrets.json（AES-256-GCM 密文） */
export function secretsPath() {
  return path.join(stateDir(), SECRETS_FILE);
}

/** @returns {string} secrets.key（32 字节随机密钥，600） */
export function secretsKeyPath() {
  return path.join(stateDir(), SECRETS_KEY_FILE);
}

/** @returns {string} known_hosts.json（host:port -> {algo, fingerprint}） */
export function knownHostsPath() {
  return path.join(stateDir(), KNOWN_HOSTS_FILE);
}

/**
 * 读配置。永远返回一个对象：文件不存在 / 内容不是 JSON / 不是对象 → 返回
 * `{...DEFAULT_CONFIG}`，并把 `corrupt: true` 之类的东西只留在返回值之外（不落盘）。
 *
 * @returns {Promise<{ok:boolean, config:object, reason:string|null}>}
 *   ok=false 表示读不到（不存在或损坏），config 仍是可用的默认值。
 */
export async function readConfig() {
  const file = configPath();
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const reason = err && err.code === "ENOENT" ? "missing" : "unreadable";
    return { ok: false, reason, config: { ...DEFAULT_CONFIG } };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt", config: { ...DEFAULT_CONFIG } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "corrupt", config: { ...DEFAULT_CONFIG } };
  }
  return { ok: true, reason: null, config: { ...parsed } };
}

/** 原子写任意 JSON 文件：目录 700 → 临时文件 600 → rename。 */
async function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return value;
}

/** 读 JSON 文件；不存在 / 损坏 / 形状不对 → null。永不抛。 */
async function readJsonMaybe(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * 归一化下载目录（TASK-FIX17-L1 R1）：trim → 空白变 null → 去尾随分隔符。
 *
 * 保留 `\` 原样（Windows 路径要能直接交给 explorer），盘根 `C:\` 与 POSIX 根 `/`
 * 末尾的分隔符**不**去掉（去掉就成了 `C:` = 当前盘当前目录，语义完全变了）。
 * 相对路径一律 null：调用方（validate）负责报错，这里只做「能不能用」的判断。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeDownloadDir(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (text.length === 0) return null;
  if (text.length > DOWNLOAD_DIR_MAX) return null;
  if (!path.isAbsolute(text)) return null;
  if (/^[A-Za-z]:[\\/]$/.test(text)) return text; // C:\ / C:/
  if (text === "/" || text === "\\") return text;
  text = text.replace(/[\\/]+$/, "");
  // `C:\\` 去尾后是 `C:`：补回分隔符，绝不能把盘根写成当前盘当前目录。
  if (/^[A-Za-z]:$/.test(text)) return `${text}\\`;
  return text.length > 0 ? text : null;
}

/**
 * 「没设目录时」的默认建议值（GET /api/config 的 `downloadDirDefault`）。
 *
 * 用 `os.homedir()` 现算，**不写死用户名**：换机器 / 换账户后仍然是本机的
 * `<家目录>\Downloads\magpie-terminal`。
 *
 * @returns {string}
 */
export function defaultDownloadDir() {
  return path.join(os.homedir(), "Downloads", "magpie-terminal");
}

/** 白名单条目是否合法（PROTOCOL §1）。非法条目整份白名单都算非法。 */
export function isValidAllowlistEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (typeof entry.pattern !== "string") return false;
  if (entry.pattern.length < 1 || entry.pattern.length > ALLOWLIST_PATTERN_MAX) return false;
  if (/[\r\n]/.test(entry.pattern)) return false;
  if (entry.mode !== "prefix" && entry.mode !== "exact") return false;
  if (typeof entry.enabled !== "boolean") return false;
  return true;
}

/**
 * 内置白名单里单个 token 的允许字符集（TASK-FIX17-I R1）。
 *
 * 故意不含引号 / 反引号 / `$` / `|` / `&` / `;` / `>` / `<` / `(){}[]*?!~`：
 * 这些是 shell 元字符，一旦允许就能写出「看起来是只读命令、实际是另一条命令」的条目。
 * `.` `:` `+` `/` `@` `-` `_` 是为真实命令名留的（`node -v`、`npm -v`、
 * `docker compose ps`、`/usr/bin/ls`、`user@host`）。
 */
const BUILTIN_ALLOWLIST_TOKEN_RE = /^[A-Za-z0-9_.:+/@-]+$/;
/** 一条规则最多几段（`docker container ls` = 3 段）。 */
const BUILTIN_ALLOWLIST_SEGMENT_MAX = 3;

/**
 * 校验内置白名单的**单条**规则（TASK-FIX17-I R1）。
 *
 * @param {unknown} entry
 * @returns {{ok:true, text:string} | {ok:false, userText:string}}
 */
export function checkBuiltinAllowlistEntry(entry) {
  if (typeof entry !== "string") {
    return { ok: false, userText: "每条规则都必须是一段文本（例如 free 或 docker volume ls）。" };
  }
  const text = entry.trim();
  if (text.length === 0) {
    return { ok: false, userText: "规则不能是空的。" };
  }
  if (text.length > BUILTIN_ALLOWLIST_ENTRY_MAX) {
    return {
      ok: false,
      userText: `每条规则最长 ${BUILTIN_ALLOWLIST_ENTRY_MAX} 个字符（这条 ${text.length} 个）。`,
    };
  }
  // 控制字符先单拎：制表符 / 换行会同时破坏“单词间单空格”与「一条规则一行」的 UI。
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    return { ok: false, userText: "规则里不能混入换行、制表符或其它控制字符。" };
  }
  if (/\s{2,}/.test(text)) {
    return { ok: false, userText: "单词之间只能有一个空格。" };
  }
  const parts = text.split(" ");
  if (parts.length > BUILTIN_ALLOWLIST_SEGMENT_MAX) {
    return {
      ok: false,
      userText: `一条规则最多 ${BUILTIN_ALLOWLIST_SEGMENT_MAX} 段（命令头 + 最多两个只读子命令词）。`,
    };
  }
  for (const part of parts) {
    if (!BUILTIN_ALLOWLIST_TOKEN_RE.test(part)) {
      return {
        ok: false,
        userText: `「${part}」里有不允许的字符：只能使用字母、数字和 _ . : + / @ -。`,
      };
    }
  }
  return { ok: true, text };
}

/**
 * 归一化内部内置白名单（TASK-FIX17-I R1）：返回值总是合法数组（可能是空数组）。
 *
 * - 非数组 / 缺失 → 默认清单（老配置自然升级，不需要版本迁移）；
 * - 数组 → 逐条过 `checkBuiltinAllowlistEntry`，非法条目**丢掉**（fail-closed：
 *   少一条放行只会多一次确认，绝不会多放行），去重保留首次出现，超 300 条截断；
 * - `[]` 仍是 `[]`（用户把自动放行清单清空了）。
 *
 * 这里与 `validateConfigPatch` 是两道关：手改 config.json 写进非法值时，
 * 读到内存里的值也必须是合法的（否则设置页会把非法值又写回去）。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeBuiltinAllowlist(value) {
  if (!Array.isArray(value)) return [...DEFAULT_BUILTIN_ALLOWLIST];
  const out = [];
  for (const entry of value) {
    const checked = checkBuiltinAllowlistEntry(entry);
    if (!checked.ok) continue;
    if (out.includes(checked.text)) continue;
    out.push(checked.text);
    if (out.length >= BUILTIN_ALLOWLIST_MAX_ENTRIES) break;
  }
  return out;
}

/**
 * 校验 `PUT /api/config` 里的 `builtinAllowlist`（TASK-FIX17-I R1）。
 *
 * 与「静默丢弃」相反：任何一条非法就整份拒绞（`INVALID_BUILTIN_ALLOWLIST` +
 * 人话 userText，带上是第几条），让用户知道自己的输入没存上。
 * 完全重复的条目不是错误（保留首次出现，其余去掉）。
 *
 * @param {unknown} value
 * @returns {{ok:true, list:string[]} | {ok:false, code:string, userText:string}}
 */
export function validateBuiltinAllowlist(value) {
  if (!Array.isArray(value)) {
    return { ok: false, code: "INVALID_BUILTIN_ALLOWLIST", userText: "内置白名单必须是一个字符串数组。" };
  }
  if (value.length > BUILTIN_ALLOWLIST_MAX_ENTRIES) {
    return {
      ok: false,
      code: "INVALID_BUILTIN_ALLOWLIST",
      userText: `内置白名单最多 ${BUILTIN_ALLOWLIST_MAX_ENTRIES} 条（现在 ${value.length} 条）。`,
    };
  }
  const list = [];
  for (let index = 0; index < value.length; index += 1) {
    const checked = checkBuiltinAllowlistEntry(value[index]);
    if (!checked.ok) {
      return {
        ok: false,
        code: "INVALID_BUILTIN_ALLOWLIST",
        userText: `第 ${index + 1} 条内置白名单不合法：${checked.userText}`,
      };
    }
    if (list.includes(checked.text)) continue;
    list.push(checked.text);
  }
  return { ok: true, list };
}

/**
 * 校验一份 `PUT /api/config` 的补丁（PROTOCOL §1）。
 *
 * 只校验 patch 里出现过的字段；返回第一个错误码，没有错误返回 null。
 * 错误码：INVALID_AUTONOMY / INVALID_ALLOWLIST / INVALID_REVIEW_MODEL / INVALID_BASE_PROMPT。
 *
 * @param {object} patch
 * @returns {{code:string, userText:string}|null}
 */
export function validateConfigPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
  const has = (field) => Object.prototype.hasOwnProperty.call(patch, field);

  if (has("autonomy")) {
    if (!AUTONOMY_LEVELS.includes(patch.autonomy)) {
      return {
        code: "INVALID_AUTONOMY",
        userText: "autonomy 必须是 strict / balanced / loose 之一。",
      };
    }
  }

  if (has("allowlist")) {
    const list = patch.allowlist;
    if (!Array.isArray(list) || list.length > ALLOWLIST_MAX_ENTRIES) {
      return {
        code: "INVALID_ALLOWLIST",
        userText: `allowlist 必须是数组且不超过 ${ALLOWLIST_MAX_ENTRIES} 条。`,
      };
    }
    for (const entry of list) {
      if (!isValidAllowlistEntry(entry)) {
        return {
          code: "INVALID_ALLOWLIST",
          userText: `allowlist 每条都需要 1-${ALLOWLIST_PATTERN_MAX} 字符的 pattern（不含换行）、mode=prefix|exact、enabled=true|false。`,
        };
      }
    }
  }

  if (has("reviewModel")) {
    const value = patch.reviewModel;
    if (value !== null && typeof value !== "string") {
      return { code: "INVALID_REVIEW_MODEL", userText: "reviewModel 必须是字符串或 null。" };
    }
    if (typeof value === "string" && value.length > REVIEW_MODEL_MAX) {
      return {
        code: "INVALID_REVIEW_MODEL",
        userText: `reviewModel 长度不能超过 ${REVIEW_MODEL_MAX}。`,
      };
    }
  }

  if (has("basePrompt")) {
    const value = patch.basePrompt;
    if (value !== null && typeof value !== "string") {
      return { code: "INVALID_BASE_PROMPT", userText: "basePrompt 必须是字符串或 null。" };
    }
    if (typeof value === "string" && value.length > BASE_PROMPT_MAX) {
      return { code: "INVALID_BASE_PROMPT", userText: `basePrompt 长度不能超过 ${BASE_PROMPT_MAX}。` };
    }
  }

  // TASK-FIX17-L1 R1：downloadDir 只收绝对路径或 null。
  // 空串 / 纯空白**不是**错误（设置页清空输入框就是它），归一化成 null。
  if (has("downloadDir")) {
    const value = patch.downloadDir;
    if (value !== null && typeof value !== "string") {
      return { code: "INVALID_DOWNLOAD_DIR", userText: "下载目录必须是绝对路径或者留空。" };
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (text.length > DOWNLOAD_DIR_MAX) {
        return {
          code: "INVALID_DOWNLOAD_DIR",
          userText: `下载目录最长 ${DOWNLOAD_DIR_MAX} 个字符（当前 ${text.length} 个）。`,
        };
      }
      // 非空但不是绝对路径 → 400（空串/空白在上一条已经放行，会归一成 null）。
      if (text.length > 0 && !path.isAbsolute(text)) {
        return { code: "INVALID_DOWNLOAD_DIR", userText: "下载目录必须是绝对路径或者留空。" };
      }
    }
  }

  // TASK-FIX17-L4 R1：推理强度只收固定枚举或 null。
  // 空串 / 纯空白**不是**错误（设置页首项「默认」与抽屉里的空 value 都是它），
  // 由 normalize 归一成 null（= 不传 reasoning_effort）。
  for (const field of ["conversationReasoning", "reviewReasoning"]) {
    if (!has(field)) continue;
    const value = patch[field];
    if (value === null) continue;
    if (typeof value !== "string") {
      return {
        code: "INVALID_REASONING_LEVEL",
        userText: `推理强度必须是 ${REASONING_LEVELS.join(" / ")} 之一，或者留空（用网关默认）。`,
      };
    }
    const text = value.trim();
    if (text.length > 0 && !REASONING_LEVELS.includes(text)) {
      return {
        code: "INVALID_REASONING_LEVEL",
        userText: `推理强度必须是 ${REASONING_LEVELS.join(" / ")} 之一，或者留空（用网关默认）。`,
      };
    }
  }

  // TASK-FIX17-I R1：内置只读白名单（用户可增/删/改）。
  // 空数组合法（= 所有命令都要确认）；非法条目整份拒绞，不静默丢弃。
  if (has("builtinAllowlist")) {
    const checked = validateBuiltinAllowlist(patch.builtinAllowlist);
    if (!checked.ok) return { code: checked.code, userText: checked.userText };
  }

  // TASK-V4-H §6：boolean，非法类型 400 INVALID_SHOW_EFFECT。
  if (has("showApprovalEffect")) {
    if (typeof patch.showApprovalEffect !== "boolean") {
      return { code: "INVALID_SHOW_EFFECT", userText: "showApprovalEffect 必须是 true 或 false。" };
    }
  }

  return null;
}

/** 只挑已知字段做类型归一；其余字段原样保留，不做断言。非法值一律回落默认，不抛错。 */
function normalize(config) {
  const next = { ...config };
  if (typeof next.model !== "string" || next.model.trim().length === 0) next.model = null;
  else next.model = next.model.trim();

  if (!AUTONOMY_LEVELS.includes(next.autonomy)) next.autonomy = DEFAULT_CONFIG.autonomy;

  if (!Array.isArray(next.allowlist)) {
    next.allowlist = [];
  } else {
    next.allowlist = next.allowlist
      .filter((entry) => isValidAllowlistEntry(entry))
      .slice(0, ALLOWLIST_MAX_ENTRIES)
      .map((entry) => ({ pattern: entry.pattern, mode: entry.mode, enabled: entry.enabled }));
  }

  if (next.reviewModel === null || next.reviewModel === undefined) {
    next.reviewModel = null;
  } else if (typeof next.reviewModel !== "string" || next.reviewModel.length > REVIEW_MODEL_MAX) {
    next.reviewModel = null;
  }

  if (next.basePrompt === null || next.basePrompt === undefined) {
    next.basePrompt = null;
  } else if (typeof next.basePrompt !== "string" || next.basePrompt.length > BASE_PROMPT_MAX) {
    next.basePrompt = null;
  }

  // showApprovalEffect：非 boolean 一律回落 false（默认关）。
  if (typeof next.showApprovalEffect !== "boolean") next.showApprovalEffect = false;

  // conversationReasoning / reviewReasoning：只保留固定枚举，其余（含 "" / 手改的乱值）
  // 一律回落 null = 不指定。这里与 validateConfigPatch 是两道关：手改 config.json
  // 写进 "turbo" 时，读到内存里的也不能把它发进请求体（网关会 400）。
  for (const field of ["conversationReasoning", "reviewReasoning"]) {
    const value = typeof next[field] === "string" ? next[field].trim() : next[field];
    next[field] = REASONING_LEVELS.includes(value) ? value : null;
  }

  // downloadDir：非法值（相对路径 / 超长 / 非字符串）一律回落 null，不抛错。
  // 这里与 validateConfigPatch 是两道关：手改 config.json 写进相对路径时，
  // 读到内存里的值也必须是「未设置」，不能把相对路径当 cwd 用。
  next.downloadDir = normalizeDownloadDir(next.downloadDir);

  // builtinAllowlist（TASK-FIX17-I R1）：非数组 / 非法条目一律按 fail-closed 处理
  // （缺少 → 默认清单；非法条目 → 丢掉，只会多一次确认，绝不会多放行）。
  next.builtinAllowlist = normalizeBuiltinAllowlist(next.builtinAllowlist);

  return next;
}

/** 对外形态：把内部配置补齐成默认值（GET /api/config 用）。 */
export function publicConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const normalized = normalize({ ...DEFAULT_CONFIG, ...source });
  return {
    model: normalized.model,
    autonomy: normalized.autonomy,
    allowlist: normalized.allowlist,
    reviewModel: normalized.reviewModel,
    basePrompt: normalized.basePrompt,
    showApprovalEffect: normalized.showApprovalEffect === true,
    downloadDir: normalized.downloadDir,
    conversationReasoning: normalized.conversationReasoning,
    reviewReasoning: normalized.reviewReasoning,
    // TASK-FIX17-I R1：内置只读白名单（归一后总是数组；缺字段时是默认清单）。
    builtinAllowlist: normalized.builtinAllowlist,
  };
}

/**
 * 原子写整份配置：临时文件（600）→ rename。目录第一次用时创建（700）。
 *
 * @param {object} config 完整配置对象（调用方负责 read-modify-write 后的合并）
 * @returns {Promise<object>} 实际写入的对象
 */
export async function writeConfig(config) {
  const file = configPath();
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(config, null, 2)}\n`;
  const tmp = path.join(dir, `.config.json.tmp-${process.pid}-${Date.now()}`);
  // mode 600：配置里将来会放主机信息，不给同机其他用户读。
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return config;
}

/**
 * 读-改-写：把 patch 里的已知字段合并进现有文件，未知字段原样保留。
 *
 * `patch` 里不认识的键会被忽略（不是报错）：下一张卡的客户端可能先于
 * 服务端升级，静默丢弃比 500 好。
 *
 * @param {object} patch
 * @returns {Promise<object>} 合并后的完整配置
 */
export async function updateConfig(patch) {
  const { config } = await readConfig();
  const merged = { ...config };
  for (const field of KNOWN_FIELDS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field];
  }
  const next = normalize(merged);
  await writeConfig(next);
  return next;
}

/* ------------------------------------------------------------------ *
 * 主机清单（TASK-V2-B §2.2）
 *
 * 落盘字段与卡片给的结构一致；但 **config.json 里永远不写密码 / 私钥正文 /
 * passphrase**，那些只进 secrets.json 的密文。`hasSecret` 在读取时按「密文能不能
 * 解密」现算：换机器 / 密钥文件丢了 / 密文被改过一个字节，都只表现为 false，
 * 不抛错、不崩服务。
 * ------------------------------------------------------------------ */

/** 生成 `h-1a2b3c` 形式的 id。 */
function newHostId() {
  return `h-${crypto.randomBytes(3).toString("hex")}`;
}

/** 去掉任何凭据字段，只留可展示的元数据。 */
function projectHost(host) {
  const clean = {
    id: host.id,
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    authType: host.authType,
    hasSecret: host.hasSecret === true,
    createdAt: host.createdAt || null,
    lastConnectedAt: host.lastConnectedAt || null,
  };
  if (typeof host.privateKeyPath === "string" && host.privateKeyPath.length > 0) {
    clean.privateKeyPath = host.privateKeyPath;
  }
  if (host.hasInlineKey === true) clean.hasInlineKey = true;
  return clean;
}

async function readHostsRaw() {
  const { config } = await readConfig();
  const hosts = Array.isArray(config.hosts) ? config.hosts : [];
  return hosts.filter((h) => h && typeof h === "object" && typeof h.id === "string");
}

async function writeHostsRaw(hosts) {
  const { config } = await readConfig();
  const next = { ...config, hosts };
  await writeConfig(next);
  return hosts;
}

/**
 * 主机清单（可展示形态）。`hasSecret` 来自「能不能真的解出密文」。
 * @returns {Promise<Array<object>>}
 */
export async function listHosts() {
  const hosts = await readHostsRaw();
  const secrets = await readSecrets();
  return hosts.map((host) =>
    projectHost({ ...host, hasSecret: secrets.ok && secrets.byId.has(host.id) }),
  );
}

/** 单条主机（可展示形态）；不存在返回 null。 */
export async function getHostRecord(id) {
  const hosts = await readHostsRaw();
  const host = hosts.find((h) => h.id === id);
  if (!host) return null;
  const secrets = await readSecrets();
  return projectHost({ ...host, hasSecret: secrets.ok && secrets.byId.has(id) });
}

/**
 * 新增一条主机（元数据）。凭据请随后调用 saveSecret(host.id, …)。
 * @param {object} input 已通过 HTTP 层 zod 校验
 * @returns {Promise<object>} 可展示形态的主机
 */
export async function addHost(input) {
  const hosts = await readHostsRaw();
  const host = {
    id: newHostId(),
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    authType: input.authType,
    hasSecret: false,
    createdAt: new Date().toISOString(),
    lastConnectedAt: null,
  };
  if (input.authType === "privateKey") {
    if (typeof input.privateKeyPath === "string" && input.privateKeyPath.length > 0) {
      host.privateKeyPath = input.privateKeyPath;
    } else {
      host.hasInlineKey = true;
    }
  }
  hosts.push(host);
  await writeHostsRaw(hosts);
  return projectHost(host);
}

/**
 * 改一条主机的元数据。只合并 patch 里出现过的字段；id/createdAt 不可改。
 * @returns {Promise<object|null>} 改完后的可展示形态；主机不存在返回 null
 */
export async function updateHost(id, patch) {
  const hosts = await readHostsRaw();
  const index = hosts.findIndex((h) => h.id === id);
  if (index === -1) return null;
  const current = { ...hosts[index] };
  if (patch && typeof patch === "object") {
    for (const field of ["name", "host", "port", "username", "authType", "privateKeyPath"]) {
      if (patch[field] === undefined) continue;
      current[field] = patch[field];
    }
    // 认证方式切换时清掉另一套的痕迹，避免「密码主机还带 privateKeyPath」。
    if (patch.authType === "password") {
      delete current.privateKeyPath;
      delete current.hasInlineKey;
    } else if (patch.authType === "privateKey") {
      if (typeof patch.privateKeyPath === "string" && patch.privateKeyPath.length > 0) {
        current.privateKeyPath = patch.privateKeyPath;
        delete current.hasInlineKey;
      }
    }
    if (patch.hasInlineKey === true && current.authType === "privateKey") {
      current.hasInlineKey = true;
      delete current.privateKeyPath;
    }
  }
  hosts[index] = current;
  await writeHostsRaw(hosts);
  return projectHost(current);
}

/**
 * 删一条主机（元数据 + 凭据 + known_hosts 那条）。
 * @returns {Promise<object|null>} 被删掉的主机；不存在返回 null
 */
export async function removeHost(id) {
  const hosts = await readHostsRaw();
  const index = hosts.findIndex((h) => h.id === id);
  if (index === -1) return null;
  const [removed] = hosts.splice(index, 1);
  await writeHostsRaw(hosts);
  await deleteSecret(id);
  if (removed && typeof removed.host === "string") {
    await forgetKnownHost(removed.host, removed.port);
  }
  return projectHost(removed);
}

/** 连接成功后盖一个 lastConnectedAt。 */
export async function touchHost(id) {
  const hosts = await readHostsRaw();
  const index = hosts.findIndex((h) => h.id === id);
  if (index === -1) return false;
  hosts[index] = { ...hosts[index], lastConnectedAt: new Date().toISOString() };
  await writeHostsRaw(hosts);
  return true;
}

/* ------------------------------------------------------------------ *
 * 凭据：AES-256-GCM + 独立密钥文件
 * ------------------------------------------------------------------ */

async function readKeyRaw() {
  let buffer;
  try {
    buffer = await readFile(secretsKeyPath());
  } catch {
    return null;
  }
  if (!Buffer.isBuffer(buffer) || buffer.length !== 32) return null;
  return buffer;
}

/** 写凭据时才建密钥；解密路径绝不「顺手重建」（重建等于永久丢掉旧密文）。 */
async function getOrCreateKey() {
  const existing = await readKeyRaw();
  if (existing) return existing;
  const key = crypto.randomBytes(32);
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(secretsKeyPath(), key, { mode: 0o600 });
  return key;
}

function encryptWith(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptWith(key, entry) {
  try {
    const iv = Buffer.from(String(entry.iv), "base64");
    const tag = Buffer.from(String(entry.tag), "base64");
    const data = Buffer.from(String(entry.data), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 读全部凭据并解密。
 *
 * `ok:false` 的四种情况（都不抛错，只表现为「凭据丢失」）：
 * key 文件不存在 / key 长度不对 / secrets.json 损坏 / 某条密文解不开。
 *
 * @returns {Promise<{ok:boolean, reason:string|null, byId:Map<string,object>}>}
 */
export async function readSecrets() {
  const key = await readKeyRaw();
  if (!key) return { ok: false, reason: "key-missing", byId: new Map() };
  const file = await readJsonMaybe(secretsPath());
  if (!file) {
    // 文件不存在 = 还没存过任何凭据，这不算「坏」；存在但读不出来才算。
    const exists = await readFile(secretsPath(), "utf8").then(
      () => true,
      () => false,
    );
    return exists
      ? { ok: false, reason: "corrupt", byId: new Map() }
      : { ok: true, reason: null, byId: new Map() };
  }
  const entries = file.entries && typeof file.entries === "object" ? file.entries : {};
  const byId = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    const plain = decryptWith(key, entry);
    if (typeof plain !== "string") continue;
    let parsed;
    try {
      parsed = JSON.parse(plain);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    byId.set(id, parsed);
  }
  return { ok: true, reason: null, byId };
}

/**
 * 存一条主机的凭据。只接受 whitelist 里的三个字段，空串视为「没给」。
 * @param {string} hostId
 * @param {{password?:string, privateKey?:string, passphrase?:string}} fields
 */
export async function saveSecret(hostId, fields) {
  const key = await getOrCreateKey();
  const file = (await readJsonMaybe(secretsPath())) || { version: 1, entries: {} };
  const entries = file.entries && typeof file.entries === "object" ? { ...file.entries } : {};
  const payload = {};
  for (const field of ["password", "privateKey", "passphrase"]) {
    const value = fields ? fields[field] : undefined;
    if (typeof value === "string" && value.length > 0) payload[field] = value;
  }
  if (Object.keys(payload).length === 0) return false;
  entries[hostId] = encryptWith(key, JSON.stringify(payload));
  await writeJsonAtomic(secretsPath(), { version: file.version || 1, entries });
  return true;
}

/**
 * 取一条主机的凭据（明文，只在服务端内存里用）。解不开 / 不存在 → null。
 * @returns {Promise<{password?:string, privateKey?:string, passphrase?:string}|null>}
 */
export async function readSecret(hostId) {
  const secrets = await readSecrets();
  return secrets.byId.get(hostId) || null;
}

/** 删一条主机的凭据（文件不存在也返回 true，幂等）。 */
export async function deleteSecret(hostId) {
  const file = await readJsonMaybe(secretsPath());
  if (!file) return true;
  const entries = file.entries && typeof file.entries === "object" ? { ...file.entries } : {};
  if (!Object.prototype.hasOwnProperty.call(entries, hostId)) return true;
  delete entries[hostId];
  await writeJsonAtomic(secretsPath(), { version: file.version || 1, entries });
  return true;
}

/* ------------------------------------------------------------------ *
 * known_hosts.json：host:port -> {algo, fingerprint}
 * 指纹是 ssh-keyscan 风格的 base64 摘要（`SHA256:……`），不含私密信息。
 * ------------------------------------------------------------------ */

function knownHostKey(host, port) {
  return `${host}:${port}`;
}

/** @returns {Promise<Record<string,{algo:string,fingerprint:string}>>} */
export async function readKnownHosts() {
  const file = await readJsonMaybe(knownHostsPath());
  if (!file) return {};
  const out = {};
  for (const [key, value] of Object.entries(file)) {
    if (!value || typeof value !== "object") continue;
    if (typeof value.fingerprint !== "string" || value.fingerprint.length === 0) continue;
    out[key] = {
      algo: typeof value.algo === "string" ? value.algo : "unknown",
      fingerprint: value.fingerprint,
    };
  }
  return out;
}

/** @returns {Promise<{algo:string,fingerprint:string}|null>} */
export async function lookupKnownHost(host, port) {
  const all = await readKnownHosts();
  return all[knownHostKey(host, port)] || null;
}

/** 记下一条指纹（用户点了「信任并记住」才会走到这里）。 */
export async function rememberKnownHost(host, port, algo, fingerprint) {
  const all = await readKnownHosts();
  all[knownHostKey(host, port)] = { algo: String(algo), fingerprint: String(fingerprint) };
  await writeJsonAtomic(knownHostsPath(), all);
  return all[knownHostKey(host, port)];
}

/** 删掉一条指纹（删主机时同步）。 */
export async function forgetKnownHost(host, port) {
  const all = await readKnownHosts();
  const key = knownHostKey(host, port);
  if (!Object.prototype.hasOwnProperty.call(all, key)) return false;
  delete all[key];
  await writeJsonAtomic(knownHostsPath(), all);
  return true;
}
