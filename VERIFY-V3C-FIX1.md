# VERIFY-V3C-FIX1：独立核验报告（返工卡 TASK-V3-C-FIX1）

> 核验者：独立复核（只读/只测/只留证）。未修改任何产品代码、测试、配置；未执行 git 写操作。
> HEAD = `aad9ea38117ee3085d25ed947721b2f56c351a76`（报告所称 aad9ea3 一致）。
> 所有产物在 `.dispatch/verify-v3c-fix1/`。核验者**新写**了 `harness.mjs`、`probe-store.mjs`、`probe-ui.mjs`、`probe-adv.mjs`、`probe-real.mjs`；只从执行者目录**复制**了 `cdp.mjs` / `server-boot.mjs`（未改原件）。
> 端口：服务 **3492**、doctor **3481**；每个探针 `MAGPIE_TERMINAL_CONFIG_PATH` 指向 `%TEMP%\vv3cf1-cfg-*`；探针末尾 `finally` 杀服务并 `process.exit()`。

---

## 0. 一句话结论

**`pass_with_issues`** —— D2/D3/D4/D5/D6/D7/D9 七条全部独立复现为 PASS，G1–G12 全部通过，404 测试 / doctor 33/33；但主动挑刺发现 3 个 minor 级残留（同一审批同步双击会发两条 approve、done 后迟到 step 会进已完成时间线、点停止到 done 到达之间 step 短暂仍显示「等待确认」）。

---

## 1. V1–V9 逐条

### V1 全量测试 —— PASS

- 命令：`cd /c/Users/41807/magpie-terminal && D:/nodejs/install/node.exe --test`（**无任何路径参数**）
- 读数：`ℹ tests 404 / pass 404 / fail 0 / duration_ms 18347.3766`，退出码 0。
- 证据：`.dispatch/verify-v3c-fix1/node-test.txt`（全文）

### V2 体检 —— PASS

- 命令：`DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs`
- 读数：`doctor: 33/33 assertions passed`；`doctor-report.json`: `assertions=33`、`passed=true`、`ok!==true 的条数=0`。
- 证据：`.dispatch/verify-v3c-fix1/doctor.txt`，`doctor-report.json`

### V3 逐条复现 7 个缺陷 —— 全部 PASS

探针：`probe-store.mjs`（store 公开 API）+ `probe-ui.mjs`（真 Chrome + 注入 WS 帧形状，`__termDebugFrame`）。

| 缺陷 | 结论 | 关键读数（原始 JSON 摘录） | 证据 |
|---|---|---|---|
| **D6** 待确认时发第二句 | **PASS** | 注入 awaiting 后：`pending=["ui-appr-1"], sendDisabled=true`；回车发第二句后：`pending` 仍 1、`status="awaiting"`、`cards=1`、`toasts=1`、`badge="1"`、step 仍 `awaiting`、`hint="先处理上面的待确认命令（或点停止），再问新的。"`、`input="再帮我看看磁盘"`（未清空）、`disabled=true`；再点发送按钮 `pending` 仍 1、`disabled=true`。store 层 `beginRun()` 返回 `{adopted:false,pending:true}`，`requestId` 仍 `req-A`。 | `results-ui.json#D6...`、`results-store.json#D6...`、`shots/d6-*.png` |
| **D2** `agent.error{BUSY,别的requestId}` | **PASS** | 注入 `requestId:"req-B-other"` 的 BUSY 后：`pending=["ui-appr-1"]`、`cards=1`、`toasts=1`、`badge="1"`、`status="awaiting"`、`error=null`、step 仍 `awaiting`；store 层 `onError` 返回 `{applied:false,reason:"scope-mismatch"}`。 | `results-ui.json#D2...`、`results-store.json#D2...`、`shots/d2-busy-kept-approval.png` |
| **D5** 别的任务 step 串台 / approve 带旧 requestId | **PASS** | 先注入 `requestId:"other-task"` 的 `ui-f2-step1`：DOM 与 store 都查无此 step；随后点三条审批，出站帧为 `[... requestId:"ui-R2" ...]`（run/rest/skip 三条**全部等于当前任务**）。 | `results-ui.json#D5...`、`results-store.json#D5...` |
| **D4** 点审批后 step 立刻离开 awaiting | **PASS** | 点 `approval-run` 后只等一个渲染（80ms，无后端帧）：`before steps=[{ui-s-solo,awaiting}]` → `after status="running", steps=[{ui-s-solo,running}], dom=[{ui-s-solo,running}], cards=0`。 | `results-ui.json#D4...`、`shots/d4-step-running-immediately.png` |
| **D9** done 后无残留 awaiting | **PASS** | 注入 awaiting+running+pending 三 step 后 `agent.done`：`status="done"`、`steps=[done,done,skipped]`、DOM `openDom=0`、`summaryBox=true`、`errorBox=false`。 | `results-ui.json#D9...`、`shots/d9-done-no-awaiting.png` |
| **D3** error 后 done 只剩总结 | **PASS** | `error` 后 `errorBox=true,status="error"`；再 `done`：`errorBox=false, summaryBox=true, error=null, status="done", summary="最终成功了。"`。 | `results-ui.json#D3...`、`shots/d3-error-then-done.png` |
| **D7** 看门狗误报自愈 | **PASS** | 拦截 `agent.run` 让后端不回帧，默认 5s 后 `errorBox=true, error.code="AGENT_NOT_READY", local=true`；注入真 `agent.start` 后 `error=null, errorBox=false, status="running"`；再 `step+done` 后只剩 `summaryBox=true`。 | `results-ui.json#D7...`、`shots/d7-watchdog-fired.png`、`d7-watchdog-healed.png` |

