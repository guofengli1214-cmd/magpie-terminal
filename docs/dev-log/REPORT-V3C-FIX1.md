# REPORT-V3C-FIX1：修 C 卡核验发现的 5 个状态机缺陷

> 执行者：子 agent（TASK-V3-C-FIX1，attempt 1）
> 时间：2025-11-23
> 只改了 3 个文件：`app/core/agent-store.js`、`app/ui/ai-drawer.js`、`app/app.js`。
> 未改 `src/`、`test/`、`package.json`、`app/index.html`、任何 CSS；未装任何依赖；未执行任何 git 写操作。
> 所有原始证据：`.dispatch/v3c-fix1/`（探针脚本、结果 JSON、截图、测试/doctor 全文）。

---

## 0. 一句话结论

核验报告里的 D2 / D3 / D4 / D5 / D6 / D7 / D9 共 7 个现象、5 个根因全部修完：
**审批不会再被静默吞掉、别的任务的帧进不来、approve 带当前 requestId、点完审批立刻离开 awaiting、done 之后没有残留 awaiting、错误框与成功总结不再并存、看门狗误报能自愈**。
新增 23 条探针断言（store 11 + 浏览器 UI 8 + 真内核 4）全 PASS；`node --test` **404 pass / 0 fail**；doctor **33/33**；真内主路径「建文件夹 → 审批 → 执行 → 总结 → 目录真存在」跑通。

---

## 1. 改了什么、为什么

### 修复 A（对应 D5 / V9 的根因）：requestId / taskId 作用域隔离

**文件**：`app/core/agent-store.js`

- 新增 `hasActiveTask()`（`:107`）与 `frameBelongsToCurrent(frame)`（`:121`）：
  - 帧带 `requestId` → 必须等于当前活动任务的 `requestId`；当前还没有任务时接受并认领；
  - 帧没带 `requestId` 但带 `taskId` → `taskId` 与当前已知值不符就丢弃；
  - 两者都没带 → **宽容地当成当前任务**（协议规定后续帧都带，旧内核可能漏；这条决定已写进探针 `scope-missing-requestId-is-tolerated`）。
- `onStep`（`:216`）/`onApproval`（`:254`）/`onDone`（`:312`）/`onError`（`:340`）入口全部先过作用域判定，不属于当前任务的帧**不改任何状态**，只 `console.debug` 记一笔（不弹 UI）。
- `onStart`（`:188`）：`requestId` 与当前不同 → **新任务**，`state = emptyState()` 丢掉上一个任务的 steps 与 pendingApprovals，再记为当前活动任务。
- `app/app.js` 的 `onApprove`（`:649` 附近）继续用 `snapshot.requestId`（= 当前活动任务）组装 `agent.approve`，现在它一定是最新任务的 id，而不是 `:157/:161` 那种「只在为空时才赋值」留下的旧值。

**为什么**：核验者的 D5 复现里当前任务 A 的时间线出现了别的任务 `f2-step1`；V9 里三条 approve 的 `requestId` 全是更早的 `req-v7`。根因就是 `agent-store` 没有「当前活动任务」这个概念。

### 修复 B（D6，最严重）：待确认时不许直接开新任务

**文件**：`app/ui/ai-drawer.js`、`app/app.js`、`app/core/agent-store.js`

- `ai-drawer.js:366,428`：`sendButton.disabled = pendingApprovals.length > 0`，待确认期间一直 disabled；清空后（点了按钮 / done / error）自动恢复。
- `ai-drawer.js:437-462`：`send()` 在两种入口（按钮点击、回车提交）都先查 `pendingApprovals`；有就**不清输入框**、在时间线尾部画一行提示 `先处理上面的待确认命令（或点停止），再问新的。`（`data-role="agent-send-hint"`，复用现有 `.agent-empty-hint` 样式，没加 CSS），并给状态栏一条 warn notice。
- `app/app.js:596-604`：`onAsk` 第一道门禁再判一次（纵深防御），返回 `"blocked-pending"`；drawer 收到这个码走同一提示路径。
- `app/core/agent-store.js:171`：`beginRun()` 不再无脑 `state = emptyState()`。**已有任务在跑/待确认时**只把这次请求记进 `pendingRun`，一个状态都不动；等 `agent.start` 到达时才切换（`onStart` 里 `startingNewTask` 分支）。
- `status === "running"` 且没有待确认时：按任务书推荐**保持现有行为**（照发 agent.run，让内核回 BUSY），但因为 `beginRun` 不再清空当前状态，BUSY 到达时当前任务的审批/时间线不受影响（修复 C 负责作用域）。`app.js` 会把被挡下的 `BUSY` 的 userText 用状态栏 notice 显示，用户不会「点了没反应」。

