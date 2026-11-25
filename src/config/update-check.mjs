// 检查更新：把 GitHub 请求、版本比较、缓存拆成可注入的纯逻辑。
//
// 为什么单独一层（TASK-FIX17-G R1/R3）：
//   `GET /api/update/check` 的失败面很多（超时 / 403 / 404 / 限流 / 非 GitHub
//   仓库），它们不能把服务打崩，也不能把「查询失败」说成「已是最新」。
//   把这些判定放进纯函数后，单测可以传假 `fetchImpl` 与假时钟，
//   永远不真连 GitHub；路由层只剩「读版本 / 安装方式 → 调这里 → 返回」。
//
// 硬约束：
//   - 不引 `semver` 依赖，自己按数字段比较；
//   - 不硬编码 token（公开 API 无需鉴权），也不把任何 stack 回给前端；
//   - 缓存 TTL 固定 5 分钟，模块级默认缓存可被调用方注入替换。

/** 更新检查结果缓存 5 分钟（防止用户狂点打爆 GitHub API）。 */
export const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;

/** 抓取超时（PRD R1：5s）。 */
export const UPDATE_TIMEOUT_MS = 5000;

/** 默认模块级缓存：key → {at, value}。测试传自己的 Map，避免互相污染。 */
const defaultCache = new Map();

/**
 * 语义化版本比较：`a > b` 返回 1，`a < b` 返回 -1，相等返回 0。
 *
 * 规则（不引 semver 包）：
 *   - 忽略前缀 `v` 与构建元数据 `+...`；
 *   - major.minor.patch 逐段按数字比，缺段按 0；
 *   - 有预发布后缀（`-beta.1`）的一侧小于无后缀的一侧；
 *   - 两侧都有后缀时按字符串比（PRD 设计：「预发布后缀按字符串比」）。
 * 非法输入不抛错：数字段按 0 处理，宁可判「一样」也不崩。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1|0|1}
 */
export function compareSemver(a, b) {
  const parse = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    const withoutPrefix = text.replace(/^v/i, "").split("+")[0];
    const dash = withoutPrefix.indexOf("-");
    const core = dash === -1 ? withoutPrefix : withoutPrefix.slice(0, dash);
    const pre = dash === -1 ? "" : withoutPrefix.slice(dash + 1);
    return { parts: core.split("."), pre };
  };

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.parts.length, right.parts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const leftNumber = Number(left.parts[index] ?? 0);
    const rightNumber = Number(right.parts[index] ?? 0);
    const leftValue = Number.isFinite(leftNumber) ? leftNumber : 0;
    const rightValue = Number.isFinite(rightNumber) ? rightNumber : 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  if (left.pre === right.pre) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  return left.pre < right.pre ? -1 : left.pre > right.pre ? 1 : 0;
}

/**
 * 把 `package.json.repository` 归一成 `{url, owner, repo, github}`。
 * 接受字符串或 `{type,url}` 两种形态；也接受常见的 git 写法：
 *   `git+https://github.com/o/r.git`、`git@github.com:o/r.git`、
 *   `github:o/r`、`ssh://git@github.com/o/r.git`、`o/r`。
 *
 * @param {unknown} repository
 * @returns {{url:string, owner:string|null, repo:string|null, github:boolean}|null}
 */