store 层 11 条、UI 层 8 条、对抗 7 条、真内核 4 条，全部 PASS（`results-*.json` 内 `pass` 字段）。

### V4 主动挑刺 —— 3 个真实残留（均为 minor），其余行为正常

| 场景 | 结论 | 关键读数 | 证据 |
|---|---|---|---|
| 待确认时点「停止」→ 后续帧 | 基本正常，**短暂不一致** | 点停止后立刻：`status="stopped", pending=[], cards=0`，但 step 仍 `awaiting`（DOM 仍显示「等待确认」）；随后真 `agent.done{stopped:true}` 到达：`steps=[done]`, `openDom=0`, `summaryBox=true`, `errorBox=false`。 | `results-adv.json#V4-stop-while-awaiting`、`shots/adv-stop-while-awaiting.png` |
| 同一审批同步连点两次「执行」 | **会发两条 approve**（后端幂等，无二次执行） | 同步 `btn.click();btn.click()` → `approveFrames.length=2`，两条 `approvalId/approved/scope` 完全相同；前端最终 `pending=[], step=running`。后端 `resolveApproval` 对已删除 approvalId 返回 false，故不重复执行。 | `results-adv.json#V4-double-click-approve`、`shots/adv-double-approve.png` |
| 审批在等时展开/收起抽屉 | PASS | 收起 `drawerOpen="false"` 时 pending 仍在；再展开 `drawerOpen="true"`、`pending=1`、`cards=1`、step 仍 `awaiting`。 | `results-adv.json#V4-collapse-expand...` |
| **done 之后迟到 step（同 requestId）** | **会污染已完成时间线** | done 后：`steps=[adv-s4:done], summaryBox=true`；注入同 requestId 的 `adv-late{running}` 后：`steps=[adv-s4:done, adv-late:running]`，`summaryBox` 仍 true，`status` 仍 `done`。 | `results-adv.json#V4-late-step-after-done-pollutes`、`shots/adv-late-step-after-done.png` |
| 关 toast 后再来新审批（D1 已知未修） | 现状确认：会复现 | `toasts:1` → 点关闭 `toasts:0` → 新审批到达 `toasts:2`（旧通知重新出现 + 新通知）。按卡片不算失败。 | `results-adv.json#V4-toast-reappears-after-close` |
| 设置页改档位/白名单后刷新 | PASS | 保存后 `/api/config` 回读 `autonomy="strict"`、`allowlist=[{pattern:"verify-mkdir",mode:"prefix",enabled:true}]`；`Page.navigate` 重载后设置页回读 `autonomy="strict"`、`allowItems=1`、文本含 `verify-mkdir`。 | `results-adv.json#V4-settings-persist...`、`shots/adv-settings-after-reload.png` |
| 指纹卡（未信任主机）回归 | PASS | 临时配置目录 `known_hosts.json` 起始不存在；API 直测返回 `{ok:false,code:"UNKNOWN_HOST_KEY"}`；真 UI 点「测试连接」后信任卡可见、含 `SHA256:`、「信任并记住」。 | `results-adv.json#V4-fingerprint-trust-card`、`shots/adv-fingerprint-card.png` |

### V5 只改 3 个文件 —— PASS

- 代码标记检索：`grep -rl "pendingRun\|agent-send-hint\|clearLocalError\|setReadyTimeout\|blocked-pending" app src test scripts package.json` → **只有** `app/app.js`、`app/core/agent-store.js`、`app/ui/ai-drawer.js`。
- mtime：15:54（本卡开工）之后改动的产品文件**恰好**这 3 个 —— `agent-store.js 15:57`、`app.js 15:58`、`ai-drawer.js 16:00`；`test/` 在 15:00 后**零改动**。
- 工作树的其它改动（`src/`、`test/`、CSS、`package.json`、`app/index.html` 等）mtime 均 ≤ 15:40，属 C/D 卡遗留。
- 证据：本节命令输出；`results-*.json`。

### V6 无新依赖 / 无 CSS 改动 —— PASS

