# 简报：magpie-terminal 文档编写（唯一事实源）

> 本文件是写文档时唯一可信的事实来源。所有数字、路径、行为都来自本机实测，**不得改写、不得补充你没读到的数字**。
> 写文档时若发现本简报没覆盖的信息，不要编，在返回 JSON 的 `gaps` 里列出来。

---

## 1. 项目身份

| 项 | 值 |
|---|---|
| 仓库目录 | `C:/Users/41807/magpie-terminal` |
| git 状态 | 已 `git init`，分支 `master`，**尚无任何提交** |
| npm 包名 | `magpie-terminal`（不发布到市场，用本地路径安装） |
| 插件页面标题 | 中文「终端」，英文 `Terminal`；`titles` 另给 `zh-TW: 終端`、`ja: ターミナル` |
| 中文一句话定位 | 在 magpie 窗口里放一个真终端，右侧配一个会说中文的 AI 命令助手 |
| 参考项目 | `github.com/chaterm/Chaterm`（只借鉴产品形态与「每步可审核」交互，**不移植任何代码**） |
| 质量对标 | 同机已装的 `@magpie-community/page-agent-console` v1.3.9（同为 magpie 页面插件、同 Bun 宿主 + node-pty + 终端面板）——借鉴 PTY 生命周期处理、无 PTY 降级、token 门禁；**不照搬**它的 React 三栏 Agent 时间线 |

---

## 2. magpie 平台硬事实（本机实测，v0.1.4015）

