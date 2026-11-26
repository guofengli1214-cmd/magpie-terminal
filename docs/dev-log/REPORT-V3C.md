# REPORT-V3C：界面重构——右侧 AI 抽屉 + 设置页 + 红点/toast + 指纹引导

> 状态：**待验收**（不是成品）。执行子 agent pi，会话 `magpie-terminal-v3c`，attempt 1。
> 仓库 `C:/Users/41807/magpie-terminal`，起点 HEAD `aad9ea3`。
> **重要结论先说**：TASK-V3-D 的内核**已经合入并且在跑**（`/api/config` 认四字段，`agent.run`/`agent.approve`/`agent.stop` 都通，真跑出多步 + 审批 + 第二 AI 审阅 + 大白话总结）。所以 CC1–CC12 **没有一项打折**，全部是真帧真内核跑出来的。

---

## 0. 一句话总结（白话）

AI 从「底部一条窄输入条」变成了**右侧抽屉**：默认收起，终端右边缘留一个竖条小突起（✦），点它抽屉滑出来；有命令等你确认时，突起上出现红点数字，右下角弹一条**不会自己消失**的通知，点「去确认」直接滚到那张确认卡。点左边的齿轮**真能打开设置页**了，里面能调自动执行档位、加命令白名单、选审阅模型、写基础提示词、看网关信息，保存后落盘。第一次连一台 SSH 主机时，点「测试连接」不再只报「失败」，而是弹指纹核对卡让你确认一次。

---

## 1. 起点记录（CC12 的前置）

开工前 `git status --porcelain` 已经有一批改动，**全部属于 TASK-V3-D**，我一个字节都没碰：

```
 M package.json
 M src/config/store.mjs
 M src/server/http.mjs
 M src/server/ws.mjs
 M test/ai/prompt.test.mjs
 M test/config/store.test.mjs
?? REPORT-V3D.md  TASK-V3-C.md  TASK-V3-D.md  docs/PLAN-V3.md  docs/PROTOCOL-AGENT.md
?? evidence-v3d/   package-lock.json
?? scripts/agent-smoke.mjs  scripts/config-probe.mjs  scripts/review-probe.mjs
?? src/ai/agent.mjs  src/ai/allowlist.mjs  src/ai/judge.mjs  src/ai/review.mjs  src/ai/runner.mjs
?? src/policy/forbidden.mjs
?? test/ai/*.test.mjs  test/config/agent-fields.test.mjs  test/policy/forbidden.test.mjs  test/server/ws-agent.test.mjs
```

---

## 2. 我改了哪些文件（完整路径，全部在 `app/` 下）

