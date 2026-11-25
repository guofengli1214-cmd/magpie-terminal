# TASK-FIX17-K · 系统目录保护（P0）

> 你是谁：本仓库（C:/Users/41807/magpie-terminal）的执行 agent。只按本卡执行，遇到需要人类拍板的事返回 `needs_clarification`，不要直接问人。
> 任务单：`.trellis/tasks/11-25-task-k-protected-paths/prd.md`（需求 / 验收标准）、`design.md`（分层与归一化设计）、`implement.md`（步骤）。
> **prd.md 是规格，本卡是执行补充；冲突时以 prd.md 为准，并在报告里记冲突点。**

## 0. 这次要修的到底是什么

J 批（commit `0e790fd`）把黑名单拆成「灾难级 / 可审阅」两层后，主 agent 的验证发现（**这是 J 之前就存在的缺口，不是 J 的回归**）：

```
Remove-Item -Recurse -Force C:\Windows                    → auto，guardOk=true，tier=normal
Remove-Item -Recurse -Force 'C:\Program Files'            → auto
Clear-Content C:\Windows\System32\drivers\etc\hosts       → auto
rm -rf C:/Windows（对话里出现过 "windows"）               → auto
del /f /s /q C:\Windows（同上）                            → auto
```

复现证据（已落盘）：`.dispatch/fix17-j/verify/own/own-j-gap.txt`。

三层原因（都已在 prd 里列了行号级说明）：① 删除类灾难级规则只认盘根/家目录；② `DESTRUCTIVE_HEADS` 没有 PowerShell 删除头与 `Clear-Content`，取不到目标 → 护栏空过；③ 护栏「对话点名过就放行」对系统目录没例外。

**目标：系统目录的删除/清空/移动一律灾难级（confirm，不送审），用户自己目录里的删除照旧能自动放行。**

## 1. 前序状态（开工先核对）

```bash
cd C:/Users/41807/magpie-terminal
git log --oneline -5     # 最近应有 0e790fd (J) 与 89bc883 (archive J)
git status --porcelain   # 必须只有 .trellis/tasks/11-25-task-k-protected-paths/task.json
```

- 基线：`node --test` = **1239/1239 pass**；`node scripts/probe-terminal-edges.mjs` = 10/10；`node scripts/probe-review-context.mjs` = 40/40；`node scripts/probe-review-redirect.mjs` = **39/48（已知红，本批 R4 要修到 48/48）**。
- 不干净且改动不属于本任务 → `blocked`，别硬来。

## 2. 文件白名单（只许动这些）

```
src/policy/protected-paths.mjs         （新增）
src/policy/forbidden.mjs
src/policy/destructive-targets.mjs
test/policy/**                          （可新增文件）
scripts/probe-review-redirect.mjs       （只改负对照基线那一处 + 注释）
scripts/probe-protected-paths.mjs       （新增）
docs/security.md
.trellis/spec/backend/security-model.md
.trellis/tasks/11-25-task-k-protected-paths/**   （trellis 自己的状态文件）
.dispatch/fix17-k/**                    （报告与证据）
```

**禁改**：`app/**`（全部前端）、`src/ai/**`、`src/server/**`、`src/config/**`、`src/fs/**`、`src/pty/**`、`package.json`、`package-lock.json`、`scripts/doctor.mjs`、`scripts/probe-review-context.mjs`、`test/ai/**`、`.trellis/tasks/archive/**`。**不要 git add / git commit**（主 agent 验收后提交）。

## 3. 实现要点（细节见 prd R1–R6 与 design.md）

- `protected-paths.mjs` 不 import `forbidden.mjs` / `destructive-targets.mjs`（避免环）。两边都 import 它。
- 子树保护：`c:/windows`、`c:/program files`、`c:/program files (x86)`、`c:/programdata`；只保护本身：`c:/users`、`/`、`/etc`、`/usr`、`/bin`、`/sbin`、`/boot`、`/dev`、`/lib`、`/lib64`、`/var`、`/home`、`/root`、`/opt`、`/srv`、`/sys`、`/proc`、`/System`、`/Library`、`/Applications`、`/private`。
- 归一化顺序：去引号 → 反斜杠转正斜杠 → 去尾随 `/` 与 `*` → `path.resolve(cwd, x)` → Windows 下小写比较。`C:\Windows\..\Windows` 必须先 resolve 再判。
- 删除/移动头集合：`rm rmdir rd del erase remove-item ri clear-content clc mv move`（**不要**加 `cp`/`copy`）。
- PowerShell 参数：`-Path` / `-LiteralPath` / `-Destination` 的**下一个**参数是目标；`-Recurse` / `-Force` / `-WhatIf` / `-r` / `-Recurse:$false` 一律当开关。
- 系统变量目标（`%SystemRoot%`、`%windir%`、`$env:SystemRoot`、`${env:SystemRoot}`）在删除/移动头下 → 直接灾难级；其它命令头不判。
- 变量 / 通配符（非系统变量）在删除头下仍交给护栏（J 批行为不变）。
- `destructive-targets.mjs` 的 `DESTRUCTIVE_HEADS` 加 `remove-item`、`ri`、`clear-content`、`clc`，**并且** `extractDestructiveTargets` 要认 PowerShell 命名参数（否则加了头也取不到目标，护栏还是空过）。
- 现有单测 `test/policy/forbidden-tier.test.mjs`（J 批新增）与 `test/policy/destructive-targets.test.mjs` 一条都不许删、不许放宽断言；要改语义必须先说明为什么。

