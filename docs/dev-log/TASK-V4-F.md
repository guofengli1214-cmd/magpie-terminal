---
id: TASK-V4-F
title: 本机 shell 可选 + 新建标签下拉（V4-F）
status: approved
plan_version: docs/mockups-v4（v4b）+ 用户 m03646 第 12、13 条
approval_ref: 用户 m03646 第 12/13 条；m03696 选 A
priority: P1
executor: pi
model_tier: 人类指定 commandcode/deepseek/deepseek-v4.1-flash（provider magpie）
attempt: 1
retry_budget: 2
escalation_policy: ask_human
session_policy: new_session_required
session_id: null
inputs:
  - C:/Users/41807/magpie-terminal/app/ui/hosts-panel.js（现状）
  - C:/Users/41807/magpie-terminal/app/ui/tab-bar.js（现状）
  - C:/Users/41807/magpie-terminal/src/pty/bridge.mjs（现有 shell 探测）
  - C:/Users/41807/magpie-terminal/src/pty/session.mjs（单一 shell 的 SessionManager）
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/hosts-files.html（主机面板视觉）
  - C:/Users/41807/magpie-terminal/docs/PROTOCOL-AGENT.md §1（config 字段约定）
quality_benchmark: 以本机已装的三个 shell 真实可跑为准（bash 5.2.37 / PowerShell 5.1.22621 / pwsh 7.7.0），不靠文案宣称。
verification: 主 agent 独立实跑三个 shell + node --test + doctor
verifier: independent_new_session
depends_on: [TASK-V4-E]
---

# 1. 背景

现在终端只能用一个全局 shell：`src/server/http.mjs:326` 启动时 `detectShell()` 探测一次（优先 git bash，失败回退 PowerShell 5.1），`SessionManager` 构造时把 `shell` 固定下来，`sessions.create()` 没有 shell 参数。用户要的是：主机面板里固定有一条「本机」，能选 bash / PowerShell 5 / PowerShell 7；标签栏的「+」能选本机（各 shell）或已配置的 SSH 主机。

# 2. 目标

1. 服务端能枚举本机可用的 shell，并按请求为**每个会话**指定 shell。
2. 前端主机面板顶部固定「本机」条目 + shell 下拉；选择结果写进 config（`defaultShell`），下次默认用它。
3. 标签栏「+」变成下拉：本机（bash / PowerShell 5 / PowerShell 7）+ 已配置主机列表。
4. 现有行为不回归：不带 shellId 时仍按 `defaultShell` → 环境变量 `MAGPIE_TERMINAL_SHELL` → 自动探测（git bash 优先）。

# 3. 非目标

- 不做 WSL、不做 cmd.exe、不做自定义 shell 路径输入（用户只要那三个）。
- 不做文件面板（V4-G）、不做会话模型（V4-H）。
- 不改 SSH 远程会话的 shell 语义（远程仍走登录 shell）。

# 4. 现状事实（别重复挖）

- `src/pty/bridge.mjs`：`detectShell()` 进程内缓存一次；`powerShellInfo()` 已能拿 PowerShell 5.1 的版本；没有 pwsh 7 与 cmd 的探测。
- `src/pty/session.mjs:59` `this.shell = opts.shell`，`:78 create({cols,rows,cwd})`，`:86 shell: this.shell`，`:111 spawnPty(module, this.shell, …)`，`:151` 的 `session.created` 回 `shell{name,version,path,fallback}`。
- `src/server/ws.mjs:288` `pty.create` 分支 → `:327 sessions.create({cols,rows,cwd})`；同文件 `:416` 组装 `session.created` 的 shell 字段。
- `src/server/http.mjs:326` `const shell = detectShell({shell: options.shell})`；`:329` `new SessionManager({shell, …})`；`:742`/`:988` 在 health 与 doctor 里用 `shell`。
- `src/config/store.mjs` 的 `KNOWN_FIELDS` 现为 `["model","autonomy","allowlist","reviewModel","basePrompt"]`，`DEFAULT_CONFIG` 需要加 `defaultShell: null`。
- 前端：`app/ui/hosts-panel.js`（主机列表 + 添加表单 + 测试连接 + 指纹信任）、`app/ui/tab-bar.js`（标签 + 新建按钮）。

# 5. 执行步骤

## 5.1 新增 `src/pty/shells.mjs`

导出：
```js
export const SHELL_IDS = Object.freeze(["bash", "pwsh", "powershell"]);
export function detectShells() -> Array<{ id, name, version, path, args, available: boolean }>
export function resolveShellById(id) -> shell | null   // 只返回 available 的
export function detectDefaultShell() -> shell            // id 也带在返回值里
```
规则：
- `bash`：沿用 `bridge.mjs` 现有的 git bash 探测（`isValidMsysBash`），要求含 msys；`args: []`。
- `powershell`：`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，`args: ["-NoLogo"]`，版本读 `$PSVersionTable.PSVersion.ToString()`。
- `pwsh`：依次试 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`、`%ProgramFiles%\PowerShell\7\pwsh.exe`、PATH 里的 pwsh，`args: ["-NoLogo"]`，版本 `pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'`。
- 版本探测超时 3s，失败不抛，`available:false` + `version:"unknown"`。
- 结果进程内缓存，导出 `resetShellsCache()` 给测试用。
- 保留 `bridge.mjs` 的 `detectShell()` 不动（健康检查还在用），但让 `detectDefaultShell()` 复用其结果以免行为漂移。

## 5.2 会话按 shell 创建