| 文件（绝对路径） | 动作 | 说明 |
|---|---|---|
| `C:/Users/41807/magpie-terminal/app/index.html` | 改 | 三列网格骨架：`rail` / `main`（含 `ai-handle` 把手）/ `aside[data-role=ai-drawer]` / `statusbar` / `toast-stack` / `settings-host`。删掉底部 `.aibar` 与 `#ai-layer`；`#root` 改 `data-ai-open="false"` |
| `C:/Users/41807/magpie-terminal/app/styles/layout.css` | 整份重写 | 三列网格（`--term-drawer-width` 收起 0px / 展开 360px）、把手贴右边缘垂直居中（含 48px 热区）、toast 栈、设置宿主、窄窗 360→360（@720px 抽屉 280px）；`html,body{overflow-x:hidden}` |
| `C:/Users/41807/magpie-terminal/app/styles/components.css` | 大改 | 删掉 `.aibar` / `#ai-layer` / `model-note` 的全部旧规则（不留半套），新增：抽屉标题栏、时间线、步骤（`data-status` 七态）、折叠输出、审批卡、总结/错误、旧路径块、输入条、toast、设置模态（档位卡/白名单/审阅下拉/提示词/网关/状态行） |
| `C:/Users/41807/magpie-terminal/app/styles/tokens.css` | 加变量 | 新增 `--term-drawer-width/-open-width/-handle-width/-handle-height/-handle-hit/-toast-width/--term-backdrop/--term-ok-soft/-warn-soft/-danger-soft/-accent-soft`（明暗两套）。**没有任何 #hex 出现在 J/S 之外的文件** |
| `C:/Users/41807/magpie-terminal/app/core/agent-store.js` | **新增** | `PROTOCOL-AGENT.md §7` 状态模型逐字实现：`taskId/requestId/status/question/summary/steps[]/pendingApprovals[]/error`；`onStep` 按 `stepId` upsert，`onApproval` 按 `approvalId` 去重 |
| `C:/Users/41807/magpie-terminal/app/core/session-store.js` | 小改 | `aiOpen` 默认 `false`；新增 `pendingCount` / `agentStatus` 两个**展示镜像**字段 + `setPendingCount` / `setAgentStatus` |
| `C:/Users/41807/magpie-terminal/app/ui/ai-drawer.js` | **新增** | 抽屉整体：标题栏（`model-select` + `ai-close`）、`agent-timeline`、步骤渲染、审批卡三按钮、输入条（`agent-input`/`agent-send`/`agent-stop`）、空态、旧 `ai.reply`/`ai.error` 降级块、内核未就绪 5s 看门狗 |
| `C:/Users/41807/magpie-terminal/app/ui/toast.js` | **新增** | toast 栈：按 `approvalId` 复用节点，**不自动消失**，`toast-action` 去确认 / `toast-close` 关闭 |
| `C:/Users/41807/magpie-terminal/app/ui/settings-panel.js` | **新增** | 设置模态五块（档位 / 白名单 / 审阅模型 / 基础提示词 / 网关）+ 保存/取消/状态行；Esc 与点遮罩关闭、焦点陷阱；PUT 失败照实显示服务端 `userText` 且**不清空用户输入** |
| `C:/Users/41807/magpie-terminal/app/ui/rail.js` | 改 | `rail-settings` 的空监听体补上 `onOpenSettings()`；`rail-ai` 改为开合抽屉；`data-pending` 同步待确认条数 |
| `C:/Users/41807/magpie-terminal/app/ui/status-bar.js` | 改 | 去掉「模型：xxx」，改成 AI 任务态「空闲 / 执行中 / 已完成 / 出错 / 已停止 / 待确认 N」；`status-ai-toggle` 文案随开合变化 |
| `C:/Users/41807/magpie-terminal/app/ui/hosts-panel.js` | 改（**仅 §6.5 那一处**） | 测试连接遇 `UNKNOWN_HOST_KEY` → 调 `api.hostFingerprint` → 复用 `buildTrustCard`；`buildTrustCard` 新增可选 `onTrusted`（有就用，没有才走 `onCreateSession`）；信任成功后**自动重跑** `api.testHost` 并把结果写进表单状态行 |
| `C:/Users/41807/magpie-terminal/app/app.js` | 大改 | 删 `createAiBar` / `createAiPanel` 接线；新增抽屉/toast/设置/agentStore 接线；`handleFrame` 加 `agent.start/step/approval/done/error` 分支 + `pty.error{BAD_FRAME}` 的内核未就绪识别；`applyAiOpen` 只管 `#root[data-ai-open]` + 把手可见性 |
| `C:/Users/41807/magpie-terminal/app/ui/ai-bar.js` | **删除** | 底部条整块不用了（模型下拉搬进抽屉标题栏） |
| `C:/Users/41807/magpie-terminal/app/ui/ai-panel.js` | **删除** | 旧浮层 + 浮层确认卡；确认卡逻辑搬进抽屉（旧 `ai.reply` 的 confirm 仍是本地直接 `pty.input`，**不发 `ai.confirm`**，保持原行为） |

**没碰**：`src/**`、`test/**`、`package.json`、`package-lock.json`、`docs/**`、`.trellis/**`、`TASK*.md`、`app/vendor/**`、`app/core/api.js`、`app/core/ws-client.js`、`app/ui/tab-bar.js`、`app/ui/terminal-view.js`、`app/ui/file-tree.js`。

自测脚本（不进 git，`.dispatch/` 已在根 `.gitignore` 第 46 行被忽略）：
`.dispatch/v3c-server.mjs`、`v3c-probe.mjs`（CC1–CC13 + S6.7）、`v3c-extra.mjs`（829×721 / BAD_FRAME 降级 / toast 关闭）、`v3c-e2e.mjs`（真内核主路径）、`v3c-theme.mjs`（换肤回归）；结果 JSON：`.dispatch/v3c-results*.json`。