- 主程序：`C:\Users\41807\Downloads\magpie-windows-amd64 (1).exe`，运行中。
- 命令行：`magpie plugin --help` 可用，子命令 `magpie plugin add <name|npm|git|path>`、`plugin list --json`、`plugin rm|update|on|off|options`。
- 配置目录：`C:\Users\41807\.config\magpie\`
  - `plugins.json`（已装 7 个插件）、`plugins.yml`（`preset: all`）、`plugins/`（`package.json` + `bun.lock` + `dist/*.tgz` + `node_modules/`）、`gateway.json`（`{"addr":"[::]:3425"}`）、`routing/`、`masking/`、`library/`。
  - **`settings.json` 里没有 port 字段**，网关端口来自 `gateway.json`。
- 日志：`C:\Users\41807\AppData\Local\magpie\logs\app.log`
  - 健康标志行：`plugin: [<name>] listening on http://127.0.0.1:<port>`
- 端口现状：3425 网关（宿主 pid 18560）、3477 page-chat、3488 agent-console 的 gate、3496 model-quota；**3480 / 3466 / 3478 / 3490 空闲**。本项目用 **3480**。
- 插件宿主运行时：`C:/Users/41807/.cache/magpie/bun/{1.4.4,1.4.5}/magpie-bun.exe`（注意可执行名是 `magpie-bun.exe`，不是 `bun.exe`）；`state.json` 当前 1.4.5。宿主脚本在 `C:/Users/41807/.cache/magpie/plugin-host/host-*.js`。
- 网关：OpenAI 兼容，`http://127.0.0.1:3425`；`GET /v1/models` 实测 HTTP 200；2026-11-22 复核为 **6 个模型**（更早一次记录为 7 个，模型清单会变，不是契约）：`shuaiapi/gpt-6-luna`、`shuaiapihermes/gpt-6.2-sol`、`commandcode/deepseek/deepseek-v4.1-flash`、`commandcode/recursive/flint-v1.0:free`、`commandcode/stealth/glyph-cluster:free`、`anyrouter/claude-fable-5-2`；**loopback 请求不校验 Authorization**。
  - ⚠ 补充实测（2026-11-22 主 agent 亲验 `netstat -ano`）：网关实际监听的是 **`0.0.0.0:3425` 和 `[::]:3425`（pid 18560）**，不是只绑 loopback —— 意味着**局域网内其他机器也能连到这个网关**。写安全文档时必须如实写出这条，不能写成「只听本地」。
- 插件页服务地址：长期运行的服务是 `127.0.0.1:3477`（page-chat）、`127.0.0.1:3488`（agent-console gate）、`127.0.0.1:3496`（model-quota），都由**同一个插件宿主 pid 14216** 监听。`magpie plugin list --json` 会在临时宿主里再起一份（日志里出现过 61541/61542 这类临时端口），那些是 list 命令的一次性实例，不是常驻服务 —— 别把 61541/61542 当成真实端口写进文档。
- 凭据文件：`C:/Users/41807/.config/magpie/caller-keys.json`（1 条，字段 `id`/`name`/`lan`/`secret`，secret 长度 62、前缀 `sk-`），插件进程可读；**文档里绝不写 secret 值**。

### 2.1 页面插件机制（决定了整个架构，必须准确）

- magpie 窗口是 Wails v3 over WebView2（origin `http://wails.localhost`）。
- 插件页不是普通网页：宿主渲染成 `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">`，`src` 为 `<host>/_magpie/plugin/<32-hex-token>/<file>`。
- 每页响应头 CSP：`sandbox allow-scripts; default-src 'none'; script-src <host>/_magpie/plugin/<token>/; frame-ancestors 'self'`
  - 这是**宿主发给 `page/` 带路页**的 CSP。第 6 轮实测：我们自己 3480 发出的应用页**不能**带
    `frame-ancestors`，否则在 `<iframe sandbox="allow-scripts">`（opaque origin，父页 `http://wails.localhost`）
    里被拦成 Chromium 错误页；同时该沙箱里 `document.cookie` 抛 `SecurityError`（认证不能用 cookie）、
    `type="module"` 是 CORS 请求（静态资源与 `/api/*` 必须带 `access-control-allow-origin`）。
  → **无内联脚本、无外部 CDN、`connect-src 'none'`（不能 fetch/XHR/WebSocket）**。
- 因此页面唯一能做的联网动作是：`location.replace()` 跳到自己的本地服务。这就是「带路页（boot page）」模式的根因。
- `_magpie/bridge.js` 加载时同步 post `{magpie:1, method:"hello"}`；窗口 `open()` 起 **10 秒**定时器，收不到 hello 就报错（中文「此页面已停止工作」）。
- `package.json` 的 `magpie` 段是规范核心。样板（page-chat v0.1.14）：
  `magpie.name` / `magpie.summary.{en,zh}` / `magpie.page.{title,titles.{zh,zh-TW,ja},file:"page/index.html",icon,service:{port:3477,option:"port"}}` / `magpie.options.{port:3477}` / `magpie.permissions` / `magpie.icon`；另有 `engines.magpie >= 0.1.1340`、`main: ./index.mjs`、`type: module`。
- `index.mjs` 约定：`export default { id, server: async (input, options) => { ...; return {}; } }`；**首次调用 `server()` 才懒起本地服务**。
- `page/index.html` + `page/boot.js` 带路页做法：`await window.magpie.ready` 取 `{dark,lang,tokens}` → 读 `window.magpie.service` → `window.magpie.options.get()` 取 port → `location.replace("http://127.0.0.1:<port>/?theme=…&tokens=<base64 JSON>")`；5 秒兜底显示「本地服务没有在运行」+ 重试按钮；非 loopback 时给 SSH 端口转发提示。
- page-agent-console 的补充事实：`magpie.page` **不写** service 字段，改用 gate 进程 302 令牌交接；`server()` 生成两个随机密钥（gate key 写进 `page/session.js`，daemon token 只经 302 的 `#` fragment 交接、不落静态文件）；daemon 只在页面导航到 `/open?k=<key>` 时启动（非 detached 子进程 + stdin lifeline + `--parent-pid`），空闲 **60 分钟**自退；**宿主把 `server()` 返回值当 OpenCode hooks、从不调用 `stop()`**，宿主在 magpie 关 stdin 后直接 `process.exit()`，所以要靠同步退出兜底；不要注册 SIGINT/SIGTERM。

### 2.2 已知平台故障（运维必读）

WebView2 132+ 会把缺 `allow-same-origin` 的沙箱 iframe 隔离成 OOPIF，Wails 只注册了旧的 `AddWebResourceRequestedFilter`，看不到该进程请求 → 子资源走网络 ERR_CONNECTION_REFUSED → 10 秒后报「此页面已停止工作」。
指纹：**所有**插件页同时坏、magpie 自带页正常、宿主日志健康。
规避（仅 workaround）：`setx WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS "--disable-features=IsolateSandboxedIframes"` + 托盘完全退出后重开（用户级变量，影响全机 WebView2 应用，属安全让步）；撤销 `reg delete HKCU\Environment /v WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS /f`。
**禁止的做法：改插件文件、重装插件。**

---

## 3. 依赖与实测结论（PTY 可行性，已跑通）

- 运行时：node `v24.16.0`、npm `11.13.0`、python `3.14.9`；`bun` 不在 PATH（用 `magpie-bun.exe`）。
- `C:\Users\41807\.config\magpie\plugins\node_modules\` 里**已经存在**：`node-pty@1.2.0-beta.15`（含 `prebuilds/win32-x64`、`win32-arm64`、`darwin-*`、`linux-*`，无 `bin` 字段）、`ws`、`zod`、`ignore`、`node-addon-api`、`@agentclientprotocol/sdk`。
- node-pty 1.1.0 纯预编译安装，**不需要 node-gyp、不需要 VS Build Tools**。
- `magpie-bun` 1.4.4 与 1.4.5 均能 `import node-pty` 并 spawn；`stty size` 回读 `30 100`、`isatty` 为 true、resize 到 `40 132` 真实生效。
- `@lydell/node-pty@1.2.0-beta.18` 在 bun 下 import/spawn/读写/resize 全通（备选）。
- 降级方案（无 PTY 时）：常驻 `bash.exe` + `printf '__DONE_%s__\n' "$?"` 哨兵法，可流式读回、精确判结束、拿真实退出码（`nosuchcmd_xyz` → 127）。**但没有 TTY**，全屏 TUI（vim/top）不能用。

### 3.1 三个必修坑（写进 spec，子 agent 必踩）

1. **resize 后第一个输入字节被吞**：Windows ConPTY 缺陷，`node-pty` 与 `@lydell/node-pty` 均复现。对策：`resize()` → 先发一个垃圾 `'\r'` → 等 **250–500ms** → 再接受真实输入（实测 10/10 干净）。
2. **shell 自己退出时不补 `kill()`，进程永不退出**：实测 15 秒仍存活。机制是只有 `kill()` 才走 `_conoutSocketWorker.dispose()`。对策：`onExit` 里无条件 `kill()`；注意 `windowsPtyAgent.js:23` 的 `FLUSH_DATA_INTERVAL = 1000`，`kill()` 后进程约 **1.07 秒**才真正消失，别在这 1 秒内断言"已清理"。
3. **Bun 会静默装错版本**：没有本地 `node_modules` 时，Bun 从全局缓存装 `node-pty@1.1.0` 并刷一屏 `AttachConsole failed` 噪声。对策：锁本地依赖 + 启动时断言实际加载版本。

---

## 4. 成品形态（方案 v1，已与用户确认方向）

magpie 侧栏多一页「终端」。打开是整页终端：

```
┌ 标签栏： [ bash: ~/project ×] [ bash: ~/huoshu ×] [+]
├──────────────────────────────────┬──────────────┐
│                                  │  AI 栏        │
│   xterm.js 真终端（主区）          │  「看看谁占   │
│                                  │   着 3480」   │
│                                  │  → 建议命令   │
│                                  │  [执行][复制] │
└──────────────────────────────────┴──────────────┘
```

- 多标签，每个标签独立 PTY、独立 cwd。
- 窗口主题（明/暗）与字体跟随 magpie 传入的 `tokens`。
- AI 栏：说中文需求 → 结合「当前 cwd + 终端最近输出 + shell 类型」给出命令；只读命令自动执行，危险命令弹确认卡。

### 4.1 安全模型（已定，不得放宽）

- 应用服务只监听 `127.0.0.1:3480`。
- 每个请求校验 `Host` 必须等于 `127.0.0.1:3480` 或 `localhost:3480`（防 DNS 重绑定）。
- 进程内随机 token（32 字节 hex）写进页面，每个 `/api/*` 与 WS 升级都要带，`timingSafeEqual` 比对。
- `Origin` 只放 `undefined` / 字面量 `"null"`（沙箱 iframe 的 opaque origin 就是 `null`）/ 自身。
- 命令分级（fail-closed）：按 `&& || ; |` 切段 → 每段命令头查只读白名单 → 出现 `>` 重定向、命中黑名单（`rm`/`mv`/`del`/`cp`/`npm i`/`pip install`/`git push`/`git reset`/`sudo`…）、或切不开 → **一律弹确认**。
- 用户手敲的命令永远直接执行（那是他自己的终端）。

---

## 5. 三阶段与验收

| 卡 | 范围 | 出口条件 |
|---|---|---|
| **T1** 骨架 + 真终端 | 插件包、`package.json` 的 `magpie` 段、`index.mjs` 起 3480 服务、带路页、xterm.js UI、多标签、主题同步、无 PTY 降级 | 能 `magpie plugin add` 装上；`app.log` 出现 `plugin: [magpie-terminal] listening on http://127.0.0.1:3480`；侧栏有「终端」；浏览器里能敲命令 |
| **T2** AI 栏 + 分级执行 | 网关客户端（`/v1/models` 探活 + 聊天补全）、上下文采集、命令抽取、白名单分级、自动跑 / 确认卡、输出回喂继续解释 | AI 说一句 → 命令真跑出来，输出可见 |
| **T3** 打磨 | 快捷键、命令历史、错误提示、README/安装/卸载/端口/权限、自测脚本 | 可交付 |
| **V1** 独立核验 | 真浏览器驱动关键路径 + 分级器单测 + 安全边界 + 孤儿进程检查 | 核验原始结果落盘 |

### 5.1 必过验收 7 条

1. 装得上；`app.log` 出现 `plugin: [magpie-terminal] listening on http://127.0.0.1:3480`；侧栏有「终端」入口。
2. `cd` / `ls` / `echo hi` 有真实输出；`vim` 能开能退（真 TTY 证据）。
3. resize 后连敲 10 次不丢字符（对应坑 1）。
4. 说「看看谁占着 3480」→ 只读命令自动执行、输出可见。
5. AI 给出删除类命令 → 弹确认卡，不点不动。
6. 伪造 `Origin` / 错 `Host` / 缺 token 全部 403。
7. 关标签、退 magpie 后无孤儿 shell（pid 核验，对应坑 2）。

### 5.2 非目标（写文档时要明确排除）

- 不做多主机 SSH / 堡垒机。
- 不发布到插件市场。
- 会话不跨 magpie 重启保留。
- 不做内联 Ghost text 命令推荐。

### 5.3 已知无法程序化验证

页面在 magpie 窗口里是否真的画出来（WebView2 沙箱 iframe），只能人眼看。

---

## 6. 术语表（全项目统一，不许自造同义词）

| 中文 | 英文/代码内 | 含义 |
|---|---|---|
| 宿主 | host | magpie 本体进程 |
| 插件宿主 | plugin host | `magpie-bun.exe` 跑的插件进程 |
| 页面插件 | page plugin | 声明了 `magpie.page` 的插件 |
| 带路页 | boot page | `page/index.html`，只负责跳转到本地服务 |
| 应用服务 | app server | `127.0.0.1:3480` 上的 HTTP + WebSocket 服务 |
| 终端内核 | pty bridge | 封装 node-pty 的模块 |
| 会话 | session | 一个 PTY 进程 + 对应标签页 |
| AI 栏 | ai panel | 右侧命令助手面板 |
| 分级执行 | tiered execution | 自动执行 / 需确认 两级 |
| 只读白名单 | allowlist | 可自动执行的命令头集合 |
| 确认卡 | confirm card | 需用户点「执行」才跑的命令卡片 |
| 哨兵法 | sentinel | 无 PTY 降级时的 `__DONE_<code>__` 结束标记 |

---

## 7. 写作规范

1. **语言：简体中文**（代码标识符、命令、路径、HTTP 头保持英文原样）。trellis 模板默认写 "All documentation should be written in English"，本项目**不使用**该默认，原因是只有一位中文开发者；此点作为待确认项在交付报告中列出。
2. 面向读者：未来的 AI 编码会话（主读者）+ 用户本人（次读者）。所以：事实优先、给出可直接照抄的路径和命令、少形容词。
3. 表格优先于长段落；每条技术断言后面跟一条"为什么"或"证据在哪"。
4. 不写营销话术（「强大」「优雅」「革命性」一律不许）。
5. 不确定的东西写进「待定」章节，**不要编造**。已知待定项：默认 shell 优先级（bash 优先 vs PowerShell 优先）、许可证、是否推送到 GitHub。
6. 文档里的所有路径用正斜杠或反斜杠保持一致（正文用反斜杠 Windows 风格，shell 命令用正斜杠/`$HOME`）。
7. 不要写日期"今天/昨天"，用绝对日期；本文件生成于 2026-11-22。

---

## 8. 交付要求（所有子 agent 通用）

- 只写你被分配的文件，**不要碰别人的文件**，不要 `git add`/`git commit`。
- 写完自检：文件存在、行数 > 0、没有 `TODO` 占位、没有编造的数字。
- 按返回 JSON 格式回报，`summary` ≤ 200 字。