**为什么**：核验 D6 里点一下「发送」就 `beginRun()` → 审批卡、toast、红点全部凭空消失，而内核里那条危险命令还挂着等 120 秒超时。

### 修复 C（D2）：`agent.error` 按 requestId 判断

**文件**：`app/core/agent-store.js:340-372`

- 不属于当前任务的错误帧 → 返回 `{applied:false, reason:"scope-mismatch"}`，**不动 pendingApprovals、不动 steps、不写 error**。
- 属于当前任务（或帧缺 requestId）→ 写 `state.error`，把仍在 `awaiting`/`running` 的 step 标 **`failed`**、`pending` 的标 **`skipped`**，清空 `pendingApprovals`，`status = "error"`。
  - 选 `failed` 而不是 `skipped` 的理由：这些步骤是「任务失败时还在跑/还在等确认」的步骤，标成失败比标成「跳过」更贴近用户直觉；用户主动点「跳过」的那条另走 `removeApproval(approved=false) → denied`。
- `app/app.js:333-347`：收到被作用域挡下的错误时，若 `code === "BUSY"` 用状态栏提示原文，并 `logInternal` 记一笔。

**验证**：`agent.error{code:"BUSY", requestId:"req-B-second-run"}` 到达时 `pendingApprovals` 仍含 `appr-A1`、审批卡/toast/角标都在、step 仍 `awaiting`、`error === null`。

### 修复 D（D4 + D9）：step 状态不能停在 awaiting

**文件**：`app/core/agent-store.js:295`（`removeApproval`）、`:150`（`closeOpenSteps`）、`:312`（`onDone`）

- `removeApproval(approvalId, approved)` 现在接收第二个参数：删掉审批后，用 `approval.stepId` 找到对应 step，**只在该 step 仍为 `awaiting` 时**改成 `running`（approved=true）或 `denied`（approved=false）。「仍为 awaiting」这个保护是为了不把内核已经推来的 `running/denied` 倒回去。
- `onDone()`：`closeOpenSteps()` 把所有 `awaiting`/`running` → `done`、`pending` → `skipped`（协议里 `agent.done.steps` 是数字不是逐 step 结果，所以没有「填结果」可言）；同时清空 `state.error`，`status` 为 `done`/`stopped`。
- `app/app.js:649` 把 `Boolean(approved)` 传进 `removeApproval`。

**验证**：点 `approval-run` 后 120ms（只等一个渲染）就 `status==="running"`、step `data-status="running"`；`agent.done` 后时间线里没有任何 `awaiting/running/pending`；`error` → `done` 只剩总结框。

### 修复 E（D7）：看门狗误报必须能自愈

**文件**：`app/ui/ai-drawer.js`、`app/core/agent-store.js`、`app/app.js`

- 看门狗时长可配置：`ai-drawer.js:64`（`elements.readyTimeoutMs`，默认 5000）与 `:585` 的 `setReadyTimeout(ms)`；`armReadyWatchdog()` 真正使用 `readyTimeoutMs`（`:484`）。`app.js:774` 增加 loopback 调试口 `__termDebugWatchdog(ms)`（与 `__termDebug*` 同层级，只用于验收/慢网关模拟，不参与业务逻辑）。
- 本地伪造错误带 `local:true`：`agent-store.js:374` 的 `failLocally()`。
- `agent-store.js:140` 的 `clearLocalError()` 在 `onStart/onStep/onApproval` 入口调用：只要 `state.error.local === true` 就清掉，并把 `status` 从 `error` 拉回 `running`/`awaiting`。看门狗、`BAD_FRAME` 都是 `AGENT_NOT_READY` + `local:true`，所以真帧一到错误框必消失。
- `app.js:251-258`：`BAD_FRAME` 的「内核未就绪」判定多一条 `agentStore.getSnapshot().requestId === pendingAgentRequestId`，避免另一个任务在跑时新请求被拒把老任务界面清掉。

