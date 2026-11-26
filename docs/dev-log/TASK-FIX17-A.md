# TASK-FIX17-A — 终端内核（问题 1 / 2 / 3）

Active task: .trellis/tasks/11-25-task-a-shell-core
Parent task: .trellis/tasks/11-25-fix-17-parent

## 你的任务

按 `.trellis/tasks/11-25-task-a-shell-core/prd.md` 实现并自测 AC1–AC10。
技术设计见同目录 `design.md`，执行步骤见 `implement.md`。根因档案见
`.trellis/tasks/11-25-fix-17-parent/notes-root-cause.md` 的问题 1/2/3 段（带 文件:行号）。
改动前先读 `.trellis/spec/backend/pty-lifecycle.md`、
`.trellis/spec/frontend/terminal-rendering.md`、`.trellis/spec/frontend/theme-tokens.md`。

## 环境

- 仓库：`C:/Users/41807/magpie-terminal`（就在这里工作）
- Node：`D:/nodejs/install/node.exe`（`node -v` = v24.16.0）
- 本机已装的 shell（已实测，供你核对探测结果）：`cmd.exe`（C:/Windows/System32/cmd.exe）、
  Git Bash（C:/Program Files/Git/bin/bash.exe）、Windows PowerShell 5.1
  （C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe）、pwsh 7.7.0
  （%LOCALAPPDATA%/Microsoft/WindowsApps/pwsh.exe）、`wt.exe` 存在；
  WSL 只有 `Ubuntu-24.04`（V2，Stopped），`wsl.exe -l -v` 的输出是 **UTF-16LE**。
  WT settings.json：`%LOCALAPPDATA%/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json`。
- 注意：本机 PATH 里 `pwsh` 的 existsSync 会报 EACCES，但能 exec（现有 detectPwsh 已处理，别退化）。

## 硬约束

1. 只改 `prd.md` 里列出的文件范围；**不改** `app/vendor/xterm/` 下任何文件；
   **不改** `app/ui/file-panel.js`、`app/ui/ai-drawer.js`、`app/ui/hosts-panel.js`（别的批次的地盘）。
2. 不 commit、不 stash、不碰 `.git`、不 `git checkout` 任何文件。
3. 不改 `package.json` 依赖（不许装新包；WT JSONC 用自己写的容错解析）。
4. 不删也不改 `/api/shells` 的已有响应字段名；只许新增。
5. 「靠证据说话」：每条 AC 都要有可复跑的命令和落盘原始输出。自测脚本放 `scripts/`，
   证据放 `.dispatch/fix17-a/evidence/`。
6. 不许为了让测试过而放宽既有断言、删测试、改测试基线。
7. 交付前先跑一遍：`node --test` 与 `node scripts/doctor.mjs`，两个都必须绿。
   若 doctor 里有与本批无关的既有失败，单独记录，不要为了绿而改无关代码。

## 重点风险（已知，务必这样办）

- **删 `\\r` 可能丢首字符**：`src/pty/session.mjs` 的 `armWarmup()` 输入排队机制要保留并可能加长窗口
  （与前端 `app/core/constants.js:9` 的 `INPUT_LOCK_MS` 同步）。必须用脚本实测「新开终端立刻输入
  `echo FIRST<CR>` → FIRST 恰好出现一次、无空行、不丢首字符」。若丢字符，加长窗口重测，
  **绝对不许把 `write("\\r")` 加回去**。
- **`src/config/store.mjs` 的 SHELL_IDS 白名单必须换成格式校验**，否则 `cmd` / `wsl:*` 存进配置会被误杀。
- **WSL 输出 UTF-16LE**：不按 utf16le 解就是乱码，会得到假的发行版名。
- **`src/server/ws.mjs:51` `max(32)` 要放宽到 `max(64)`**，否则 `wsl:Ubuntu-24.04`（16 字符没问题，
  但 WT profile 派生的 `profile:` id 可能接近上限）会被 zod 打成 BAD_FRAME。
- **黑边是 3 个来源叠加**：xterm.css 的 `#000`、layout.css 的 `padding:2px`、`--term-bg: Canvas` 回落黑。
  只修一个不会消失。改完要真浏览器取像素证明（浅色 + 深色两套）。

## 交付

1. 代码改动（工作区，不 commit）。
2. `.dispatch/fix17-a/evidence/` 下每条的原始输出（命令 + stdout/截图/JSON）。
3. `.dispatch/fix17-a/REPORT.md`：AC1–AC10 逐条「结论 / 证据路径 / 若未达成说明」，
   外加「改了哪些文件（带行号）」「没做什么」「已知风险」。
4. 最后打印一行 `verdict: PASS` 或 `verdict: FAIL`（FAIL 要写清哪条 AC 没过）。
