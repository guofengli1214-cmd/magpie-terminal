# REPORT-FIX-PS — PowerShell 会话下 AI 无法执行命令（EXEC_UNSUPPORTED）

**状态：待验收**（独立新会话交付，未 commit、未 stash、未动 `.git`、未碰 `app/`）
**任务卡**：`TASK-FIX-PS-SHELL.md`（plan_version：用户 m02595「1B」批准）
**仓库**：`C:/Users/41807/magpie-terminal`，起点 HEAD `1fb3dc2`
**session_id**：`fix-ps-1`　**模型**：`commandcode/deepseek/deepseek-v4.1-flash`（thinking max）

---

## 1. 白话总结（plain_summary，≤200 字）

以前在 PowerShell 终端里，AI 一条命令都跑不了，只能回一句「这个终端不支持自动执行」，让用户自己贴结果。原因是给 bash 写死的那串包装命令在 PowerShell 里根本提交不出去（停在续行提示符 `>>` 上）。现在给 PowerShell 单独做了一套提交方式与退出码判定，AI 在 PowerShell 7 和 Windows PowerShell 5.1 里都能真跑命令、拿到输出和成败。已知小限制：PowerShell 5.1 下有些「成功了但往 stderr 打提示」的命令（比如 `git status` 的进度）会被判成失败，AI 需要看输出自己判断；PowerShell 7 不受影响。

---

## 2. 修好前后（一句话对照）

| | 修好前 | 修好后 |
|---|---|---|
| pwsh 7 `runner.probe()` | `false`（探测串停在 `>>`） | `true` |
| PS5 `runner.probe()` | `false` | `true` |
| AI 在 PowerShell 里执行命令 | 恒 `EXEC_UNSUPPORTED`，只回文字 | 真执行、真拿输出与成败 |
| bash 分支 | 正常 | 正常（包装串逐字节未变，见 §4） |

缺陷复现的机器证据：`.dispatch/fix-ps/probe-before-check.txt` —— 把旧的 bash 探测串发进 pwsh，`includes(marker) === false`，原始回显停在 `>> printf '__MT_PROBE_oldstyle1__%s\n' "ok"`（续行提示符），正是卡 §1 描述的现象。

---

## 3. 改了什么（逐文件）

### 3.1 `src/ai/runner.mjs`（+209 行）

新增 6 个导出函数 / 常量，**bash 分支的两个函数一个字符都没改**：

| 名字 | 作用 |
|---|---|
| `shellFamilyOf(shellName)` | §6.1 家族判定：`/powershell\|pwsh/i` → `"powershell"`，其它（含 `null` / `ssh u@h`）→ `"bash"` |
| `buildPowerShellPayload(command, startMark, endMark)` | §6.2 五段式包装串，CR 连接，`$?` + `$Error.Count` + `$LASTEXITCODE` 组合判退出码 |
| `buildPowerShellProbePayload(nonce)` | §6.3 探测串，CR 结尾 |
| `cleanPowerShellOutput(text, {echoLines})` | §6.4 输出清洗（详见 §3.1.1） |
| `stripTerminalNoise(text)` | 剥 OSC 7 与 stripAnsi 漏掉的 CSI（PS 分支专用） |
| `probeMarkerSeen(text, marker, family)` | §4.4 探测判定：PowerShell 分支要求标记出现在**不带 `Write-Output` 的行**上 |

runner 内部：

- 新增 `shellNameResolver`（默认 `() => null`）与 `setShellNameResolver(fn)`，**与 `setSessionResolver` 相互独立**（后者返回值形状 `"local"|"remote"|null` 没动，现有测试不受影响）。
- `familyOf(sessionId)`：解析器抛错时退化为 `"bash"`，绝不把执行带崩。
- `probe()`：按家族选探测串；判定改用 `probeMarkerSeen()`；日志带 `family`。
- `run()`：按家族选包装串；日志 `COMMAND_RUN_START` 增加 `family`（仍然只打 `commandLength` + 前 40 字符，铁律不变）；`settle()` 里 PS 分支多走 `stripTerminalNoise` → `stripAnsi` → `cleanPowerShellOutput` → `truncateOutput`。
- `return` 对象加 `setShellNameResolver`。

#### 3.1.1 输出清洗为什么比卡 §6.4 多做一步（真 PTY 实测逼出来的）

卡 §6.4 只要求「剥每行开头的 `>> `」。按卡实现后跑真 PTY，发现三类实际噪音：

