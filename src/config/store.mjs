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
import { SHELL_IDS } from "../pty/shells.mjs";

/** 环境变量覆盖路径：只给测试用，生产不设。 */
export const CONFIG_PATH_ENV = "MAGPIE_TERMINAL_CONFIG_PATH";

/**
 * 已知字段（`updateConfig` 的补丁白名单 + `PUT /api/config` 的字段白名单）。
 *
 * TASK-V3-D 按 docs/PROTOCOL-AGENT.md §1 从 `["model"]` 扩成五项：
 * `hosts` 仍然不从这里走，它由下面的 `addHost/updateHost/removeHost` 直接
 * 读-改-写整份配置（未知字段本来就是原样保留的，所以两者不会互相踩）。
 *
 * TASK-V4-F §5.3 又加了 `defaultShell`（本机默认 shell 的 id，取值见
 * `src/pty/shells.mjs` 的 `SHELL_IDS`）。
 */
export const KNOWN_FIELDS = Object.freeze([
  "model",
  "autonomy",
  "allowlist",
  "reviewModel",
  "basePrompt",
  "defaultShell",
  // TASK-V4-H §6：确认卡上常显 AI 的效果评估（默认关）。
  "showApprovalEffect",
]);

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
  // null = 不指定，按 MAGPIE_TERMINAL_SHELL → 自动探测（git bash 优先）。
  defaultShell: null,
  // TASK-V4-H §6：确认卡上是否常显「执行后会发生什么」，默认关。
  showApprovalEffect: false,
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

  // TASK-V4-H §6：boolean，非法类型 400 INVALID_SHOW_EFFECT。
  if (has("showApprovalEffect")) {
    if (typeof patch.showApprovalEffect !== "boolean") {
      return { code: "INVALID_SHOW_EFFECT", userText: "showApprovalEffect 必须是 true 或 false。" };
    }
  }

  // TASK-V4-F §5.3：只接受 SHELL_IDS 里的值或 null（null = 回到自动探测）。
  if (has("defaultShell")) {
    const value = patch.defaultShell;
    if (value !== null && !SHELL_IDS.includes(value)) {
      return {
        code: "INVALID_SHELL",
        userText: `defaultShell 必须是 ${SHELL_IDS.join(" / ")} 之一或 null。`,
      };
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

  // defaultShell：非法值一律回落 null（不抛错，下次再选就好）。
  if (!SHELL_IDS.includes(next.defaultShell)) next.defaultShell = null;

  // showApprovalEffect：非 boolean 一律回落 false（默认关）。
  if (typeof next.showApprovalEffect !== "boolean") next.showApprovalEffect = false;

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
    defaultShell: normalized.defaultShell,
    showApprovalEffect: normalized.showApprovalEffect === true,
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
