---
id: TASK-FIX-PS-SHELL
title: 修 PowerShell 会话下 AI 无法执行命令（EXEC_UNSUPPORTED）
status: approved
plan_version: 用户 m02595「1B」批准
approval_ref: 用户消息 m02595「1B 2A」
priority: P0
executor: sub-agent
model_tier: commandcode/deepseek/deepseek-v4.1-flash（--thinking max）
attempt: 1
retry_budget: 2
escalation_policy: ask_human
session_policy: new_session_required
session_id: fix-ps-1
inputs:
  - C:/Users/41807/magpie-terminal（仓库根，HEAD 1fb3dc2）
  - src/ai/runner.mjs（497 行）
  - src/server/ws.mjs（runner 注入点）
  - src/pty/session.mjs（session.shell 字段）
  - src/ssh/registry.mjs（session.shell 字段）
  - test/ai/runner.test.mjs（651 行）
  - docs/PROTOCOL-AGENT.md（418 行）
quality_benchmark: 不适用（缺陷修复卡，以「bash 分支零回归 + pwsh/PS5 真终端 8 用例全对」为门槛）
verification: 详见第 11 节
verifier: independent_new_session
depends_on: []
---

# 1. 背景与现状（大白话）

AI 助手在 PowerShell 终端里**完全跑不了命令**。用户点发送后，AI 只回一句「这个终端不支持自动执行，改为只用文字回答」，然后让用户自己贴结果。这台机器默认 shell 就是 PowerShell 7.7.0，等于「真正的 agent」这个核心功能在用户的实际使用形态下是死的。

**已确认的根因（主 agent 亲自用真 PTY 探测过，不是猜测）**：

`src/ai/runner.mjs:118-120` 的 `buildPayload()` 与 `:129-131` 的 `buildProbePayload()` 都是按 bash 语义写死的：

```js
// :119
export function buildPayload(command, startMark, endMark) {
  return `printf '\\n%s\\n' '${startMark}'; ( ${command}\n ) 2>&1; printf '${endMark}%s\\n' "$?"\n`;
}
// :130
export function buildProbePayload(nonce) {
  return `printf '__MT_PROBE_${nonce}__%s\\n' "ok"\n`;
}
```

三个点在 PowerShell 下全错：

1. **行尾用 LF（`\n`）提交** → PowerShell 的 PSReadLine 把它当「续行」而不是「提交」。实测原始回显出现 `>> ` 续行提示符，命令永远不执行。
2. **多行命令 `( cmd \n )`** → 同上，卡在 `>>`。
3. **`"$?"` 取退出码** → PowerShell 的 `$?` 是**布尔**（True/False），不是数字。而且 cmdlet 的非终止错误在 PS5 下 `$?` 仍为 True，判不出失败。

后果链条：探测串发出去没有任何回显 → `probe()` 等不到标记 → 返回 `false` → `run()` 在 `src/ai/runner.mjs:328-338` 直接返回 `code:"EXEC_UNSUPPORTED"` → `src/ai/agent.mjs:66-68` 追加一句「这个终端不支持自动执行」。

**主 agent 的真 PTY 实测（已跑完，你可以复现）**：

| 形态 | pwsh 7.7.0 | Windows PowerShell 5.1 |
|---|---|---|
| `printf '...' "ok"` + **LF** | 停在 `>>`，不执行 | 停在 `>>`，不执行 |
| `printf '...' "ok"` + **CR** | 执行，输出正确 | 执行，输出正确 |
| `Write-Output '...'` + **CR** | 执行，输出正确 | 执行，输出正确 |
| 多行块 + 逐行 CR | 能执行完（输出里混 `>>` 回显） | 能执行完 |
| bracketed paste（`\e[200~ ... \e[201~`） | **不执行** | **不执行** |

`printf` 本身在 PowerShell 里可用（是 git-bash 带进 PATH 的 `printf.exe`），**所以问题不在 printf，在换行与多行包装**。

**主 agent 已经验证过一种可用的 PS 包装形态（单行版，pwsh + PS5 双档实测）**：

```
Write-Output '__MT_S_<nonce>__'; $__mt_e0 = $Error.Count; <cmd> 2>&1; if ($? -and $Error.Count -eq $__mt_e0) { Write-Output '__MT_E_<nonce>__0' } else { Write-Output '__MT_E_<nonce>__1' }
```

