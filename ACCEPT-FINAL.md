# ACCEPT-FINAL：整件验收（功能 + 布局 + 返工 + 端到端走查）

> 时间：2026-11-24 22:5x　仓库 `C:/Users/41807/magpie-terminal`　HEAD `e17bcf9`
> 范围：用户 13 条需求（终端 + AI agent 的 magpie 页面版插件）→ 功能验收 F1 → 布局验收 L1 → 返工卡 1/2/3/4 + 安全卡 S + 卡 H + PS/UI 收尾卡。
> 结论：**通过**（21/21 端到端断言全 PASS；722/722 测试；doctor 33/33）。遗留两项观察（见 §5），不阻断核心使用。

## 1. 已交付能力（对应用户 13 条）
| 用户要求 | 落点 | 验收证据 |
|---|---|---|
| AI 栏靠右、默认收起、中间突起、待确认红点、右下角通知 | `layout.css` 把手 24×78 贴右缘、`app.js syncAgentBadge()`、`ui/toast.js` | 走查 A1/A9；`ACCEPT-FUNC.md` F10 PASS |
| 像 Hermes 一样思考 + 工具调用 + 总结 | `src/ai/agent.mjs`（工具循环、思考块、审批卡） | 走查 A3：真模型真 PTY 一轮 6.4s，1 step done |
| 设置页可打开、可配基础提示词/自主档/审阅效果 | `ui/settings-panel.js` + `config/store.mjs` | 走查 A7（焦点不在终端） |
| 模型选择在输入框内、无边框、可切换 | `ai-drawer.js` composer 网格 | 走查 B2：model/input/send 全在 composer-box 内 |
| 输入框可放大、Enter 提示进框内、发送是向上箭头 | `.composer-box` grid + grip | `TASK-FIX-ACCEPT3` 探针 + 走查 B2 |
| 会话列表记录本机终端类型 / 主机 | `tab-bar.js shellShortName()`、会话徽标 | 卡 H `VERIFY-V4-H.md` AC4/AC5 |
| 主机与文件分开、文件实时跟随 cwd、增删改查上下传 | `ui/file-panel.js` + `src/fs/*` + OSC 7 | 卡 G `VERIFY-V4-G.md` AC1–AC11 |
| 主机内固定本机 + 可选 bash/pwsh/PS5；加号可选主机 | `ui/hosts-panel.js` + `src/pty/shells.mjs` | 卡 F `VERIFY-V4-F.md`、`/api/shells` 实测 |
| 主机面板点外关闭 | `hosts-panel.js` 外部监听 | 走查 A8 |
| 打开/关闭 AI 面板不再多打空回车 | 卡 H 会话模型重写 | `VERIFY-V4-H.md` AC12/AC13 |
| 已展开时右下角不重复通知 | `app.js` 徽标条件 + toast 去重 | `ACCEPT-FUNC.md` F10 |
| UI 整体用设计/产品视角重做 | 卡 E/F/G + 返工 1–4（tabbar 40/statusbar 26/rail SVG/虚拟滚动） | `ACCEPT-LAYOUT.md` + 返工探针 |
| AI 判断是否真需确认 + 白名单 + 审阅 AI | `src/ai/judge.mjs` / `review.mjs` / `allowlist.mjs` | 卡 S `VERIFY-V4-S.md`、卡 H AC6/AC8/AC9 |

## 2. 本轮最终改动（`e17bcf9`，15 文件 +2659/−69）
- PowerShell 会话可自动执行：`src/ai/runner.mjs` 家族分支（PS 用 CR 提交、`$?`＋`$Error.Count` 增量＋`$LASTEXITCODE` 三判退出码），bash 分支逐字节冻结。
- 文件条目动作条 156px→`⋯` 面板级菜单（5/3 项），不再横向溢出 49.6px。
- AI 抽屉把手对齐视口中心（原差 13px）。
详见 `VERIFY-FIX-PS.md`、`VERIFY-FIX-UI-REST.md`。

## 3. 端到端走查（主 agent 亲写亲跑，真浏览器 CDP + 真 PTY + 真模型网关）
脚本 `.dispatch/my-walk-final3.mjs`，输出 `.dispatch/my-walk-final3b.txt`（`DONE pass=21 fail=0`），截图 `.dispatch/my-walk-final3/*.png`。

- 1440×900：默认收起；把手 24×78、贴右缘、中心 450 vs 视口 450（Δ0）；抽屉 `left=1055 w=385 right=1440`。
- **PowerShell 真跑**：提问 → `REVIEW risk=safe` → `COMMAND_RUN_START family=powershell` → `(Get-Location).Path` → `exitCode 0`、`output "C:\Users\41807"`、step `done`、`AGENT_DONE steps:1 durationMs:6442`，无 `EXEC_UNSUPPORTED`。
- 文件面板：26 条目、`⋯` 常显（opacity 0.7）；文件条目菜单 5 项「查看/编辑/重命名/下载/删除」、四边在面板内；Esc 关闭且焦点回 `⋯`。
- 设置面板打开后焦点在 `BUTTON[autonomy-option]`，不在 xterm；主机面板点外关闭；收起 AI 后焦点不在抽屉。
- 1280×760：无横向溢出，把手 Δ0，composer 三块全在框内。

## 4. 回归与自检
- `node --test --test-force-exit`：**722 / 722 pass，0 fail**（`.dispatch/my-final-full.txt`）。
- `scripts/doctor.mjs`：**33/33 assertions passed**（`.dispatch/my-doctor-final.txt`）。
- bash 包装串冻结：7 用例 diff=0（`.dispatch/my-bash-frozen.txt`）。
- 测试改动只放宽了假 PTY 的探测正则（加 `ok` 分支），未删断言（`git diff test/ai/runner.test.mjs` 删除 2 行：注释 + 正则）。
- 探针实例端口 3790 已释放，无残留监听。

## 5. 遗留观察（不阻断，待人类决定）
- **O1 状态栏 shell 名不准**：`/api/health` 的 `shell` 是「探测到的默认 shell」（本机 bash 5.2.37），而用户 config `defaultShell=pwsh`、新会话实际是 PowerShell 7。状态栏（`ui/status-bar.js:72-77`）直接显示 health 值 → 用户看到「shell：bash 5.2.37」却在 PowerShell 里打字。修法：状态栏优先显示当前会话的 `session.shell`，health 只作兜底。
- **O2 宿主重启后旧页面永久重连失败**：token 每次宿主启动新生成，旧页面 meta 里的 token 失效，`ws-client.js` 指数退避无限重试（宿主日志每 10s 一条 `AUTH_TOKEN_MISMATCH`），必须手动刷新页面。修法：连续失败 3 次后取一次首页比对 token，不一致就 `location.reload()`。
- **已知限制（文档已写）**：PS 5.1 下 native 命令写 stderr 但成功退出会判失败（`docs/PROTOCOL-AGENT.md §4.6`）；PS 分支退出码归一到 0/1。
