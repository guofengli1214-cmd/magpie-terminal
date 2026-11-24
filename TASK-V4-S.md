---
id: TASK-V4-S
title: 安全返工卡（3 个 P0 + 4 个 P1 + 2 个焦点 P0）
status: approved
plan_version: V4-S（安全返工，用户 2026-11-24 拍板「A：立刻开安全返工卡，验收通过后再做卡 H」）
approval_ref: 用户消息 m05441「A」
priority: P0
executor: sub-agent
model_tier: cheap
attempt: 1
retry_budget: 1
escalation_policy: ask_human
session_policy: new_session_required
session_id: null
inputs:
  - C:/Users/41807/magpie-terminal/VERIFY-V4-G.md §4（缺口的逐字复现结果与脚本名）
  - C:/Users/41807/magpie-terminal/docs/PROTOCOL-AGENT.md §5（分级链唯一权威）
quality_benchmark: 不适用（安全缺陷修复，按 AC 逐条判定，无对标对象）
verifier: independent_new_session
depends_on: []
---

# 1. 背景与现状（大白话）

`VERIFY-V4-G.md §4` 记录了一批已复现的安全缺口，全部由主 agent 亲自跑脚本证实，不是推测：

| 编号 | 一句话 | 已复现的逐字结果 |
|---|---|---|
| P0-1 | 任何网页都能用 `fetch('http://127.0.0.1:3480/')` 读到带 64 位口令的首页 HTML，等于偷到钥匙 | `Origin: null` 请求 `GET /` → 200，响应头 `access-control-allow-origin: null`，body 含 `<meta name="magpie-term-token" content="<64 位真 token>">`；拿它调 `/api/config` → 200 |
| P0-2 | 用户白名单只比字符串前缀，`mkdir -p /tmp/x && rm -rf /tmp/victim` 因为「以 mkdir 开头」被自动执行 | `{"decision":"auto","reason":"你的白名单","hit":"mkdir"}` |
| P0-3 | 内置只读白名单含 cat/head/tail 且没有敏感路径黑名单，`cat ~/.config/magpie-terminal/secrets.key` 直接自动执行 | `{"decision":"auto","hit":"allow:cat"}` |
| P1-1 | 危险删除目标只认 11 个写死的字面量，带尾斜杠/`$HOME/`/`/./`/`//` 全部漏判 | 11/11 漏判（`rm -rf ~/`、`$HOME/`、`~/.`、`//`、`/**`、`/./`、`/tmp/../..`、`chmod 777 /`、`rd /s /q C:\`、`Remove-Item -Recurse -Force C:\`、`del /f /s /q C:\Users`） |
| P1-2 | 因为 P1-1 漏判，`rm -rf ~/` 在宽松档 + 假审阅 caution 时被判 auto | `{"decision":"auto","reason":"AI 审阅：清理家目录里的临时文件"}` |
| P1-3 | 命令切不开（含换行）时 `classify` 正确判 confirm，但 `judge` 继续走审阅，审阅说 safe 就 auto | `{"decision":"auto","reason":"AI 审阅：看起来只是列目录","hit":null}`（命令 `echo hi\nrm -rf /`） |
| P1-4 | 文件 API 的路径校验不展开符号链接/junction，敏感路径检查会被人绕开 | `/api/fs/list` 经 junction 指家目录 → 200 读到 139 条 |
| 焦点 P0-a | 打开设置页后焦点没进模态，打字直接跑进终端 | 点 `rail-settings` 后 `document.activeElement` 仍是 `TEXTAREA.xterm-helper-textarea`，真敲 `echo ok > ~/SETTINGS_LEAK_*.txt` → 文件真生成 |
| 焦点 P0-b | 收起抽屉后输入框仍能聚焦，打字进看不见的框，回车就发 | `data-ai-open="false"` 但 `agent-input` 仍持焦点、`inert` false；打 20 字符全进输入框 |

## 已实测的关键事实（写卡依据，不要重新猜）

**导航请求 vs CORS fetch 的真实请求头差异**（主 agent 用两个端口 + 沙箱 iframe 实测）：
- 合法 iframe 导航 `GET http://127.0.0.1:PORT/`：**完全没有 `origin` 头**，`sec-fetch-mode: navigate`、`sec-fetch-dest: iframe`、`sec-fetch-site: cross-site`。
- 沙箱内 `fetch`：`origin: null`、`sec-fetch-mode: cors`、`sec-fetch-dest: empty`。
- curl / Node `fetch`：既无 `Origin` 也无 `Sec-Fetch-*`。
→ 所以「只服务导航」的判据必须同时覆盖这三类。

