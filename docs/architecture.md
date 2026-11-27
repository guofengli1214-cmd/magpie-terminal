# 架构（magpie-terminal）

> 状态：0.3.0 已实现。终端只连 SSH 主机（0.3.0 删除了本机终端与本机文件面板），本文描述当前代码结构。所有路径、端口、行为来自仓库代码与本机实测。

---

## 1. 进程与组件关系

```
┌────────────────────────────────────────────────────────────────────┐
│ 宿主 host：magpie.exe  v0.1.4015                                   │
│ Wails v3 over WebView2，origin http://wails.localhost              │
│                                                                    │
│   ┌────────────────────────────────────────────────────┐           │
│   │ 侧栏页面容器：<iframe sandbox="allow-scripts">     │           │
│   │ src = …/_magpie/plugin/<tok>/page/index.html       │           │
│   │ 响应头 CSP：default-src 'none'; connect-src 'none' │           │
│   └─────────────────────────┬──────────────────────────┘           │
│                             │ 页面不能 fetch / XHR / WS            │
│                             │ 只能 location.replace()              │
└─────────────────────────────┼──────────────────────────────────────┘
                              │
      ┌───────────────────────┬───────────────────────┐
      │ 带路页 boot page   page/index.html + boot.js  │
      │ magpie.ready → options.get().port             │
      │ → http://127.0.0.1:3480/?theme=…&tokens=<b64> │
      └───────────────────────┬───────────────────────┘
                              │
┌─────────────────────────────▼──────────────────────────────────────┐
│ 应用服务 app server  127.0.0.1:3480（HTTP + WebSocket，同源）      │
│ src/server ─ token / Host / Origin 门禁 ─ 静态 app/ + /api/* + /ws │
│                                                                    │
│           │ 写 SSH 通道               │ AI 请求                    │
│           ▼                           ▼                            │
│ src/policy 分级器                     src/ai 网关客户端            │
│ allowlist / 确认卡                    OpenAI 兼容                  │
│ 只判命令，不管 I/O 与通道             只出话，不执行               │
└───────────┬───────────────────────────┬────────────────────────────┘
            │                           │
            │ SSH shell                 │ /v1/chat/completions
            ▼                           ▼
┌──────────────────────────────┐  ┌──────────────────┐
│ SSH 远端 shell               │  │ magpie 网关      │
│ 用户登录 shell（远端分配）   │  │ 127.0.0.1:3425   │
│ 每标签一个                   │  │ OpenAI 兼容      │
│ 独立 cwd                     │  │ 模型清单非契约   │
│ 句柄归 src/ssh               │  │                  │
└──────────────────────────────┘  └──────────────────┘

另一条独立链路（不经过 3480 的请求面）：
插件宿主 plugin host   magpie-bun.exe 1.4.5
  └─ 加载 index.mjs → server(input, options)（懒启动，只起一次）
     └─ 宿主把 server() 返回值当 OpenCode hooks，从不调用 stop()
```

要点：

- **插件宿主不是终端进程的父进程管理者。** `index.mjs` 只是「起服务」的入口；SSH 连接由 3480 服务在 WS 建连时才建立，本机不再 spawn 任何 shell 进程。
- **两条出网方向的线各走各的。** 页面 → 3480 是浏览器导航（不是 fetch）；3480 → 3425 是服务端自己发的 HTTP，loopback 不校验 `Authorization`（实测）。
- **没有中间层代理 UI。** 3480 直接服务 `app/` 静态文件，页面与 API 同源，因此 WS 不需要跨源协商。

## 2. 时序 A：一次「打开页面」

```
宿主                      带路页(boot)              应用服务(3480)          终端内核
 │                            │                        │                    │
 1│ 渲染 iframe sandbox=allow-scripts，src=_magpie/plugin/<tok>/page/index.html
 │───────────────────────────>│                        │                    │
 2│ bridge.js 同步 post {magpie:1, method:"hello"}；窗口起 10 秒定时器
 │───────────────────────────>│                        │                    │
 3│                            │ await window.magpie.ready → {dark,lang,tokens}
 4│                            │ window.magpie.service（magpie web 转发地址，可能为空）
 5│                            │ options.get() → port（缺省 3480）
 6│                            │ location.replace("http://127.0.0.1:3480/?theme=…&tokens=<b64>")
 │                            │───────────────────────>│                    │
 7│                            │                        │ 校验 Host ∈ {127.0.0.1:3480, localhost:3480}
 │                            │                        │ 校验 token（timingSafeEqual）
 │                            │                        │ 校验 Origin ∈ {undefined,"null",自身}
 8│                            │                        │ 200 → app/index.html + xterm.js
 │                            │<───────────────────────│                    │
 9│                            │ 建 WS /ws?token=…      │                    │
 │                            │───────────────────────>│ 升级前再验一次 token │
10│                            │                        │ ssh2 建 shell 通道  │
 │                            │                        │───────────────────>│
11│                            │                        │<─── data / exit ───│
```