**为什么**：核验 D7 里 5 秒看门狗在慢网关上误报，之后真 `agent.start/step/done` 都到了、任务成功，那句「AI 内核还没就绪」却永远挂着，和成功总结并存。

---

## 2. G1–G12 逐条证据

> 探针全部在 `.dispatch/v3c-fix1/`，三个脚本末尾都是 `finally { killServer(...); process.exit(...) }`。
> 服务端口 **3490**；每个探针用 `MAGPIE_TERMINAL_CONFIG_PATH` 指向 `%TEMP%\fix1-cfg-*` 临时目录；Chrome headless CDP 端口 9415、临时 profile `fix1-cdp-*`。

| 编号 | 结果 | 证据 |
|---|---|---|
| G1 待确认时发新问题被拦 | **PASS** | `results-ui.json` → `G1-second-question-blocked-by-pending-approval`；截图 `shots/g1-before-second-question.png`、`shots/g1-blocked-second-question.png` |
| G2 BUSY（别的 requestId）不清审批 | **PASS** | `results-store.json` → `G2-busy-other-requestId-ignored`；`results-ui.json` → `G2-ui-busy-other-requestId-keeps-approval`；截图 `shots/g2-busy-kept-approval.png` |
| G3 别的任务 step 不混入 + approve 带当前 requestId | **PASS** | `results-store.json` → `G3-other-task-frames-isolated`、`A-approve-uses-current-requestId`；`results-ui.json` → `G3-alien-step-isolated-and-G4-approve-requestId-current` |
| G4 三条 approve 的 requestId 都等于当前活动任务 | **PASS** | 同上，抓到的出站帧见下方原始摘录 |
| G5 点审批后 step 立刻 running | **PASS** | `results-store.json` → `G5-approval-leaves-awaiting-immediately`；`results-ui.json` → `G5-ui-step-running-right-after-approve-click`；截图 `shots/g5-step-running-immediately.png` |
| G6 done 后没有 awaiting | **PASS** | `results-store.json` → `G6-done-closes-all-open-steps`；`results-ui.json` → `G6-ui-done-leaves-no-awaiting-step`；截图 `shots/g6-done-no-awaiting.png` |
| G7 error 后 done 只有总结框 | **PASS** | `results-store.json` → `G6b-error-then-done-no-error-left`；`results-ui.json` → `G7-ui-error-then-done-only-summary`；截图 `shots/g7-error-then-done.png` |
| G8 看门狗误报自愈 + 慢网关 8 秒不出错误框 | **PASS** | `results-store.json` → `G7a-local-watchdog-error-self-heals`；`results-ui.json` → `G8a-watchdog-false-alarm-self-heals`、`G8b-slow-gateway-no-notready-box`；截图 `shots/g8-watchdog-fired.png`、`g8-watchdog-healed.png`、`g8b-slow-gateway-8s.png`、`g8b-slow-gateway-done.png` |
| G9 真内核主路径 + 目录真存在 | **PASS** | `results-real.json` → `G9a-real-approval-arrived`、`G9b-real-main-path-summary-and-dir-exists`；截图 `shots/g9-question-sent.png`、`g9-approval-shown.png`、`g9-approval-clicked.png`、`g9-done-summary.png` |
| G10 终端 / 新建标签 / rail-hosts 不回归 | **PASS** | `results-real.json` → `G10a-terminal-keyboard-input`、`G10b-tabs-and-hosts-panel`；截图 `shots/g10-terminal-typed.png`、`g10-hosts-panel.png` |
| G11 `node --test` 0 fail；doctor 33/33 | **PASS** | `node-test-full.txt`（404 pass / 0 fail）、`doctor.txt`（`doctor: 33/33 assertions passed`） |
| G12 只改 3 个文件 | **PASS（证据方式见 §4）** | `git-diff-stat-after.txt` vs `.dispatch/fix1-verify/git-diff-stat.txt`；`touched-files.txt` |