export function normalizeRepository(repository) {
  let raw = null;
  if (typeof repository === "string") raw = repository;
  else if (repository && typeof repository === "object" && typeof repository.url === "string") {
    raw = repository.url;
  }
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.length === 0) return null;

  // 简写与 git 协议统一成 https。
  if (/^github:/i.test(text)) text = `https://github.com/${text.slice("github:".length)}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(text)) text = `https://github.com/${text}`;
  else if (/^git@[^:]+:.+$/.test(text)) {
    const [host, rest] = text.slice("git@".length).split(":");
    text = `https://${host}/${rest}`;
  } else if (/^git\+ssh:\/\/git@[^/]+\//i.test(text)) {
    text = text.replace(/^git\+ssh:\/\/git@[^/]+\//i, (match) => {
      const host = match.slice("git+ssh://git@".length, -1);
      return `https://${host}/`;
    });
  } else if (/^ssh:\/\/git@[^/]+\//i.test(text)) {
    text = text.replace(/^ssh:\/\/git@[^/]+\//i, (match) => {
      const host = match.slice("ssh://git@".length, -1);
      return `https://${host}/`;
    });
  } else if (/^git\+/i.test(text)) {
    text = text.slice("git+".length);
  } else if (/^git:\/\//i.test(text)) {
    text = text.replace(/^git:\/\//i, "https://");
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (pathname.length === 0) pathname = "";
  url.pathname = pathname;

  const segments = pathname.split("/").filter(Boolean);
  const isGithub = /^(?:www\.)?github\.com$/i.test(url.hostname);
  const owner = isGithub && segments.length >= 2 ? segments[0] : null;
  const repo = isGithub && segments.length >= 2 ? segments[1] : null;

  return {
    url: url.toString().replace(/\/$/, ""),
    owner,
    repo,
    github: Boolean(owner && repo),
  };
}

/** 不管什么错误都翻成人话；绝不把 stack / 原始 URL 带出去。 */
function humanizeFetchError(error) {
  const name = error && typeof error.name === "string" ? error.name : "";
  const code = error && typeof error.code === "string" ? error.code : "";
  if (name === "TimeoutError" || name === "AbortError" || code === "ABORT_ERR" || code === "ETIMEDOUT") {
    return "连不上 GitHub（超时）";
  }
  return "连不上 GitHub（网络错误）";
}

function cacheRead(cache, key, now) {
  if (!cache || typeof cache.get !== "function") return null;
  const entry = cache.get(key);
  if (!entry || typeof entry.at !== "number") return null;
  const age = now - entry.at;
  if (!Number.isFinite(age) || age < 0 || age >= UPDATE_CACHE_TTL_MS) {
    if (typeof cache.delete === "function") cache.delete(key);
    return null;
  }
  return entry.value && typeof entry.value === "object" ? { ...entry.value } : null;
}

function cacheWrite(cache, key, value, now) {
  if (!cache || typeof cache.set !== "function") return;
  cache.set(key, { at: now, value: { ...value } });
}

/**
 * 检查更新。**不抛错**，所有失败都变成 `{hasUpdate:false, error:"<人话>"}`。
 *
 * @param {{
 *   repository?: unknown,
 *   installKind?: "local-path"|"registry"|"unknown"|string,
 *   currentVersion?: string,
 *   fetchImpl?: typeof fetch,
 *   cache?: Map<string, {at:number, value:object}>,
 *   now?: () => number,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{
 *   current:string,
 *   latest:string|null,
 *   hasUpdate:boolean,
 *   url:string|null,
 *   note?:string,
 *   error?:string,
 * }>}
 */
export async function checkForUpdate(options = {}) {
  const current = typeof options.currentVersion === "string" && options.currentVersion.trim().length > 0
    ? options.currentVersion.trim().replace(/^v/i, "")
    : "0.0.0";
  const installKind = options.installKind || "unknown";

  // 本地目录安装：`magpie plugin update` 不会动它，直接给手动更新指引。
  // 这不是错误（PRD R1），UI 应显示成提示而不是失败。
  if (installKind === "local-path") {
    return {
      current,
      latest: null,
      hasUpdate: false,
      url: null,
      note: "本地目录安装：在仓库里 git pull 后重启 magpie 即可",
    };
  }

  if (installKind === "unknown") {
    return {
      current,
      latest: null,
      hasUpdate: false,
      url: null,
      error: "无法判断安装方式，暂时不能检查更新",
    };
  }

  const repository = normalizeRepository(options.repository);
  if (!repository) {
    return {
      current,
      latest: null,
      hasUpdate: false,
      url: null,
      error: "未配置仓库地址，无法检查更新",
    };
  }
  if (!repository.github) {
    return {
      current,
      latest: null,
      hasUpdate: false,
      url: repository.url,
      error: "仓库不在 GitHub 上，暂时无法检查更新",
    };
  }

  const cache = options.cache === undefined ? defaultCache : options.cache;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : UPDATE_TIMEOUT_MS;

  const cacheKey = `${repository.owner}/${repository.repo}@${current}`;
  const cached = cacheRead(cache, cacheKey, now());
  if (cached) return cached;

  if (typeof fetchImpl !== "function") {
    return {
      current,
      latest: null,
      hasUpdate: false,
      url: repository.url,
      error: "当前运行环境不支持网络请求，暂时无法检查更新",
    };
  }

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(
    repository.repo,
  )}/releases/latest`;

  let response;
  try {
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    response = await fetchImpl(apiUrl, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "magpie-terminal",
        "x-github-api-version": "2022-11-28",
      },
      signal,
    });
  } catch (error) {
    const result = {
      current,
      latest: null,
      hasUpdate: false,
      url: repository.url,
      error: humanizeFetchError(error),
    };
    cacheWrite(cache, cacheKey, result, now());
    return result;
  }

  if (!response || response.ok !== true) {
    const status = response && Number.isFinite(response.status) ? response.status : 0;
    let error;
    if (status === 404) error = "GitHub 上找不到这个仓库，或它还没有发布版本";
    else if (status === 403 || status === 429) error = "GitHub 接口访问受限（可能触发了限流），请稍后再试";
    else if (status >= 500) error = "GitHub 服务暂时不可用";
    else if (status > 0) error = `GitHub 返回 HTTP ${status}`;
    else error = "连不上 GitHub（网络错误）";
    const result = { current, latest: null, hasUpdate: false, url: repository.url, error };
    cacheWrite(cache, cacheKey, result, now());
    return result;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const result = {
      current,
      latest: null,
      hasUpdate: false,
      url: repository.url,
      error: "GitHub 返回的内容无法解析",
    };
    cacheWrite(cache, cacheKey, result, now());
    return result;
  }

  const tag = payload && typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
  if (tag.length === 0) {
    const result = {
      current,
      latest: null,
      hasUpdate: false,
      url: repository.url,
      error: "GitHub 上没有找到发布版本",
    };
    cacheWrite(cache, cacheKey, result, now());
    return result;
  }

  const latest = tag.replace(/^v/i, "");
  const htmlUrl =
    payload && typeof payload.html_url === "string" && /^https?:\/\//i.test(payload.html_url)
      ? payload.html_url
      : `${repository.url}/releases/tag/${encodeURIComponent(tag)}`;
  const result = {
    current,
    latest,
    hasUpdate: compareSemver(latest, current) > 0,
    url: htmlUrl,
    note: "",
  };
  cacheWrite(cache, cacheKey, result, now());
  return result;
}
