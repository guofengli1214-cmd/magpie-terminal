# 平台笔记：magpie 页面插件（magpie-terminal）

> 状态：0.3.0 已实现。本文记录 **magpie 平台** 的硬事实与本项目的对接约定，平台事实来自本机实测（2026-11-22）。读代码前先读这一份，能省掉大半试错。

术语统一见 README：「宿主」= magpie 本体，「插件宿主」= `magpie-bun.exe` 进程，「应用服务」= 本项目在 `127.0.0.1:3480` 上的 HTTP+WS。

---

## 1. magpie 平台事实

| 项 | 值 |
|---|---|
| 版本 | `v0.1.4015` |
| 主程序 | `C:\Users\41807\Downloads\magpie-windows-amd64 (1).exe`（运行中；gateway 进程 pid 18560） |
| 日志 | `C:\Users\41807\AppData\Local\magpie\logs\app.log` |
| 配置目录 | `C:\Users\41807\.config\magpie\` |
| 命令行 | `magpie plugin --help` 可用；子命令 `add <name\|npm\|git\|path>`、`list --json`、`rm`、`update`、`on`、`off`、`options` |
| 窗口技术栈 | Wails v3 over WebView2，origin `http://wails.localhost` |
| 插件宿主运行时 | `C:/Users/41807/.cache/magpie/bun/{1.4.4,1.4.5}/magpie-bun.exe`（**可执行名是 `magpie-bun.exe`，不是 `bun.exe`**），`state.json` 当前 `1.4.5` |
| 宿主脚本 | `C:/Users/41807/.cache/magpie/plugin-host/host-*.js` |

### 1.1 配置目录里每个文件管什么

| 路径 | 内容 | 对本项目的意义 |
|---|---|---|
| `plugins.json` | 已安装插件清单，结构 `{"plugins":[{"spec":"<pkg>@latest"}, …]}`，当前 7 条 | `magpie plugin add` 写这里；`plugin list --json` 读这里 |
| `plugins.yml` | 内置插件的开关与配置（`preset: all`、`settled: 1`） | 与页面插件无关，不要改 |
| `plugins/package.json` | 插件宿主的依赖清单（Bun 视角的「workspace 根」） | 本项目的依赖解析落在这个 `node_modules` 下 |
| `plugins/bun.lock` | 上面那份依赖的锁文件 | 决定宿主侧装到的依赖版本；本项目改用自带 `node_modules`（纯 JS 包，见 `package.json`） |
| `plugins/node_modules/` | 已存在 `node-pty@1.2.0-beta.15`、`ws@8.22.0`、`zod@4.6.7`、`ignore@7.0.14`、`node-addon-api@7.1.1`、`@agentclientprotocol/sdk` 与 7 个 `@magpie-community/*` 插件 | 宿主自己的依赖。0.3.0 起本项目不再依赖其中的 `node-pty`，自带 `node_modules`（纯 JS 包） |
| `plugins/dist/*.tgz` | 各插件的打包产物 | 与本项目无关（本地路径安装不经过 tgz） |
| `gateway.json` | `{"addr":"[::]:3425","pid":18560,"serves":"tray","version":"0.1.4015",…}` | 网关端口的**唯一**来源 |
| `settings.json` | 主题、语言、托盘、redact、lan 等 UI/行为设置 | **里面没有 port 字段**；不要以为能从这读到网关端口 |
| `routing/` | 按天轮转的请求路由日志（`.jsonl` / `.jsonl.gz`） | 排查「AI 请求到底发出去没有」时看 |
| `masking/` | 按天的脱敏日志 | 与本项目无关 |
| `library/` | `library.json` + `skills/`，宿主侧的技能库 | 与本项目无关 |
| `caller-keys.json` | 网关调用凭据，1 条，字段 `id` / `name` / `lan` / `secret` | 插件进程可读；**文档与日志绝不写 `secret` 值** |

### 1.2 端口占用现状（2026-11-22 实测）

