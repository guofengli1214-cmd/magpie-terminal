# TASK-FIX17-E（插件级：侧栏图标 + 日志与脱敏导出（问题 13 / 14））

Active task: `.trellis/tasks/11-25-task-e-plugin/`
父任务: `.trellis/tasks/11-25-fix-17-parent/`
必读（按顺序）：`.trellis/tasks/11-25-task-e-plugin/implement.jsonl` 里列的每份文件 → `prd.md` → `design.md` → `implement.md`

工作目录 `C:/Users/41807/magpie-terminal`，Node 是 `D:/nodejs/install/node.exe`（PATH 里的 `node` 就是它）。
你要把本卡**从头到尾做完**：写代码、写测试、跑验证、出报告。


## 本卡重点

- 图标：`package.json` 里 `magpie.page.icon` **现在错放了 data URI**（契约要求相对文件路径），且**没有顶层 `magpie.icon`**（data URL）。改：新建 `page/icon.svg`、`magpie.page.icon = "page/icon.svg"`、新增顶层 `magpie.icon` = 同图形的 data URI。
- 日志现在只打 stdout（`src/server/http.mjs:93-105`），宿主把所有插件的日志混在 `%LOCALAPPDATA%\magpie\logs\app.log`（已 2.1MB）。改：写自有文件 `show-terminal.log` + 2MB 轮转（只留 1 份 `.1`）+ **写盘前脱敏**。
- 残留敏感风险：`commandHead: command.slice(0,40)`（`src/ai/runner.mjs:572-580`）可能含 `-p密码`/绝对路径；`err.stack` 原样带出（`http.mjs:97-102`）。两处都要过 `redact()`。
- 导出：`GET /api/logs/export`（附件下载，双保险再脱敏一遍）+ `GET /api/logs/status` + `DELETE /api/logs`；设置面板加「日志」block（`app/ui/settings-panel.js:416` 前，照现有 `el("button",{...})` 模式）。
- **验收要证明敏感内容不落盘**：造一条含 `Bearer abcdef123456` 与 `C:\Users\bob\secret.txt` 的日志，`grep` 日志文件确认原串不在。


## 硬约束（违反即判失败）

1. 只改 PRD「Notes / 涉及文件」里点名的文件。不碰 `app/vendor/xterm/`、不碰其它批次的文件。
2. **不 commit、不 stash、不碰 `.git` 内部**。
3. 不改 `package.json` 的 `dependencies`（除本卡明确允许的字段）。
4. **不许放宽已有断言、不许删已有测试、不许改基线夹具**来让测试变绿。已有测试红了就是你的改动坏了东西，去修代码。
5. 交付前必须跑通：`node --test`（全绿）与 `node scripts/doctor.mjs`（退出码 0）。
   - 注意：插件服务正在 `127.0.0.1:3480` 上跑，doctor 会用同一端口冲突。**用 `DOCTOR_PORT=3499 node scripts/doctor.mjs`** 或先确认端口可用。这是已知环境事实，别当成 bug 去改源码。
   - `doctor.mjs` 会被本机 `~/.config/magpie-terminal/config.json` 里的 `defaultShell` 影响（现在是 `pwsh`），需要隔离时用 `MAGPIE_TERMINAL_CONFIG_PATH` 指到临时目录（看 `src/config/store.mjs:13` 的注释）。
6. 证据全部落盘到 `.dispatch/fix17-e/evidence/`，报告写 `.dispatch/fix17-e/REPORT.md`，最后一行打印 `verdict: PASS` 或 `verdict: FAIL`。
7. 不做卡外决策。卡里没写清楚又必须决定的事，**停下来**在报告里写明 `blocked: <原因>`，不要自己拍板改目标。
8. 修完要按使用者视角自己走一遍主路径（真浏览器 / 真终端），发现缺陷先修再交。产物未验证完不许写 PASS。

## 已知环境事实（省你时间，别再重新发现）

- 插件服务已在跑：`127.0.0.1:3480`，进程是 `magpie-bun.exe`。**重启插件会打断 magpie 里正在用的页面**，除非本卡明确要求，不要重启它。
- 本机 shell：`cmd.exe` = `C:/Windows/System32/cmd.exe`、Git Bash = `C:/Program Files/Git/bin/bash.exe`（5.2.37）、PowerShell 5.1、`pwsh` 7.7.0（`%LOCALAPPDATA%/Microsoft/WindowsApps/pwsh.exe`，`existsSync` 会报 EACCES 但能执行）、`wt.exe` 存在、WSL 只有 `Ubuntu-24.04`（V2, Stopped）。
- `wsl.exe -l -v` / `-l -q` 输出是 **UTF-16LE**，直接按 utf8 读是乱码，必须先解码。
- Windows Terminal 配置：`%LOCALAPPDATA%/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json`（JSONC，含注释）。
- magpie 主题设置：`~/.config/magpie/settings.json`（`theme`: system|light|dark、`accent`、`textSize`、`lang`）。
- 真浏览器探针已有：`scripts/browser-probe.mjs`（自带极简 CDP 客户端，Chrome/Edge 路径内置）。核验用它或扩展它。
- magpie CSS 变量真名：`--bg --fg --line --accent --accent-fg --card --sub --muted --surface --surface-2 --edge --warn --bad --ok --ring`。