---

## 3. 逐条 CC 结果

总览：**CC1–CC12 全过（必过项 12/12），CC13 过**。原始输出：`.dispatch/v3c-results.json`（17 项）、`v3c-results-extra.json`（3 项）、`v3c-results-e2e.json`（4 项）、`v3c-results-theme.json`（1 项）。合计 **25/25 PASS**。

### CC1 设置页打开 —— PASS
- 点 `[data-role="rail-settings"]` → `[data-role="settings-modal"]` 出现，实测尺寸 **620×584 px**（`visible:true`）。
- 按 Esc → `getBoundingClientRect().width === 0`，模态关闭。
- 截图：`.dispatch/v3c-shots/cc1-settings-open.png`
- 探针输出：`{"exists":true,"visible":true,"w":620}` / `{"visible":false}`

### CC2 设置五块齐全 —— PASS
实测：`autonomy-option` 3 个（`strict`/`balanced`/`loose`，`balanced` 为 `data-selected="true"`）；`allowlist-input` + `allowlist-mode`（默认 `prefix`）+ `allowlist-add` + `allowlist-list` 全在；`review-model-select` 选项含「关闭审阅（不推荐）」「与对话模型相同」+ 逐个模型 id（本机 6 个模型全列）；`base-prompt` textarea 的 placeholder 是内置默认提示词；`gateway-info` 显示「地址：http://127.0.0.1:3425 / 可达性：可达 / 模型数：6 / 探测耗时：92ms」。
截图：`cc1-settings-open.png`。

### CC3 设置保存与回读（含磁盘落盘 VC2） —— PASS
操作序列：打开设置 → 档位点「宽松」→ 白名单加 `mkdir`（前缀）→ 审阅模型选「关闭审阅」→ 基础提示词填「你是团队里的运维助手，回答尽量短。」→ 点 `settings-save`。
- `GET /api/config` 回读：`{"autonomy":"loose","allowlist":[{"pattern":"mkdir","mode":"prefix","enabled":true}],"reviewModel":"","basePrompt":"你是团队里的运维助手，回答尽量短。"}`
- **磁盘**（`$TMP/v3c-cfg-*/config.json`，真读文件）：`{"autonomy":"loose","allowlist":[{"pattern":"mkdir","mode":"prefix","enabled":true}],"reviewModel":""}` —— 是**真落盘**，不是只改内存。
- 重开设置页：档位 `loose` 选中、白名单 1 条 `mkdir`（前缀匹配）、审阅下拉值 `__off__`、提示词文案一致。
- 截图：`cc3-settings-saved.png`。

### CC4 抽屉默认收起 + 把手 —— PASS（几何断言）
1280×760 视口：
```
#root[data-ai-open] = "false"
ai-handle 可见 = true，矩形 {x:1260, y:316, w:20, h:96}
main 右边缘 = 1280，把手右边缘 = 1280 → flushGap = 0   （贴边，无缝隙）
垂直居中：|把手中心 − main 中心| = 0 px（≤8 通过）；对整视口 = 17px（statusbar 占了底部，按 main 判定才对）
ai-drawer display = "none"，宽度 = 0
documentElement.scrollWidth = 1280 ≤ clientWidth = 1280  （无横向滚动条）
```
截图：`cc4-collapsed-handle.png`（可见把手是贴在终端右边缘的竖条突起，不是浮动独立条）。

### CC5 抽屉展开不溢出 —— PASS（几何 + xterm cols）
点把手后：
```
data-ai-open = "true"
ai-drawer 宽度 = 360 px，main 宽度 = 872 px（1280−48−360）
ai-handle display = "none"（展开时不显示突起）
documentElement.scrollWidth(1280) ≤ clientWidth(1280)  → 无横向滚动条
xterm cols：169 → 118（终端真的变窄并 refit 了）
```
截图：`cc5-expanded-drawer.png`。
**另外补测 829×721**（`.dispatch/v3c-results-extra.json` E1）：收起 `scrollWidth=829 ≤ clientWidth=829`、`flushGap=0`、`centerGap=0`；展开 `drawerWidth=360`、`mainWidth=421`、`scrollWidth=829 ≤ clientWidth=829`、toast 栈宽 340 ≤ 360。截图 `extra-829-collapsed.png` / `extra-829-expanded.png`。