1. **OSC 7 残渣**：本仓库给每个会话注入 OSC 7（当前目录），`stripAnsi()` 的正则（PROTOCOL §4.2 逐字冻结）吃 OSC 时只吃一半，输出里留下 `ile://NING/C:/Users/41807`。→ 加 `stripTerminalNoise()`（PS 分支专用，bash 分支不用）。
2. **真输出与提示符重绘粘在一行**：实测出现 `1027511XPS C:\Users\…> $__mtBad = …`。若按「整行丢弃」实现会把真输出 `1027511` 丢掉。→ 改成「行中的提示符只是分隔符，保留它前面的内容」。
3. **payload 折行残片**：120 列 + 长提示符下，`$__mtBad = …` 那一行被 PSReadLine 折成 `…$__mtLx0` / `0` / ` -and $LASTEXITCODE -ne 0)` 三段，孤立的 `0` 会混进最终输出（**这条在 live.txt 里真的出现过**：`"output":"240\n0"`）。→ 规则 5：遇到退出码判定行的回显就整体截断。

最终规则（写进 PROTOCOL §4.1-PS，与代码逐字一致，`doc-check.mjs` 17/17 校验）：

1. `\r\n` / `\r` 统一成 `\n`；
2. 行中的 `PS C:\…> ` 换成换行（前段是真输出）；
3. 丢 `>> ` 开头的整行；
4. 在每行第一个 `__MT_S_` / `__MT_E_` / `$__mt` 处截断，保留前缀；
5. 遇退出码判定行（含 `-not $?`）整体截断；
6. 折行残片：整行是某个 `echoLines` 元素的**前缀/后缀/全等**（长度 ≥ 8；或含 `&|>` 的短残片）就当回显丢。

### 3.2 `src/server/ws.mjs`（+8 行）

在现有 `runner.setSessionResolver(...)` 之后注入：

```js
runner.setShellNameResolver((id) => {
  const hit = lookup(id);
  if (!hit || !hit.session || !hit.session.shell) return null;
  const name = hit.session.shell.name;
  return typeof name === "string" && name.length > 0 ? name : null;
});
```

远程会话的 `shell.name` 是 `ssh u@h` → 自动落回 bash 分支（卡片非目标要求）。

### 3.3 `test/ai/runner.test.mjs`（+228 行，35 → 53 个用例）

- **保留** `:154` / `:162` 两条 bash 逐字断言**原样未动**（AC5）。它们因文件头新增 2 个 import 而下移到 `:164` / `:172`，断言内容逐字未变（`git diff` 里这两条只出现在上下文行）。
- 新增 PS 家族断言：`shellFamilyOf` 9 条映射（含 `"ssh u@h"`、`null`、`undefined`、`""`）。
- 新增 `buildPowerShellPayload("ls", …)` 逐字断言 + `\r` 结尾 + 不含裸 `\n` + 五段逐段核对。
- 新增多行命令、CRLF 归一（不得出现双 `\r`）断言。
- 新增 `buildPowerShellProbePayload("ab12")` 逐字断言。
- 新增 `cleanPowerShellOutput` 三条断言（噪音行、折行残片、真输出不误杀）。
- 新增 `stripTerminalNoise` / `probeMarkerSeen` 断言。
- 新增「按 `shellNameResolver` 选分支」「未注入时落回 bash」「解析器抛错退化为 bash」三条行为锁。

### 3.4 `docs/PROTOCOL-AGENT.md`（+95 行）

- §4.1 拆成 §4.1-bash（逐字冻结）与 §4.1-PS（模板逐字贴 §6.2），并写明三个差异点（CR 提交 / 逐行 / `$?` 是布尔）。
- §4.1-PS 新增「输出清洗」小节，逐步贴出 6 条规则。
- §4.4 补 PowerShell 探测串 + 「必须用 `probeMarkerSeen()`，不能只 `includes()`」的理由。
- §4.5 铁律增加「bash 分支逐字节冻结」。
- 新增 §4.6「已知限制（PowerShell）」，把 PS5 native-stderr 差异、退出码归一、清洗启发式的代价全部写明。

### 3.5 未改动的文件（按卡片非目标）

`src/ai/agent.mjs`、`src/pty/osc7-inject.mjs`、`src/ssh/registry.mjs`、`app/**`、`package.json`、`.git/**`。`git status` 里 `app/` 与 `test/app/file-panel-menu.test.mjs` 的改动是**另一张卡**（TASK-FIX-UI-REST）的，本卡一个字节都没碰。

---

## 4. bash 分支零改动（AC5）

`bash-frozen-check.mjs` 用 `git show HEAD:src/ai/runner.mjs` 抽出旧实现的**返回表达式**现场求值，与工作区版本逐字节比对：