### 原始读数摘录（逐字来自结果 JSON / 探针输出）

**G1**（`results-ui.json`）：
```json
{"before":{"pending":["ui-appr-1"],"sendDisabled":true,"toasts":1,"badge":"1"},
 "afterAsk":{"pending":["ui-appr-1"],"requestId":"ui-A","status":"awaiting","cards":1,"toasts":1,
             "badge":"1","stepEls":[{"id":"ui-step-1","status":"awaiting"}],
             "hint":"先处理上面的待确认命令（或点停止），再问新的。",
             "inputValue":"再帮我看看磁盘","sendDisabled":true},
 "afterClick":{"pending":["ui-appr-1"],"sendDisabled":true}}
```

**G2**（`results-ui.json`）：
```json
{"pending":["ui-appr-1"],"cards":1,"toasts":1,"badge":"1","status":"awaiting","error":null,
 "steps":[{"id":"ui-step-1","status":"awaiting"}]}
```

**G3 + G4**（`results-ui.json`，先注入 `requestId:"req-F2"` 的 `ui-f2-step1`，再在当前任务里点三个审批按钮）：
```json
"afterAlien":{"steps":[{"id":"ui-s-solo","status":"running"}],"stepEls":[{"id":"ui-s-solo","status":"running"}]},
"approveFrames":[
 {"type":"agent.approve","requestId":"ui-R2","approvalId":"ui-a-run","approved":true,"scope":"once"},
 {"type":"agent.approve","requestId":"ui-R2","approvalId":"ui-a-rest","approved":true,"scope":"rest"},
 {"type":"agent.approve","requestId":"ui-R2","approvalId":"ui-a-skip","approved":false,"scope":"once"}],
"allRequestIdCurrent":true,
"afterApprove":{"pending":[],"steps":[{"id":"ui-s-run","status":"running"},
 {"id":"ui-s-rest","status":"running"},{"id":"ui-s-skip","status":"denied"}]}
```
（`ui-f2-step1` 在 `steps` 与 DOM 里都不存在。）

**G5**（`results-ui.json`）：
```json
{"before":{"status":"awaiting","steps":[{"id":"ui-s-solo","status":"awaiting"}],"cards":1},
 "afterRunClick":{"status":"running","steps":[{"id":"ui-s-solo","status":"running"}],
                  "stepEls":[{"id":"ui-s-solo","status":"running"}],"cards":0}}
```

**G6**（`results-ui.json`）：
```json
{"status":"done","steps":[{"id":"ui-s-run","status":"done"},{"id":"ui-s-rest","status":"done"},
 {"id":"ui-s-skip","status":"denied"}],"summaryBox":true,"errorBox":false}
```

**G7**（`results-ui.json`）：
```json
{"afterError":{"status":"error","error":{"code":"SOMETHING","userText":"内核出错了"},"errorBox":true,
               "steps":[{"id":"ui-s3","status":"failed"}]},
 "afterDone":{"status":"done","error":null,"errorBox":false,"summaryBox":true,"summary":"最终成功了。",
              "steps":[{"id":"ui-s3","status":"failed"}]}}
```
（错误框消失、只有总结框；`failed` 的 step 保留 —— 内核正常路径也会先推 `failed` 再发 `done`，不能把真实失败洗成成功。）

**G8a**（默认 5000ms 看门狗 + 拦截出站 agent.run，6 秒后注入真帧）：
```json
{"watchdogRequestId":"agent-…","afterWatchdog":{"status":"error",
 "error":{"code":"AGENT_NOT_READY","userText":"AI 内核还没就绪…","local":true},"errorBox":true},
 "afterRealFrames":{"status":"done","error":null,"errorBox":false,"summaryBox":true,
 "steps":[{"id":"slow-1","status":"done"}]}}
```