| 端口 | 状态 | 占用者 |
|---|---|---|
| 3425 | 已占 | magpie 网关，宿主 pid 18560，监听 `0.0.0.0:3425`（`gateway.json` 写的是 `[::]:3425`） |
| 3477 | 已占 | `page-chat` 的应用服务，`127.0.0.1` |
| 3488 | 已占 | `page-agent-console` 的 gate 进程，`127.0.0.1` |
| 3496 | 已占 | `page-model-quota`，`127.0.0.1` |
| **3480** | **空闲** | **本项目使用** |
| 3466 | 空闲 | — |
| 3478 | 空闲 | — |
| 3490 | 空闲 | — |

证据：`netstat -ano -p tcp | grep LISTENING` 输出里 `3425`/`3477`/`3488`/`3496` 有监听项，其余四个不在列表中。选 3480 的理由见 `docs/architecture.md` 的决策表。

---

## 2. 页面插件机制

插件页**不是普通网页**，宿主把它塞进一个受限 iframe：

```html
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"
        src="http://wails.localhost/_magpie/plugin/<32-hex-token>/<file>">
```

每个页面响应带的 CSP 原文（照抄，不要改写）：

```
sandbox allow-scripts; default-src 'none'; script-src <host>/_magpie/plugin/<token>/; frame-ancestors 'self'
```

由此推出的**硬约束**（这就是整个架构的根因）：

| 约束 | 后果 |
|---|---|
| 无内联脚本（`default-src 'none'` + 只有一条 `script-src` 指向插件目录） | 不能写 `<script>…</script>`，事件处理器属性也不行 |
| 无外部 CDN | xterm.js 等前端依赖**必须打进插件包**，不能 `unpkg` |
| `connect-src 'none'` | **不能 fetch / XHR / WebSocket**，连 `no-cors` 也会被拒 |
| `sandbox="allow-scripts"` 无 `allow-same-origin` | origin 是 opaque（`Origin: null`），不能用 storage、不能读父窗口 |
| `frame-ancestors 'self'` | 只能被 magpie 自己嵌（**这条只约束宿主给 `page/` 带路页发的响应**） |

**所以页面唯一能做的联网动作是 `location.replace()` 跳到自己的本地服务**——这就是「带路页（boot page）」模式的根因，不是风格选择。

> **第 6 轮实测补充（应用页侧，与上面这张表不是同一个响应）**：上面那串 CSP 是**宿主**发给
> `page/` 带路页的。我们**自己的应用页**（3480 发出）如果也照抄 `frame-ancestors 'self'`，
> 会被同一个沙箱 iframe 拦成 Chromium 错误页：
> `Framing 'http://127.0.0.1:3480/' violates the following Content Security Policy directive: "frame-ancestors 'self'"`
> ——沙箱文档是 opaque origin，父页是 `http://wails.localhost`，属于跨源嵌框。
> **应用页的 CSP 必须完全不写 `frame-ancestors`**（官方 page-chat 干脆不发 CSP）；也不要改成
> `frame-ancestors http://wails.localhost`，父页 host 会随平台/版本变。
>
> 同一次实测还确认两件事：①沙箱里 `document.cookie = …` 抛 `SecurityError`，跨源请求也不带
> 我们的 cookie，所以 set-cookie 认证在这个环境里不可行 → 口令改注入 HTML `<meta>`；
> ②`type="module"` 是 CORS 请求，`Origin: null` 时没有 `access-control-allow-origin` 就被拦
> （`blocked by CORS policy`），应用页的静态资源与 `/api/*` 都必须带 CORS 头、`OPTIONS` 先回 204。

### 2.1 bridge.js 与 10 秒定时器

- `_magpie/bridge.js` 加载时**同步** post `{magpie:1, method:"hello"}` 给宿主。
- 宿主在窗口 `open()` 时起 **10 秒**定时器；10 秒内收不到 hello 就报错，页面显示中文「此页面已停止工作」。
- 由此可判断故障层级：**10 秒后报错 = bridge 没跑起来（平台/沙箱问题）**；bridge 正常但页面空白 = 我们自己的服务没起。

---

## 3. `package.json` 的 `magpie` 段

样板：`@magpie-community/page-chat v0.1.14`（`C:\Users\41807\.config\magpie\plugins\node_modules\@magpie-community\page-chat\package.json`），已实测读出的字段如下。

顶层（非 `magpie` 段）：