```
{"kind":"buildPayload","cmd":"ls","identical":true}
{"kind":"buildPayload","cmd":"ls -la","identical":true}
{"kind":"buildPayload","cmd":"echo a\necho b","identical":true}
{"kind":"buildPayload","cmd":"git status --short 2>/dev/null","identical":true}
{"kind":"buildPayload","cmd":"","identical":true}
{"kind":"buildProbePayload","nonce":"ab12","identical":true}
{"kind":"buildProbePayload","nonce":"deadbeefcafe","identical":true}
{"kind":"buildProbePayload","nonce":"","identical":true}
{"allIdentical":true}
```

证据：`.dispatch/fix-ps/bash-frozen.txt`。另有 `test/ai/runner.test.mjs:164`/`:172` 两条逐字断言原样通过（卡片写的是 `:154`/`:162`，因为我在文件头加了 2 个 import，行号下移 10 行，断言内容逐字未改）。

---

## 5. 探针：8 用例逐条结果（AC1–AC4、AC9）

`.dispatch/fix-ps/probe.mjs` 起真服务（`127.0.0.1:3730`，**未碰 3480**），用 WS 建真会话，再用 `server.sessions` 手搭 `createCommandRunner()`，注入与 `ws.mjs` 完全相同的两个 resolver；**8 个用例全部走 `runner.probe()` / `runner.run()` 的公开路径**。

| # | 用例 | pwsh 7.7.0 | Windows PowerShell 5.1 soul |
|---|---|---|---|
| 1 | `probe()` | **true** | **true** |
| 2 | `Write-Output 'hello'` → exit 0、输出 `hello` | PASS（`hello`） | PASS（`hello`） |
| 3 | `Get-Item 'C:/definitely-not-here-xyz'` → exit 1 + 含「找不到路径」 | PASS（exit 1） | **PASS（exit 1）** |
| 4 | `cmd /c exit 3` → exit 1 | PASS | PASS |
| 5 | 两行 `Write-Output` → exit 0、`l1\nl2` | PASS | PASS |
| 6 | `if ($true) { … }\nWrite-Output 'after'` → exit 0、`in-block\nafter` | PASS | PASS |
| 7 | `Get-ChildItem … \| Select-Object -First 3` → exit 0、非空 3 行 | PASS | PASS |
| 8 | 输出无 `__MT_S_/__MT_E_/$__mt`、无 `>> `、无 OSC 残渣 | PASS | PASS |

**汇总：pwsh 8/8，PS5 8/8，allPass=true**（`.dispatch/fix-ps/probe.txt`）。

> ⚠️ **与卡片 §7.6 / §9 的偏差（必须阅读）**：卡预测 PS5 下用例 3 会「exit 0（判不出）」，实测是 **exit 1（判得出）**。判出来的机制是 `$Error.Count` 增量。我没有为了迎合卡片而把断言改成 0，而是按实测事实要求两档都 exit 1。卡 §9 那条「已知限制」在本机 5.1.22621 上**未复现**；PS5 真正不同于 pwsh 的是另一件事，见 §6。

### 5.1 退出码语义矩阵（补充证据）

`.dispatch/fix-ps/matrix.txt`（18 条）、`matrix7.txt`：

| 命令 | pwsh | PS5 |
|---|---|---|
| `Write-Output 'hello'` | 0 | 0 |
| `Get-Item 'C:/nope'` | 1 | 1 |
| `Get-Item 'C:/nope' \| Out-Null; Write-Output 'after'` | 1 | 1 |
| `cmd /c exit 3`（连跑两次） | 1 / 1 | 1 / 1 |
| `git -C <非仓库> status --short` | 1 | 1 |
| `this-command-does-not-exist` | 1 | 1 |
| 失败后紧跟成功命令（`cmd /c exit 3` → `Write-Output 'ok'`） | 0 ✅ 不误报 | 0 ✅ 不误报 |
| `$Error` 涨到上限（灌 300 条）后再报错 | 1 | 1 |

结论：退出码判定在 16 条真实场景里两档全对，且**不会**被上一条命令的失败残留污染。

---

## 6. 已知限制（不隐瞒）

### 6.1 PowerShell 5.1：native 命令写 stderr 且成功退出 → 被判失败

`matrix7.txt` 的受控实验（同一命令，只改重定向）：

| shell | 变体 | `$?` | `$Error` 增量 | `$LASTEXITCODE` |
|---|---|---|---|---|
| PS5 | `cmd /c "echo warn 1>&2" 2>&1` | **False** | **3** | 0 |
| PS5 | `cmd /c "echo warn 1>&2"`（不重定向） | True | 2 | 0 |
| PS5 | `… 2>&1 \| Out-Null` | **False** | **3** | 0 |
| pwsh | 三个变体 | True | 2 | 0 |

