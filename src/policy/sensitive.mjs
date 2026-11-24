// 敏感路径表 + 判定（TASK-V4-S §6.3，P0-3）。
//
// 为什么需要它：内置只读白名单含 `cat` / `head` / `tail`，且没有敏感路径黑名单，
// 于是 `cat ~/.config/magpie-terminal/secrets.key`、`cat .env`、`cat ~/.ssh/id_rsa`
// 全部被判 auto 直接执行（VERIFY-V4-G §4 P0-3 已逐字复现）。
//
// 为什么按「路径段 + 文件名 + 扩展名」三条判据，而不是正则整串匹配：
// 命令里的路径写法太多（~ / $HOME / 反斜杠 / 引号 / 相对路径），逐条正则必然漏。
//
// 纯函数、零 IO、永不抛：输入不是字符串就 false。

/** 出现在任意一级目录名即命中（小写比较）。 */
export const SENSITIVE_DIRS = Object.freeze([
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".kube",
  ".config/gcloud",
]);

/** 文件名（含后缀变体）精确命中（小写比较）。 */
export const SENSITIVE_BASENAMES = Object.freeze([
  "secrets.key",
  "secrets.json",
  "known_hosts",
  "known_hosts.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "authorized_keys",
  "netrc",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".pypirc",
  ".pgpass",
  ".my.cnf",
  ".bash_history",
  ".zsh_history",
  ".psql_history",
  ".mysql_history",
  "credentials.json",
  "service-account.json",
]);

/** 文件名后缀。 */
export const SENSITIVE_SUFFIXES = Object.freeze([".pem", ".pfx", ".p12", ".jks", ".keystore"]);

/**
 * 相邻三段（小写）出现即命中：Hermes 自己的数据目录、本插件的配置目录。
 * 这些目录整棵拒 —— 里面装的就是口令与主机指纹。
 */
export const SENSITIVE_SEQUENCES = Object.freeze([
  ["appdata", "local", "hermes"],
  ["appdata", "roaming", "hermes"],
  [".config", "magpie-terminal"],
  ["local", "hermes", "openviking"],
]);

/** 归一：去引号、`\` → `/`、小写、去首尾空白。 */
function normalizeForMatch(candidate) {
  let text = String(candidate).trim();
  // 成对引号（`'~/.ssh/id_rsa'` / `"C:\Users\x\id_rsa"`）。
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" || first === '"') && last === first) text = text.slice(1, -1);
  }
  return text.replace(/\\/g, "/").toLowerCase();
}

/**
 * 这个路径字符串是否指向密钥 / 凭据（命中即需要用户确认）。
 *
 * 判据（任一命中即 true）：
 *   1. 任一路径段 ∈ SENSITIVE_DIRS
 *   2. basename === ".env" 或以 ".env." 开头（`.env` / `.env.local` / `.env.production`）
 *   3. basename ∈ SENSITIVE_BASENAMES，或以 SENSITIVE_SUFFIXES 里任一项结尾
 *   4. 相邻 3 段（或 2 段）序列命中 SENSITIVE_SEQUENCES
 *   5. Windows 家目录环境变量写法 `%USERPROFILE%`（AC13）——它们本身就指向家目录，
 *      但只要后面不是敏感段就不拦，所以这里不单独判危险，靠段匹配覆盖。
 *
 * `~` 与 `$HOME` / `${HOME}` / `%USERPROFILE%` 都**不展开**：它们本身就是「家目录」，
 * 后面跟的敏感段（`.ssh` / `.aws` / …）已经足够判定（`~/.ssh/id_rsa` 命中 `.ssh`）。
 *
 * @param {unknown} candidate
 * @returns {boolean}
 */
export function isSensitivePath(candidate) {
  try {
    if (typeof candidate !== "string") return false;
    const text = normalizeForMatch(candidate);
    if (text.length === 0) return false;

    const segments = text.split("/").filter((s) => s.length > 0 && s !== ".");
    if (segments.length === 0) return false;

    // 1) 目录段。`.config/gcloud` 是两段，所以按「拼接后的连续段」比。
    for (let i = 0; i < segments.length; i += 1) {
      for (const dir of SENSITIVE_DIRS) {
        const parts = dir.split("/");
        let hit = true;
        for (let k = 0; k < parts.length; k += 1) {
          if (segments[i + k] !== parts[k]) {
            hit = false;
            break;
          }
        }
        if (hit) return true;
      }
    }

    const basename = segments[segments.length - 1];

    // 2) .env 家族。
    if (basename === ".env" || basename.startsWith(".env.")) return true;

    // 3) 文件名 / 后缀。
    if (SENSITIVE_BASENAMES.includes(basename)) return true;
    for (const suffix of SENSITIVE_SUFFIXES) {
      if (basename.endsWith(suffix)) return true;
    }

    // 4) 相邻序列（2~3 段）。Hermes 数据目录整棵拒。
    for (const seq of SENSITIVE_SEQUENCES) {
      for (let i = 0; i + seq.length <= segments.length; i += 1) {
        let hit = true;
        for (let k = 0; k < seq.length; k += 1) {
          if (segments[i + k] !== seq[k]) {
            hit = false;
            break;
          }
        }
        if (hit) return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * 粗筛：命令里是否出现疑似敏感路径的 token（命中则返回那个 token）。
 *
 * 与 classify 共用同一份 `isSensitivePath`；这里只做「按空白切 token」的最小实现：
 * 不做词法、不剥引号（`isSensitivePath` 自己会剥），宁可多确认不可漏。
 * 只用于 judge 的第 1.5 级（用户白名单也不能变成读密钥的捷径）。
 *
 * @param {unknown} command
 * @returns {string|null}
 */
export function sensitiveReadTarget(command) {
  try {
    if (typeof command !== "string") return null;
    const tokens = command.split(/[\s;&|]+/);
    for (const token of tokens) {
      if (token.length === 0) continue;
      // 选项跳过：`-c 100` 里的 `-c` 不是路径（`100` 也不敏感，无害）。
      if (token.startsWith("-")) continue;
      if (isSensitivePath(token)) return token;
    }
    return null;
  } catch {
    return null;
  }
}