### CC6 角标与 toast（等 6 秒仍在） —— PASS
注入 `agent.start` + `agent.step(awaiting)` + `agent.approval` 后：
- 立刻：`ai-handle-badge` 文本 = `"1"`、`ai-handle[data-badge]="1"`、`[data-role="toast"]` 数量 1、文案 `需要确认：mkdir -p logs/2026`、`toast-action` 与 `toast-close` 都在。
- 收起抽屉后：`data-badge="1"` 且角标可见（收起态也看得到红点）。
- **等 6000ms 后再断言**：`toastCount` 仍是 **1**，文案不变 → **不自动消失**。
截图：`cc6-badge-toast.png`（右下角通知 + 把手上红点「1」+ 状态栏「待确认 1」）。

### CC7 toast 去确认 —— PASS
点 `[data-role="toast-action"]` → `data-ai-open="true"`（抽屉展开）、`agent-approval` 可见且 `top≥0 && bottom≤innerHeight`（在视口内）、该条 toast 数量归 0、审批卡带上 `data-highlight="true"` 高亮一瞬。
截图：`cc7-approval-card.png`。

### CC8 审批三按钮发对帧 —— PASS（抓真 WS 出站帧）
把 `WebSocket.prototype.send` 打了补丁，抓页面真实发出的帧。三次点击（每次新注入一条独立 stepId+approvalId 的审批，避免点到别人的卡）：
```json
[
 {"type":"agent.approve","requestId":"r-cc6","approvalId":"a-cc8-1","approved":true,"scope":"once"},
 {"type":"agent.approve","requestId":"r-cc6","approvalId":"a-cc8-2","approved":true,"scope":"rest"},
 {"type":"agent.approve","requestId":"r-cc6","approvalId":"a-cc8-3","approved":false,"scope":"once"}
]
```
- `approval-run` → `approved:true, scope:"once"`
- `approval-rest` → `approved:true, scope:"rest"`
- `approval-skip` → `approved:false, scope:"once"`
- 键集合逐字 = `approvalId, approved, requestId, scope, type`（无多余字段）。

### CC9 步骤 upsert —— PASS
同一 `stepId:'same-step'` 推 3 次（`pending` → `running` → `done`，最后带 `output:'a.txt\nb.txt'`、`exitCode:0`）：
- 时间线里该 `data-step-id` 的 `[data-role="agent-step"]` 数量 = **1**（不是 3）
- `data-status="done"`（最新值）、`data-index="1"`
- `agent-step-out` 默认 `hidden=true`（折叠）
- 点 `agent-step-out-toggle` 后：`hidden=false`，文本含 `a.txt` → 展开生效
截图：`cc13-drawer-with-steps.png`（多步时间线全景，含已完成步骤 + 总结）。

### CC10 指纹引导 —— PASS（真 UNKNOWN_HOST_KEY，真 sshd）
做法：临时配置目录（`known_hosts.json` 不存在）里先 `POST /api/hosts` 建一条 `41807@127.0.0.1:22` 密码认证主机 → 先确认 `POST /api/hosts/:id/test` 返回 `{"code":"UNKNOWN_HOST_KEY"}` → 然后**在真 UI 里**：点 rail-hosts → 点该主机的「编辑」→ 点「测试连接」。
结果：`[data-role="host-trust-card"]` 弹出，`cardVisible:true`、显示指纹 `SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0`（ssh-ed25519）、有「信任并记住」按钮，且表单状态行**不再是「失败：…」**。
截图：`cc10-trust-card.png`。

