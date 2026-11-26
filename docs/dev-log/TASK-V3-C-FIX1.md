---
id: TASK-V3-C-FIX1
title: 修 C 卡核验发现的 5 个状态机缺陷（审批被吞 / 残帧串台 / 看门狗误报）
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

TASK-V3-C（界面卡）已经做完，独立核验 15 项硬指标全过：设置页能开、抽屉默认收起、把手位置对、红点角标、toast 不自动消失、审批三按钮发的帧字段逐字对、指纹引导真弹卡、终端不回归、348 测试全绿、doctor 33/33。

但独立核验者用「注入异常帧序列」的方式挑出了 **5 个 major 级状态机缺陷**，全部集中在异常路径上。主路径（问一句 → 审批 → 执行 → 总结）不受影响，但下面这几条会让用户**以为自己的危险命令被取消了**，或者**看到互相矛盾的两个框**。

逐条（位置都是核验者实测出来的）：

**D6（最严重）**：正在等确认时，用户再问一句话 → 前端直接 `beginRun()` 把 `pendingApprovals` 清空 → 审批卡、toast、红点**全部凭空消失**。内核那边那条审批还挂着（120 秒后自动拒绝），但用户界面上一点痕迹都没有。
- `app/ui/ai-drawer.js:406-407` 发送按钮永远 `disabled=false`
- `app/app.js:573-598` 的 `onAsk` 没有「正在跑/待确认」门禁
- `app/core/agent-store.js:105-111` 的 `beginRun()` 直接 `state = emptyState()`

**D2**：有审批在等时发第二个问题，内核回 `agent.error{code:"BUSY"}` → 前端 `onError()` 不判断 `requestId`，一律清空 `pendingApprovals` → 同 D6 的后果。
- `app/core/agent-store.js:200-211`

**D5**：前端完全没有 `requestId`/`taskId` 作用域隔离。别的任务的 `agent.step` 会混进当前时间线；`agent.approve` 会带**旧的 requestId** 发出去（核验者抓到三条 approve 帧的 `requestId` 全是更早任务的 `req-v7`）。
- `app/core/agent-store.js:112`、`:157`、`:161`（只在 requestId 为空时赋值，收到新任务不更新）

**D4 + D9**：点了审批按钮后，对应 step 永久停在「等待确认」状态，但审批卡已经消失。设计上依赖内核随后推 `agent.step{running}` 纠正，但只要那一帧晚到或丢了，界面就一直显示「等待确认」却没有可点的按钮 —— 用户会以为按钮没生效，反复点。`agent.done` 到达时同样不清 `awaiting` 状态（D9），出现「等待确认」和「任务结束」总结并存。
- `app/core/agent-store.js:180-190` 的 `removeApproval()` 只删数组不动 step 状态
- `app/core/agent-store.js:192-198` 的 `onDone()` 只清 pendingApprovals，不改 step 状态、也不清 `error`

**D3 + D7**：`agent.error` 之后收到 `agent.done`，错误框和成功总结**同时显示**（`onDone()` 不清 `state.error`）。更糟的是 5 秒「内核未就绪」看门狗在网关慢（首 token > 5 秒）时误报，之后即使真帧到达、任务成功完成，那句「AI 内核还没就绪」的错误框**永远挂着**。
- `app/ui/ai-drawer.js:434-448` 看门狗
- `app/ui/ai-drawer.js:411-417` 的 `agent.start` 只清 watchdog 不清 error
- `app/core/agent-store.js:192-198` 的 `onDone()`

# 2. 目标

修掉 D2/D3/D4/D5/D6/D7/D9（共 7 个现象、5 个根因），**不改变任何已验收的行为**。

# 3. 非目标（不要做）

- 不改 `src/`（后端内核另卡，此刻可能有人正在改）。
- 不改 `docs/PROTOCOL-AGENT.md`（帧结构、字段名、状态名都不许变）。
- 不改 `test/` 里的任何文件（后端测试归另一卡）。
- 不做 D1（关闭的 toast 会复现）与 D8（toast 遮终端 1 行）—— 这两条是 minor，留到下一卡，本卡不要动 `app/ui/toast.js` 的关闭逻辑与 toast 定位 CSS。
- 不加新功能、不改布局、不动视觉效果。

# 4. 必读与涉及范围

必读：
1. `C:/Users/41807/magpie-terminal/VERIFY-V3C.md` §2 的 D2/D3/D4/D5/D6/D7/D9（有逐字复现 JSON）
2. `C:/Users/41807/magpie-terminal/docs/PROTOCOL-AGENT.md` §3（帧协议）、§7（前端状态模型）
3. `C:/Users/41807/magpie-terminal/TASK-V3-C.md`（原验收标准，不许降标）