编号步骤的补充：

- 第 1 步路径里的 `<tok>` 是**宿主给插件页面文件**的一次性路径令牌，跟本插件自己的 API token 是两回事，不要混用。
- 第 3–5 步失败都不阻塞：没有 bridge 就用默认主题、默认端口 3480，页面仍能跳转（代价是 token 缺失 → 3480 直接 403，见第 7 步）。
- 第 6 步的 `tokens` 是 base64 编码的 JSON，内容是 magpie 自己的 CSS 变量值，用来让终端配色/字体跟窗口一致。
- 第 7 步三项任一不通过一律 403，不给任何业务响应（验收第 6 条）。
- 第 10 步之前**不建连**：没有通过门禁的连接不应该在远端机器上留下会话。

## 3. 时序 B：一次「AI 给命令」

```
UI(AI 栏)            src/server           src/ai           网关 3425       src/policy      远端 shell
   │                     │                  │                 │              │            │
 1 │ 用户说「看看谁占着 3480」
   │────────────────────>│                  │                 │              │            │
 2 │                     │ 采集上下文：cwd + 最近 N 行输出 + 远端 shell 类型
 3 │                     │─────────────────>│ POST /v1/chat/completions
   │                     │                  │────────────────>│              │            │
 4 │                     │                  │<─── 中文说明 + 命令块 ─────────│            │
 5 │                     │<─────────────────│ 抽取命令（代码块/单行）
 6 │                     │───────────────────────────────────>│ 分级判定      │            │
 7a│                     │<── 只读白名单命中：自动执行 ─────────│              │            │
   │                     │──────────────────────────────────────────────────────────────>│
 7b│                     │<── 命中黑名单/重定向/切不开：确认卡 ─│              │            │
   │<── 确认卡 [执行][复制] │                  │                 │              │            │
   │──── 点击「执行」─────>│                  │                 │              │            │
   │                     │──────────────────────────────────────────────────────────────>│
 8 │<── 流式输出 ─────────│<──────────────────────────────────────────────────────────────│
 9 │                     │ 输出回喂（可选）→ 再次调网关解释结果
```

- 第 2 步的上下文只取**最近窗口**的输出，不写盘、不入库（见第 6 节）。
- 第 5 步抽取失败（模型没给命令）就直接把文本显示在 AI 栏，不进入分级器。
- 第 6 步是 **fail-closed**：切不开的命令串按「危险」处理，不是按「安全」处理。
- 第 7a/7b 的分界只看分级器结论，AI 自己的措辞不参与判断。
- 第 9 步的回喂有轮次上限（具体轮数待定，T2 实现时定），避免无限自问自答。

## 4. 模块划分

| 模块 | 职责（输入 → 输出） | 明确不做的事 |
|---|---|---|
| `src/server` | HTTP 请求 / WS 升级 → 静态文件或 JSON；统一门禁（token、Host、Origin）；把 `/api/hosts`、`/api/fs*`、`/api/ai`、`/api/policy` 路由到对应模块 | 不实现终端语义（不懂 ANSI）、不实现分级规则、不直接调网关 |
| `src/ssh` | `{hostId, cols, rows}` → SSH 通道句柄 + `data`/`exit` 事件流；`write()`、`resize()`、`close()`；OSC 7 解析远端 cwd | 不做鉴权、不做命令分级、不解析用户输入内容 |
| `src/ai` | 上下文 + 用户话术 → 网关响应文本与抽取出的命令 | 不决定命令能不能跑（交给 policy）、不直接 spawn |
| `src/policy` | 命令行字符串 → `auto` / `confirm` 两级结论 + 命中原因 | 不执行命令、不调模型、不认识具体 shell 语法糖（只按分隔符切段） |
| `page/` | 带路页：读 `magpie.ready` / `service` / `options.port` → `location.replace` | 不含任何业务 UI、不发 fetch（CSP 也不允许） |
| `app/` | 主界面：标签栏、xterm.js、AI 栏、确认卡、主机面板、远程文件面板；WS 客户端 | 不做鉴权判断（服务端已做）、不直接持有 SSH 通道 |

边界规则：**`src/ssh` 永远不 import `src/policy`，`src/ai` 永远不 import `src/ssh`。** 三者只在 `src/server` 里被编排，这样分级器可以单测（验收里的「分级器单测」要求），SSH 通道也能在没有 AI 的情况下独立跑。

## 5. 关键设计决策