**当前代码位置（行号已核对）**：
- `src/server/auth.mjs:53` `if (originHeader === "null") return { ok: true };`（必须保留，`/api` 与静态资源依赖它）
- `src/server/auth.mjs` 导出：`TOKEN_HEADER`/`TOKEN_META_NAME`/`TOKEN_QUERY`/`TOKEN_BYTES`/`generateToken`/`maskToken`/`checkHost`/`checkOrigin`/`checkToken`/`readToken`/`tokenMetaTag`/`checkHttpGate`/`checkWsGate`
- `src/server/http.mjs:700-726` 根路径分支：`decodeTokens(url.searchParams.get("tokens"))` → `renderAppIndex(tokens, token)` → 200 + `...cors`，**没有 token 门也没有导航判定**
- `src/server/http.mjs:118-134` `corsHeaders(req, port)`：`origin === "null"` → `access-control-allow-origin: null`
- `src/policy/classify.mjs:58` `splitSegments(input)` 是**模块内私有**，返回 `{ok:true,segments}` 或 `{ok:false,reason,hit}`
- `src/ai/allowlist.mjs:49-71` `matchAllowlist` 只 `startsWith` + 边界判定，不切段
- `src/policy/allowlist.mjs:19` `ALLOW_HEADS` 逐字：`ls dir pwd cat type head tail stat grep where which echo netstat ss ping`
- `src/policy/forbidden.mjs:248-264` `DANGEROUS_RM_TARGETS` 11 个字面量、`isDangerousRmTarget` 只 `toLowerCase` 后 `has`
- `src/policy/forbidden.mjs:275` `destroysDangerousTarget(heads)` 只看 `head==="rm"`/`"rm.exe"` 的段
- `src/ai/judge.mjs` 顺序：硬禁止 → `matchAllowlist` → `classify` → `reviewModelSetting===""` 直接 confirm → `autonomy==="strict"` 直接 confirm → 审阅 → 分级
- `src/fs/local.mjs:51-71` `guardPath` 只做 非空/NUL/长度/`isAbsolute`/`resolve`，**注释明确写「符号链接不展开」**
- `src/fs/local.mjs:80-95` `deletionBlockedReason` 只挡盘根与家目录根
- `app/ui/settings-panel.js` `open()`（约 :468-478）：`void load()` 之后立刻 `backdrop.querySelector('[data-role="autonomy-option"]')` + `requestAnimationFrame(() => focusTarget.focus())`；而 `[data-role="autonomy-option"]` 只在 `renderAutonomy()` 里创建，`renderAutonomy` 由 async 的 `load()` 调 → **rAF 那一刻 focusTarget 为 null**
- `app/app.js` `applyAiOpen(open)`（约 :508-517）：只设 `#root[data-ai-open]` 与把手 `aria-expanded`/`title`，**不设 inert / aria-hidden / visibility**

# 2. 目标

把 9 项缺口全部修掉，每项都有能反向验证的测试（改之前红、改之后绿）。

# 3. 非目标（不要做，做了算越界）

1. **不改分级链的档位语义**。`reviewModelSetting === ""` 直接 confirm、`autonomy === "strict"` 跳过审阅这两条**保持现状**，属卡 H 范围（PROTOCOL §5 的「审阅全档位强制执行」在卡 H 落地）。
2. **不改 `reviewWhy` 字段名** → 卡 H。
3. **不改** `docs/mockups-v4/`、`app/vendor/`、`package.json`、`package-lock.json`。
4. **不加新依赖**。
5. **不改** 模型名截断（`max-width: 58%`）和 PS5/PS7 标签标题 → 卡 H。
6. **不做** 文件面板的沙箱化。文件面板本来就有用户本机全盘权限，P1-4 只修「敏感路径用真实路径判定」和「写/删前用真实路径复核」，不假装它是沙箱。
7. **不改** 任何 `data-role` 名单（前端探针与核验脚本依赖它们）。

# 4. 涉及范围

新增 4 个文件：
- `src/policy/segments.mjs`
- `src/policy/sensitive.mjs`
- `test/policy/segments.test.mjs`
- `test/policy/sensitive.test.mjs`

改动 11 个文件：
- `src/policy/classify.mjs`
- `src/ai/allowlist.mjs`
- `src/ai/judge.mjs`
- `src/policy/forbidden.mjs`
- `src/server/auth.mjs`
- `src/server/http.mjs`
- `src/fs/local.mjs`
- `src/server/routes/fs.mjs`
- `app/ui/settings-panel.js`
- `app/app.js`
- `app/styles/components.css`（抽屉 visibility）

改动测试 6 个文件：
- `test/server/auth.test.mjs`
- `test/ai/allowlist.test.mjs`
- `test/ai/judge.test.mjs`
- `test/policy/forbidden.test.mjs`
- `test/policy/classify.test.mjs`
- `test/fs/local.test.mjs`

# 5. 现有做法（必须复用，不要另起炉灶）

- 分级链只走 `src/ai/judge.mjs`，不要新建第二条链路。
- 切段逻辑只许有一份：从 `src/policy/classify.mjs` 抽出 `splitSegments` 到新文件，`classify.mjs` 改为 import，`ai/allowlist.mjs` 也 import 同一份。**严禁复制粘贴出第二份实现。**
- 错误码风格：`fsError(code, userText)`，HTTP 侧 `{code, userText}`，`src/server/routes/fs.mjs` 有 `statusFor(code)` 映射表。
- 中文文案：面向不懂命令行的用户，说清「发生了什么」和「我该做什么」，不出现英文错误码（错误码放 `code` 字段）。

# 6. 需求细节（逐项修法，按此实现）

## 6.1 P0-1 口令外泄：根 HTML 只服务导航请求

**新增** `src/server/auth.mjs`：

```js
/**
 * 是不是「用户真在打开这个页面」的导航请求。
 *
 * 为什么需要它：首页 HTML 里注入了 64 位口令，而 `<iframe sandbox="allow-scripts">`
 * 造出的 opaque origin（Origin: null）可以让任意网页 fetch 到我们自己的服务。
 * 如果只校验 Origin，就会把口令交给任何网页。
 *
 * 实测三种真实请求头（2026-11-24，两端口 + 真沙箱 iframe）：
 *   magpie 里的合法导航：无 origin 头，sec-fetch-mode: navigate, sec-fetch-dest: iframe
 *   沙箱里恶意 fetch  ：origin: null,  sec-fetch-mode: cors,     sec-fetch-dest: empty
 *   curl / Node fetch ：两者都没有
 */
export function isNavigationRequest(req) {
  const headers = req && req.headers ? req.headers : {};
  const mode = headers["sec-fetch-mode"];
  if (typeof mode === "string" && mode.length > 0) {
    // 浏览器发的请求：只有 navigate 才是「打开页面」。
    // cors / no-cors / same-origin（fetch、img、script、beacon）一律不是。
    return mode.trim().toLowerCase() === "navigate";
  }
  // 非浏览器客户端（curl / Node fetch / doctor）：没有 Sec-Fetch-*。
  // 带 Origin 说明是浏览器里的跨源脚本 —— 即便没有 sec-fetch-mode 也不放行。
  return headers.origin === undefined;
}
```