| 字段 | 值 | 作用 |
|---|---|---|
| `name` | `@magpie-community/page-chat` | 包名；本项目为 `magpie-terminal` |
| `version` | `0.1.14` | 插件版本，`plugin update` 用来比对 |
| `main` | `./index.mjs` | 插件宿主加载的入口 |
| `type` | `module` | ESM；`index.mjs` 里可以直接 `import` |
| `engines.magpie` | `>=0.1.1340` | 宿主版本门槛（page-agent-console 另有 `engines.node: ">=20"`） |

`magpie` 段逐字段（page-chat v0.1.14 实测只有 `icon` / `page` / `options` 三个键；`name` 与 `summary` 用 `page-model-quota v0.1.0` 补齐，两者都是同目录下的已装插件）：

| 字段 | 样板里的值 | 含义 | 本项目的取值 |
|---|---|---|---|
| `magpie.name` | `Model Quota`（page-model-quota；注意 `index.mjs` 里另有 `id`） | 插件显示名 | `magpie-terminal` |
| `magpie.summary.en` / `.zh` | 各一段简介（page-model-quota 有） | 插件列表里的一句话说明 | 英文/中文各一句（文案定稿前写功能描述，不写形容词） |
| `magpie.page.title` | `Chat` | 页面英文标题 | `Terminal` |
| `magpie.page.titles.zh` | `对话` | 中文标题 | `终端` |
| `magpie.page.titles.zh-TW` | `對話` | 繁体标题 | `終端` |
| `magpie.page.titles.ja` | `チャット` | 日文标题 | `ターミナル` |
| `magpie.page.file` | `page/index.html` | 带路页的相对路径 | 同 |
| `magpie.page.icon` | `assets/icon.svg` | 侧栏图标（相对路径） | 同 |
| `magpie.page.service.port` | `3477` | 声明「本插件会在该端口提供服务」，`magpie web` 据此做转发 | `3480` |
| `magpie.page.service.option` | `port` | 端口对应的选项名，改端口时两处联动 | `port` |
| `magpie.options.port` | `3477` | 选项默认值，`options.get()` 读到的就是它 | `3480` |
| `magpie.permissions` | page-chat 未写；page-agent-console 为 `[]` | 权限声明数组 | `[]`（不申请任何平台权限） |
| `magpie.icon` | `data:image/svg+xml;base64,…` | 插件市场/列表用的图标，可内联 data URL | 一个 SVG data URL |

容易踩的三点：

1. **`service` 只是声明，不代建服务。** 宿主不会因为这段配置就监听端口；服务必须由 `index.mjs` 的 `server()` 自己起。反例：`page-agent-console` 干脆不写 `service`，改用 gate 进程做 302 令牌交接。
2. **`service.port` 与 `options.port` 必须同值。** 前者给宿主做转发，后者给带路页读；不一致会出现「跳过去是 3477、服务在 3480」这种只有日志能解释的空白页。
3. **`engines.magpie` 要照抄 `>=0.1.1340`。** 本机是 0.1.4015，门槛写高了会直接装不上。

---

## 4. `index.mjs` 契约

样板（page-chat v0.1.14 的 `index.mjs`，已实读）：

```js
let started = null;
function start(options) {
  if (!started) { started = startServer({ options }).then(...).catch(...); }
  return started;
}

export default {
  id: "magpie-chat",
  server: async (input, options) => {
    await start(options);
    return {};          // ← 返回空对象
  },
};
```

规则逐条：

| 规则 | 为什么 |
|---|---|
| 必须 `export default { id, server }` | 宿主按这个形状找插件；`id` 用于日志与去重 |
| 其它导出会被当成插件 | page-chat 的注释写明「magpie 会把每个导出的函数当成一个插件调用」，只导出 default |
| **`server()` 首次调用才懒起服务** | 单纯 `import` 模块不该占端口；`started` 单例保证只起一次 |
| `server()` 的 `options` 就是 `magpie.options` 的合并结果 | 端口从这里读，别去读 `settings.json`（里面没有 port） |
| 宿主**从不调用 `stop()`**，把返回值当 OpenCode hooks | 所以不能靠 `stop()` 做清理，返回值保持 `{}` |
| 宿主关 stdin 后直接 `process.exit()` | 没有优雅关闭窗口；退出兜底要同步做（`close()` 打开的 SSH 连接与 WS） |
| **不要注册 `SIGINT`/`SIGTERM`** | 宿主直接 `process.exit()`，信号处理器不会被走到，写了只会造成「以为清了其实没清」的错觉 |
| 端口被上一个宿主占着时不要抛错阻塞启动 | page-chat 的做法：`info.ready.then(...)` 后台等它松手，宿主先起来 |