涉及文件（只能改这些）：
- `app/core/agent-store.js`
- `app/ui/ai-drawer.js`
- `app/app.js`

# 5. 具体要改什么

## 修复 A（D5，根因）：加 requestId/taskId 作用域隔离

`agent-store` 要记录「当前活动任务的 requestId 与 taskId」。规则：
1. 收到 `agent.start{requestId, taskId}` → 记为当前活动任务，**清空上一个任务的 steps 与 pendingApprovals**（这是新任务，旧的必须丢掉）。
2. 收到 `agent.step` / `agent.approval` / `agent.done` / `agent.error` 时，**如果帧带的 `requestId`（或 `taskId`）与当前活动任务不符 → 丢弃这一帧，不改任何状态**（并可用 `console.debug` 记一笔，但不要弹 UI）。
3. `agent.approve` 出站帧的 `requestId` **必须取当前活动任务的 requestId，不许用旧的**。
4. 帧里没带 `requestId` 的情况：`agent.start` 一定带（协议规定），后续帧若缺就当属于当前任务（宽容处理，但要在测试里写明这个决定）。

验收：核验者的 D5 复现场景（当前任务 A 的时间线里注入别的任务的 `f2-step1`）→ 该 step **不得出现**在时间线里；三条 `agent.approve` 帧的 `requestId` 全部等于当前活动任务。

## 修复 B（D6，最严重）：待确认时不许直接开新任务

`onAsk` 之前要加门禁。规则：
1. 当 `pendingApprovals.length > 0`（有待确认）时，用户再提交问题：**不调 `beginRun()`、不清任何状态**，而是：
   - 输入框里那句话保留（不清空）
   - 显示一行提示：「先处理上面的待确认命令（或点停止），再问新的。」
   - 发送按钮 **`disabled = true`**，并在有 `pendingApprovals` 期间保持 disabled
2. 当 `status === "running"`（任务正在跑但没待确认）时：允许发新问题，但走 `agent.stop` 语义还是直接 BUSY 由你选，**选更保守的**（推荐：保持现在的行为，让内核回 BUSY，然后由修复 C 保证 BUSY 不会吞掉审批）。
3. `pendingApprovals` 清空后（用户点了某个按钮、或内核推了 done/error），发送按钮恢复 enabled。

验收：复现 D6 —— 有待确认时点发送 → `pendingApprovals` 不变、审批卡/toast/角标都还在、发送按钮 `disabled=true`、出现提示文案。

## 修复 C（D2）：`agent.error` 要按 requestId 判断

`onError(frame)` 规则：
1. 若帧带 `requestId` 且与当前活动任务不符 → **丢弃**（不影响任何状态）。特别是 `BUSY`：它是对「新问题」的回应，不该动正在等待的旧任务。
2. 若 `requestId` 相符（或缺失且当前有活动任务）→ 设置 `state.error`，并且**同时把仍在 `awaiting` 的 step 标成 `failed`（或 `skipped`，你选一个并在报告里写清）**，`pendingApprovals` 清空。
3. `status` 从 `awaiting`/`running` 变成 `error`。

验收：复现 D2 —— 有 `apprA` 在等待时收到 `agent.error{code:"BUSY", requestId:"<另一个>"}` → `pendingApprovals` 仍含 `apprA`、审批卡还在、toast 还在、角标还在、step 仍 `awaiting`。

## 修复 D（D4 + D9）：step 状态不能停在 awaiting

1. `removeApproval(approvalId, approved)` → 除了从数组删，还要把对应的 step 状态改成 `running`（当 `approved=true`）或 `denied`/`skipped`（当 `approved=false`）。step 与 approval 的对应关系：`agent.approval` 帧带 `stepId`（协议里有），用它对应。
2. `onDone()` → 把所有仍为 `awaiting`/`running`/`pending` 的 step 收尾：`running`/`awaiting` 的改成 `done`（如果帧里给了该 step 的结果就填结果），`pending` 的改成 `skipped`。**不许留任何 awaiting**。
3. `onDone()` 同时**清空 `state.error`**（修复 D3 的另一半）：成功结束就是成功，错误框必须消失。

验收：
- 复现 D4：点 `approval-run` 后立刻 `status === "running"`、该 step 状态是 `running`（不是 `awaiting`）
- 复现 D9：`agent.done` 到达后时间线里**没有任何 `awaiting` 的 step**
- 复现 D3：`error` 后收到 `done` → `errorBox` 不存在，只有 `summaryBox`