**改** `src/server/http.mjs` 根路径分支：在 `if (req.method === "GET" && (pathname === "/" || pathname === "/index.html"))` 之后、`decodeTokens` 之前插入：

```js
if (!isNavigationRequest(req)) {
  // 不给 HTML，也不给 ACAO：让恶意页连响应体都读不到。
  // 这里刻意不用 writeForbidden（它带 cors），否则沙箱 fetch 能通过 CORS 读到 body。
  log({ level: "warn", code: "AUTH_NOT_NAVIGATION", msg: "root html refused for non-navigation request", route: `GET ${pathname}` });
  writeJson(res, 403, { code: "FORBIDDEN" });
  return;
}
```

`writeJson(res, 403, {code:"FORBIDDEN"})` 最后一参省略 → 不带 `cors`（函数签名有默认 `{}`）。

**不要**动 `checkOrigin`。保留 `"null"` 放行，因为 `/api/*` 与静态资源必须能用。但要在 `checkOrigin` 上方补一句注释：`// 注意：这里放行 "null" 是为了 /api 与静态资源；带口令的首页 HTML 另有 isNavigationRequest() 一道门，见 http.mjs 根路径分支。`

**新增测试**（写进 `test/server/auth.test.mjs`）：

| # | 请求 | 预期 |
|---|---|---|
| N1 | `GET /` + `origin: "null"` + `sec-fetch-mode: cors` | 403；响应头无 `access-control-allow-origin`；body 不含 `magpie-term-token` |
| N2 | `GET /` + `sec-fetch-mode: navigate` + `sec-fetch-dest: iframe`（无 origin） | 200；body 含 `<meta name="magpie-term-token" content="[0-9a-f]{64}">` |
| N3 | `GET /` 无任何 Sec-Fetch / Origin（curl 形态） | 200 含口令（doctor 与现有测试都依赖这条） |
| N4 | `GET /index.html` + `origin: "null"` + `sec-fetch-mode: cors` | 403 |
| N5 | `GET /` + `origin: "http://evil.example.com"` | 403（沿用现有 checkHttpGate） |
| N6 | `GET /app.js` + `origin: "null"` | 200 + `access-control-allow-origin: null`（现有测试必须继续绿） |

## 6.2 P0-2 用户白名单必须逐段命中

**新增** `src/policy/segments.mjs`：把 `src/policy/classify.mjs` 的 `splitSegments` 原样搬过来并 `export`，函数体逐字不改（包括所有 reason/hit 文案）。`classify.mjs` 改为 `import { splitSegments } from "./segments.mjs";` 并删掉本地实现。

**改** `src/ai/allowlist.mjs` 的 `matchAllowlist`：

```js
/**
 * 按 §2 语义匹配一条命令。
 *
 * **整条命令必须能被安全切分成 N 段，且每一段都命中同一条 enabled 条目**，
 * 才算命中。这样 `mkdir -p a && rm -rf b` 不会因为「以 mkdir 开头」被放行。
 *
 * 切不开（含换行 / 重定向 / 命令替换 / 引号不闭合 / 空段）→ 一律不命中（fail-closed）。
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
        if (!segmentMatches(segment, pattern, entry.mode)) { allHit = false; break; }
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
```

**新增测试**（写进 `test/ai/allowlist.test.mjs`，现有 17 条必须继续绿）：

| # | 命令 | 白名单 | 预期 |
|---|---|---|---|
| A1 | `mkdir -p /tmp/x && rm -rf /tmp/victim` | `prefix("mkdir")` | `null` |
| A2 | `mkdir -p /tmp/x; rm -rf /tmp/victim` | `prefix("mkdir")` | `null` |
| A3 | `mkdir -p /tmp/x \| tee /tmp/y` | `prefix("mkdir")` | `null` |
| A4 | `mkdir a && mkdir b` | `prefix("mkdir")` | `hit === "mkdir"` |
| A5 | `mkdir a b` | `prefix("mkdir")` | `hit === "mkdir"`（保持） |
| A6 | `mkdirx` / `mkdirx a` | `prefix("mkdir")` | `null`（保持） |
| A7 | `npm run build && npm run test` | `exact("npm run build")` | `null`（exact 只认整条单段） |
| A8 | `ls && ls -la` | `prefix("ls")` | `hit === "ls"` |

## 6.3 P0-3 敏感路径：内置白名单不能读密钥

**新增** `src/policy/sensitive.mjs`：

```js
// 敏感路径表：被这些路径命中的读操作一律需要用户确认，内置只读白名单也不例外。
//
// 为什么按「路径段 + 文件名 + 扩展名」三条判据，而不是正则整串匹配：
// 命令里的路径写法太多（~ / $HOME / 反斜杠 / 引号 / 相对路径），逐条正则必然漏。

/** 出现在任意一级目录名即命中（小写比较）。 */
export const SENSITIVE_DIRS = Object.freeze([
  ".ssh", ".aws", ".gnupg", ".docker", ".kube", ".config/gcloud",
]);

/** 文件名（含后缀变体）精确命中（小写比较）。 */
export const SENSITIVE_BASENAMES = Object.freeze([
  "secrets.key", "secrets.json", "known_hosts", "known_hosts.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "authorized_keys", "netrc", ".npmrc", ".netrc", ".git-credentials",
  ".pypirc", ".pgpass", ".my.cnf",
  ".bash_history", ".zsh_history", ".psql_history", ".mysql_history",
  "credentials.json", "service-account.json",
]);

/** 文件名后缀。 */
export const SENSITIVE_SUFFIXES = Object.freeze([".pem", ".pfx", ".p12", ".jks", ".keystore"]);

/** 相邻三段（小写）出现即命中：Hermes 自己的数据目录、本插件的配置目录。 */
export const SENSITIVE_SEQUENCES = Object.freeze([
  ["appdata", "local", "hermes"],
  ["appdata", "roaming", "hermes"],
  [".config", "magpie-terminal"],
  ["local", "hermes", "openviking"],
]);

export function isSensitivePath(candidate) { … }
```