- `git diff HEAD -- package.json` 新增的是 `ai` 与 `@ai-sdk/openai-compatible`，但 `package.json` mtime = **11:51**（D 卡），早于本卡开工 15:54；本卡未动依赖。
- `git diff --stat HEAD -- app/styles/` 只有 C 卡既有改动；三个 CSS 的 mtime = 12:45–12:51（C 卡）。本卡标记在 CSS 中检索为空。
- 证据：本节命令输出。

### V7 内核（src/）零改动 —— PASS

- `git diff HEAD -- src/` 只有 `config/store.mjs`、`server/http.mjs`、`server/ws.mjs` + 6 个 untracked 新文件，全部为 D 卡内容。
- mtime 判定：`src/` 最新文件是 `src/ai/runner.mjs` **14:54:48**，本卡三个文件是 **15:57–16:00**；`src/` 没有任何文件晚于本卡开工时间。
- 证据：`find src -type f -printf '%T...'` 输出、`git diff --stat HEAD -- src/`。

### V8 主路径真跑不回归 —— PASS

真内核、真 PTY、真 WS，无任何注入：

- 终端真键盘输入：`focus.ok=true`，终端回显随机串（`VFIX1_d5nozg`）。
- 新建标签：tabs 1→2、服务端 sessions 1→2。
- 问「在当前目录新建空文件夹 …」→ 4.9s 后真审批卡（1 条 `mkdir -p … && ls -d …`）→ 点「执行这一条」→ 任务 `done`，`summaryBox=true`、`errorBox=false`、DOM 无未完成 step。
- 目录**真实存在**：`dirExists=true`，`ls -ld` 输出 `drwxr-xr-x … C:\Users\41807\verify-fix1-e2e-…`（探针随后清理）。
- 证据：`results-real.json`、`shots/v8-terminal-typed.png`、`v8-question-sent.png`、`v8-approval-or-result.png`、`v8-done-summary.png`

### V9 慢网关（默认 5s 看门狗）—— PASS（先出错误框，随后自愈）

- 拦截出站 `agent.run` 模拟网关慢；默认看门狗（未调 `__termDebugWatchdog`）：
  - 5.6s 时：`errorBox=true`，`error={code:"AGENT_NOT_READY",local:true}`（符合预期：先出现错误框）
  - 8s 时投递真 `agent.start/step/done`：`errorBox=false`、`error=null`、`status="done"`、`summaryBox=true`、`summary="慢网关也完成了。"`
- 结论：默认配置下误报**会自愈**，不判 FAIL。
- 证据：`results-ui.json#V9-slow-gateway...`、`shots/v9-at5s-error-shown.png`、`v9-after-8s-healed.png`

---

## 2. 我主动挑刺发现的问题（逐条）

### P1（minor）同一审批按钮同步双击 → 发出两条完全相同的 `agent.approve`
- 现象：在按钮尚未被重渲染移除的同一 tick 内连点两次，击发两次 `onApprove`；抓包 `approveFrames.length=2`，字段逐字相同。
- 复现：注入 1 条审批 → `const b=document.querySelector('[data-role="approval-run"]'); b.click(); b.click();` → 读 `window.__frames`。
- 影响：普通用户双击/手抖会触发，但后端 `src/ai/agent.mjs:140 resolveApproval()` 对已删除的 approvalId 返回 `false`，不会二次执行命令；只是多一条无意义出站帧 + 第二次 `removeApproval` 空操作。不会造成审批被吞或命令双跑。
- 建议（非本卡范围）：`removeApproval` 返回 false 时或按钮 handler 里加一次 `pendingApprovals` 存在性判断；或点后立刻 disable 按钮。

### P2（minor）`agent.done` 之后同 requestId 的迟到 `agent.step` 会进入已完成时间线
- 现象：done 后时间线出现「总结框 + 新的 running step」并存；`status` 仍为 done。
- 复现：注入 `start → step(done) → done`，再注入同一 `requestId` 的 `step{stepId:"adv-late",status:"running"}`；store 与 DOM 都新增该 step。
- 影响：正常 WS 单连接有序、内核在 done 后不再发 step，普通用户不会踩到；属防御性缺口（重连/乱序/内核 bug 时会出现「任务已结束但某步还在进行中」的错觉）。不阻塞。
- 证据：`results-store.json#V4-late-step-after-done`、`results-adv.json#V4-late-step-after-done-pollutes`、`shots/adv-late-step-after-done.png`。

