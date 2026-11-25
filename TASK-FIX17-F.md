# TASK-FIX17-F（安装 ui-ux-pro-max skill + 布局审查优化（问题 18））

Active task: `.trellis/tasks/11-25-task-f-ux-review/`
父任务: `.trellis/tasks/11-25-fix-17-parent/`
必读（按顺序）：`.trellis/tasks/11-25-task-f-ux-review/implement.jsonl` 里列的每份文件 → `prd.md` → `design.md` → `implement.md`

工作目录 `C:/Users/41807/magpie-terminal`，Node 是 `D:/nodejs/install/node.exe`（PATH 里的 `node` 就是它）。
你要把本卡**从头到尾做完**：写代码、写测试、跑验证、出报告。


## 本卡重点

- **skill 已由主控装好（2026-11-25 03:25），你不需要再 clone**：位置 `C:/Users/41807/AppData/Local/hermes/skills/ui-ux-pro-max/`（84 个文件，含 data/ 13 个 CSV、references/、scripts/），来源 commit `a4fc248f6136552cb881e298847abc7ddce84e6b`。安装证据在 `.dispatch/fix17-f/evidence/skill-install.txt`。
- 你的第一步是**验证它可用**：`python C:/Users/41807/AppData/Local/hermes/skills/ui-ux-pro-max/scripts/search.py "terminal layout spacing" --domain ux` 退出码 0 且有结果。不可用就 blocked（不许自己重装、不许换别的 skill）。
- 审查时至少跑这四类查询并引用原文：`--domain ux`（间距/热区/对比度/溢出）、`--domain style`（工具类产品视觉）、`--domain typography`（行高/字号）、`--domain icons`（图标按钮可访问性）。
- 审查对象是**真跑起来的界面**（`scripts/browser-probe.mjs` 起真 Chrome），四个组合都要截图：浅/深 × 宽(1600×1000)/窄(1100×800)。
- `AUDIT.md` 每条问题必须有：位置（文件:行号 或 截图坐标）、现象、违反的规则（**引 skill 原文**）、严重度（高/中/低）、建议、是否本批修。
- 只修「高」+「改 CSS 数值就能解决的中」；**禁止结构性重构**；改动只允许 `app/styles/**` 与 `app/index.html`（`git status --porcelain` 断言）。
- 修后要重新截四组图对比，逐条回填"修前值 → 修后值"。


## 硬约束（违反即判失败）

1. 只改 PRD「Notes / 涉及文件」里点名的文件。不碰 `app/vendor/xterm/`、不碰其它批次的文件。
2. **不 commit、不 stash、不碰 `.git` 内部**。
3. 不改 `package.json` 的 `dependencies`（除本卡明确允许的字段）。
4. **不许放宽已有断言、不许删已有测试、不许改基线夹具**来让测试变绿。已有测试红了就是你的改动坏了东西，去修代码。
5. 交付前必须跑通：`node --test`（全绿）与 `node scripts/doctor.mjs`（退出码 0）。
   - 注意：插件服务正在 `127.0.0.1:3480` 上跑，doctor 会用同一端口冲突。**用 `DOCTOR_PORT=3499 node scripts/doctor.mjs`** 或先确认端口可用。这是已知环境事实，别当成 bug 去改源码。
   - `doctor.mjs` 会被本机 `~/.config/magpie-terminal/config.json` 里的 `defaultShell` 影响（现在是 `pwsh`），需要隔离时用 `MAGPIE_TERMINAL_CONFIG_PATH` 指到临时目录（看 `src/config/store.mjs:13` 的注释）。
6. 证据全部落盘到 `.dispatch/fix17-f/evidence/`，报告写 `.dispatch/fix17-f/REPORT.md`，最后一行打印 `verdict: PASS` 或 `verdict: FAIL`。
7. 不做卡外决策。卡里没写清楚又必须决定的事，**停下来**在报告里写明 `blocked: <原因>`，不要自己拍板改目标。
8. 修完要按使用者视角自己走一遍主路径（真浏览器 / 真终端），发现缺陷先修再交。产物未验证完不许写 PASS。

## 已知环境事实（省你时间，别再重新发现）

- 插件服务已在跑：`127.0.0.1:3480`，进程是 `magpie-bun.exe`。**重启插件会打断 magpie 里正在用的页面**，除非本卡明确要求，不要重启它。
- 本机 shell：`cmd.exe` = `C:/Windows/System32/cmd.exe`、Git Bash = `C:/Program Files/Git/bin/bash.exe`（5.2.37）、PowerShell 5.1、`pwsh` 7.7.0（`%LOCALAPPDATA%/Microsoft/WindowsApps/pwsh.exe`，`existsSync` 会报 EACCES 但能执行）、`wt.exe` 存在、WSL 只有 `Ubuntu-24.04`（V2, Stopped）。
- `wsl.exe -l -v` / `-l -q` 输出是 **UTF-16LE**，直接按 utf8 读是乱码，必须先解码。
- Windows Terminal 配置：`%LOCALAPPDATA%/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json`（JSONC，含注释）。
- magpie 主题设置：`~/.config/magpie/settings.json`（`theme`: system|light|dark、`accent`、`textSize`、`lang`）。
- 真浏览器探针已有：`scripts/browser-probe.mjs`（自带极简 CDP 客户端，Chrome/Edge 路径内置）。核验用它或扩展它。
- **深浅色截图怎么切（别改用户真实配置）**：真正配色由 `GET /api/theme` 决定，客户端 prefer 只来自 `app/app.js:875-882 systemPreference()` 的 `matchMedia("(prefers-color-scheme: dark)")`。所以用 CDP `Emulation.setEmulatedMedia({features:[{name:"prefers-color-scheme",value:"dark"|"light"}]})` 再刷新页面即可拿到两套配色。**不要写 `~/.config/magpie/settings.json`**（那是用户真实设置）。URL 上的 `?theme=dark|light` 只加 `colorScheme` 与 `theme-dark/theme-light` 类（`app/app.js:76-90`），不改变实际调色板，单靠它截图会得到"类名对、颜色不对"的假象。
- magpie CSS 变量真名：`--bg --fg --line --accent --accent-fg --card --sub --muted --surface --surface-2 --edge --warn --bad --ok --ring`。