`isSensitivePath(input)` 要求：
- 非字符串 / 空 → `false`（不抛）
- 去引号、把 `\` 统一成 `/`、`toLowerCase()`
- `.env` 与 `.env.*` 单独判（`basename === ".env" || basename.startsWith(".env.")`）
- `~` 与 `$HOME`/`${HOME}` 都视为「家目录」：**不展开**，只做「后面是不是跟敏感段」的判定即可（例如 `~/.ssh/id_rsa` 会被 `.ssh` 段命中）
- 段分割后任一段 ∈ `SENSITIVE_DIRS` → `true`
- basename ∈ `SENSITIVE_BASENAMES` 或以 `SENSITIVE_SUFFIXES` 里任一项结尾 → `true`
- 任意相邻 3 段（也检查 2 段序列里的 `.config/magpie-terminal`）等于 `SENSITIVE_SEQUENCES` 某项 → `true`

**改** `src/policy/classify.mjs`：新增常量 `READ_HEADS`（`cat type head tail stat grep where which`，**不含** `ls dir pwd echo netstat ss ping`——它们不吐文件内容），在 `inspectSegment` 里「命令头参数允许集 / 命头白名单」通过**之后**加一道：

```js
// 敏感路径：命令头只读也要确认。放在「允许」之后统一拦，避免每个分支各写一遍。
if (READ_HEADS.has(head)) {
  const hitPath = args.find((arg) => !arg.startsWith("-") && isSensitivePath(arg));
  if (hitPath) {
    return { ok: false, reason: "这条命令会读出密钥或凭据文件，需要你确认", hit: "deny:sensitive-path" };
  }
}
```

参数里的 `-` 开头项跳过（`head -c 100 /x` 里的 `-c`、`100` 都不是路径，`100` 不敏感，无害）。

**改** `src/ai/judge.mjs`：在「硬禁止」与「用户白名单」之间插入一道，防止用户白名单成为读密钥的捷径：

```js
// 1.5 敏感路径读取：用户白名单也不能自动放行读密钥的操作。
const sensitiveHit = sensitiveReadTarget(text);
if (sensitiveHit) {
  return result("confirm", "这条命令会读出密钥或凭据文件，需要你确认", "deny:sensitive-path", null, null);
}
```

`sensitiveReadTarget` 与 classify 共用同一份实现 → 在 `src/policy/sensitive.mjs` 再导出一个 `sensitiveReadTarget(command)`：内部复用 `segments.mjs` 的 `splitSegments` **不可行**（segments 不自带 tokenize）。改为最小实现：把命令按空白切成 token，过滤掉 `-` 开头，逐个 `isSensitivePath`，命中返回该 token。**注意**：这条只是「粗筛」，宁可多确认不可漏 —— 所以不做精确词法也可以。

**新增测试**（`test/policy/sensitive.test.mjs` + 现有文件补充）：

| # | 输入 | 预期 |
|---|---|---|
| S1 | `isSensitivePath("C:/Users/x/.ssh/id_rsa")` | true |
| S2 | `isSensitivePath("~/.config/magpie-terminal/secrets.key")` | true |
| S3 | `isSensitivePath(".env")` / `".env.local"` | true |
| S4 | `isSensitivePath("C:/Users/x/AppData/Local/hermes/cache/a.txt")` | true（Hermes 数据目录整棵拒） |
| S5 | `isSensitivePath("README.md")` / `"src/index.mjs"` | false |
| S6 | `isSensitivePath(null)` / `""` / `123` | false，不抛 |
| S7 | `classify("cat ~/.config/magpie-terminal/secrets.key")` | `confirm`，`hit === "deny:sensitive-path"` |
| S8 | `classify("head -c 100 /home/u/.ssh/id_rsa")` | `confirm`，`hit === "deny:sensitive-path"` |
| S9 | `classify("cat .env")` | `confirm` |
| S10 | `classify("cat README.md")` / `classify("grep foo src/index.mjs")` / `classify("ls -la")` | 仍 `auto`（不误伤） |
| S11 | `judge("cat secrets.key", {allowlist:[prefix("cat")], autonomy:"loose"}, 假审阅)` | `confirm`，`hit === "deny:sensitive-path"`，且**审阅函数未被调用**（计数器） |

## 6.4 P1-1 危险目标归一化 + 补 cmd/PowerShell/chmod

**改** `src/policy/forbidden.mjs` `isDangerousRmTarget`：先把目标归一，再比对集合。

归一规则（写成 `normalizeDangerTarget(target)` 并导出，便于单测）：
1. 去首尾空白与成对引号
2. `\` → `/`
3. 小写
4. 把 `$home`/`${home}`/`%userprofile%` 替换为 `~`
5. 折叠连续 `/`（`//` → `/`）
6. 反复去掉尾部 `/` 与末尾 `/.`（`~/` → `~`、`~/.` → `~`、`/./` → `/`、`/**` → `*` 不适用，见下）
7. 用 `path.posix.normalize` 处理含 `..` 的纯 POSIX 形式（`/tmp/../..` → `/`）；结果若为 `//` 或 `..` 前缀，直接视为危险
8. 保留 `*` 通配：`/*` 归一为 `/*`（尾斜杠规则会把 `/**` 变成 `/*`，两者都在集合里）

归一后的集合（保持原有 11 个，全部按归一形态书写）：`/`、`/*`、`~`、`~/*`、`*`

