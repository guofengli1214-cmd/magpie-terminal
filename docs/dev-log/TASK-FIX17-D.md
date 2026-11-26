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

- `app/ui/ai-drawer.js`（抽屉抖动、composer 结构、单按钮双形态、markdown 渲染接线）
- `app/styles/components.css`（**只改 220-842 抽屉段与 843-1126 composer 段**，并可在文件末尾新增 markdown 渲染样式段；不许碰 1541 之后的文件面板/主机面板/会话段）
- `app/styles/layout.css`（仅 `.main` 的 `overflow: clip` 与抽屉相关定位）
- `app/index.html`（引入 vendor markdown 脚本）
- 新增 `app/vendor/markdown/{marked.umd.js,purify.min.js,markdown.js,VERSION.md}`（离线文件，已由主控下好，见下）
- 新增 `scripts/probe-drawer.mjs`（真浏览器抖动与按钮形态验收脚本）
- `test/app/**`（新增单测，如 markdown 渲染的三例 XSS）
- `.dispatch/fix17-d/**`

**不许改**：`app/vendor/xterm/**`、`app/tokens.css`、`app/ui/file-panel.js`、`app/ui/tab-bar.js`、`app/ui/hosts-panel.js`、`src/**`（本批纯前端）、`scripts/doctor.mjs`、`package.json`。

## 离线 markdown 库已备好（不用联网，别再找 CDN）

主控已在 `.dispatch/fix17-d/vendor/` 下好两个 npm 包并核对过内部路径：

- `marked-12.0.2.tgz`（166.1 KB，sha256 `6cfd2d09c6bce2541558a1547e5f3b9895ed743f0d287536ff2280e318e8a074`）内含 `package/lib/marked.umd.js`（UMD，挂 `window.marked`）
- `dompurify-3.5.0.tgz`（330.0 KB，sha256 `faa5f2bfe2814384b83d6edb4ed66812fbfdb2a654b4d59edd4b12304058ec20`）内含 `package/dist/purify.min.js`（UMD，挂 `window.DOMPurify`）

解包（bash 可用）：

```
cd .dispatch/fix17-d/vendor
tar -xzf marked-12.0.2.tgz package/lib/marked.umd.js
tar -xzf dompurify-3.5.0.tgz package/dist/purify.min.js
mkdir -p ../../../app/vendor/markdown
cp package/lib/marked.umd.js ../../../app/vendor/markdown/marked.umd.js
cp package/dist/purify.min.js ../../../app/vendor/markdown/purify.min.js
```

`VERSION.md` 要写：`marked 12.0.2 (MIT)`、`DOMPurify 3.5.0 (Apache-2.0 OR MPL-2.0)`、来源 npm registry、两个 tgz 的 sha256。`/vendor/` 已在 `src/server/static.mjs` 的 `STATIC_PREFIXES` 里，静态服务不用改。