## 4. 验收（全做，逐条落证据到 `.dispatch/fix17-k/evidence/`）

| 编号 | 怎么验 | 期望 |
|---|---|---|
| AC1 | `node --test > evidence/ac1-node-test.txt 2>&1` | 全绿，总数 ≥ 1254（1239 + ≥15 新增） |
| AC2 | `MAGPIE_TERMINAL_CONFIG_PATH=$PWD/tmp/k-doctor/config.json DOCTOR_PORT=3881 node scripts/doctor.mjs` | `33/33 assertions passed`，退出码 0（临时配置内容 `{"version":1,"defaultShell":null}`，验完删掉） |
| AC3 | `node scripts/probe-terminal-edges.mjs` | 10/10 |
| AC4 | `node scripts/probe-review-redirect.mjs` | **48/48**（R4 修基线后） |
| AC5 | `node scripts/probe-protected-paths.mjs` | 全过（≥30 条），把 `N/N passed` 原样贴进报告 |
| AC6 | `git status --porcelain -- app src/ai src/server src/config package.json scripts/doctor.mjs scripts/probe-review-context.mjs test/ai` | 空 |
| AC7 | 新增代码里 `grep -E '#[0-9a-fA-F]{3,8}|rgba?\('` | 无命中（本批纯后端） |
| AC8 | 报告里写一段走查 | 用户说「把 build 删了」→ 必须能 auto；「删 C:\Windows」→ 必须 confirm |

`probe-protected-paths.mjs` 必须覆盖三组（prd R5 列了具体命令）：
1. 灾难级 12+ 条：`reviewCalls === 0` 且 `decision === "confirm"`；
2. 正常放行 10+ 条：假审阅返回 `aligned:true, risk:"safe", reversible:true` 时 `decision === "auto"`；
3. 不误伤 8+ 条：`guardOk` 正常、未命中灾难级（`rm -rf C:\Users\41807\project\build` 在 cwd 内必须 auto）。

## 5. 本机已知坑（踩过，别再踩）

1. **pty 孤儿会让 `node --test` 假死**：`test/pty/osc7.test.mjs` 起的 `bash -i` 可能变孤儿并继承输出管道，表现为测试跑几分钟不动、CPU 几乎为 0。判据与清理（**必须先加 `-Filter`，否则会把你自己这条命令也杀掉**）：
   `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Where-Object { $_.CommandLine -like '*magpie-term-rc*' } | Select-Object ProcessId,CreationDate"`
2. **不要往仓库根或 `tmp/` 里写临时文件**：magpie 对插件目录每秒扫一次（`internal/plugin/pathstamp.go:23`），根目录任何文件改动都会重启整个插件宿主（终端会话一起没了）。临时脚本写 `.dispatch/fix17-k/`（点开头目录被跳过）。
3. **原生程序不认 `/c/...` 与 `/tmp`**：node/powershell/python 的参数要用 `C:/...` 形式；临时目录用 `$TMPDIR` 或 `$LOCALAPPDATA/Temp`。
4. node 在 `D:/nodejs/install`，pi 在 `/c/Users/41807/AppData/Roaming/npm`；必要时 `export PATH="/c/Users/41807/AppData/Roaming/npm:/d/nodejs/install:$PATH"`。
5. 真网关会按浏览器签名拒 curl/python；本批**不需要**调真模型，全部用假审阅函数。
6. `~/.config/magpie-terminal/config.json` 是用户真实配置，**只读不改**；doctor 一律用 `MAGPIE_TERMINAL_CONFIG_PATH` 隔离。

## 6. 交付

- 代码改动 + 单测 + 两个探针（一个修、一个新）+ 两份文档。
- 报告 `.dispatch/fix17-k/REPORT.md`：改了什么（文件:行号）、AC1–AC8 每条的实际输出（原样）、未做项与原因、使用者视角自查、末行 `verdict: PASS|FAIL`。
- 证据目录 `.dispatch/fix17-k/evidence/`：每个 AC 一个 txt/json，截图不需要。
- 返回 JSON 按 §11 格式（status / summary / artifacts / verification_results / audit）。