## 修复 E（D7）：看门狗误报必须能自愈

1. 看门狗时长从 5 秒改成**可配置**（默认 5 秒保留，或者你论证更合理的值并写进报告）。
2. **关键**：收到任何真实 `agent.*` 帧（`start`/`step`/`approval`/`done`/`error`）时，如果 `state.error.code === "AGENT_NOT_READY"`（看门狗伪造的那个码），**必须清掉这个 error**，因为内核显然已就绪。
3. `AGENT_NOT_READY` 是本地伪造码，要有明确标记（比如 `error.local === true`），以便和内核真返回的错误区分。

验收：复现 D7 —— 5 秒无帧 → 错误框出现；第 6 秒注入真 `agent.start` → 错误框消失；接着 `agent.step` + `agent.done` → 只有 `summaryBox`，没有 `errorBox`。

# 6. 执行约束（硬性）

- **全新会话**：你是本任务唯一执行者，不得复用任何旧会话。
- **不许碰 `src/` 和 `test/`**（另一个 agent 可能正在改后端）。
- 不许 git commit / add / checkout / stash / reset。
- 不许改 `package.json`、不许装新依赖。
- 临时探针放 `.dispatch/fix-c1-verify/`，**末尾必须 `process.exit(0)`**，`finally` 里 `taskkill /PID <pid> /T /F`。探针不退出会把上游永久挂死（已经踩过多次）。
- 自测端口 **3490**（若被占就 3493，写清用了哪个）。
- 配置目录用 `MAGPIE_TERMINAL_CONFIG_PATH` 指到临时目录，不要污染 `~/.config/magpie-terminal`。
- 全量回归必须跑：`cd /c/Users/41807/magpie-terminal && D:/nodejs/install/node.exe --test`（**不带路径参数**）→ 0 fail；`DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs` → 33/33（浏览器类失败可等 120 秒重跑一次）。
- 不做卡外决策。遇到模糊点选**更保守（更安全）**的，报告里写明选择与理由。
- 交付前按使用者视角自查：真在页面里走一遍「问一句 → 弹审批 → 能不能再问一句 → 点执行 → 看总结」。

# 7. 交付物

1. 代码改动。
2. `REPORT-V3C-FIX1.md`（中文）：每个修复改了什么、为什么、A–E 五组验收的实际读数与截图路径、还剩什么问题。
3. 自测探针与结果 JSON 落 `.dispatch/fix-c1-verify/`，截图也放那里。
4. `git diff --stat` 必须只有 `app/` 下的 3 个文件。

# 8. 验收标准

| 编号 | 必过项 | 验证方法 |
|---|---|---|
| G1 | 待确认时发新问题：待确认不消失、审批卡/toast/角标都在、发送按钮 disabled、出现提示 | 自己写探针，贴读数 |
| G2 | `agent.error{BUSY, 别的 requestId}` 不清当前审批 | 贴读数 |
| G3 | 别的任务的 `agent.step` 不混进当前时间线 | 贴读数 |
| G4 | 三条 `agent.approve` 帧的 `requestId` 都等于当前活动任务 | 抓出站帧 |
| G5 | 点 `approval-run` 后该 step 立刻是 `running`（不是 `awaiting`） | 贴读数 |
| G6 | `agent.done` 后时间线里没有任何 `awaiting` 的 step | 贴读数 |
| G7 | `error` 后收到 `done` → 只有总结框，没有错误框 | 贴读数 |
| G8 | 看门狗误报后收到真 `agent.start` → 错误框消失；任务成功后只有总结框 | 贴读数 |
| G9 | 主路径不回归：真跑「建一个文件夹」→ 弹审批 → 执行 → 总结 → 目录真存在 | 贴读数 + `ls -d` |
| G10 | 终端/主机面板/文件树不回归（真键盘输入、新建标签、rail-hosts） | 贴读数 |
| G11 | `node --test` 0 fail；doctor 33/33 | 贴输出 |
| G12 | 只改了 `app/core/agent-store.js`、`app/ui/ai-drawer.js`、`app/app.js` | `git diff --stat` |

# 9. 返回格式

```json
{"status":"done|blocked|failed","task_id":"TASK-V3-C-FIX1","attempt":1,"summary":"≤200字","artifacts":["路径"],"verification_results":[{"id":"G1","status":"pass|fail","output_ref":"路径"}],"report_file":"REPORT-V3C-FIX1.md","plain_summary":"白话"}
```

开始。
