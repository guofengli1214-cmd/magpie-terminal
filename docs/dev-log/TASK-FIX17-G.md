# TASK-FIX17-G（更新机制：版本显示 + 检查更新（问题 15，最后一批））

Active task: `.trellis/tasks/11-25-task-g-update/`
父任务: `.trellis/tasks/11-25-fix-17-parent/`
必读（按顺序）：`.trellis/tasks/11-25-task-g-update/implement.jsonl` 里列的每份文件 → `prd.md` → `design.md` → `implement.md`

工作目录 `C:/Users/41807/magpie-terminal`，Node 是 `D:/nodejs/install/node.exe`（PATH 里的 `node` 就是它）。
你要把本卡**从头到尾做完**：写代码、写测试、跑验证、出报告。


## 本卡重点

用户原话：「如果后面我在 github 更新了，旧版本的用户怎么更新插件？需不需要在设置页面增加插件更新按钮？」

- 现状：`git remote` 为空、`package.json` 无 `repository`、`private: true`、版本 0.1.0；插件以**裸路径**挂在 `~/.config/magpie/plugins.json`（官方插件是 `@magpie-community/x@latest`）；`magpie plugin update` **只对带版本的 spec 生效**，裸路径原地不动。官方插件也都不做自更新。
- 本批做能落地的：`GET /api/version`（version/name/repository/installKind/updateSupported）+ `GET /api/update/check`（GitHub API，5s 超时，5 分钟缓存，失败给人话不假装最新）+ 设置页「关于/更新」block（版本、仓库、安装方式、检查更新按钮、"如何更新"折叠说明按 installKind 给不同命令）。
- **不做自动下载安装**（magpie 没这 API，写了会在 plugins.json 留脏状态）。
- 不改 `~/.config/magpie/plugins.json`、不建 git remote、不加 npm 依赖。


## 硬约束（违反即判失败）

1. 只改 PRD「Notes / 涉及文件」里点名的文件。不碰 `app/vendor/xterm/`、不碰其它批次的文件。
2. **不 commit、不 stash、不碰 `.git` 内部**。
3. 不改 `package.json` 的 `dependencies`（除本卡明确允许的字段）。
4. **不许放宽已有断言、不许删已有测试、不许改基线夹具**来让测试变绿。已有测试红了就是你的改动坏了东西，去修代码。
5. 交付前必须跑通：`node --test`（全绿）与 `node scripts/doctor.mjs`（退出码 0）。
   - 注意：插件服务正在 `127.0.0.1:3480` 上跑，doctor 会用同一端口冲突。**用 `DOCTOR_PORT=3499 node scripts/doctor.mjs`** 或先确认端口可用。这是已知环境事实，别当成 bug 去改源码。
   - `doctor.mjs` 会被本机 `~/.config/magpie-terminal/config.json` 里的 `defaultShell` 影响（现在是 `pwsh`），需要隔离时用 `MAGPIE_TERMINAL_CONFIG_PATH` 指到临时目录（看 `src/config/store.mjs:13` 的注释）。
6. 证据全部落盘到 `.dispatch/fix17-g/evidence/`，报告写 `.dispatch/fix17-g/REPORT.md`，最后一行打印 `verdict: PASS` 或 `verdict: FAIL`。
   - 探针脚本本身放 `scripts/probe-update.mjs`（白名单允许），跑出来的输出/截图进 `.dispatch/fix17-g/evidence/`。
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

- A 批（问题1/2/3）已 commit `a2dfa3c`，B 批（问题4/17 主题）`bcac4e9`，C 批（5/6/16）`52a064e`，D 批（7/8/9/10/11/12）`b00157b`，E 批（13/14）`9ee519f`，E2（日志洪水）`aa8b033`，F 批（17 布局审查）`7853e4c` —— **七批全部合入，本批是最后一批**。开工前先跑 `git log --oneline -6` 和 `git status --porcelain` 确认工作区干净；不干净就报告 blocked，不许 stash / clean / checkout 掩盖。
- 主题现状（B 批之后）：`app/styles/tokens.css` 里颜色全部由 `--magpie-*` 派生（`color-mix`），`--term-panel-2` 等面板底色已是不透明实色；`<html>` 上有 `is-dark` / `is-light` 类；根字号由 magpie `textSize` 映射。**你写 CSS 不许再引入写死的 `#000` / `#fff` / `rgba(120,120,120,...)`**，一律用现有变量或 `color-mix` 派生。
- F 批（2026-11-25）给输入控件定了规矩，本批新控件照用：边框 `1px solid var(--term-line-3)`（浅 3.09:1 / 深 4.73:1，`--term-line`/`--term-line-2` 太淡不合格），聚焦 `border-color: var(--term-focus)`（浅 7.04 / 深 7.68）。深色下 `--term-accent` 已改成 `color-mix(accent 42%, fg)` 才有可读性，别直接拿 `--magpie-accent` 当前景色。
- A 批新增 `app/styles/terminal-surface.css`（修终端黑边，用 `!important` 覆盖 vendor xterm 的 `#000`）。**不许删或削弱它**；`app/index.html` 的引入顺序是 `vendor/xterm/xterm.css → styles/terminal-surface.css → styles/tokens.css → styles/layout.css → styles/components.css`，要动顺序必须复跑 `node scripts/probe-terminal-edges.mjs`（A 批 10/10，不许回退）。
- 基线：`node --test` 全绿（**截至 F 批 995 tests**）；`node scripts/doctor.mjs` 用隔离配置可达 33/33；`node scripts/probe-terminal-edges.mjs` 10/10。

