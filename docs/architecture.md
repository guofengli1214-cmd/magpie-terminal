# 架构（magpie-terminal）

> 状态：设计已定，代码未开始。本文描述的是**要实现的结构**，不是已存在的代码。所有路径、端口、行为来自 `BRIEF.md` 与本机实测。

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
│           │ 命令执行                  │ AI 请求                    │
│           ▼                           ▼                            │
│ src/policy 分级器                     src/ai 网关客户端            │
│ allowlist / 确认卡                    OpenAI 兼容                  │
│ 只判命令，不管 I/O 与 PTY             只出话，不执行               │
└───────────┬───────────────────────────┬────────────────────────────┘
            │                           │
            │ spawn                     │ /v1/chat/completions
            ▼                           ▼
┌──────────────────────────────┐  ┌──────────────────┐
│ PTY 子进程                   │  │ magpie 网关      │
│ 默认 bash（回退 PowerShell） │  │ 127.0.0.1:3425   │
│ 每标签一个                   │  │ OpenAI 兼容      │
│ 独立 cwd                     │  │ 模型清单非契约   │
│ 句柄归 src/pty               │  │                  │
└──────────────────────────────┘  └──────────────────┘

另一条独立链路（不经过 3480 的请求面）：
插件宿主 plugin host   magpie-bun.exe 1.4.5
  └─ 加载 index.mjs → server(input, options)（懒启动，只起一次）
     └─ 宿主把 server() 返回值当 OpenCode hooks，从不调用 stop()
```

要点：

- **插件宿主不是终端进程的父进程管理者。** `index.mjs` 只是「起服务」的入口；PTY 由 3480 服务在收到 `/api/pty` 或 WS 建连时才 spawn。
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
10│                            │                        │ spawn(shell, cwd)  │
 │                            │                        │───────────────────>│
11│                            │                        │<─── data / exit ───│
```

编号步骤的补充：

- 第 1 步路径里的 `<tok>` 是**宿主给插件页面文件**的一次性路径令牌，跟本插件自己的 API token 是两回事，不要混用。
- 第 3–5 步失败都不阻塞：没有 bridge 就用默认主题、默认端口 3480，页面仍能跳转（代价是 token 缺失 → 3480 直接 403，见第 7 步）。
- 第 6 步的 `tokens` 是 base64 编码的 JSON，内容是 magpie 自己的 CSS 变量值，用来让终端配色/字体跟窗口一致。
- 第 7 步三项任一不通过一律 403，不给任何业务响应（验收第 6 条）。
- 第 10 步之前**不 spawn**：没有通过门禁的连接不应该在机器上留下进程。

## 3. 时序 B：一次「AI 给命令」