实测结果：pwsh — 成功命令→0、cmdlet 失败→1、`cmd /c exit 3`→1、双语句→0、`git status`（非仓库）→1（全对）；PS5 — 成功→0、native 非零→1、双语句→0，但 **cmdlet 失败 / git stderr 仍判 0**（PS5 语言限制，见第 6 节已知限制）。

# 2. 目标

1. 让 AI 在 **pwsh 7** 与 **Windows PowerShell 5.1** 会话里都能真正执行命令并拿到输出与退出码。
2. **bash 分支逐字节零改动**（现有 692 条测试全绿，历史证据都在 bash 下）。
3. 探测（§4.4）与执行（§4.1）两条链路都按 shell 类型分支。
4. 同步协议文档与逐字断言测试，避免下次照旧文档改回去。

# 3. 非目标（做了算越界）

- **不改 `src/ai/agent.mjs`** 的提示词与 `EXEC_UNSUPPORTED` 处理逻辑（保持原样，只是不再触发）。
- **不动 bash 分支的字符串**：`buildPayload()` 现有返回值和 `buildProbePayload()` 现有返回值对 bash 必须逐字节相同。
- 不改 `src/pty/osc7-inject.mjs`（OSC 7 注入已经工作，`SESSION` 帧里能看到 pwsh 的 shell 记录）。
- 不改 SSH 远端行为：SSH 会话的 `session.shell.name` 是 `ssh user@host`，远端是 Linux bash → **必须走 bash 分支**。
- 不引入新依赖、不改 `package.json`。
- 不顺手改 UI（另一个卡在做）。

# 4. 涉及范围

| 文件 | 动作 |
|---|---|
| `src/ai/runner.mjs` | 新增 PS 分支的 payload 生成 + 按会话 shell 选择 |
| `src/server/ws.mjs` | 给 runner 注入「这个会话用哪个 shell」的解析器 |
| `test/ai/runner.test.mjs` | 保留 bash 两条逐字断言；新增 PS 分支断言 |
| `docs/PROTOCOL-AGENT.md` | §4.1 / §4.4 补 PowerShell 分支 |
| `.dispatch/fix-ps/` | 探针与原始证据落盘 |

# 5. 现有做法（别打破的约定）

- `createCommandRunner()` 在 `src/ai/runner.mjs:190` 拿到 `{sessions, remote, log}`；`setSessionResolver(fn)`（`:212`）由 `src/server/ws.mjs:167` 注入，返回 `"local" | "remote" | null`。
- `registryFor(sessionId)`（`:216-224`）决定写哪个注册表；`writeTo(sessionId, payload)`（`:236-241`）把 payload 写进 PTY。
- `probe(sessionId)`（`:248`）按 sessionId 缓存 `"ok" | "unsupported"`；`dispose()`（`:485`）清缓存。
- `run(sessionId, command, opts)` 内部 `:352-353` 生成 `{startMark, endMark}` 与 payload；`:478` 写完 payload；`:426` `checkQuiet()` 用 `splitBuffer()` 判结束。
- `splitBuffer(buffer, startMark, endMark)`（`:141`）用 `lastIndexOf(startMark)` + 结束标记后取最后一个匹配，解析 `exitCode: Number(m[1])`。
- 会话对象形状：本地 `src/pty/session.mjs:196-198` 的 `session.shell = runShell`，`runShell` 来自 `withOsc7Injection()`，含 `{id, name, version, path, args, fallback}`；远程 `src/ssh/registry.mjs:170-175` 的 `session.shell = {name: "ssh user@host", version: null, path: null, fallback: false}`（**没有 id 字段**）。
- `src/pty/shells.mjs:15` `SHELL_IDS = ["bash","pwsh","powershell"]`；`:174 resolveShellById(id)`；`:222 resolveShellForRequest()`。

# 6. 需求细节

## 6.1 判定「这个会话该用哪个 payload」

新建一个纯函数（放 `src/ai/runner.mjs` 或新建 `src/ai/payload.mjs`，你定，但要可单测）：

```js
/** "bash" | "powershell" */
export function shellFamilyOf(shellName)
```

规则（**只认这两个**，别加别的分支）：
- `shellName` 是字符串且匹配 `/powershell|pwsh/i` → `"powershell"`
- 其它一切（含 `null`、`undefined`、`ssh user@host`、`bash`）→ `"bash"`

## 6.2 PowerShell 执行包装串（按这个形态实现，已实测可用）