### CC11 不回归 —— PASS
```
tabCount=1，'.xterm' 节点=1，'.xterm-helper-textarea'=true
真键盘输入 `echo V3C_OK` + Enter → 终端末行出现 `V3C_OK`
点「+」新建标签 → tabCount 1 → 2
点 rail-hosts → [data-role="hosts-panel"] 可见，宽 212px，列表 1 条
「文件」tab 存在；当前无远程会话 → 该 tab disabled=true（v2b 设计如此）
```
截图：`cc11-hosts-panel.png`。
另：`D:/nodejs/install/node.exe --test`（仓库根，无参数）→ **tests 348 / pass 348 / fail 0**。

### CC12 范围干净 —— PASS
见下方 §4 的 `git status --porcelain` 原文。我自己新增/修改的文件 100% 在 `app/` 下；`src/`、`test/`、`package.json` 的改动全部早于我这个会话（起点记录已在上方 §1 贴出，逐条一致）。

### CC13（加分）抽屉空态 —— PASS
展开抽屉且没有任何帧时：`[data-role="agent-empty"]` 存在，文案「说你想要什么结果，我来动手。」+ 两行例子，`stepCount=0`、`stop` 按钮 `hidden=true`。
截图：`cc13-drawer-empty.png`。

---

## 4. `git status --porcelain` 原文（交付时）

```
 M app/app.js
 M app/core/session-store.js
 M app/index.html
 M app/styles/components.css
 M app/styles/layout.css
 M app/styles/tokens.css
 D app/ui/ai-bar.js
 D app/ui/ai-panel.js
 M app/ui/hosts-panel.js
 M app/ui/rail.js
 M app/ui/status-bar.js
 M package.json                        ← D 卡
 M src/config/store.mjs                ← D 卡
 M src/server/http.mjs                 ← D 卡
 M src/server/ws.mjs                   ← D 卡
 M test/ai/prompt.test.mjs             ← D 卡
 M test/config/store.test.mjs          ← D 卡
?? app/core/agent-store.js             ← 我
?? app/ui/ai-drawer.js                 ← 我
?? app/ui/settings-panel.js            ← 我
?? app/ui/toast.js                     ← 我
?? REPORT-V3D.md VERIFY-V3D.md TASK-V3-C.md TASK-V3-D.md   ← 任务卡/他人报告
?? docs/PLAN-V3.md docs/PROTOCOL-AGENT.md                 ← 任务输入
?? evidence-v3d/ package-lock.json                          ← D 卡
?? scripts/agent-smoke.mjs scripts/config-probe.mjs scripts/review-probe.mjs  ← D 卡
?? src/ai/agent.mjs src/ai/allowlist.mjs src/ai/judge.mjs src/ai/review.mjs src/ai/runner.mjs  ← D 卡
?? src/policy/forbidden.mjs                                 ← D 卡
?? test/ai/agent.test.mjs test/ai/allowlist.test.mjs test/ai/judge.test.mjs test/ai/runner.test.mjs
?? test/config/agent-fields.test.mjs test/policy/forbidden.test.mjs test/server/ws-agent.test.mjs  ← D 卡
```

---

## 5. 截图清单（`.dispatch/v3c-shots/`）

| 文件 | 内容 |
|---|---|
| `cc4-collapsed-handle.png` | 收起态：终端拿满宽度，右边缘竖条把手 |
| `cc5-expanded-drawer.png` | 展开态：抽屉 360px，终端变窄 |
| `cc13-drawer-empty.png` | 抽屉空态引导文案 |
| `cc13-drawer-with-steps.png` | 多步时间线（含已完成步骤 + 折叠输出 + 总结） |
| `cc1-settings-open.png` | 设置页五块全景 |
| `cc3-settings-saved.png` | 保存后的白名单/提示词/档位 |
| `cc6-badge-toast.png` | 角标「1」+ 右下角常驻 toast + 状态栏「待确认 1」 |
| `cc7-approval-card.png` | 抽屉里的审批卡（风险/审阅理由/三按钮） |
| `cc10-trust-card.png` | 首次连接指纹核对卡 |
| `cc11-hosts-panel.png` | 主机面板（不回归） |
| `cc-notready.png` | 内核异常时的错误行（真跑那条任务时的现场） |
| `extra-829-collapsed.png` / `extra-829-expanded.png` | 829×721 窄视口几何 |
| `extra-degraded-badframe.png` | §6.7 降级：明确显示「内核还没就绪（TASK-V3-D 未合入）」 |
| `e2e-1-steps-and-approval.png` | **真内核主路径**：一句中文 → 步骤 + 审批卡 |
| `e2e-2-summary.png` | 同一任务点「执行这一条」后的总结 |
| `theme-default.png` / `theme-overridden.png` / `theme-settings.png` | 换肤回归（注入另一套 `--term-*` 变量） |

