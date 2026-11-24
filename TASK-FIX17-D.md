# TASK-FIX17-D（AI 抽屉：抖动 / 下拉框透明 / 输入区重构 / 发送停止合一 / markdown（问题 7/8/9/10/11/12））

Active task: `.trellis/tasks/11-25-task-d-ai-drawer/`
父任务: `.trellis/tasks/11-25-fix-17-parent/`
必读（按顺序）：`.trellis/tasks/11-25-task-d-ai-drawer/implement.jsonl` 里列的每份文件 → `prd.md` → `design.md` → `implement.md`

工作目录 `C:/Users/41807/magpie-terminal`，Node 是 `D:/nodejs/install/node.exe`（PATH 里的 `node` 就是它）。
你要把本卡**从头到尾做完**：写代码、写测试、跑验证、出报告。


## 本卡重点

- **抖动已真浏览器复现并验证过修法**：打开抽屉 + `focus()` 后 `.main.scrollLeft` 0→385（恰为抽屉宽 385）。`focus({preventScroll:true})` 或 `.main{overflow:clip}` 任一都能修 → **两个都做**。
- 下拉框透明根因：三处菜单 `background: var(--term-panel-2)`，亮色下该值是 `rgba(120,120,120,0.12)`（`tokens.css:87`）。**本批必须独立成立**，不能依赖 B 批已把 `--term-panel-2` 改实色 → 新增 `--term-panel-solid` 并显式用它。
- 输入区结构变更：模型下拉移出 `.composer-box`，与发送按钮同一行（模型左、按钮右）；hint 改 `textarea.placeholder`（这样"输入即可覆盖"是浏览器原生行为）；删 `.composer-hint` 的 grid area（`components.css:866-870`）。
- 发送/停止合一：单元素 + `.is-busy` 类；忙碌态 = 红环（`--term-danger`）+ 深色圆心。
- markdown：**必须用现成开源库**（`marked` + `DOMPurify`），离线文件放 `app/vendor/markdown/`，不改 package.json 依赖。流式输出期间保持纯文本，消息结束后才渲染。XSS 三例（`<img onerror>`、`javascript:` 链接、`<script>`）必须被拦。
- `app/vendor/markdown/marked.umd.js` 与 `purify.min.js` 的获取：本机对 GitHub release CDN 整段不可达，**用 npm 而不是 GitHub**（`D:/nodejs/install/npm.cmd pack marked@12` 后解包取 dist 单文件），或从 unpkg 用 curl 取。取不到就 `blocked` 并写清错误，**不要自己写一个 markdown 解析器**。
  - **主控已实测（2026-11-25 03:20）**：`cd tmp && D:/nodejs/install/npm.cmd pack marked@12` → `marked-12.0.2.tgz`（166.1 KB），内含 `package/lib/marked.umd.js`（UMD，挂 `window.marked`）与 `package/marked.min.js`；`npm.cmd pack dompurify@3` → `dompurify-3.5.0.tgz`（330.0 KB），内含 `package/dist/purify.min.js`（UMD，挂 `window.DOMPurify`）。两个包都能从 npm registry 正常拉，不需要外网 CDN。
  - 落地方式建议：`tar -xzf marked-12.0.2.tgz package/lib/marked.umd.js`（在 bash 里可用），复制到 `app/vendor/markdown/marked.umd.js`，同理 `dompurify-3.5.0.tgz package/dist/purify.min.js` → `app/vendor/markdown/purify.min.js`，再写 `VERSION.md` 记 `marked 12.0.2 (MIT)` / `DOMPurify 3.5.0 (Apache-2.0 OR MPL-2.0)`。


## 硬约束（违反即判失败）

1. 只改 PRD「Notes / 涉及文件」里点名的文件。不碰 `app/vendor/xterm/`、不碰其它批次的文件。
2. **不 commit、不 stash、不碰 `.git` 内部**。
3. 不改 `package.json` 的 `dependencies`（除本卡明确允许的字段）。
4. **不许放宽已有断言、不许删已有测试、不许改基线夹具**来让测试变绿。已有测试红了就是你的改动坏了东西，去修代码。
5. 交付前必须跑通：`node --test`（全绿）与 `node scripts/doctor.mjs`（退出码 0）。
   - 注意：插件服务正在 `127.0.0.1:3480` 上跑，doctor 会用同一端口冲突。**用 `DOCTOR_PORT=3499 node scripts/doctor.mjs`** 或先确认端口可用。这是已知环境事实，别当成 bug 去改源码。
   - `doctor.mjs` 会被本机 `~/.config/magpie-terminal/config.json` 里的 `defaultShell` 影响（现在是 `pwsh`），需要隔离时用 `MAGPIE_TERMINAL_CONFIG_PATH` 指到临时目录（看 `src/config/store.mjs:13` 的注释）。
6. 证据全部落盘到 `.dispatch/fix17-d/evidence/`，报告写 `.dispatch/fix17-d/REPORT.md`，最后一行打印 `verdict: PASS` 或 `verdict: FAIL`。
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