**新增** 三类危险删除的判定（都在 `forbiddenReason` 里）：
- **cmd 删除**：`rd` / `rmdir` 带 `/s` 且目标是盘根或 `C:\` 形态（`basename` 为空或只有盘符）→ 危险
- **PowerShell 删除**：`Remove-Item` / `ri` / `del` 带 `-Recurse`（或 `-r`）且目标归一是盘根 / 家目录 / `*` → 危险
- **del**：`del` / `erase` 带 `/s` 且目标归一是盘根或家目录 → 危险

均为「粗筛 + 复用 `normalizeDangerTarget`」，宁可多确认不可漏。

**chmod/chown 补一条**：`chmod` 的目标归一是 `/` 或 `/*` 时，无论有没有 `-R`，都判危险（现有规则只挡 `-R`）。

**新增测试**（`test/policy/forbidden.test.mjs`，现有 75 条继续绿）：

| # | 命令 | 预期 `forbiddenReason` |
|---|---|---|
| F1 | `rm -rf ~/` | 非 null |
| F2 | `rm -rf $HOME/` | 非 null |
| F3 | `rm -rf ~/.` | 非 null |
| F4 | `rm -rf //` | 非 null |
| F5 | `rm -rf /**` | 非 null |
| F6 | `rm -rf /./` | 非 null |
| F7 | `rm -rf /tmp/../..` | 非 null |
| F8 | `chmod 777 /` | 非 null |
| F9 | `rd /s /q C:\` | 非 null |
| F10 | `Remove-Item -Recurse -Force C:\` | 非 null |
| F11 | `del /f /s /q C:\Users` | 非 null |
| F12 | `rm -rf ./build` / `rm -rf /tmp/mydir` / `chmod 777 ./x` | **null**（不误伤） |
| F13 | `git commit -m reboot` / `npm run format` / `rg shutdown src/` | **null**（沿用返工卡 V3-D-FIX1 的成果，不许回退） |
| F14 | `normalizeDangerTarget("~/./")` === `"~"`；`normalizeDangerTarget("/tmp/../..")` === `"/"`；`normalizeDangerTarget("$HOME//x/..")` === `"~"` | 单测直测归一函数 |

## 6.5 P1-2 由 6.4 覆盖

`rm -rf ~/` 归一后进硬禁止第 1 级，`judge` 在 `forbiddenReason` 就返回，永远走不到审阅。
**必加一条集成测试**：`judge("rm -rf ~/", {autonomy:"loose", reviewModel:"x"}, 假审阅 → {risk:"caution", reversible:true})` → `confirm`，`reason` 以 `硬性禁止` 开头，且审阅函数未被调用。

## 6.6 P1-3 切不开的命令不许交给审阅

**改** `src/ai/judge.mjs`：在调审阅之前插入：

```js
// 命令切不开（换行 / 重定向 / 命令替换 / 引号不闭合 / 空段）时，
// 审阅模型看到的往往是「第一行看起来无害」的片段，会误判成 safe。
// 这类命令一律直接确认，不给审阅开口子的机会。
const UNREVIEWABLE_HITS = new Set([
  "unparsable", "substitution", "redirect", "exception", "invalid-input",
]);
if (builtin && UNREVIEWABLE_HITS.has(String(builtin.hit))) {
  return result("confirm", builtin.reason || "这条命令无法静态判定，需要你确认", builtin.hit, null, null);
}
```

放在「3. 内置只读白名单」之后、「审阅关闭/严格档」之前。

**新增测试**：

| # | 输入 | 预期 |
|---|---|---|
| J1 | `judge("echo hi\nrm -rf /x", balanced, 假审阅 safe)` | `confirm`；`hit` 是 `unparsable`；**审阅未被调用** |
| J2 | `judge("ls > out.txt", balanced, 假审阅 safe)` | `confirm`；`hit === "redirect"`；审阅未被调用 |
| J3 | `judge("echo $(rm -rf x)", balanced, 假审阅 safe)` | `confirm`；`hit === "substitution"`；审阅未被调用 |
| J4 | `judge("npm run build", balanced, 假审阅 safe)` | 仍 `auto`（走审阅，正常路径不回退） |

## 6.7 P1-4 文件 API 用真实路径判定

**改** `src/fs/local.mjs`：
- 新增 `async function realPathOf(target)`：`fs.realpath(target)`，`ENOENT` 时返回 `target`（新建文件场景目标还不存在）
- `guardPath` 保持不变（同步纯函数，不动）
- `listDirectory` / `readTextFile` / `openDownloadStream` / `statPath`：在 `guardPath` 之后加

```js
const real = await realPathOf(target);
const blocked = sensitiveBlockedReason(real);
if (blocked) throw fsError("FORBIDDEN_PATH", blocked);
```

其中 `sensitiveBlockedReason(real)` = `isSensitivePath(real) ? "这个位置是密钥或凭据目录，不能通过文件面板访问。" : null`（从 `src/policy/sensitive.mjs` import）
- `writeFileAtomic` / `writeTextFile` / `writeStreamAtomic` / `makeDirectory` / `makeFile` / `renamePath` / `removePath`：**要求 realpath 与 resolve 结果一致**（跨链接写入/删除拒绝）

```js
// 经符号链接 / junction 的写入与删除会落到「看起来不是这里」的地方：
// 用户以为删的是链接，实际删的是目标目录里的文件。宁可拒绝。
const real = await realPathOf(target);
if (path.resolve(real) !== path.resolve(target)) {
  throw fsError("FORBIDDEN_PATH", "这个路径经过符号链接，为安全起见不能写入或删除。");
}
```

（新建场景目标不存在时 `realPathOf` 返回 `target`，比较相等 → 放行；但父目录可能是链接，所以 `makeDirectory`/`makeFile`/`writeFileAtomic` 还要对 `path.dirname(target)` 做同样比较。）

**改** `src/server/routes/fs.mjs`：`statusFor` 已有 `FORBIDDEN_PATH → 403`，不用改；只在 catch 时把 `userText` 原样回给前端（现有逻辑已如此，确认即可）。

**新增测试**（`test/fs/local.test.mjs`，现有用例继续绿）：

| # | 场景 | 预期 |
|---|---|---|
| L1 | 建真目录 `tmp/real-secret/`（内含 `secrets.key`），请求 `readTextFile("tmp/real-secret/secrets.key")` | 抛 `FORBIDDEN_PATH` |
| L2 | 建 junction `tmp/link-ssh → <home>/.ssh`（`mklink /J`），请求 `listDirectory("tmp/link-ssh")` | 抛 `FORBIDDEN_PATH` |
| L3 | 同 L2，`readTextFile("tmp/link-ssh/known_hosts")` | 抛 `FORBIDDEN_PATH` |
| L4 | 建 junction `tmp/link-plain → tmp/plain/`，`listDirectory("tmp/link-plain")` | 200 正常（不误伤普通链接） |
| L5 | `removePath("tmp/link-plain", {recursive:true})` | 抛 `FORBIDDEN_PATH`（拒跨链接删除） |
| L6 | 普通 `removePath("tmp/plain/x")` / `writeTextFile("tmp/plain/y.txt","hi")` | 正常成功 |
| L7 | junction 不可建时（无权限）用 `try/catch` 跳过并 `t.skip`，**不许把 skip 写成 pass** |

> L2/L5 的 junction 用 `child_process.execFileSync("cmd", ["/c", "mklink", "/J", link, target])` 创建（Windows 下 junction 不需要管理员权限；符号链接才需要）。

## 6.8 焦点 P0-a：设置页焦点时序

**改** `app/ui/settings-panel.js` `open()`：

```js
function open() {
  if (opened) return;
  opened = true;
  focusBefore = document.activeElement;
  if (!backdrop) build();
  backdrop.hidden = false;
  rootForInert()?.setAttribute("inert", "");   // 见下
  document.addEventListener("keydown", onGlobalKeydown, true);
  void load().then(() => {
    // 焦点必须等 load() 建完 DOM 再进：autonomy-option 是 async load 里才渲染的，
    // 之前用 rAF 时元素还不存在（实测焦点留在终端，打字直接跑进 shell）。
    if (!opened) return;
    const target = backdrop.querySelector('[data-role="autonomy-option"]') ||
                   backdrop.querySelector("button, [href], input, select, textarea");
    if (target && typeof target.focus === "function") {
      try { target.focus(); } catch { /* 忽略 */ }
    }
  });
}
```

`rootForInert()` = `document.querySelector('[data-role="app"]')` 里除设置挂载点之外的部分。实现上用：给 `nav.rail`、`section.main`、`[data-role="statusbar"]` 三个容器各设 `inert`（它们都是 `#root` 的直接子元素），在 `closeModal()` 里移除。