```js
export function buildPowerShellPayload(command, startMark, endMark) {
  const body = String(command).replace(/\r\n/g, "\n").replace(/\n/g, "\r");
  return [
    `Write-Output '${startMark}'`,
    `$__mtErr0 = $Error.Count; $__mtLx0 = $LASTEXITCODE`,
    `${body} 2>&1`,
    `$__mtBad = (-not $?) -or ($Error.Count -gt $__mtErr0) -or ($LASTEXITCODE -ne $__mtLx0 -and $LASTEXITCODE -ne 0)`,
    `Write-Output ('${endMark}' + $(if ($__mtBad) { 1 } else { 0 }))`,
  ].join("\r") + "\r";
}
```

**必须遵守的细节**：
- 五个片段之间用 **`\r`**（回车）连接，最后再补一个 `\r`。用 `\n` 就前功尽弃。
- 命令本体里的换行先统一成 `\n` 再全替换成 `\r`（逐行提交，PowerShell 会自动进 `>>` 续行并执行完）。
- `$__mtBad` 那一行必须**紧跟在命令之后**：`$?` 只反映紧邻的上一条语句。
- 结束标记格式与 bash 分支一致：`<endMark><数字>`，让 `splitBuffer()` 不用改也能解析。
- `2>&1` 加在命令本体的最后一小段后面（对 `git status` 是 `git status 2>&1`；对块语句 `if (...) { ... }` 是 `} 2>&1`，PowerShell 合法）。

## 6.3 PowerShell 探测串

```js
export function buildPowerShellProbePayload(nonce) {
  return `Write-Output '__MT_PROBE_${nonce}__ok'\r`;
}
```

（`\r` 结尾，实测能执行并回显标记。）

## 6.4 输出清洗（PowerShell 分支专有）

逐行 CR 提交时，PowerShell 会把续行提示符 `>> ` 和命令回显一起吐回来。`stripAnsi()` 之后、`truncateOutput()` 之前，对 PowerShell 分支多做一步：**剥掉每行开头连续的 `>> `**（正则 `/^>> /gm`），并把 CR 统一成 LF。

理由：这些是 shell 的提示符噪音，不是命令输出；不剥掉会把 4000 字符预算浪费在回显上。

**注意**：只对 PowerShell 分支做；bash 分支输出一个字节都不许变。

## 6.5 runner 如何知道 shell 类型

`ws.mjs` 已经有 `lookup(id)`（`:186-194`）能拿到 `{kind, session, registry}`。给 runner 增加一个独立注入点（**不要改 `setSessionResolver` 的返回值形状，现有测试依赖它**）：

```js
// src/ai/runner.mjs
let shellNameResolver = () => null;
function setShellNameResolver(fn) { shellNameResolver = typeof fn === "function" ? fn : () => null; }
// 内部
function familyOf(sessionId) {
  const name = shellNameResolver(sessionId);
  return shellFamilyOf(name);
}
// 返回对象加 setShellNameResolver
return { setSessionResolver, setShellNameResolver, run, probe, dispose, reset };
```

`ws.mjs` 注入（放在现有 `runner.setSessionResolver(...)` 之后）：

```js
runner.setShellNameResolver((id) => {
  const hit = lookup(id);
  return hit && hit.session && hit.session.shell ? hit.session.shell.name || null : null;
});
```

# 7. 执行步骤（按顺序做）

1. 读 `src/ai/runner.mjs` 全文，读 `src/server/ws.mjs:150-210` 与 `:340-400`。
2. 按 §6.1–§6.5 实现；**bash 分支的 `buildPayload()` / `buildProbePayload()` 一个字符都不改**。
3. 在 `probe()` 与 `run()` 里按 `familyOf(sessionId)` 选 payload 生成器。
4. `docs/PROTOCOL-AGENT.md`：§4.1 加 PowerShell 分支的包装串（逐字贴 §6.2 的模板），§4.4 加探测串（§6.3），并写明「行尾必须是 CR」「`$?` 是布尔，退出码靠 `$?` + `$Error.Count` + `$LASTEXITCODE` 组合判定」「PowerShell 5.1 对 cmdlet 非终止错误判不出退出码」。
5. 更新 `test/ai/runner.test.mjs`：
   - 保留 `:154` 与 `:162` 两条 bash 逐字断言**原样**（它们测的是 bash 分支）。
   - 新增：`shellFamilyOf` 的 6 条映射（`"PowerShell 7"`→powershell、`"PowerShell 5"`→powershell、`"pwsh"`→powershell、`"bash"`→bash、`"ssh u@h"`→bash、`null`→bash）。
   - 新增：`buildPowerShellPayload("ls", "__MT_S_a__", "__MT_E_a__")` 的逐字断言——它必须以 `\r` 结尾、不含裸 `\n`、含 `Write-Output '__MT_S_a__'`、含 `$__mtBad`、结束行是 `Write-Output ('__MT_E_a__' + $(if ($__mtBad) { 1 } else { 0 }))`。
   - 新增：`buildPowerShellProbePayload("ab12")` 逐字等于 `"Write-Output '__MT_PROBE_ab12__ok'\r"`。
   - 新增：多行命令 `"if ($true) {\n  Write-Output 'x'\n}"` 经 `buildPowerShellPayload` 后不含裸 `\n`。