## 本机已知坑（A 批踩过，别再踩）

- `node --test` 的 pty 集成测试或 doctor 若报 `STEP_TIMEOUT`、或直接 spawn bash 报 `bash.exe: *** fatal error - console device allocation failure - too many consoles in use`，是本机残留的旧 `bash.exe` 孤儿耗尽 ConPTY 名额，**不是你的改动**。先跑 `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Select-Object ProcessId,CreationDate"` 看启动时间，只结束 **11/24 及更早** 的残留（当天启动的会话别杀），再重跑。不许改 `scripts/doctor.mjs`，不许放宽断言。
- doctor 隔离跑法：`MAGPIE_TERMINAL_CONFIG_PATH=<临时目录>/config.json`（内容 `{"version":1,"defaultShell":null}`）+ `DOCTOR_PORT=3499`，避免和真实配置、插件占用的 3480 端口打架。
- 原生程序不认 `/c/...` 和 `/tmp` 路径（会报 `Cannot find module 'C:\tmp\...'`）；临时脚本放仓库 `tmp/`（已被 .gitignore 忽略）或 `$TMPDIR`。

## 涉及文件（白名单，只许改这些）

- `src/server/http.mjs`（新增 `GET /api/version`、`GET /api/update/check`）
- 新增 `src/config/install-kind.mjs`（读 `~/.config/magpie/plugins.json` 判定 local-path / registry / unknown）
- 新增 `src/config/update-check.mjs`（`compareSemver` + `checkForUpdate` 纯函数，可注入 fetch 与缓存）
- `app/ui/settings-panel.js`（第 8 个 block：关于/更新）
- `app/core/api.js`（两个接口调用）
- `app/styles/components.css`（仅新增该 block 需要的样式）
- 新增 `scripts/probe-update.mjs`（真浏览器探针）
- `test/server/**`、`test/config/**`（单测）
- `.dispatch/fix17-g/**`

**不许改**：`package.json` 的 `version`（保持 0.1.0，本卡不发布）、`~/.config/magpie/plugins.json`（只读）、`scripts/doctor.mjs`。

**不许做**：自动下载 / 自动安装更新（magpie 无此 API）、加 npm 依赖、伪装"已是最新"。

## 关键判定（照做，别猜）

- `GET /api/version` 返回 `{version, name, repository, installKind, updateSupported}`。`repository` 读 `package.json` 的 `repository` 字段（可能是 string，也可能是 `{type,url}`，两种都要处理）；没有就返回 `null`。`installKind` 判定：spec 是裸路径（盘符开头、`/` 开头、或 `\\\\` 开头）→ `local-path`；带 `@` 版本范围 → `registry`；读不到 plugins.json → `unknown`。
- **测试不许碰真实配置**：`plugins.json` 的路径必须能注入。约定：`detectInstallKind({ pluginsPath })`（默认 `~/.config/magpie/plugins.json`，可用环境变量 `MAGPIE_PLUGINS_PATH` 覆盖，纯为测试隔离），单测传临时文件路径。不许在测试里写真实的 `~/.config/magpie/plugins.json`。
- **更新检查要可注入**：GitHub 请求与版本比较写成纯函数（建议新增 `src/config/update-check.mjs`：`compareSemver(a,b)` + `checkForUpdate({repository, installKind, fetchImpl, cache})`），单测传假 `fetchImpl` 与假时钟，**不许单测真连 GitHub**。路由层只做「读版本/安装方式 → 调纯函数 → 返回」。这样 AC3/AC4 不需要改 `package.json` 也能验，也更稳。
- `GET /api/update/check` 的抓取条件：`repository` 是 GitHub 且 `installKind === "registry"` 才真请求 `https://api.github.com/repos/<owner>/<repo>/releases/latest`，用 `AbortSignal.timeout(5000)`，结果在模块级缓存 5 分钟。`installKind === "local-path"` 时**不发网络请求**，直接返回 `{hasUpdate:false, note:"本地目录安装：在仓库里 git pull 后重启 magpie 即可"}`（这不是错误，UI 显示成提示而不是失败）。任何失败（网络 / 404 / 限流）都返回 `{hasUpdate:false, error:"<人话>"}`，`error` 里不许塞 stack。
- 设置面板文案按 `installKind` 给不同"如何更新"说明：`local-path` → "这个插件是本地目录安装，`git pull` 后重启 magpie 即可"；`registry` → "在 magpie 插件页点更新，或运行 `magpie plugin update <name>`"；`unknown` → "无法判断安装方式"。
- AC3 验证方式（**不许把 `repository` 留在提交里**，本卡不决定发布地址）：用纯函数 + 假 fetch 断言「有 repository + registry → 调用了 GitHub API、解析出 hasUpdate/latest/url」；再对真接口做一次「本地路径安装不发网络请求」的断言（AC1 的 `updateSupported` 仍是 `false`，因为本机无 repository）。如果你想额外用临时桩验证真 HTTP 路径，临时改 `package.json` 后必须 `git checkout -- package.json` 并 `git diff` 确认为空。
