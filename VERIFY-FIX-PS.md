# VERIFY-FIX-PS：PowerShell 会话自动执行（TASK-FIX-PS-SHELL）

> 结论：**通过**（主 agent 独立复核，2026-11-24）
> 任务书 `TASK-FIX-PS-SHELL.md`（用户 m02595「1B」批准，`--thinking max`）
> 执行报告 `REPORT-FIX-PS.md`（18.1K）／机器断言 `.dispatch/fix-ps/summary.txt`（10 AC + 4 EXTRA + 5 LIMIT）
> 起始 HEAD `1fb3dc2`，验收时工作区（未提交）包含 `src/ai/runner.mjs +229/−6`、`src/server/ws.mjs +8`、`docs/PROTOCOL-AGENT.md +101/−1`、`test/ai/runner.test.mjs +240/−2`

## 1. 缺陷与修法
缺陷：`src/ai/runner.mjs` 的包装串与探测串按 bash 写死，PowerShell 会话下 `printf …\n` 被 PSReadLine 当续行停在 `>> `，探测不到标记 → `probe()` false → 每步 `EXEC_UNSUPPORTED`，AI 在 PowerShell 终端里跑不了任何命令。
修法：新增 shell 家族分支（`shellFamilyOf`）+ `buildPowerShellPayload` / `buildPowerShellProbePayload`（CR 提交、`$?` + `$Error.Count` 增量 + `$LASTEXITCODE` 三判退出码）+ `probeMarkerSeen`（PS 分支排掉 `Write-Output` 回显行）+ `cleanPowerShellOutput` / `stripTerminalNoise`（只对 PS 分支清洗）；`ws.mjs` 注入独立 `setShellNameResolver`，**bash 分支一个字节未改**。

## 2. 主 agent 亲跑的证据（不复用执行者脚本）
| 项 | 命令/脚本 | 结果 |
|---|---|---|
| 全量回归 | `node --test --test-force-exit` → `.dispatch/my-final-full.txt` | **722 / 722 pass，0 fail，EXIT=0**（24.6s） |
| 端到端自检 | `DOCTOR_PORT=3551 scripts/doctor.mjs` → `.dispatch/my-doctor-final.txt` | **33/33 assertions passed，EXIT=0** |
| bash 包装串冻结 | `.dispatch/my-bash-frozen.mjs`（把 `git show HEAD:src/ai/runner.mjs` 写到临时文件后 import 对比） | 7 个用例 `buildPayload`/`buildProbePayload` **逐字节 diff=0** |
| 三档 shell 真 PTY 跑命令 | `.dispatch/my-ps-verify.mjs`（真 `SessionManager` + 真 node-pty + 真 `createCommandRunner`，21 项） | 见 §3 |
| PS5 已知限制复核 | `.dispatch/my-ps-stderr.mjs` | 见 §4 |

## 3. 三档 shell 实测（真 PTY，主 agent 自己的探针）
`probe()` 三档全 true（bash / PowerShell 7.7.0 / Windows PowerShell 5.1.22621）。逐条（exitCode 均为实测）：

| 用例 | bash | pwsh 7 | PS 5.1 |
|---|---|---|---|
| 中文输出 `中文OK 42` | 0 ✓ 逐字 | 0 ✓ 逐字 | 0 ✓ 逐字 |
| 多行输出 l1/l2/l3 | 0 ✓ 三行齐 | 0 ✓ | 0 ✓ |
| 失败命令（`false` / `cmd /c exit 3`） | **1** | **1** | **1** |
| 不存在路径（`ls /…` / `Get-Item C:/…`） | **2** | **1** | **1** |
| `git status --short`（有改动的工作区） | 0 | **0** | **0** |
| 输出残留扫描（`__MT_S_`/`__MT_E_`/`$__mt`/`>> `/`PS C:…>`） | 无 | **无** | **无** |

注：我第一版探针把「非零退出」断言成 `ok === false`，6 项因此报红——查 `src/ai/runner.mjs:625` 与 `src/ai/agent.mjs:587` 后确认 `ok` 只表示「命令执行且取到输出」，失败与否看 `exitCode`，我的判据写错了，产品语义正确（`agent.mjs:620` 用 `exitCode === 0` 定 step 状态）。这条留在报告里作为独立复核的证据。

## 4. 已知限制（实测确认，须随交付说明）
- **PS 5.1 下 native 命令写 stderr 但成功退出会被判失败**（主 agent 实测）：`git diff --stat` → PS5 `exitCode 1`（输出里是 `git : warning: LF will be replaced by CRLF`），pwsh 7 → `0`；`node -e "console.error('warnline'); console.log('outline')"` 同样 PS5 判 1、pwsh 判 0。原因：PS5 的 `2>&1` 把 native stderr 记成 `NativeCommandError` 进 `$Error`。**本机默认 shell 是 pwsh 7，不受影响；用户在 shell 选择里挑 PowerShell 5 时才会遇到**，且输出文本仍在 step.output 里，AI 可读文本自行判断（`src/ai/agent.mjs:47` 的系统提示已要求「先读错误再决定」）。
- PS 分支退出码归一到 0/1（bash 保留原始码如 2、3）。
- 输出清洗会把「恰好是 payload 片段前缀/后缀且 ≥8 字符」的真输出当回显丢掉；行首 `>> `／`PS C:…> ` 也当回显。
- 卡 §9 预测的「PS5 cmdlet 非终止错误判不出」在本机 5.1.22621 **未复现**（`Get-Item` 不存在路径判 1）。

## 5. 文档
`docs/PROTOCOL-AGENT.md` 新增 §4.1 家族分支、§4.1-bash（冻结）、§4.1-PS、§4.1-PS 输出清洗、§4.4 探测分支与 `probeMarkerSeen`、§4.5 冻结铁律、§4.6 已知限制。主 agent 逐段比对：文档里的 JS 片段与 `src/ai/runner.mjs` 实现**逐字一致**（执行者另有 `doc-check.txt` 17/17，我复核了 5 个片段）。

## 6. 未改动项
`src/pty/*`（OSC 7 注入、shell 探测）、`src/ssh/*`、`app/**` 一行未动；远程会话 `shell.name = "ssh u@h"` 落回 bash 分支（`shellFamilyOf` 有单测锁）。
