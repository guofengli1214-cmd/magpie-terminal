// 日志脱敏（TASK-FIX17-E R3）：纯函数、零 IO、深度有限、永不抛。
//
// 为什么放在独立文件：这是「敏感内容不落盘」的唯一实现点，写入路径（logger）
// 与导出路径（GET /api/logs/export）共用同一份逻辑，必须能被表驱动单测覆盖，
// 不能藏在 http.mjs 的闭包里。
//
// 两条独立防线（缺一不可）：
//   ① 键名命中 `SECRET_KEYS` → 值整个换成 "[REDACTED]"（结构保留，便于排查）
//   ② 字符串内容按模式改写（Bearer / -p密码 / 长 hex / 绝对路径 / 邮箱 / IPv4）
//
// 为什么键名与内容都要做：`{ tokenLength: 64 }` 只需键名；而
// `commandHead: "curl -pP@ss ..."` 的键名无害，敏感值在字符串里面。

/** 键名（不区分大小写）命中即整体脱敏：值与业务语义无关，一律不可记录。 */
export const SECRET_KEYS = Object.freeze([
  "token",
  "authtoken",
  "authorization",
  "auth",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "apikey",
  "credential",
  "credentials",
  "privatekey",
  "sshkey",
  "passphrase",
  "sessiontoken",
  "sessionkey",
  "sessionsecret",
]);

// 卡片 R3 对 `session` 家族的口径是「保留结构但脱敏值 → 简化为以上键名一律
// 脱敏值」。因此**键名里出现 session 的字段值一律换成 [REDACTED]**：
// `sessionId` 的键还在（结构可读、能看出「这里有个会话」，但不含可关联的值）。
// 这是卡片明确的取舍，不在这里自作主张改成「保留 id 便于关联」。
// 要定位多标签场景请用 `route` / `shell` / 时间戳这些不含凭据嫌疑的字段。

/**
 * 归一化后的键名集合：去掉 `_` / `-` / 空白后小写比较。
 * 这样 `api_key` / `apiKey` / `API-KEY` 都命中同一条规则，不必在正则里穷举。
 */
const SECRET_KEY_SET = new Set(SECRET_KEYS);
export const REDACTED = "[REDACTED]";
export const CIRCULAR = "[Circular]";
export const MAX_DEPTH = 8;

/** 键名是否属于「值必须脱敏」的那一类。 */
export function isSecretKey(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  const normalized = key.toLowerCase().replace(/[\s_-]+/g, "");
  if (SECRET_KEY_SET.has(normalized)) return true;
  // `session` 家族（PRD R3：键名含 session 的一律脱敏值）。
  if (normalized.includes("session")) return true;
  // 其余凭据派生词（parentTokenId / userPassword…）同样不可记。
  // 用后缀匹配而不是子串：`tokenBytes` / `tokenCount` 这类「数量、长度」不脱敏
  // 才有诊断价值（SERVER_STARTED 的 `tokenBytes: 32` 就靠这条留下）。
  // `parentTokenId` 不是以 token 结尾，所以另加一条「中缀 + Id 后缀」的判断。
  if (/(?:token|password|passwd|secret|apikey|credential|passphrase)id$/.test(normalized)) {
    return true;
  }
  return /(?:token|password|passwd|secret|apikey|credential|passphrase)$/.test(normalized);
}

/* ------------------------------------------------------------------ *
 * 字符串内容模式
 *
 * 顺序很重要：先处理带参数名的（`-p…` / `--password=…`），再处理宿主体
 * （Bearer …），最后才是通用的长串 / 路径 / 邮箱 / IP。否则 `-pBearer abc`
 * 会被前一条吃掉一半，得到难以预期的结果。
 * ------------------------------------------------------------------ */