即：PS5 一旦 `2>&1` 重定向，stderr 会被记成一条 `NativeCommandError` 写进 `$Error`，`$?` 变 False。后果：`git status`（成功但往 stderr 打进度）、`npm --version`（`npm.ps1` 被执行策略拦）这类命令在 PS5 下报 `exitCode: 1`。

**缓解**：AI 拿到 `exitCode 1` 时应读输出文本再判；PROTOCOL §4.6 已写清。**pwsh 7 不受此限**。

### 6.2 退出码被归一到 0/1

PowerShell 分支只报成功/失败（`<endMark>0` 或 `1`），bash 分支的原始码（3、7…）在 PowerShell 下看不到。这是卡 §6.2 指定的形态，不是实现偷懒。

### 6.3 输出清洗的启发式代价

- 命令自己的输出若恰好是 payload 某片段的**前缀/后缀/全等**（长度 ≥ 8，如 `Write-Output ('`），会被当回显丢掉；
- 行首是 `>> ` 或 `PS C:\…> ` 的输出行会被当回显丢掉（例如 `cat` 一份终端日志）；
- 退出码判定行之后的后置输出被截断（后台作业往终端打的东西）。runner 本来就以 `endMark` 为结束依据，那部分原本也领不到。

实测收益对比：不清洗时 PS 分支输出里 OSC 残渣、`>>`、标记回显、折行残片全都在；清洗后 160 列 / 120 列 / 连跑复现三组 capture 共 22 个样本 **DIRTY COUNT: 0**（`play6.mjs`）。

### 6.4 探测判定的加固（顺带修的隐患）

`probe-echo-check.txt` 证明：PowerShell 探测串的**回显本身**就含完整标记 `__MT_PROBE_<nonce>__ok`。若沿用 bash 的 `includes(marker)`，一台只会回显、不会执行的终端也会被误判为「支持」。已加 `probeMarkerSeen()`：PS 分支要求标记出现在**不带 `Write-Output` 的行**上。bash 分支语义不变。

### 6.5 `BUSY_SESSION`（非本卡引入）

同一会话并行两条命令会得到 `BUSY_SESSION`。`busy-check.txt` 证明 bash 与 pwsh 行为**完全一致**，是既有设计（runner 用 `active` Map 保证同一会话不并发）。真网关那一轮里模型偶尔并行发两条命令触发它，与本卡无关，未改。

---

## 7. 回归数字

| 项 | 结果 | 证据 |
|---|---|---|
| `node --test`（仓库根，无路径参数） | **722 tests / 722 pass / 0 fail**（基线 692） | `.dispatch/fix-ps/node-test.txt` |
| 新增用例数 | 30（runner.test.mjs 35 → 53，其中 18 条 PS 相关；全仓 692 → 722） | 同上 |
| `scripts/doctor.mjs`（`DOCTOR_PORT=3741`，`MAGPIE_TERMINAL_CONFIG_PATH` 指向 `.dispatch/config-backup-0959.json` 的副本且 `defaultShell=null`） | **33/33 assertions passed**，exit 0 | `.dispatch/fix-ps/doctor.txt` |
| 探针（真 PTY） | pwsh 8/8、PS5 8/8 | `.dispatch/fix-ps/probe.txt` |
| bash 冻结校验 | 8/8 identical | `.dispatch/fix-ps/bash-frozen.txt` |
| 文档与代码一致性 | 17/17 | `.dispatch/fix-ps/doc-check.txt` |
| 真网关 AI 轮次（pwsh 会话） | 1 step，status `done`，`failedSteps=0`，`EXEC_UNSUPPORTED=0` | `.dispatch/fix-ps/live.txt` |

> doctor 说明：按要求先把配置副本的 `defaultShell` 置 `null`（源：`.dispatch/config-backup-0959.json`），端口用 3741（**未碰 3480**）。

---

## 8. 验收标准对照

| 编号 | 结论 | 证据 |
|---|---|---|
| AC1 pwsh `probe()` true | **PASS** | `probe.txt` 第 1 行 |
| AC2 PS5 `probe()` true | **PASS** | `probe.txt` 第 10 行附近 |
| AC3 pwsh 8 用例 | **PASS** | `probe.txt` |
| AC4 PS5 8 用例 | **PASS**（含 §5 的偏差说明） | `probe.txt` |
| AC5 bash payload 逐字节不变 | **PASS** | `bash-frozen.txt` + `runner.test.mjs:154/:162` |
| AC6 全量 0 fail | **PASS**（722/722） | `node-test.txt` |
| AC7 doctor 33/33 | **PASS** | `doctor.txt` |
| AC8 协议文档含 PS 分支且与代码逐字一致 | **PASS** | `doc-check.txt` |
| AC9 无标记残留 / 无 `>> ` | **PASS** | `probe.txt` case 8 |
| AC10 真网关 AI 轮次 step 非 failed | **PASS** | `live.txt` |