**G8b**（看门狗调到 12000ms，模拟首 token 8 秒）：
```json
{"at5s":{"status":"running","errorBox":false,"error":null},
 "at8s":{"status":"running","errorBox":false,"error":null},
 "afterStartAndDone":{"status":"done","errorBox":false,"summaryBox":true,"error":null}}
```

**G9**（`results-real.json`，真内核、真 PTY、真目录）：
```json
{"which":"G9a","waitedMs":4595,
 "pending":[{"approvalId":"a-a2903d22fe7e","command":"mkdir -p \"…\" && ls -ld \"…\""}],
 "status":"awaiting"}
{"final":{"status":"done",
 "steps":[{"id":"s-16212582e5","status":"done","exitCode":0},
          {"id":"s-66b0787c30","status":"done","exitCode":0}],
 "summary":"已经建好了。…新建了一个文件夹：**…**…里面是空的…",
 "summaryBox":true,"errorBox":false,"error":null},
 "dirExists":true,"ls":"C:\\Users\\41807\\…"}
```
> 说明：PTY 会话的 cwd 是用户主目录（`C:\Users\41807`），不是仓库根；探针按 `os.homedir()` 校验目录真实存在，随后清理掉这个空目录（路径与 `ls` 输出已留在 JSON 里）。

**G11**：
```
ℹ tests 404
ℹ pass 404
ℹ fail 0
```
```
doctor: 33/33 assertions passed
```

---

## 3. 复现命令

```bash
cd /c/Users/41807/magpie-terminal

# 状态机（纯 node，无浏览器）
D:/nodejs/install/node.exe .dispatch/v3c-fix1/probe-store.mjs

# 真浏览器 UI（G1/G2/G3/G4/G5/G6/G7/G8）
D:/nodejs/install/node.exe .dispatch/v3c-fix1/probe-ui.mjs

# 真内核主路径 + 终端/标签/主机面板（G9/G10）
D:/nodejs/install/node.exe .dispatch/v3c-fix1/probe-real.mjs

# 全量回归
D:/nodejs/install/node.exe --test                 # 不许带 test/ 路径参数
DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs
```

三个探针的 SUMMARY：
```
probe-store: {"total":11,"pass":11,"fail":0,"failed":[]}
probe-ui   : {"total":8,"pass":8,"fail":0,"failed":[]}
probe-real : {"total":4,"pass":4,"fail":0,"failed":[]}
```

---

## 4. G12「只改 3 个文件」的证据与说明

工作树在开工前就有 C/D 卡留下的大量未提交改动（`agent-store.js`、`ai-drawer.js` 本来还是 untracked），所以 `git diff --stat` 不可能只显示 3 个文件。我用两个可核查的事实证明本卡只动了 3 个文件：

1. **tracked 文件只有 `app/app.js` 的 stat 发生增量**：
   - 开工前的快照（核验者留下）`.dispatch/fix1-verify/git-diff-stat.txt`：`app/app.js | 310`，全仓 `1607 insertions`；
   - 收工后 `.dispatch/v3c-fix1/git-diff-stat-after.txt`：`app/app.js | 351`，全仓 `1648 insertions`；
   - 其余 16 个 tracked 文件的增删行数**一字未变**（`src/`、`test/`、CSS、package.json 全都不在其中）。
2. **本卡新增的代码标记只出现在 3 个文件里**：
   ```bash
   $ grep -rl "pendingRun\|agent-send-hint\|clearLocalError\|setReadyTimeout\|blocked-pending" app src test scripts package.json
   app/app.js
   app/core/agent-store.js
   app/ui/ai-drawer.js
   ```
   `app/core/agent-store.js` 与 `app/ui/ai-drawer.js` 在 C 卡时就是 untracked 新文件（`git status` 显示 `??`）。

`git status --short` 里 `src/`、`test/` 的改动全部是 C/D 卡遗留，不是本卡产生；我没有执行过一次写入这些路径的操作。

---

## 5. 设计选择与理由（任务书要求写清的）