## 前序批次已合入 — 开工前必读

- A 批（问题1/2/3）已 commit `a2dfa3c`，B 批（问题4/17 主题）已 commit。**开工前先跑 `git log --oneline -6` 和 `git status --porcelain` 确认工作区干净**；不干净就报告 blocked，不许 stash / clean / checkout 掩盖。
- 主题现状（B 批之后）：`app/tokens.css` 里颜色全部由 `--magpie-*` 派生（`color-mix`），`--term-panel-2` 等面板底色已是不透明实色；`<html>` 上有 `is-dark` / `is-light` 类；根字号由 magpie `textSize` 映射。**你写 CSS 不许再引入写死的 `#000` / `#fff` / `rgba(120,120,120,...)`**，一律用现有变量或 `color-mix` 派生。
- A 批新增 `app/styles/terminal-surface.css`（修终端黑边，用 `!important` 覆盖 vendor xterm 的 `#000`）。**不许删或削弱它**；`app/index.html` 的引入顺序是 `vendor/xterm/xterm.css → styles/terminal-surface.css → styles/tokens.css → styles/layout.css → styles/components.css`，要动顺序必须复跑 `node scripts/probe-terminal-edges.mjs`（A 批 10/10，不许回退）。
- 基线：`node --test` 全绿（A 批结束时 763 tests）；`node scripts/doctor.mjs` 用隔离配置可达 33/33。

## 本机已知坑（A 批踩过，别再踩）

- `node --test` 的 pty 集成测试或 doctor 若报 `STEP_TIMEOUT`、或直接 spawn bash 报 `bash.exe: *** fatal error - console device allocation failure - too many consoles in use`，是本机残留的旧 `bash.exe` 孤儿耗尽 ConPTY 名额，**不是你的改动**。先跑 `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Select-Object ProcessId,CreationDate"` 看启动时间，只结束 **11/24 及更早** 的残留（当天启动的会话别杀），再重跑。不许改 `scripts/doctor.mjs`，不许放宽断言。
- doctor 隔离跑法：`MAGPIE_TERMINAL_CONFIG_PATH=<临时目录>/config.json`（内容 `{"version":1,"defaultShell":null}`）+ `DOCTOR_PORT=3499`，避免和真实配置、插件占用的 3480 端口打架。
- 原生程序不认 `/c/...` 和 `/tmp` 路径（会报 `Cannot find module 'C:\tmp\...'`）；临时脚本放仓库 `tmp/`（已被 .gitignore 忽略）或 `$TMPDIR`。

## 涉及文件（白名单，只许改这些）

- `package.json`（**只允许**改 `magpie.icon` / `magpie.page.icon` 两个字段，不许动 `dependencies` / `version` / `scripts`）
- 新增 `page/icon.svg`（侧栏图标，相对路径引用）
- `src/server/http.mjs`（新增 `/api/logs/export`、`/api/logs/status`、`DELETE /api/logs` 三个路由）
- 新增 `src/server/log-redact.mjs`（脱敏纯函数，便于单测）
- `src/server/http.mjs` 的 `makeLogger`（改成写文件 + 轮转；也可以抽到新文件 `src/server/logger.mjs`）
- `app/ui/settings-panel.js`（第 7 个 block：日志导出）
- `app/core/api.js`（三个日志接口调用）
- `app/styles/components.css`（**只在该设置 block 需要新样式时新增**，不许改既有段落）
- `test/server/**`（redact 单测 ≥10 例）
- `.dispatch/fix17-e/**`

**不许改**：`app/vendor/**`、`app/tokens.css`、`app/ui/file-panel.js`、`app/ui/ai-drawer.js`、`src/pty/**`、`src/ai/runner.mjs` 的 payload 逻辑（只允许把 `commandHead` 包一层 redact）、`scripts/doctor.mjs`。

## 图标形状（照这个画，别自己发挥）

`page/icon.svg`：64×64 viewBox，`rx="14"` 圆角矩形底 `#111318`，前景 `#4ade80` 画 `>_` 两个符号（`>` 用折线、`_` 用矩形条），描边宽度 5、圆头。顶层 `magpie.icon` 用同一个 SVG 的 data URI 内联（base64 或 URL 编码版均可），两处视觉必须一致。

## 日志脱敏的硬要求

- 日志文件路径：`%LOCALAPPDATA%\magpie\logs\show-terminal.log`（用 `process.env.LOCALAPPDATA` 拼，不许写死用户名）。
- 轮转：单文件 2MB，超出后改名 `.1`（**只留一份 `.1`**，旧的 `.1` 直接覆盖）。
- 写盘失败只 `warn` 一次，不许让插件退出。
- `GET /api/logs/export`：`Content-Disposition: attachment; filename="show-terminal-logs-<YYYYMMDD-HHmmss>.log"`，**导出前再脱敏一遍**（防历史日志里有未脱敏内容）。
- 脱敏函数必须纯、可单测：`redact(value, seen)`，深度上限 8，循环引用返回 `[Circular]`。
- **AC5 的反例必须真跑**：造一条含 `Bearer abcdef123456`、`C:\Users\bob\secret.txt`、`--password=hunter2`、`ssh-ed25519 AAAAC3...` 的日志行，导出后 `grep` 确认原文一个都不在。