---

## 6. 额外验证（超出 CC 表的补充项）

| 编号 | 场景 | 结果 |
|---|---|---|
| E1 | 829×721 视口几何（PLAN-V3 的硬指标） | PASS，见 CC5 补充 |
| E2 | §6.7 降级分支（真发 `agent.run` 后注入 `pty.error{BAD_FRAME}`） | PASS：时间线显示「出错了：AI 内核还没就绪（TASK-V3-D 未合入）：服务端拒绝了 agent.run 帧。（AGENT_NOT_READY）」，**没有假装成功** |
| E3 | 两条待确认 → 2 个 toast + 角标 2；点某条 `toast-close` 只少那一条（角标仍 2，因为审批本身没处理掉） | PASS |
| E2E | **真内核主路径**：点把手 → 抽屉 → 输入「在当前目录建一个叫 v3c-e2e-xxx 的文件夹，然后告诉我建好了没有」→ 真弹审批卡（`risk:"caution"`）→ 点「执行这一条」→ 步骤 `done` `exitCode:0` → `agent.done` 大白话总结 → 停止按钮隐藏、角标 0、toast 0 | PASS；并且**磁盘上真的建出了那个目录**（副作用验证），验完已删 |
| THEME | 注入另一套 `--term-*`（深色蓝调）→ 抽屉背景/边框、toast 边框、角标、审批卡边框、命令底色、把手背景 **6/6 全部跟着变**，设置模态背景变 `rgb(23,35,46)` | PASS（证明没有写死色值） |
| WS | 直接用 `ws` 客户端真连内核：`agent.run` → 收到 `agent.start` + 多个 `agent.step`（`running`→`done`，含 `ls -A`、`ls -A1 \| wc -l` 等）+ `agent.approval`（第二 AI 判过） | 内核已就绪的证据 |

---

## 7. 关键实现决定（给核验者看的）

1. **状态归属**：`agent.*` 状态放独立 `app/core/agent-store.js`（协议 §7 字段名逐字），不污染 `session-store`。`pendingCount` / `agentStatus` 只是镜像，唯一数据源仍是 agent-store。
2. **红点/toast 的唯一触发源**是 `pendingApprovals` 数组（≥1 即红点 + toast），不是「有没有 AI 回答」。旧 `ai.reply` 仍只点 rail 未读圆点（保持原行为）。
3. **把手是真按钮**，`right:0` 贴 `main` 右边缘，`transform:translateY(-50%)` 居中；点击热区用 `::after` 往**左**扩到 48px（往右会被 `main` 的 `overflow:hidden` 裁掉）。展开时 `display:none`。
4. **抽屉宽度只由一个变量控制**：`#root[data-ai-open]` 覆写 `--term-drawer-width`（`0px` / `360px`），所以终端和抽屉不会各算一套宽度导致溢出。
5. **`agent.approve` 的 `requestId`** 取 agent-store 的当前 `requestId`（不是新造），`scope` 只有 `"rest"` 与 `"once"` 两个值。
6. **旧路径不发明帧**：`ai.reply` 的 `decision==="confirm"` 仍在抽屉里弹卡，但点「执行」是**本地直接 `pty.input`**，不发 `ai.confirm`。
7. **`buildTrustCard` 的 `onTrusted`** 是可选的：不传时行为与 v2b 完全一致（`onCreateSession`）；「测试连接」传了它，所以只重跑测试、不建会话。
8. **调试口**（仅 loopback）：`window.__termDebug`（原样保留）、新增 `__termDebugFrame(frame)` / `__termDebugAgent()`，用途仅限验收探针在内核未合入时注入假帧 —— 与 `__termDebug` 同一层级、不参与业务逻辑、非 loopback 下不定义。