---

## 5. 带路页模板

`page/index.html` 只做三件事：引 `bridge.js`、引 `boot.js`、显示状态文案。CSP 不允许内联脚本，所以脚本必须是独立文件。

`boot.js` 的取参流程（顺序不能变）：

```js
// 伪代码：只表达取参顺序，不是实现
const t = await window.magpie?.ready;            // { dark, lang, tokens }
const s = window.magpie?.service;                // magpie web 的转发地址，可能是 undefined
const o = await window.magpie?.options?.get?.(); // { port, … }
// port = Number(o.port) > 0 ? Number(o.port) : 3480
location.replace(`http://127.0.0.1:${port}/?theme=…&tokens=<base64 JSON>`);
```

要点：

| 点 | 说明 |
|---|---|
| **直接跳，不要先探测** | `connect-src 'none'` 下 `alive()` 永远返回 false，先探测会让页面永远停在等待页（page-chat 的 `boot.js` 注释就是这条教训） |
| `theme` / `tokens` 一起带上 | `tokens` 是 magpie 算好的 CSS 变量，base64 后放 query；带上它终端配色/字体才跟窗口一致 |
| **5 秒兜底** | WebKit 在目标不可达时不报错，`location.replace()` 失败也当没事。5 秒后如果这份文档还活着，就把文案换成「本地服务没有在运行（127.0.0.1:3480）」+ 一个「重试」按钮（`location.reload()`） |
| 非 loopback 提示 | `magpie web` 从另一台机器打开时，那台的 `127.0.0.1` 不是跑服务的机器；此时显示 SSH 端口转发命令 `ssh -N -L 3480:127.0.0.1:3480 <用户名>@<host>` 和一个「继续」按钮，不要直接跳（否则是 `ERR_CONNECTION_REFUSED`） |
| `location.hostname` 判断 | `""`、`localhost`、`*.localhost`、`::1`、`127.*` 视为 loopback |
| 字体不要从页面读 | page-chat 试过读 `--ui-font`，但 magpie 在设置加载完成后才写该变量，`magpie.ready` 之后立刻读经常是空，且 CSP 下无法重试。本项目由服务端读配置后经 `/api/*` 下发 |

---

## 6. WebView2 已知故障（专章）

这是**平台级**故障，与本插件代码无关。遇到时不要改本插件的任何文件。

### 6.1 症状指纹

| 观察点 | 故障时的表现 |
|---|---|
| 插件页 | **所有**页面插件（对话、模型额度、Agent 控制台、终端……）**同时**报「此页面已停止工作」 |
| magpie 自带页（设置、模型列表等） | 正常 |
| 宿主日志 `app.log` | 健康：该有的 `plugin: [<name>] listening on http://127.0.0.1:<port>` 都在 |
| 直接用浏览器打开 `http://127.0.0.1:3480` | 正常可用 |

三条同时成立才判定为这个故障。**只有本插件一页坏 → 是本插件的问题**，走第 8 节的排查。

### 6.2 根因

WebView2 132+ 会把**缺 `allow-same-origin` 的沙箱 iframe 隔离成 OOPIF**（out-of-process iframe，独立渲染进程）。Wails 只注册了旧的 `AddWebResourceRequestedFilter`，看不到那个子进程发出的请求 → 子资源请求直接走网络 → `ERR_CONNECTION_REFUSED` → bridge 的 hello 到不了 → 10 秒后报「此页面已停止工作」。

注意：`sandbox="allow-scripts"`（不给 `allow-same-origin`）是 magpie 的安全设计，**我们不能为了绕故障去加 `allow-same-origin`**——那等于自己拆掉沙箱。

### 6.3 规避办法（仅 workaround，不是修复）

```bat
setx WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS "--disable-features=IsolateSandboxedIframes"
```

然后从**托盘完全退出** magpie 再重新打开（只关窗口不算）。`setx` 写的是用户级环境变量，新启动的进程才读得到。

### 6.4 这是安全让步，必须知情

该变量对**全机所有 WebView2 应用**生效（不只 magpie），等于全局关掉了沙箱 iframe 的进程隔离。它会削弱浏览器侧针对恶意 iframe 的防护。请在确认这是本机个人开发环境后再用；共享机器或需要跑不可信页面的机器不要用。

### 6.5 撤销

```bat
reg delete HKCU\Environment /v WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS /f
```

撤销后同样要完全退出并重开 magpie。

### 6.6 红线

> **禁止改插件文件、禁止重装插件。**

理由：故障在 WebView2 的进程模型，插件文件里改不出解；改文件只会让「本插件的问题」和「平台的问题」混在一起，重装还会把已经调好的 `options.port` 冲掉。

---

## 7. magpie 网关

| 项 | 值 |
|---|---|
| 地址 | `http://127.0.0.1:3425` |
| 协议 | OpenAI 兼容（`/v1/chat/completions`、`/v1/models`） |
| 鉴权 | **loopback 请求不校验 `Authorization`**（实测：不带 header 与带 `Bearer nonsense` 都返回 200）；非 loopback 走 `caller-keys.json` |
| `/v1/models` 实测 | HTTP 200，2026-11-22 实测 **6 个模型**，逐个为 `shuaiapi/gpt-6-luna`、`shuaiapihermes/gpt-6.2-sol`、`commandcode/deepseek/deepseek-v4.1-flash`、`commandcode/recursive/flint-v1.0:free`、`commandcode/stealth/glyph-cluster:free`、`anyrouter/claude-fable-5-2`；响应结构 `{data, first_id, has_more, last_id, object}`，`has_more: false` |
| 模型数量会变 | 更早一次记录为 **7 个**（多出的那个已被下线），2026-11-22 实测为 6 个。**模型清单不是契约**，代码里不要写死数量或顺序，用 `/v1/models` 探活即可 |

### 7.1 caller-keys.json

| 项 | 值 |
|---|---|
| 路径 | `C:/Users/41807/.config/magpie/caller-keys.json` |
| 结构 | 数组，当前 1 条 |
| 字段 | `id` / `name` / `lan` / `secret`（`secret` 长度 62、前缀 `sk-`） |
| 谁能读 | 插件进程可读（同用户权限） |
| 文档纪律 | **只写文件名与字段名，绝不写 `secret` 值**；日志里也不要打印 |

本项目的 AI 栏走 loopback（`127.0.0.1:3425`），按实测不需要带 `Authorization`；但**不要依赖这一点写死**——如果将来 `lan` 模式打开，鉴权要求会变。实现上按「能拿到 key 就带上」处理，拿不到则退化为不带头（T2 定稿）。

---

## 8. 排查顺序（建议照这个走）

1. `app.log` 有没有 `plugin: [magpie-terminal] listening on http://127.0.0.1:3480`？没有 → 服务没起来，看同一日志里 `[magpie-terminal]` 的错误。
2. 有 listening 行，但页面空白 → 用浏览器直接开 `http://127.0.0.1:3480/?theme=dark`：能开 = 平台/沙箱问题（第 6 节）；打不开 = 服务问题。
3. 浏览器也打不开 → 查 3480 是否被占（`netstat -ano -p tcp | grep :3480`）、token/Host 校验是否误判（403 而不是连接失败）。
4. 所有插件页一起坏 + 自带页正常 → 第 6 节，别改代码。

---

## 9. 待定

| 项 | 说明 |
|---|---|
| 网关在 `lan` 模式下的鉴权要求 | 本轮只验证了 loopback 不校验；`lan` 打开后是否强制 `Authorization` 未实测 |
| `/v1/models` 的稳定数量 | 会变：2026-11-22 实测 6 条、更早 7 条。代码只断言 HTTP 200 与 data[] 非空，不写死数量 |
| `magpie web` 转发下 WS 是否可用 | 已知 `service` 声明可做 HTTP 转发，WS 升级是否透传未实测 |
