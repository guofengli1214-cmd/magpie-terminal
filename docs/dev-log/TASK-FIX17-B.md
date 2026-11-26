# TASK-FIX17-B（主题系统：magpie 深浅色 + 色系跟随（问题 4 / 17））

Active task: `.trellis/tasks/11-25-task-b-theme/`
父任务: `.trellis/tasks/11-25-fix-17-parent/`
必读（按顺序）：`.trellis/tasks/11-25-task-b-theme/implement.jsonl` 里列的每份文件 → `prd.md` → `design.md` → `implement.md`

工作目录 `C:/Users/41807/magpie-terminal`，Node 是 `D:/nodejs/install/node.exe`（PATH 里的 `node` 就是它）。
你要把本卡**从头到尾做完**：写代码、写测试、跑验证、出报告。


## 本卡重点

- 注入链路是断的：`page/boot.js:24` 取 `ready.tokens`（键是裸 `bg/fg/card`…），`src/server/http.mjs:181` 的 `decodeTokens` 只收 `/^--/` 开头的键 → 裸键全被丢弃（已实测注入为空）。而且即使注入也写错名字：`--term-border→--magpie-muted`（应 `--magpie-line`）、`--term-accent→--magpie-fg`（应 `--magpie-accent`）、`--term-panel-bg→--magpie-bg`（应 `--magpie-card`）。
- `theme` 只在 `app/app.js:72-88` 读一次，`theme-dark` 类加了但 CSS 里**没有任何对应规则**；无 `matchMedia`；页面跳转后 `window.magpie` 变 `undefined`（`page/index.html:29` → `boot.js:98`），bridge 的 `onTheme` 丢失。
- 硬编码色全在 `app/styles/tokens.css`：`:21-32`（`--term-danger` 等）、`:35-50`（ANSI 16 色写死）、`:87-103`（`--term-panel-2: rgba(120,120,120,0.12)` → 亮色下 88% 透明，这是 D 批下拉框透明的根因）、`:108-153`（`@media prefers-color-scheme dark` 一整套，跟 magpie 主题脱钩）。
- `buildRootStyle`（`http.mjs:192-204`）用 `html:root` 选择器（特异性 0,1,1），比 `:root` 高。
- **验收要用真浏览器**：改 `~/.config/magpie/settings.json` 的 theme 后，不刷新页面颜色就要跟着变（这是 AC 里最硬的一条）。


## 硬约束（违反即判失败）

1. 只改 PRD「Notes / 涉及文件」里点名的文件。不碰 `app/vendor/xterm/`、不碰其它批次的文件。
2. **不 commit、不 stash、不碰 `.git` 内部**。
3. 不改 `package.json` 的 `dependencies`（除本卡明确允许的字段）。
4. **不许放宽已有断言、不许删已有测试、不许改基线夹具**来让测试变绿。已有测试红了就是你的改动坏了东西，去修代码。
5. 交付前必须跑通：`node --test`（全绿）与 `node scripts/doctor.mjs`（退出码 0）。
   - 注意：插件服务正在 `127.0.0.1:3480` 上跑，doctor 会用同一端口冲突。**用 `DOCTOR_PORT=3499 node scripts/doctor.mjs`** 或先确认端口可用。这是已知环境事实，别当成 bug 去改源码。
   - `doctor.mjs` 会被本机 `~/.config/magpie-terminal/config.json` 里的 `defaultShell` 影响（现在是 `pwsh`），需要隔离时用 `MAGPIE_TERMINAL_CONFIG_PATH` 指到临时目录（看 `src/config/store.mjs:13` 的注释）。
6. 证据全部落盘到 `.dispatch/fix17-b/evidence/`，报告写 `.dispatch/fix17-b/REPORT.md`，最后一行打印 `verdict: PASS` 或 `verdict: FAIL`。
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

## A 批已合入（commit a2dfa3c）— 开工前必读

- 工作区现在应是干净的（`git status --porcelain` 为空）。若不为空，先报告 blocked，不要自己 stash/clean。
- 主题相关现状已变，别再按上面的"旧根因"理解这几处：
  - `app/styles/tokens.css` 的 `--term-bg` 已有真实色值兜底（浅 `#f4f4f6` / 深 `#1a1a1e`），不再是 `Canvas`。
  - `app/ui/terminal-view.js` 的 `refreshTheme()` 已被调用（A 批接上了主题切换路径），本批要保证主题变化时**所有**终端实例都 refresh。
  - 新增 `app/styles/terminal-surface.css`（A 批修黑边用，`!important` 覆盖 xterm vendor 的 `#000`）。**不要删它、不要削弱它**；本批若要让终端底色跟随 `--term-bg`，改 `tokens.css` 的变量来源即可，覆盖规则本身保留。
  - `app/index.html` 的引入顺序已改为：`vendor/xterm/xterm.css` → `styles/terminal-surface.css` → `styles/tokens.css` → `styles/layout.css` → `styles/components.css`。要动顺序必须在报告里说明理由并复跑黑边探针 `node scripts/probe-terminal-edges.mjs`（A 批 AC8，当时 10/10 PASS，不许回退）。
  - `node --test` 现在 763 tests 全绿；`node scripts/doctor.mjs` 用隔离配置可达 33/33。

## 涉及文件（白名单，只许改这些）

- `app/styles/tokens.css`（本批主战场）
- `app/styles/terminal-surface.css`（仅在需要让终端底色跟随变量时改，且必须复跑黑边探针）
- `app/app.js`（主题应用、`is-dark` / `is-light` 类、轮询或事件驱动刷新）
- `app/index.html`（仅在必须加脚本/样式引用时改）
- `app/ui/terminal-view.js`（所有实例 refreshTheme）
- `app/core/api.js`（调 `/api/theme`）
- `page/boot.js`（bridge tokens 转存 / 跳转前上报）
- `src/server/http.mjs`（`decodeTokens` 裸键归一 + `GET /api/theme` + `POST /api/theme/bridge`）
- `src/config/store.mjs` 或新增 `src/config/magpie-settings.mjs`（只读读取 `~/.config/magpie/settings.json`）
- `test/**`（新增/更新单测）
- 新增 `scripts/probe-theme.mjs`（真浏览器验收脚本）
- `.dispatch/fix17-b/**`（证据与报告）

**不许改**：`app/vendor/**`、`app/styles/components.css`、`app/styles/layout.css`（D 批地盘）、`app/ui/file-panel.js`、`app/ui/ai-drawer.js`、`app/ui/hosts-panel.js`、`src/pty/**`（A 批已定稿）、`scripts/doctor.mjs`。

## 本机已知坑（A 批踩过）

- `node --test` 的 pty 集成测试 / doctor 若报 `STEP_TIMEOUT` 或 `console device allocation failure - too many consoles in use`，是本机残留的旧 `bash.exe` 孤儿耗尽 ConPTY 名额，**不是你的改动**。先 `Get-CimInstance Win32_Process -Filter "Name='bash.exe'"` 看启动时间，只结束 11/24 及更早的残留（今天的会话别杀），再重跑。不许改 `scripts/doctor.mjs`，不许放宽断言。
- doctor 用 `MAGPIE_TERMINAL_CONFIG_PATH=<临时目录>/config.json`（内容 `{"version":1,"defaultShell":null}`）+ `DOCTOR_PORT=3499` 隔离跑，避免和真实配置、插件占用的 3480 端口打架。
- 计时器/轮询要写成可测形式（导出纯函数或允许注入 interval），否则 AC3 的"不刷新就变色"没法自动化验收。