**注意**：`[data-role="settings-host"]` 是 `#root` 的另一个子元素，绝不能设 inert（设置页自己就在里面）。

**改** `closeModal()`：移除这三处 inert（在恢复 `focusBefore` 之前）。

**新增测试**：这一项是前端行为，单测留空；由 AC 里的真浏览器探针验证（见 §10 AC8）。

## 6.9 焦点 P0-b：收起抽屉必须真的不可交互

**改** `app/styles/layout.css`：现有规则（`app/styles/layout.css:55-72`）已经有 `transform: translateX(100%)` + `pointer-events: none`，但**没有 `visibility`**，所以里面的输入框仍能被 Tab / 程序聚焦、能打字、回车能发（`pointer-events` 不影响键盘焦点）。在现有 `[data-role="ai-drawer"]` 规则里追加 `visibility: hidden;`，并在 `[data-role="app"][data-ai-open="true"] [data-role="ai-drawer"]`（同文件 :77）里追加 `visibility: visible;`。

过渡时长必须用现有的 `0.18s`（不要改成 200ms，会与抽屉滑动不同步）：

```css
/* 收起态的 visibility 必须延迟到滑动结束再切，否则抽屉会「瞬间消失」再滑。
   展开时立刻 visible（0s 延迟），收起时延后 0.18s。 */
[data-role="ai-drawer"] {
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), visibility 0s linear 0s;
  visibility: visible;
}
[data-role="app"][data-ai-open="false"] [data-role="ai-drawer"] {
  visibility: hidden;
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), visibility 0s linear 0.18s;
}
```

（既有 `[data-role="ai-drawer"]` 块里已有 `transition: transform 0.18s …`，就地改写成上面两属性的版本，不要留两条 transition 打架。）

**改** `app/app.js` `applyAiOpen(open)`（现约 :508-517）：`app/app.js:23` 已用 `const aiDrawerHost = document.querySelector('[data-role="ai-drawer"]');` 拿到抽屉 DOM，直接用它：

```js
function applyAiOpen(open) {
  root.setAttribute("data-ai-open", open ? "true" : "false");
  if (aiDrawerHost) {
    // 三重关死：inert 挡聚焦与点击，aria-hidden 挡读屏，CSS visibility 兜底旧 WebView2。
    // 只靠 transform 挪出视野不够 —— 实测收起后 agent-input 仍持焦点、打字可发。
    if (open) {
      aiDrawerHost.removeAttribute("inert");
      aiDrawerHost.removeAttribute("aria-hidden");
    } else {
      aiDrawerHost.setAttribute("inert", "");
      aiDrawerHost.setAttribute("aria-hidden", "true");
      const active = document.activeElement;
      if (active && aiDrawerHost.contains(active)) {
        try { if (aiHandle) aiHandle.focus(); } catch { /* 忽略 */ }
      }
    }
  }
  if (aiHandle) {
    aiHandle.setAttribute("aria-expanded", open ? "true" : "false");
    aiHandle.setAttribute("title", open ? "收起 AI 助手" : "打开 AI 助手");
  }
}
```