### P3（minor）点「停止」到 `agent.done` 到达之间，step 短暂仍显示「等待确认」
- 现象：`markStopped()` 只清 `pendingApprovals`，不改 step 状态；因此点停止后瞬间 `status="stopped"`、审批卡消失，但 step `data-status` 仍是 `awaiting`（旁边已无按钮），随后真 done 到达才收尾为 done。
- 复现：注入 awaiting 审批 → 点 `agent-stop` → 立即读 DOM（不等 done）。
- 影响：窗口期只有一次网络往返（本机毫秒级）；若连接恰好断开、done 永远不到，会留下「已停止 + 等待确认」的静态残留。严重级别 minor。
- 证据：`results-adv.json#V4-stop-while-awaiting` 的 `rightAfterStop` 与 `afterStopDone`。

### P4（已知、按卡不修）关掉的 toast 会在下一次审批通知时回来
- `toasts:1 → 关闭 0 → 新审批 2`。与 `VERIFY-V3C.md` D1 一致，属本卡明确非目标，不作为失败。

---

## 3. 打折与未覆盖项（如实）

1. **V9/D7 的慢网关是模拟**：用「拦截出站 `agent.run` + 注入与 `src/ai/agent.mjs` 同形帧」实现（执行者也如此）。没有把真网关人为拖慢 8 秒；真实网关慢时的中间态（错误框在屏幕上停留 3 秒左右）只在注入口径下验证。
2. **默认看门狗仍 5s**：首 token >5s 时用户会先看到一条「内核未就绪」错误框，再自动消失。自愈已验证，但「不出现误报」需要调大 `__termDebugWatchdog`/`readyTimeoutMs`，执行者报告 §6.1 已如实承认，我确认属实。
3. **真实内核只跑了一条主路径**（建目录 → 1 次审批 → 总结）；没有用真内核跑多审批/「rest 全部允许」/超时拒绝/断网重连等长尾路径。
4. **未覆盖**：审批等待中断网/重连、页面刷新时审批状态恢复、WebSocket 乱序、设备级 console 上限压力测试（本轮未触发 `console device allocation failure`）。
5. `test/` 无前端测试；本卡新增的 UI 行为只能靠浏览器探针，已按上述 V3/V4 覆盖。
6. 我没有运行执行者的三个探针作为通过依据；全部断言由我新写的 store/UI/对抗/真内核探针产生。执行者结果仅用于对照（其 `results-*.json` 与我的读数一致）。

---

## 4. 与 `REPORT-V3C-FIX1.md` 的不一致处

执行者报告的 G1–G12 我**全部复核为 PASS**，没有「它 PASS 我判 FAIL」的验收项。差异只在未声明事项：

1. 报告未提及 **P1 双击发两条 approve**；这不违反 G1–G12（后端幂等），但属于真实用户可触发的多余出站帧。
2. 报告未提及 **P2 done 后迟到 step 进时间线**；其 G6 断言「done 后时间线无 awaiting/running/pending」只在 done 那一刻成立，此后同 requestId 的迟到 step 仍会进入。建议下一卡补一条「done 后拒绝新 step/approval」的不变量。
3. 报告未提及 **P3 停止瞬间 step 仍 awaiting**；其修复 D 只覆盖了 `removeApproval` 与 `onDone`，`markStopped()` 未收尾 step。
4. 报告 §6.8 说测试基线 404（C 卡核验的 348 是旧数）——我实测 404，一致；报告 §6.1 关于「8 秒慢网关靠配置」的打折声明与我 V9 的观测一致（默认会先误报再自愈）。
5. 报告 G12 的「只改 3 个文件」我用 mtime + 标记检索独立复核，**成立**。

---

## 5. 证据索引

```
.dispatch/verify-v3c-fix1/
├─ harness.mjs / server-boot.mjs / cdp.mjs        # 核验者自己的启动与 CDP 封装（cdp/server-boot 为复制件）
├─ probe-store.mjs  → results-store.json          # 11 条 store 断言（含 3 条迟到/停止边界）
├─ probe-ui.mjs     → results-ui.json             # 8 条浏览器断言（D6/D2/D5/D4/D9/D3/D7/V9）
├─ probe-adv.mjs    → results-adv.json            # 7 条对抗断言（停止/双击/抽屉/迟到/离开的 toast/设置持久化/指纹）
├─ probe-real.mjs   → results-real.json           # 4 条真内核断言（终端/新标签/真审批/真目录）
├─ probe-*.out.txt                               # 探针控制台全文
├─ node-test.txt                                 # 404 pass / 0 fail / 18347ms
├─ doctor.txt                                    # doctor 33/33
└─ shots/ (19 png)
   d6-before-second-question / d6-blocked-second-question / d2-busy-kept-approval
   d4-step-running-immediately / d9-done-no-awaiting / d3-error-then-done
   d7-watchdog-fired / d7-watchdog-healed / v9-at5s-error-shown / v9-after-8s-healed
   adv-stop-while-awaiting / adv-double-approve / adv-late-step-after-done
   adv-settings-after-reload / adv-fingerprint-card
   v8-terminal-typed / v8-question-sent / v8-approval-or-result / v8-done-summary
```