- `SessionManager` 构造签名兼容：`new SessionManager({shell, ptyLoad, mode})` 仍可用（默认 shell）。
- `create({cols, rows, cwd, shell})` 新增可选 `shell` 参数；每会话存自己的 shell；`session.created` 回该会话真实的 `shell{name,version,path,fallback}`。
- `ws.mjs` 的 `pty.create` zod schema 新增 `shellId: z.enum(["bash","pwsh","powershell"]).optional()`；`:327` 传给 `create()`；非法值 → 回 `session.failed` 带 `code:"PTY_UNKNOWN_SHELL"`（不要抛未捕获异常）。
- 解析顺序：`frame.shellId` → `config.defaultShell` → `MAGPIE_TERMINAL_SHELL` → `detectShell()`。解析函数放 `src/pty/shells.mjs`，供 ws 与 health 共用。

## 5.3 HTTP 接口

- `GET /api/shells`（需要 token，和现有 `/api/models` 同级）→ `{ shells: [...], default: "bash" }`。
- `PUT /api/config` 支持 `defaultShell`：只接受 `SHELL_IDS` 里的值或 `null`，否则 400 `INVALID_SHELL`；写进 `KNOWN_FIELDS` + `DEFAULT_CONFIG` + 现有校验函数。

## 5.4 前端：主机面板

- 面板顶部固定一条「本机」：图标 + 名称「本机」+ 当前 shell 版本（如 `bash 5.2.37`），右侧 shell 下拉（三个选项，不可用的置灰并标「未安装」）。
- 切换下拉 → `PUT /api/config {defaultShell}` → 成功后刷新显示；不重建已有会话（只影响之后新开的）。
- 「本机」条目点击 = 新开一个本机终端标签（用当前 defaultShell）。
- 保留下方 SSH 主机列表与所有既有功能（添加/测试/指纹/连接/删除）。
- 面板点外部关闭（V4-E 已做，不要破坏）。

## 5.5 前端：标签栏「+」

- 点击 `+` 弹出菜单（绝对定位，点外部/Esc 关闭）：
  - 分组「本机」：三个 shell（显示名 + 版本），点一项 = 用该 shell 新建本机标签。
  - 分组「主机」：已配置主机列表（名称 + user@host:port），点一项 = 连该主机。
  - 没有任何主机时，主机分组显示「还没有配置主机」文字 + 「去添加」按钮（打开主机面板）。
- `data-role`：`tab-new-menu`、`tab-new-local`、`tab-new-host`，便于探针。
- 现有 `createTab()` 要能接受 `{shellId}`；现有远程建连函数要能被菜单直接调用（复用，不复制）。

## 5.6 测试

- 新增 `test/pty/shells.test.mjs`：`detectShells()` 至少返回 3 项且 `bash` 在这台机器上 `available:true`；`resolveShellById("nope")` 返回 null；`resolveShellById("pwsh")` 返回 args 含 `-NoLogo`。
- 新增/补 `test/server/shells-route.test.mjs`：`GET /api/shells` 200、结构正确；`PUT /api/config {defaultShell:"pwsh"}` 落盘并可回读；`{defaultShell:"zsh"}` → 400 `INVALID_SHELL`。
- `test/config/store.test.mjs` 里若有对 `KNOWN_FIELDS` 的逐字断言，同步更新（不许删断言、不许放水）。

# 6. 契约

- 不改 `session.created` 已有字段；只确保 `shell` 是该会话真实 shell。
- 不改 `/api/health` 现有字段（`shell` 仍是默认 shell 的信息）。
- `pty.create` 不带 `shellId` 时必须保持旧行为（回归）。

# 7. 验收标准（主 agent 独立复跑）

| 编号 | 必过 | 标准 |
|---|---|---|
| AC1 | 必过 | `GET /api/shells` 返回 bash / pwsh / powershell 三项，bash 与 powershell `available:true`，版本号与 `bash --version`、`$PSVersionTable` 实测一致 |
| AC2 | 必过 | 用 `shellId:"powershell"` 建会话，在该终端执行 `$PSVersionTable.PSVersion.ToString()` 输出以 `5.1.` 开头；`session.created.shell.name` 含 PowerShell |
| AC3 | 必过 | 用 `shellId:"pwsh"` 建会话，执行 `$PSVersionTable.PSVersion.ToString()` 输出以 `7.` 开头 |
| AC4 | 必过 | 用 `shellId:"zsh"` 建会话 → 收到 `session.failed` 且 `code` 为 `PTY_UNKNOWN_SHELL`，服务不崩、其它会话不受影响 |
| AC5 | 必过 | 不带 shellId、config.defaultShell=null 时仍是 bash（回归）；`PUT {defaultShell:"pwsh"}` 后不带 shellId 建会话得到 pwsh 7 |
| AC6 | 必过 | 主机面板有「本机」条目与 shell 下拉，切换后 `GET /api/config` 的 defaultShell 变了，重启服务后仍生效 |
| AC7 | 必过 | 标签栏「+」下拉含本机三 shell 与已存主机；点本机某 shell 真新建对应终端；点主机会连该主机 |
| AC8 | 必过 | `node --test` 0 fail；`doctor` 33/33 |
| AC9 | 必过 | 无回归：SSH 远程终端、文件树、AI 抽屉开关都还正常 |

# 8. 执行约束

- 独立新会话；不改 `docs/mockups-v4/`、`app/vendor/`；不新增依赖。
- 探针必须自带 `process.exit` 与 60s 硬超时，不留后台进程。
- 不 commit。交付标「待验收」。

# 9. 交付物

`REPORT-V4F.md`（每条 AC 的实际结果 + 证据路径）、`test/pty/shells.test.mjs`、`.dispatch/v4f-probe/*.txt`、`.dispatch/v4f-shots/*.png`（主机面板与「+」菜单，1280×760 与 1440×900）。