**同时**在初始化时确保收起态就已关死：`app/app.js` 启动末尾（`aiDrawer.init()` 附近）调一次 `applyAiOpen(store.getSnapshot().aiOpen === true)`。

# 7. 执行步骤（按序，每步跑对应单测再进下一步）

1. 读 `VERIFY-V4-G.md §4`、`docs/PROTOCOL-AGENT.md §5`、`src/policy/{classify,allowlist,forbidden}.mjs`、`src/ai/{allowlist,judge}.mjs`、`src/server/{auth,http}.mjs`、`src/fs/local.mjs`、`src/server/routes/fs.mjs`、`app/ui/settings-panel.js`、`app/app.js`。
2. 建 `src/policy/segments.mjs`（搬 `splitSegments`），改 `classify.mjs` import；跑 `node --test test/policy/classify.test.mjs --test-force-exit` 必须仍 60/60。
3. 改 `src/ai/allowlist.mjs`，补 A1–A8 测试；跑该文件。
4. 建 `src/policy/sensitive.mjs` + `test/policy/sensitive.test.mjs`（S1–S6）；跑该文件。
5. 改 `classify.mjs` 加 `READ_HEADS` 敏感路径拦截，补 S7–S10；跑 classify 测试。
6. 改 `judge.mjs`（敏感路径前置 + `UNREVIEWABLE_HITS`），补 S11/J1–J4；跑 judge 测试（现有 27 条必须继续绿）。
7. 改 `forbidden.mjs`（归一化 + cmd/PS 删除 + chmod 根），补 F1–F14 + P1-2 集成测试；跑 forbidden + judge。
8. 改 `auth.mjs` 加 `isNavigationRequest`，改 `http.mjs` 根路径分支，补 N1–N6；跑 auth 测试（现有 32 条必须继续绿）。
9. 改 `fs/local.mjs`（realpath），补 L1–L7；跑 fs 测试。
10. 改 `settings-panel.js` + `app.js` + `components.css`（焦点两项）。
11. 跑全量：`timeout 240 D:/nodejs/install/node.exe --test`（裸跑、不带路径参数），要求 fail 0。
12. 跑 `DOCTOR_PORT=3485 timeout 200 D:/nodejs/install/node.exe scripts/doctor.mjs`，要求 33/33。
13. 写 `REPORT-V4-S.md`（见 §15），标「待验收」，**不要 commit**。

# 8. 示例与模板

## 反面示例（会被 AC 判失败）

```js
// ❌ 在白名单里加黑名单兜底：`mkdir && rm` 的 head 是 mkdir，仍会命中
if (command.includes("&&")) return null;   // 也太粗暴：`mkdir a && mkdir b` 该放行
```

```js
// ❌ 只判第一个 token 的路径
const first = args[0];
if (isSensitivePath(first)) ...           // `head -c 100 secrets.key` 会漏
```

```js
// ❌ 归一化只去掉尾部斜杠
const t = target.replace(/\/+$/, "");     // `~/.`、`/tmp/../..`、`$HOME/` 都还漏
```

## 正面示例

```js
// ✅ 切段后逐段比，任一段不命中整条不命中
const split = splitSegments(command);
if (!split.ok) return null;
return allowlist.some(entry => split.segments.every(s => segmentMatches(s, entry.pattern, entry.mode)));
```

```js
// ✅ 归一化用 path.posix.normalize 处理 ..
const normalized = path.posix.normalize(text.replace(/\\/g, "/"));
```

# 9. 执行约束

1. **全新会话**，只按本卡执行；不得直接问人类；不做卡外决策，遇到需要取舍的地方返回 `needs_clarification`。
2. **测试跑法硬规则**（此项目踩过两次坑）：
   - 全量必须**裸跑**：`timeout 240 D:/nodejs/install/node.exe --test`（cwd 是仓库根，**不带任何路径参数**）。带路径参数会让 node v24 把路径当模块解析。
   - 单文件：`timeout 120 D:/nodejs/install/node.exe --test --test-force-exit test/policy/xxxx.test.mjs`
   - **90 秒不返回立刻 `taskkill /PID <pid> /T /F` 杀掉那一支，换别的文件跑，禁止换写法反复重试同一命令。**
   - 已知基线 flaky（`test/ssh/registry.test.mjs` 的「建连后立刻 close」、`test/pty/session.test.mjs` 整文件）**不许追、不许跑 10 次以上**；只要全量跑出 `fail 0` 就记通过。
3. 前端改动**不许**换掉任何 `data-role` 名字；**不许**改 `app/vendor/`。
4. 每处改动都要有注释写清「为什么」，用中文，面向后来维护者（参考现有代码的注释风格）。
5. 交付前按使用者视角自查：
   - 若你在浏览器里走查，用 `http://127.0.0.1:<新端口>/`，**不要碰 3480**（那是用户正在用的宿主）。
   - 探针脚本放 `.dispatch/v4s-probe/`，**探针必须 `process.exit(0)` 结尾**，否则会让你的 bash 调用永久挂住（此项目已发生过两次，各挂 20+ 分钟）。
   - CDP 客户端只有 `send/close`，敲键必须 `client.send("Input.insertText")` + `client.send("Input.dispatchKeyEvent", {...})` 三段（keyDown / char / keyUp）。
6. 产物标「待验收」，**不许**标「成品」或「已验收」。
7. **不 commit**，**不 push**。

# 10. 验收标准

