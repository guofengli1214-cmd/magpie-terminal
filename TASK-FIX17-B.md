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