6. **真 PTY 探针**（这是本卡最重要的证据）。写 `.dispatch/fix-ps/probe.mjs`，自己起服务（端口 3730 起，**不要占 3480**），用 `WebSocket` 连 `ws://127.0.0.1:<port>/ws?token=<server.token>`：
   - 对 `pwsh` 与 `powershell` 各建一个会话（`{type:"pty.create", shellId}`）。
   - 每档跑这 8 个用例，全部通过 `runner` 的公开路径（**推荐直接 `import { createCommandRunner }` 用手搭一个假的 sessions 注册表接管真 PTY 输出，或用 `runner.probe()/run()`**；若太绕，就直接调 `buildPowerShellPayload` 拼串写进 PTY 再用 `splitBuffer` 解析——**但探测链路必须用 `runner.probe()` 真跑一次**）：
     1. `probe()` 返回 `true`（这条是核心，修好前是 false）。
     2. `Write-Output 'hello'` → exit 0，输出含 `hello`。
     3. `Get-Item 'C:/definitely-not-here-xyz'` → pwsh 下 exit 1；PS5 下 exit 0（已知限制，见 §8），两档输出都必须含「找不到路径」原文。
     4. `cmd /c exit 3` → 两档 exit 1（非零即失败）。
     5. `Write-Output 'l1'\nWrite-Output 'l2'`（多行）→ exit 0，输出两行都在。
     6. `if ($true) {\n  Write-Output 'in-block'\n}\nWrite-Output 'after'`（多行块）→ exit 0，输出含 `in-block` 与 `after`。
     7. `Get-ChildItem -File -Force | Select-Object -First 3 -ExpandProperty Name`（管道）→ exit 0，输出非空。
     8. 输出里**不含** `__MT_S_` / `__MT_E_` 标记残留、不含 `>> ` 续行提示符。
7. 回归：`D:/nodejs/install/node.exe --test`（仓库根，不带路径参数）必须 0 fail；`DOCTOR_PORT=<空闲端口> D:/nodejs/install/node.exe scripts/doctor.mjs` 必须 33/33（**注意**：doctor 只用 bash 语法，跑之前把配置里的 `defaultShell` 置 null，源用 `.dispatch/config-backup-0959.json`，通过 `MAGPIE_TERMINAL_CONFIG_PATH` 指到临时副本）。
8. 写 `REPORT-FIX-PS.md`（仓库根）+ `.dispatch/fix-ps/summary.txt`（机器可读，一行一条断言 PASS/FAIL）。

# 8. 示例与模板

## 正例（pwsh 下一条命令的完整 payload，`nonce=x1`）

```
Write-Output '__MT_S_x1__'\r$__mtErr0 = $Error.Count; $__mtLx0 = $LASTEXITCODE\rgit status --short 2>&1\r$__mtBad = (-not $?) -or ($Error.Count -gt $__mtErr0) -or ($LASTEXITCODE -ne $__mtLx0 -and $LASTEXITCODE -ne 0)\rWrite-Output ('__MT_E_x1__' + $(if ($__mtBad) { 1 } else { 0 }))\r
```

## 反例（会失败的写法，别用）

- ❌ 用 `\n` 连接五个片段 → 全部停在 `>>`，永远不出标记。
- ❌ 用 `"$?"` 当退出码 → PowerShell 返回 `True`/`False`，`Number("True")` 是 `NaN`。
- ❌ 用 `( cmd )` 包住命令 → 多行时 `)` 被吞进续行。
- ❌ 用 bracketed paste（`\e[200~`）→ 实测不执行。
- ❌ 用 `-EncodedCommand` / here-string → 过度复杂，且 `@'...'@` 的结束符必须行首，PTY 里更脆。

# 9. 执行约束