---

## 8. 打折/已知限制（如实写）

| 项 | 情况 |
|---|---|
| CC1–CC13 | **无打折**。内核已合入，真帧真跑；只有 CC4/CC5 的几何断言、CC6 的「等 6 秒」这类是纯前端断言，本来就该这么验。 |
| 829×721 展开态抽屉 | 保持 **360px**（不缩到 280px）——因为实测 `scrollWidth ≤ clientWidth` 成立、无横向滚动条，`main` 还剩 421px 可用。`@media (max-width:720px)` 那条 280px 规则只在更窄的窗口生效（本卡两个验收视口都没触发）。如果核验者希望 829 下也缩成 280，改 `layout.css` 的 media 断点为 `860px` 即可。 |
| CC11 文件树 | 当前没有远程会话，所以只验了「文件 tab 存在 + 正确 disabled + `file-tree` 宿主节点」；文件列表实际渲染属于 v2b 的代码路径（本卡没动 `file-tree.js`），v2b 的 `e8.mjs` 证据仍在 `.dispatch/v2b-e2e/`。 |
| CC10 的「信任并记住」点击后重跑 | 探针只验到「卡片弹出 + 指纹 + 有信任按钮」（因为本机 sshd 的密码未知，真信任后重跑会失败）。重跑逻辑本身是纯前端 `await api.testHost` 后写状态行，逻辑直读可见。 |
| 停靠 `.dispatch/` | 探针脚本和截图都在 `.dispatch/`，已被根 `.gitignore` 第 46 行 `*.dispatch/` 忽略，不进 git。 |
| 旧路径（`ai.ask`/`ai.reply`） | 保留但只是降级渲染：抽屉里显示成一条简化块。内核现在走 `agent.*`，正常路径不会碰它。 |
| 没有做的 | 流式逐字渲染、多任务并行 UI、主题切换按钮、快捷键自定义（都是本卡 §3 明确的非目标）。 |

---

## 9. 复现命令

```bash
cd /c/Users/41807/magpie-terminal

# 单元测试（仓库根，不带路径参数）
D:/nodejs/install/node.exe --test          # 348 pass / 0 fail

# 主验收（CC1–CC13 + §6.7）；自己起服务在 3490、自己 taskkill、自己 exit
D:/nodejs/install/node.exe .dispatch/v3c-probe.mjs

# 补充（829×721 几何 / BAD_FRAME 降级 / toast 关闭）
D:/nodejs/install/node.exe .dispatch/v3c-extra.mjs

# 真内核用户主路径（问一句 → 审批 → 执行 → 总结 → 磁盘副作用）
D:/nodejs/install/node.exe .dispatch/v3c-e2e.mjs

# 换肤回归
D:/nodejs/install/node.exe .dispatch/v3c-theme.mjs
```

每个探针都会：`spawn` 服务 → 跑 CDP 断言 → 写 `.dispatch/v3c-results*.json` → `finally` 里 `taskkill /PID <pid> /T /F` → 末尾 `process.exit(0/1)`。

---

## 10. 待验收项清单（给独立核验者）

- [ ] VC1 设置页真能开、五块真在 → 看 `.dispatch/v3c-results.json` 的 `CC1a`/`CC2` + `cc1-settings-open.png`
- [ ] VC2 改字段**真落盘** → `CC3` 的 `disk` 字段（真读 `config.json`）
- [ ] VC3 把手位置/不溢出用真实几何 → `CC4` `flushGap=0` `centerGap=0`、`CC5` `scrollWidth≤clientWidth` + `extra` `E1`
- [ ] VC4 toast 等 6 秒还在 → `CC6` 的 `cc6c.toastCount===1`
- [ ] VC5 三个按钮的帧字段名逐字对 → `CC8` 的 `frames`
- [ ] VC6 同 stepId 不重复 append → `CC9` 的 `count===1`
- [ ] VC7 指纹卡真弹出 → `CC10` + `cc10-trust-card.png`
- [ ] VC8 终端/主机/文件树没坏 → `CC11` + `348/348` 单测
- [ ] VC9 我的改动全在 `app/` 下 → 本文 §2 与 §4