| 决策 | 选择 | 为什么 |
|---|---|---|
| 打开页面不自动建会话 | 应用页只建 WS，不自动发 `pty.create`；没有主机/会话时显示空态引导「添加主机」 | 0.3.0 起终端必须先有 SSH 主机，没有主机就开不出终端；空态比空白区更能说明下一步 |
| 页面怎么进 3480 | 用**带路页**（`page/index.html` 只做跳转），不在插件页里直接渲染 UI | 插件页 CSP 是 `default-src 'none'; script-src <host>/_magpie/plugin/<token>/; connect-src 'none'`，无内联脚本、无外部 CDN、不能 fetch/XHR/WebSocket。页面唯一能做的联网动作就是 `location.replace()`；把 UI 放在插件页里就连不上自己的服务 |
| 谁来起 HTTP 服务 | 插件**自己**在 `index.mjs` 的 `server()` 里起 | 宿主只提供 hooks（`server()` 被调用时传 options），不能替插件暴露 HTTP 接口；`package.json` 的 `magpie.page.service` 只是声明端口与选项名，不代建服务 |
| 端口为什么固定 3480 | 3480 | 3425 网关、3477 page-chat、3488 agent-console gate、3496 model-quota 已占；3480/3466/3478/3490 空闲，四个里选 3480（BRIEF 2 节选定值）。固定端口而不是随机端口：带路页必须在跳转前就知道端口，而 CSP 不允许它先去问服务；随机端口需要额外握手通道 |
| 终端用什么 | `ssh2@1.17.0` 的 shell 通道 | 0.3.0 删除了本机终端与 `node-pty`：本地 shell 要付原生模块、平台差异、shell 探测三份成本。`ssh2` 是纯 JS，对端 PTY 由远端 sshd 分配，`vim`/`top` 正常，三平台同一套代码 |
| 依赖装哪 | 插件自己的 `node_modules`（npm 安装） | 全是纯 JS 包（`ssh2`、`ws`、`zod`、`ai`），无原生模块、无需编译；不再依赖宿主 `plugins/node_modules` 里恰好有 `node-pty` |
| 鉴权放哪 | `src/server` 统一入口 | 每个 `/api/*` 和 WS 升级都要过同一段代码，避免某个路由漏检；token 用 `timingSafeEqual` 比对，避免时序侧信道 |
| SSH 何时连 | WS 建连并验过 token 之后，且 `pty.create` 带 `hostId` | 未通过门禁的连接不该在远端留下会话；也保证「关标签 → 关通道」是 1:1。缺 `hostId` 直接回 `HOST_REQUIRED` |

## 6. 数据存在哪

**不落库，不持久化会话。**

- 进程内存里只有：标签列表（id、标题、cwd、SSH 通道句柄、最近输出环形缓冲）与门禁用的 token。
- 没有数据库、没有 history 文件、没有 `localStorage` 依赖（沙箱 iframe 的存储本来也不可用）。
- 关掉标签 → 关闭 SSH 通道 → 该会话的数据一起消失；退出 magpie → 全部丢失。
- 因此「会话不跨 magpie 重启保留」是设计选择，不是缺陷（见 README 的非目标）。
- 命令历史（T3 范围）如果要落盘，位置与格式**待定**，不能默认写进 magpie 的配置目录。
- **TASK-FIX17-L1 新增的唯一落盘位置**：用户在设置页指定的 `downloadDir`（存在 `~/.config/magpie-terminal/config.json` 的 `downloadDir` 字段）。下载文件与导出日志只往这个目录写，文件名撞了就退到 `name (1).ext`，绝不覆盖已有文件。没设置时一律走浏览器默认下载目录（服务端不落盘）。

## 7. shell 从哪来（0.3.0 起）

0.3.0 删除了 `node-pty`、`src/pty/`、`/api/shells` 与配置项 `defaultShell`，原先的默认 shell 探测顺序（git-bash 优先、PowerShell 回退、`MAGPIE_TERMINAL_SHELL` 覆盖、msys 校验）全部作废。

- 终端只有一种来源：连接一台已保存的 SSH 主机。shell 由远端 sshd 按该用户的登录 shell 分配，插件不探测、不覆盖，也没有 shell 选择器。
- 通道尺寸（`cols`/`rows`）由前端在 `pty.create` 时给出，`resize` 转发到 SSH 通道。
- 远端当前目录靠 OSC 7 上报（`src/ssh/osc7.mjs`），前端据此更新标签 cwd 与文件面板路径；远端不上报时 cwd 为空，不猜。
- 缺 `hostId` 一律拒绝：WS 回 `{type:"pty.error", id:"", code:"HOST_REQUIRED", userText:"终端只能连远程主机：先在主机面板里添加一台主机。"}`。

## 8. 待定

> 下表只留真正未决的项。

| 项 | 影响 |
|---|---|
| AI 栏的上下文窗口大小（最近多少行输出） | 影响 token 消耗与 prompt 长度；T2 前定 |
| 回喂轮次上限 | 防止无限循环；T2 实现时定 |
| 命令历史的落盘位置与格式（T3） | 若不做则 T3 只保留内存历史 |