1. **error 时把 step 标 `failed` 而不是 `skipped`**：等待确认/正在跑的步骤在任务失败时是「没做成」，不是「用户主动跳过」；用户主动跳过的走 `denied`。
2. **`approved=false` 的 step 立刻标 `denied`**：与内核随后推的 `denied` 帧语义一致；内核再推一次是幂等的。
3. **`done` 不把 `failed` 洗成 `done`**：内核正常路径就是先推 `agent.step{failed}` 再发 `agent.done`（总结里说明哪条失败），如果 done 把 failed 改成 done，真实的命令失败会消失。
4. **缺 requestId/taskId 的帧按当前任务处理（宽容）**：协议规定后续帧都带，但旧内核/注入序列可能漏；这条决定写进了探针 `scope-missing-requestId-is-tolerated`。
5. **`status==="running"` 时仍允许发新问题**（任务书推荐方案）：内核回 BUSY，但 `beginRun` 不再清当前状态，BUSY 被作用域挡下，用户只会看到一句状态栏提示，原任务时间线/审批不受影响。
6. **看门狗默认仍 5000ms**：D7 的验收要求「5 秒无帧 → 错误框出现」，所以默认值不动；慢网关场景可通过 `__termDebugWatchdog(ms)`/`elements.readyTimeoutMs` 调大，且任何真帧都会立刻清掉错误框（自愈）。

---

## 6. 没做到 / 打折（如实）

1. **G8「8 秒才来 start 全程不出错误框」是靠配置实现的，不是默认行为**：默认看门狗仍是 5 秒，如果真实网关首 token >5s，用户会先看到 3 秒左右的「内核未就绪」错误框，真帧到达后自动消失（`G8a` 证明自愈）。要彻底不出现，需要把默认值调大（例如 15s），但那会让「内核真的没就绪」的反馈变慢，也会改变 D7 的验收口径，所以本次保留 5 秒 + 可配置，**这是本条的打折点**。
2. **G8 的「慢网关」是模拟**：通过拦截出站 `agent.run` + 注入真帧形状完成，没有真的把网关拖慢 8 秒。注入帧与 `src/ai/agent.mjs` 实际发送的字段逐字一致。
3. **`error.local` 只用于前端区分，未进 PROTOCOL-AGENT.md**：协议文档不在本卡允许修改的文件清单里；`local` 只在 `agent-store` 内部使用，UI 不展示。
4. **D1（关掉的 toast 会复现）与 D8（toast 遮终端 1 行）没有动**：任务书明确留给下一卡；`app/ui/toast.js` 与 CSS 未改。
5. **`app/app.js` 的 diff 里混有 C 卡的既有改动**：工作树不干净，无法用 `git diff` 分离出本卡那 41 行净增；只能用 §4 的 stat 增量与代码标记检索证明。
6. **新增了 3 个调试出口行为**：`__termDebugWatchdog`（app.js）与 `setReadyTimeout`（ai-drawer.js）只挂在 `127.0.0.1/localhost` 的调试块里，和已有 `__termDebug*` 同层级；`onAsk` 的返回值从布尔改成字符串码（`"sent" | "blocked-pending" | "no-active" | "send-failed"`）。`test/` 里没有前端测试，不影响 404 条。
7. **真内核 G9 会因模型决定分多步而多次弹审批**（第一次跑探针只点了一次，内核又弹了第二条 `ls` 校验）。最后一次探针改成「后续审批一律点执行」直到 done，这才是真实用户操作；`results-real.json` 里 `approvalsClicked:1`（最后一次内核只用了两步且第二步自动执行）。
8. **测试基线不是 348 而是 404**：核验报告写 348 是 C 卡时的数字，之后 D 卡合入后端测试，现在是 404 pass / 0 fail；本卡没有改 `test/`，条数只增不减。

---

## 7. 证据清单