| 编号 | 级别 | 标准 | 验证方法 | 证据位置 |
|---|---|---|---|---|
| AC1 | 必过 | `Origin: null` + `sec-fetch-mode: cors` 请求 `GET /` → 403，无 ACAO 头，body 不含口令 | 单测 N1 + 真 curl 复现 | 测试输出 |
| AC2 | 必过 | 导航请求（`sec-fetch-mode: navigate`）与无 Sec-Fetch 的 curl 都能拿到 200 + 口令；`/api` 与静态资源的 `Origin: null` 行为不变 | 单测 N2/N3/N6 + 现有 32 条 auth 测试全绿 | 测试输出 |
| AC3 | 必过 | `mkdir -p /tmp/x && rm -rf /tmp/victim`、`; ` 变体、`\| tee` 变体全部**不命中**用户白名单；`mkdir a b`、`mkdir a && mkdir b` 仍命中 | 单测 A1–A8 | 测试输出 |
| AC4 | 必过 | `cat ~/.config/magpie-terminal/secrets.key`、`head -c 100 /home/u/.ssh/id_rsa`、`cat .env` 从 `auto` 变 `confirm`；用户白名单写 `cat` 也不能自动放行 | 单测 S7–S11 | 测试输出 |
| AC5 | 必过 | `cat README.md`、`grep foo src/index.mjs`、`ls -la` 仍 `auto`（无误伤） | 单测 S10 | 测试输出 |
| AC6 | 必过 | 11 条危险删除命令全部 `forbiddenReason !== null`；12 条正常命令全部 `null`；`rm -rf ~/` 在宽松档 + 假审阅 caution 下仍 confirm 且审阅未被调用 | 单测 F1–F14 + P1-2 集成测试 | 测试输出 |
| AC7 | 必过 | `echo hi\nrm -rf /x`、`ls > out.txt`、`echo $(rm -rf x)` 在 balanced + 假审阅 safe 下仍 confirm，且审阅未被调用 | 单测 J1–J3 | 测试输出 |
| AC8 | 必过 | 设置页打开后焦点在模态内（`document.activeElement` 在 `[data-role="settings-backdrop"]` 内）；此时 CDP 敲 `echo ok > ~/SETTINGS_LEAK_<ts>.txt` **不生成文件**；对照组（焦点在终端时）同命令**生成文件** | 真浏览器 CDP 探针（带对照组） | 探针输出 + 截图 |
| AC9 | 必过 | 抽屉收起后 `agent-input` 的 `inert` 为 true、`aria-hidden="true"`、computedStyle `visibility: hidden`；此时 CDP 聚焦该输入框并打字 20 字符，其 `value` 仍为空 | 真浏览器 CDP 探针 | 探针输出 |
| AC10 | 必过 | 全量测试 `fail 0`（裸跑） | `timeout 240 D:/nodejs/install/node.exe --test` | 原始输出落盘 |
| AC11 | 必过 | doctor 33/33 | `DOCTOR_PORT=3485 ... scripts/doctor.mjs` | 原始输出落盘 |
| AC12 | 必过 | 终端 / 远程 SSH / 文件面板 / AI 抽屉无回归 | 真浏览器走查：新建标签、敲 `echo` 有回显；点文件面板列出目录；点抽屉把手展开/收起 | 截图 + 探针输出 |
| AC13 | 加分 | 敏感路径表覆盖 `%USERPROFILE%`、`.config/gcloud` 形态 | 单测 | 测试输出 |

# 11. 核验要求

自测（你）：AC1–AC13 全部实际执行，原始输出落 `.dispatch/v4s-probe/`。

独立核验（另一个会话，不是你）：会重跑 AC3/AC4/AC6/AC7 的单测、AC1 的 curl 复现、AC8/AC9 的 CDP 探针，并主动找「修了 A 但把 B 弄坏」的回归。

# 12. 交付物

1. 代码改动（§4 列的文件）
2. `.dispatch/v4s-probe/` 下的探针脚本与原始输出
3. `REPORT-V4-S.md`：9 项逐条「改了什么文件哪几行 + 哪个测试证明了它」+ 全量测试与 doctor 原始数字 + 打折项（没做到/做不好的地方如实列）
4. 白话总结（不超过 200 字，面向不懂命令行的用户）

# 13. 风险与回退

- **风险 1**：`splitSegments` 抽取改动 `classify.mjs` 的 428 行核心逻辑 → 现有 60 条 classify 测试是回归网，第 2 步后必须立刻跑。
- **风险 2**：`isNavigationRequest` 判太严会让 magpie 里的合法页面打不开 → AC2 的 N2 用真请求头模拟，且必须由主 agent 在真 magpie 窗口复核。
- **风险 3**：敏感路径表过宽会误伤日常命令（例如 `grep` 扫整个仓库时命中 `AppData/Local/hermes`）→ AC5 兜住；若发现更多误伤，**加豁免要写进 REPORT，不许默默放过**。
- **风险 4**：`inert` 在旧 WebView2 上不支持 → CSS `visibility: hidden` 是兜底，两条都要有。
- 回退：每项独立，可单项 revert。全量 `git checkout -- <file>` 即可。

# 14. 澄清记录

无。用户已批准本卡范围（m05441「A」）。

# 15. 执行报告要求

`REPORT-V4-S.md` 必须含：

1. 9 项逐条：改的文件与行号、证明它的测试编号、单测输出摘要
2. 全量测试原始数字（`tests / pass / fail / duration_ms`）+ doctor 原始数字（`passed / assertions`）
3. 真浏览器探针结果（AC8 对照组、AC9、AC12）
4. 打折项：任何「做到了但打了折扣」的地方，逐条列（例如「inert 在 xx 情况下没生效」「junction 建不出来所以 L2 跳过」）
5. 未执行清单：任何没跑的项，写清原因与影响
6. 白话总结（≤200 字）
7. 返回 JSON（按派发指令要求的格式）
