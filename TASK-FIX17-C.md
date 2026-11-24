# TASK-FIX17-C（文件面板：定位按钮 / 多选批量操作 / 去掉主机栏文件按钮（问题 5 / 6 / 16））

Active task: `.trellis/tasks/11-25-task-c-file-panel/`
父任务: `.trellis/tasks/11-25-fix-17-parent/`
必读（按顺序）：`.trellis/tasks/11-25-task-c-file-panel/implement.jsonl` 里列的每份文件 → `prd.md` → `design.md` → `implement.md`

工作目录 `C:/Users/41807/magpie-terminal`，Node 是 `D:/nodejs/install/node.exe`（PATH 里的 `node` 就是它）。
你要把本卡**从头到尾做完**：写代码、写测试、跑验证、出报告。


## 本卡重点

- 现有 `followButton`（`app/ui/file-panel.js:1491-1502`）的显隐条件 `:476-485` 让用户根本看不见 → 改成**始终可见的内联 SVG 图标按钮 + 三态**。
- 现在是纯单选（`:319` `selected: new Set()`；`:758-766` 点击先 `clear()` 再 `add()`）→ 加 ctrl/meta/shift/ctrl+A/escape。
- 后端**没有 move 接口**，`src/fs/local.mjs:422` 的 `renamePath` 只调 `rename`，跨盘 `EXDEV` 会失败 → 新增 `POST /api/fs/move` + EXDEV 降级（复制→校验大小→删源）。
- 删 `app/ui/hosts-panel.js:777-789` 的 `hosts-open-files` 按钮 + `app/app.js:758-760` 传参 + `components.css:1601-1612` 样式；`app/index.html:40-42` 的 rail 入口必须保留。
- `components.css` 只改 **2089-2685（文件面板）** 与 **1541-1936（主机面板）** 两段，不要碰 843-1126 与 220-842。


## 硬约束（违反即判失败）

1. 只改 PRD「Notes / 涉及文件」里点名的文件。不碰 `app/vendor/xterm/`、不碰其它批次的文件。
2. **不 commit、不 stash、不碰 `.git` 内部**。
3. 不改 `package.json` 的 `dependencies`（除本卡明确允许的字段）。
4. **不许放宽已有断言、不许删已有测试、不许改基线夹具**来让测试变绿。已有测试红了就是你的改动坏了东西，去修代码。
5. 交付前必须跑通：`node --test`（全绿）与 `node scripts/doctor.mjs`（退出码 0）。
   - 注意：插件服务正在 `127.0.0.1:3480` 上跑，doctor 会用同一端口冲突。**用 `DOCTOR_PORT=3499 node scripts/doctor.mjs`** 或先确认端口可用。这是已知环境事实，别当成 bug 去改源码。
   - `doctor.mjs` 会被本机 `~/.config/magpie-terminal/config.json` 里的 `defaultShell` 影响（现在是 `pwsh`），需要隔离时用 `MAGPIE_TERMINAL_CONFIG_PATH` 指到临时目录（看 `src/config/store.mjs:13` 的注释）。
6. 证据全部落盘到 `.dispatch/fix17-c/evidence/`，报告写 `.dispatch/fix17-c/REPORT.md`，最后一行打印 `verdict: PASS` 或 `verdict: FAIL`。
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