/** `Bearer abcdef123456` → `Bearer [REDACTED]`（大小写不敏感，保留写法）。 */
const BEARER_RE = /\b(Bearer|Basic|Token|Digest)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** `--password=hunter2` / `--password hunter2` / `--token abc…` → 保留参数名。 */
const LONG_FLAG_RE = /(--(?:password|passwd|token|secret|api-?key|auth|passphrase))(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi;

/** `-pP@ssw0rd` / `-p hunter2` / `-p"P@ss"` → `-p[REDACTED]`。
 *
 * 难点：`-p` 也是很多命令的普通短选项（`find . -print`、`git -p`）。
 * 一律当成密码会把 `-print` 改成 `-p[REDACTED]`，日志直接失去排查价值。
 * 所以分两种形态：
 *   · 空格/引号/等号分隔的（`-p hunter2`、`-p"x"`、`-p=x`）→ 一定是值，直接脱敏；
 *   · 紧贴着的（`-phunter2`）→ 只有值里带数字或符号才当密码
 *     （密码几乎必然含数字/符号；`-print` / `-prune` / `-path` 这类纯字母选项不会被误伤）。
 */
const SHORT_P_RE = /(^|[\s"'])-p((?:"[^"]*"|'[^']*'|[=\s]\S+)|\S+)/g;

/** `sk-…` / `ghp_…` 这类带前缀的密钥。 */
const PREFIXED_KEY_RE = /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abps]|AKIA|ASIA)[-_][A-Za-z0-9_-]{12,}/g;

/** 长 hex / base64（≥24 连续字符，且字母与数字都有）→ `[REDACTED:len=N]`。 */
const LONG_BLOB_RE = /[A-Za-z0-9+/=_-]{24,}/g;

/**
 * `ssh-ed25519 AAAAC3` 这类模板占位符（本仓库的凭据写法）→ `[REDACTED:len=N]`。
 *
 * 为什么必须单独一条：它不是 hex 也不是 base64，`LONG_BLOB_RE` 的字符类
 * 不包含 `{` `}`，所以整串永远匹配不上；而它在真日志里就是「真凭据被替换后的
 * 占位符」，扩散到导出文件里同样等于把钥匙的名字告诉别人。
 */
const TEMPLATE_TOKEN_RE = /\{\{[A-Za-z0-9_-]{8,}\}\}/g;

/** Windows 绝对路径（盘符 + 反斜杠）。 */
const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s"'<>|]*/g;

/**
 * POSIX 绝对路径。两个条件只命中一个才缩写：
 *   · 第一级是用户/系统数据的根（`home` `users` `root` `mnt` `media` `var`
 *     `tmp` `opt` `srv` `private` `etc` `usr`）—— 里面必然有用户名或主机信息；
 *   · 最后一级带扩展名（`nginx.conf` / `a.txt`）—— 是文件，不是接口名。
 *
 * 为什么要这两条限定：`GET /api/logs/export` 也是「/ 开头多级路径」，
 * 不加限定会被缩写成「盘符 + 省略号 + 末段」的样子，把路由名（排查时最有用的字段）
 * 直接抹掉（实测发生过）。接口路径不是机密，用户目录与文件名才是。
 */
const POSIX_ROOT_SEGMENTS = new Set([
  "home",
  "users",
  "root",
  "mnt",
  "media",
  "var",
  "tmp",
  "opt",
  "srv",
  "private",
  "etc",
  "usr",
  "Volumes",
]);
const POSIX_PATH_RE = /(^|[\s"'(=:])\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|/]*/g;

/** 邮箱：首字母 + `***@域名`。 */
const EMAIL_RE = /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/** IPv4：保留前两段，后两段 `.*.*`。 */
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/** `C:\Users\<name>` 里的用户名 → `***`（在 WIN_PATH_RE 之前先落位）。 */
const WIN_USER_RE = /([A-Za-z]:\\Users\\)[^\\\s"'<>|]+/gi;

/** `C:\Users\bob\proj\a.txt` → `C:\***\a.txt`：只留盘符与最后一级。 */
function shortenWindowsPath(match) {
  const drive = match.slice(0, 2);
  const rest = match.slice(3);
  const parts = rest.split("\\").filter((part) => part.length > 0);
  if (parts.length <= 1) return match;
  const last = parts[parts.length - 1];
  return `${drive}\\***\\${last}`;
}

/** `/home/bob/proj/a.txt` → `/***​/a.txt`；不够像文件路径时原样返回。 */
function shortenPosixPath(match, prefix) {
  const parts = match.split("/").filter((part) => part.length > 0);
  if (parts.length <= 1) return `${prefix}/***`;
  const looksLikeUserData = POSIX_ROOT_SEGMENTS.has(parts[0]) || POSIX_ROOT_SEGMENTS.has(parts[0].toLowerCase());
  const looksLikeFile = parts[parts.length - 1].includes(".");
  if (!looksLikeUserData && !looksLikeFile) return match;
  return `${prefix}/***/${parts[parts.length - 1]}`;
}

/**
 * 长串处理：只有「含数字且含字母」才当密钥脱敏。
 * 纯数字（毫秒时间戳、端口）与纯字母（普通英文单词、标识符）保留，
 * 否则日志会变成一片 `[REDACTED:len=N]`，失去排查价值。
 */
function redactLongBlob(match) {
  const hasDigit = /[0-9]/.test(match);
  const hasAlpha = /[A-Za-z]/.test(match);
  if (!hasDigit || !hasAlpha) return match;
  // 纯 UUID / 纯日期时间这类「有分隔但仍是标识」的串按原样保留？
  // 不保留：UUID 常用来当会话 id，而会话 id 属于要脱敏的一类（security-model §4.1）。
  return `[REDACTED:len=${match.length}]`;
}

/**
 * 对单个字符串做内容脱敏。空串 / 非字符串原样返回（调用方保证类型）。
 *
 * 顺序：模板占位符 → 参数名 → 宿主体 → 带前缀的密钥 → 用户名 →
 *       Windows 路径 → POSIX 路径 → 邮箱 → IPv4 → 长串。
 */
export function redactString(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let text = value;
  text = text.replace(TEMPLATE_TOKEN_RE, (match) => `[REDACTED:len=${match.length}]`);
  text = text.replace(LONG_FLAG_RE, (match, flag) => `${flag}=${REDACTED}`);
  text = text.replace(SHORT_P_RE, (match, prefix, raw) => {
    const separated = /^["='\s]/.test(raw);
    if (separated) return `${prefix}-p${REDACTED}`;
    // 紧贴形：纯字母（`-print` / `-prune`）不当密码，带数字或符号才脱敏。
    return /[0-9]|[^A-Za-z0-9]/.test(raw) ? `${prefix}-p${REDACTED}` : match;
  });
  text = text.replace(BEARER_RE, (match, scheme, space) => `${scheme}${space}${REDACTED}`);
  text = text.replace(PREFIXED_KEY_RE, (match) => `[REDACTED:len=${match.length}]`);
  text = text.replace(WIN_USER_RE, (match, prefix) => `${prefix}***`);
  text = text.replace(WIN_PATH_RE, (match) => shortenWindowsPath(match));
  text = text.replace(POSIX_PATH_RE, (match, prefix) => shortenPosixPath(match, prefix));
  text = text.replace(EMAIL_RE, (match, first, domain) => `${first}***@${domain}`);
  text = text.replace(IPV4_RE, (match, a, b) => `${a}.${b}.*.*`);
  text = text.replace(LONG_BLOB_RE, (match) => redactLongBlob(match));
  return text;
}

/**
 * 递归脱敏任意值。
 *
 * 契约（AC5 逐条对应）：
 * - `null` / `undefined` / 数字 / 布尔 原样返回（数字不参与内容模式）
 * - 字符串走 `redactString`
 * - 数组逐项、对象逐键（键名命中 `isSecretKey` 时值整个换成 `[REDACTED]`）
 * - 深度上限 `MAX_DEPTH`：超过就返回 `"[Truncated]"`，避免恶意/异常结构爆栈
 * - 循环引用返回 `"[Circular]"`（`seen` 是 WeakSet，只对对象生效）
 * - 永不抛：`Error` 走 `{name, message, stack}` 三字段后继续脱敏
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, seen = new WeakSet(), depth = 0) {
  try {
    if (value === null || value === undefined) return value;
    const type = typeof value;
    if (type === "string") return redactString(value);
    if (type === "number" || type === "boolean" || type === "bigint") return value;
    if (type === "function" || type === "symbol") return `[${type}]`;
    if (depth >= MAX_DEPTH) return "[Truncated]";
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => redact(item, seen, depth + 1));
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      return redact(
        { name: value.name, message: value.message, stack: value.stack },
        seen,
        depth + 1,
      );
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? REDACTED : redact(item, seen, depth + 1);
    }
    return out;
  } catch {
    // 永不抛：脱敏失败时宁可丢字段，也不让日志链路炸掉调用点。
    return "[Unserializable]";
  }
}

/**
 * 对整个日志文本再跑一遍脱敏（导出前用）。
 *
 * 为什么要有它：写入时脱敏只覆盖「当时知道的结构」。历史文件里可能有旧版本
 * 写进去的未脱敏内容（例如升级前落盘的 `commandHead`），导出是最后一道闸门。
 *
 * **为什么优先 JSON 解析而不是直接对原文跑正则**：日志行是 JSON 编码后的文本，
 * 路径里的反斜杠是转义过的（`C:\\\\Users\\\\bob…`）。直接对文本跑
 * 路径规则会把 `\\\\` 换成一个 `\\`，输出悬法解析（实测：导出的日志
 * `JSON.parse` 直接 `Bad escaped character`），结果是「为了脱敏把日志弄坏」。
 * 先 parse 再 `redact()` 再 stringify：反斜杠由 JSON 编码器负责，结构不会坏。
 *
 * 解析不了的脏行（被截断 / 被手改过）仍要洗：退回原文正则，宁可格式不好，
 * 也不能把明文带出。
 *
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.length === 0) return line;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return JSON.stringify(redact(parsed));
        }
      } catch {
        // 脏行：走下面的原文正则。
      }
      return redactString(line);
    })
    .join("\n");
}