- 独立新会话，只按本卡执行；**不得直接向人类提问**；卡外的架构决策一律返回 `needs_clarification`。
- 不 commit、不 stash、不动 `.git`。
- 不碰 `app/` 下任何文件（另一个卡在做）。
- 交付前按使用者视角自查：一个不懂命令行的用户，在 PowerShell 终端里问「这个目录有几个文件」，AI 必须能真的跑出答案。
- 未定稿标「草稿」，送审产物标「待验收」，**不得标「成品/已验收」**。
- 已知限制必须写进 REPORT，不许隐瞒：**PowerShell 5.1 下 cmdlet 的非终止错误（如 `Get-Item` 找不到路径）判不出退出码 1**，只能靠输出文本让 AI 自己判断。pwsh 7 不受此限。

# 10. 验收标准

| 编号 | 级别 | 内容 | 验证方法 | 证据位置 |
|---|---|---|---|---|
| AC1 | 必过 | pwsh 会话 `runner.probe()` 返回 `true` | 探针真 PTY | `.dispatch/fix-ps/probe.txt` |
| AC2 | 必过 | PS5 会话 `runner.probe()` 返回 `true` | 探针真 PTY | 同上 |
| AC3 | 必过 | pwsh 下 8 个用例全部符合 §7.6 期望 | 探针真 PTY | 同上 |
| AC4 | 必过 | PS5 下 8 个用例全部符合 §7.6 期望（含 §9 的已知限制例外） | 探针真 PTY | 同上 |
| AC5 | 必过 | bash 分支 payload 逐字节不变 | `test/ai/runner.test.mjs:154/:162` 原样通过 | `node --test` |
| AC6 | 必过 | 全量测试 0 fail（基线 692 条 + 新增） | `node --test` | `.dispatch/fix-ps/node-test.txt` |
| AC7 | 必过 | doctor 33/33 | `scripts/doctor.mjs` | `.dispatch/fix-ps/doctor.txt` |
| AC8 | 必过 | 协议文档含 PS 分支且与代码逐字一致 | 人工比对 §4.1/§4.4 | `docs/PROTOCOL-AGENT.md` |
| AC9 | 必过 | 输出里无标记残留、无 `>> ` 续行噪音 | 探针断言 | `.dispatch/fix-ps/probe.txt` |
| AC10 | 加分 | 真发一轮 AI 对话（`agent` 走真网关），pwsh 会话下 step 状态不是 `failed` | 见 §11 V10 | `.dispatch/fix-ps/live.txt` |

# 11. 核验要求

关键项 10 条（对应 AC1–AC10），每条都要落原始输出。V10（真网关 AI 轮次）若网关不可用，记 `skip` 并写原因，不算失败。

# 12. 交付物

- 代码改动（`src/ai/runner.mjs`、`src/server/ws.mjs`、`test/ai/runner.test.mjs`、`docs/PROTOCOL-AGENT.md`）
- `.dispatch/fix-ps/probe.mjs` + `probe.txt`（原始输出，逐用例一行）
- `.dispatch/fix-ps/node-test.txt`、`.dispatch/fix-ps/doctor.txt`
- `REPORT-FIX-PS.md`（仓库根，人类可读，含已知限制）
- `.dispatch/fix-ps/summary.txt`（机器可读断言清单）
- `.dispatch/fix-ps/dispatch.txt`（派发指令原文）

# 13. 风险与回退

| 风险 | 处理 |
|---|---|
| 改坏 bash 分支 | 两条逐字断言测试会立刻红；先跑测试再声明完成 |
| PS5 行为差异导致用例不过 | §9 的已知限制是唯一允许的例外，其它必须过 |
| 探针端口冲突 | 用 3730+，起服务前先确认端口空闲；**不要碰 3480** |
| 探针留孤儿进程 | 每个会话结束 `pty.close`；脚本末尾 `server.close()` + `process.exit(0)`；**不要用 `while` 长循环** |

# 14. 澄清记录

- 主 agent 已把包装串形态定死（§6.2/§6.3），无需自行设计。
- 用户 m02595「1B」已批准本卡开工。

# 15. 执行报告要求

`REPORT-FIX-PS.md` 必须含：改了什么（逐文件）、销量前后对比、探针 8 用例逐条结果、已知限制（PS5 cmdlet 退出码）、回归数字、审计信息（session_id / 模型 / 工具调用数）、`plain_summary` 白话总结（≤200 字，说清「以前 PowerShell 里 AI 跑不了命令，现在能跑了，PS5 有个小限制」）。