```
UI(AI 栏)            src/server           src/ai           网关 3425       src/policy      PTY
   │                     │                  │                 │              │            │
 1 │ 用户说「看看谁占着 3480」
   │────────────────────>│                  │                 │              │            │
 2 │                     │ 采集上下文：cwd + 最近 N 行输出 + shell 类型
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
| `src/server` | HTTP 请求 / WS 升级 → 静态文件或 JSON；统一门禁（token、Host、Origin）；把 `/api/pty`、`/api/ai`、`/api/policy` 路由到对应模块 | 不实现终端语义（不懂 ANSI）、不实现分级规则、不直接调网关 |
| `src/pty` | `{shell, cwd, cols, rows}` → PTY 句柄 + `data`/`exit` 事件流；`write()`、`resize()`、`kill()` | 不做鉴权、不做命令分级、不解析用户输入内容 |
| `src/ai` | 上下文 + 用户话术 → 网关响应文本与抽取出的命令 | 不决定命令能不能跑（交给 policy）、不直接 spawn |
| `src/policy` | 命令行字符串 → `auto` / `confirm` 两级结论 + 命中原因 | 不执行命令、不调模型、不认识具体 shell 语法糖（只按分隔符切段） |
| `page/` | 带路页：读 `magpie.ready` / `service` / `options.port` → `location.replace` | 不含任何业务 UI、不发 fetch（CSP 也不允许） |
| `app/` | 主界面：标签栏、xterm.js、AI 栏、确认卡；WS 客户端 | 不做鉴权判断（服务端已做）、不直接持有 PTY |

边界规则：**`src/pty` 永远不 import `src/policy`，`src/ai` 永远不 import `src/pty`。** 三者只在 `src/server` 里被编排，这样分级器可以单测（验收里的「分级器单测」要求），PTY 也能在没有 AI 的情况下独立跑（T1 出口条件）。

## 5. 关键设计决策

| 决策 | 选择 | 为什么 |
|---|---|---|
| 打开页面即有标签 | 应用页 WS 连上且 store 零会话时自动发一次 `pty.create`；重连不重复建 | 产品定位是「整页是终端」，进页面看见空白区再自己找「+」是使用失败 |
| 页面怎么进 3480 | 用**带路页**（`page/index.html` 只做跳转），不在插件页里直接渲染 UI | 插件页 CSP 是 `default-src 'none'; script-src <host>/_magpie/plugin/<token>/; connect-src 'none'`，无内联脚本、无外部 CDN、不能 fetch/XHR/WebSocket。页面唯一能做的联网动作就是 `location.replace()`；把 UI 放在插件页里就连不上自己的服务 |
| 谁来起 HTTP 服务 | 插件**自己**在 `index.mjs` 的 `server()` 里起 | 宿主只提供 hooks（`server()` 被调用时传 options），不能替插件暴露 HTTP 接口；`package.json` 的 `magpie.page.service` 只是声明端口与选项名，不代建服务 |
| 端口为什么固定 3480 | 3480 | 3425 网关、3477 page-chat、3488 agent-console gate、3496 model-quota 已占；3480/3466/3478/3490 空闲，四个里选 3480（BRIEF 2 节选定值）。固定端口而不是随机端口：带路页必须在跳转前就知道端口，而 CSP 不允许它先去问服务；随机端口需要额外握手通道 |
| 终端用什么 | `node-pty@1.2.0-beta.15` | `child_process` 给的是管道不是 TTY：`isatty` 为 false、没有窗口尺寸、`vim`/`top` 这类全屏程序跑不起来。实测 node-pty 下 `stty size` 回读 `30 100`、`isatty` 为 true、resize 到 `40 132` 真实生效（BRIEF 第 3 节） |
| 依赖装哪 | 复用宿主 `plugins/node_modules` | 该目录已有 node-pty、ws、zod 等；自建一份 `node_modules` 会让 Bun 从全局缓存装 `node-pty@1.1.0`（坑 3），并刷 `AttachConsole failed` |
| 鉴权放哪 | `src/server` 统一入口 | 每个 `/api/*` 和 WS 升级都要过同一段代码，避免某个路由漏检；token 用 `timingSafeEqual` 比对，避免时序侧信道 |
| PTY 何时 spawn | WS 建连并验过 token 之后 | 未通过门禁的连接不该在机器上留下 shell 进程；也保证「关标签 → 关 PTY」的对应关系是 1:1 |

## 6. 数据存在哪

**不落库，不持久化会话。**

- 进程内存里只有：标签列表（id、标题、cwd、PTY 句柄、最近输出环形缓冲）与门禁用的 token。
- 没有数据库、没有 history 文件、没有 `localStorage` 依赖（沙箱 iframe 的存储本来也不可用）。
- 关掉标签 → `kill()` PTY → 该会话的数据一起消失；退出 magpie → 全部丢失。
- 因此「会话不跨 magpie 重启保留」是设计选择，不是缺陷（见 README 的非目标）。
- 命令历史（T3 范围）如果要落盘，位置与格式**待定**，不能默认写进 magpie 的配置目录。

## 7. 默认 shell 与探测顺序

**结论：bash（msys / git-bash）优先，PowerShell 回退。** 探测按下列顺序进行，第一个通过校验的候选胜出。

1. **用户配置覆盖**：插件选项 `shell` 或环境变量 `MAGPIE_TERMINAL_SHELL` 有值则直接用，不再探测（信任用户，跳过校验）。
2. `%ProgramFiles%\Git\bin\bash.exe`
3. `%ProgramFiles(x86)%\Git\bin\bash.exe`
4. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
5. 从 `PATH` 解析到的 bash，但**必须拒绝**路径中含 `\WindowsApps\` 的。实测 `where bash` 的第二条是 `C:\Users\41807\AppData\Local\Microsoft\WindowsApps\bash.exe`——它是指向 `wsl.exe` 的软链（111 字节），拉起来是 WSL 发行版的 bash，文件系统与路径语义全部不同，不能当终端默认 shell。
6. **Hermes 私有目录不得硬编码依赖**：`where bash` 的第一条是 `C:\Users\41807\AppData\Local\hermes\tools\git-2.53.0+3-win32-x64\usr\bin\bash.exe`。这条路径带版本号，Hermes 升级就会失效；只能作为「PATH 偶然命中 + 通过校验」的结果被使用，代码里不许出现这个前缀。
7. **msys 校验**：候选 bash 跑一次 `--version`，输出必须包含 `msys` 或 `MSYS`，不含则弃用该候选、继续下一个。实测本机系统 git-bash 输出 `GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)`，git 版本 `2.50.1.windows.1`。
8. **全部失败 → PowerShell 回退**：`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（本机已验证存在）。
9. **UI 必须标明当前 shell 名称与版本**；处于回退状态时写「PowerShell（回退）」，不要让用户以为自己在 bash 里。
10. **node-pty 的 `name` 参数**：bash 与 PowerShell 都用 `xterm-256color`。

本机实测的 `where bash` 两条结果，正好对应上面两个坑：

| 顺序 | 路径 | 判定 |
|---|---|---|
| 1 | `C:\Users\41807\AppData\Local\hermes\tools\git-2.53.0+3-win32-x64\usr\bin\bash.exe` | 可用但**不可硬编码**：路径含 Hermes 版本号，升级即失效 |
| 2 | `C:\Users\41807\AppData\Local\Microsoft\WindowsApps\bash.exe` | **拒绝**：111 字节软链 → `wsl.exe`，是 WSL 发行版的 bash |

**为什么不是 PowerShell 优先**：现有全部 PTY 实测证据（`stty size` → `30 100`、`isatty` 为 true、`vim` 能开能退、`Ctrl-C`、哨兵法 `printf '__DONE_%s__\n' "$?"`）都是在 msys bash 上取得的。选 PowerShell 等于把这些数字的适用性全部打回未验证状态，T1 的出口条件要重测。

**探测结果怎么用**：探测只在启动或新建标签时做一次，结果在进程内缓存（不做定时重探，避免用户装/卸 Git 时行为抖动）；UI 的 shell 标识取自这次探测的返回值，前端不得自己猜。`spawn` 失败不做换 shell 重试，只返回 `PTY_SPAWN_FAILED`——静默换 shell 会让「为什么我的命令跑不通」变成不可解释的现象（细节见 `.trellis/spec/backend/pty-lifecycle.md` 第 2 节）。

## 8. 待定

> 默认 shell 已定，见本文第 7 节。下表只留真正未决的项。

| 项 | 影响 |
|---|---|
| AI 栏的上下文窗口大小（最近多少行输出） | 影响 token 消耗与 prompt 长度；T2 前定 |
| 回喂轮次上限 | 防止无限循环；T2 实现时定 |
| 命令历史的落盘位置与格式（T3） | 若不做则 T3 只保留内存历史 |