---

## 9. 交付物清单

```
src/ai/runner.mjs                 （改）
src/server/ws.mjs                 （改）
test/ai/runner.test.mjs           （改）
docs/PROTOCOL-AGENT.md            （改）
REPORT-FIX-PS.md                  （本文件）
.dispatch/fix-ps/dispatch.txt     （派发指令原文）
.dispatch/fix-ps/probe.mjs        （真 PTY 探针，8 用例）
.dispatch/fix-ps/probe.txt        （探针原始输出，逐用例一行 JSON）
.dispatch/fix-ps/node-test.txt    （全量测试）
.dispatch/fix-ps/doctor.txt       （doctor 33/33）
.dispatch/fix-ps/live.mjs/.txt    （真网关 AI 轮次）
.dispatch/fix-ps/bash-frozen-check.mjs/.txt  （AC5 逐字节校验）
.dispatch/fix-ps/doc-check.mjs/.txt          （AC8 文档-代码一致性）
.dispatch/fix-ps/summary.txt      （机器可读断言清单）
.dispatch/fix-ps/matrix*.mjs/.txt （退出码语义矩阵、PS5 差异分离实验）
.dispatch/fix-ps/repro*.mjs       （缺陷复现：折行残片、OSC 残渣、粘行）
.dispatch/fix-ps/play*.mjs        （离线清洗器迭代脚本）
.dispatch/fix-ps/explore*.mjs     （早期原始回显探测）
.dispatch/fix-ps/capture-*.mjs / raw-*.json （原始回显 capture，供复核）
.dispatch/fix-ps/probe-echo-check.*、probe-before-check.*、busy-check.*（补充证据）
```

---

## 10. 使用视角自查

一个不懂命令行的用户，在 PowerShell 终端里问「这个目录里有多少个 .md 文件？」：

- 修好前：AI 回「这个终端不支持自动执行」，让用户自己敲命令。
- 现在（`live.txt` 实测）：AI 直接跑 `rg --files -g "*.md" | wc -l`，`exitCode 0`，输出 `61`，一句话回答「这个目录里一共有 61 个 .md 文件，其中也包含子文件夹里的文件。」
- 同一轮里 `EXEC_UNSUPPORTED` 帧数 **0**，step 状态 `done`。

另有两次多步真实提问（「有几个文件/几个文件夹」「最大的文件叫什么」）也跑通了，AI 能自己从 bash 语法（`ls -A`）失败中纠正到 PowerShell 语法再答对——这说明失败信息也真的传回给模型了。

---

## 11. 审计信息

- `session_id`：`fix-ps-1`（独立新会话，只按本卡执行）
- 模型：`commandcode/deepseek/deepseek-v4.1-flash`，`--thinking max`
- 改动文件数：4（源码 2 + 测试 1 + 文档 1）
- 新增/修改行数：`git diff --stat` = 532 insertions(+), 8 deletions(-)
- 未 commit、未 stash、未动 `.git`、未碰 `app/`
- 探针端口：3730–3755（各脚本各自一个，均先确认空闲；**全程未使用 3480**）
- 未新增依赖、未改 `package.json`
- 卡外架构决策：无（未触发 `needs_clarification`）

### 与卡片的偏差汇总（逐条说明，不隐瞒）

1. **PS5 用例 3 期望值**：卡预测 exit 0，实测 exit 1。按实测断言（§5 说明）。
2. **卡 §6.4 只要求剥 `>> `**：真 PTY 实测多出 OSC 残渣、粘行、折行残片三类噪音，按「先剥 OSC/CSI，再按 6 条规则清洗」实现。§4.1-PS 已同步文档。
3. **卡 §6.3 探测串可直接用**：串本身没问题，但**判定**不能只 `includes`（回显就含完整标记），补了 `probeMarkerSeen()`。§4.4 已同步文档。
4. **§6.2 的 `$__mtBad` 行会被折行**：120 列下残片会漏进输出，用「遇判定行整体截断」根治（不改 payload 形态）。

以上 4 条都属于「实现卡片要求时真 PTY 暴露的额外约束」，不是改需求方向。
