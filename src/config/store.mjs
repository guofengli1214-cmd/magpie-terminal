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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 环境变量覆盖路径：只给测试用，生产不设。 */
export const CONFIG_PATH_ENV = "MAGPIE_TERMINAL_CONFIG_PATH";

/** 已知字段（本卡只有 model）。下一张卡在这里追加 hosts。 */
export const KNOWN_FIELDS = Object.freeze(["model"]);

/** 文件不存在 / 损坏时返回的值。调用方可以再与网关清单求默认。 */
export const DEFAULT_CONFIG = Object.freeze({
  model: null,
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

/** 只挑已知字段做类型归一；其余字段原样保留，不做断言。 */
function normalize(config) {
  const next = { ...config };
  if (typeof next.model !== "string" || next.model.trim().length === 0) next.model = null;
  else next.model = next.model.trim();
  return next;
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