```
.dispatch/v3c-fix1/
├─ harness.mjs / server-boot.mjs / cdp.mjs        # 起服务、CDP（端口 3490 / 9415）
├─ probe-store.mjs  → results-store.json          # 11 条状态机断言
├─ probe-ui.mjs     → results-ui.json             # 8 条真浏览器断言（G1/G2/G5/G3+G4/G6/G7/G8a/G8b）
├─ probe-real.mjs   → results-real.json           # 4 条真内核断言（G9a/G9b/G10a/G10b）
├─ probe-*.out.txt                                # 三个探针的控制台全文（含 PASS/FAIL 与 SUMMARY）
├─ node-test-full.txt                             # node --test 全文（404 pass / 0 fail）
├─ doctor.txt                                     # doctor 33/33
├─ git-diff-stat-after.txt / touched-files.txt    # G12 证据
└─ shots/ (17 png)
   g1-before-second-question.png / g1-blocked-second-question.png
   g2-busy-kept-approval.png / g5-step-running-immediately.png / g4-all-approvals-clicked.png
   g6-done-no-awaiting.png / g7-error-then-done.png
   g8-watchdog-fired.png / g8-watchdog-healed.png / g8b-slow-gateway-8s.png / g8b-slow-gateway-done.png
   g9-question-sent.png / g9-approval-shown.png / g9-approval-clicked.png / g9-done-summary.png
   g10-terminal-typed.png / g10-hosts-panel.png
```

---

## 8. 返回格式

```json
{
  "status": "done",
  "task_id": "TASK-V3-C-FIX1",
  "attempt": 1,
  "summary": "修完 D2/D3/D4/D5/D6/D7/D9：agent-store 加 requestId/taskId 作用域、beginRun 不再吞审批、removeApproval 立即收尾 step、onDone 清 error 并关闭所有未完成 step、看门狗错误带 local 标记且任何真帧自愈；chat 发送在待确认期间 disabled 并给提示。23 条探针全 PASS，node --test 404/0，doctor 33/33，真内核主路径目录真存在。",
  "artifacts": [
    ".dispatch/v3c-fix1/results-store.json",
    ".dispatch/v3c-fix1/results-ui.json",
    ".dispatch/v3c-fix1/results-real.json",
    ".dispatch/v3c-fix1/node-test-full.txt",
    ".dispatch/v3c-fix1/doctor.txt",
    ".dispatch/v3c-fix1/shots/"
  ],
  "verification_results": [
    {"id": "G1", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-ui.json#G1-second-question-blocked-by-pending-approval"},
    {"id": "G2", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-store.json#G2-busy-other-requestId-ignored + results-ui.json#G2-ui-busy-other-requestId-keeps-approval"},
    {"id": "G3", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-ui.json#G3-alien-step-isolated-and-G4-approve-requestId-current"},
    {"id": "G4", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-ui.json#G3-alien-step-isolated-and-G4-approve-requestId-current"},
    {"id": "G5", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-ui.json#G5-ui-step-running-right-after-approve-click"},
    {"id": "G6", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-ui.json#G6-ui-done-leaves-no-awaiting-step"},
    {"id": "G7", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-ui.json#G7-ui-error-then-done-only-summary"},
    {"id": "G8", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-ui.json#G8a + #G8b（默认 5s 自愈 / 12s 配置下 8s 不误报）"},
    {"id": "G9", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-real.json#G9a + #G9b"},
    {"id": "G10", "status": "pass", "output_ref": ".dispatch/v3c-fix1/results-real.json#G10a + #G10b"},
    {"id": "G11", "status": "pass", "output_ref": ".dispatch/v3c-fix1/node-test-full.txt + doctor.txt"},
    {"id": "G12", "status": "pass", "output_ref": ".dispatch/v3c-fix1/git-diff-stat-after.txt（对比 .dispatch/fix1-verify/git-diff-stat.txt）"}
  ],
  "report_file": "REPORT-V3C-FIX1.md",
  "plain_summary": "审批不会再因为多问一句话或别的任务的报错就凭空消失；点完执行按钮，那一步马上显示进行中；任务结束时不会再有「等待确认」残留，也不会同时出现错误和成功两个框；网关慢导致的「内核未就绪」误报会在真数据到达后自动消失。"
}
```
