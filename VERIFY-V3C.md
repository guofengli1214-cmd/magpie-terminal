# VERIFY-V3C：独立核验报告（TASK-V3-C 前端界面卡）

> 核验者：独立复核子 agent。**只读**：未修改任何 git 跟踪文件，未执行 git add/commit/checkout/stash/reset。
> 所有临时脚本、结果 JSON、截图在 `.dispatch/verify-v3c/`（`.gitignore:46` 的 `*.dispatch/` 已忽略，已用 `git check-ignore -v` 确认）。
> 我**没有**拿执行者的探针当唯一证据：`harness.mjs` / `server-boot.mjs` / `cdp.mjs`（从 `.dispatch/cdp.mjs` 复制并改端口 9411→9413、profile 前缀以免撞同一 Chrome 实例）/ `probe-a..g.mjs` 全部由我新写。
> 交叉验证另跑了执行者的 `.dispatch/v3c-probe.mjs`（17/17 PASS，输出在下文附一处）。
> 端口：全部用 **3495**；每个探针末尾 `process.exit()`，spawn 的服务在 `finally` 里 `taskkill /PID x /T /F`。
> 配置目录：每个探针用 `MAGPIE_TERMINAL_CONFIG_PATH` 指到独立临时目录（`%TEMP%\vv3c-cfg-*`），未污染 `~/.config/magpie-terminal`。

## 0. 复现命令

```bash
cd /c/Users/41807/magpie-terminal
D:/nodejs/install/node.exe .dispatch/verify-v3c/probe-a.mjs   # V1 V5 V6 V10 V12 V13
D:/nodejs/install/node.exe .dispatch/verify-v3c/probe-b.mjs   # V2 V3 V4 V7 V8 V9
D:/nodejs/install/node.exe .dispatch/verify-v3c/probe-c.mjs   # V11
D:/nodejs/install/node.exe .dispatch/verify-v3c/probe-d.mjs   # V15（7 个缺陷复现）
D:/nodejs/install/node.exe .dispatch/verify-v3c/probe-e.mjs   # 小视口设置模态 / toast
D:/nodejs/install/node.exe .dispatch/verify-v3c/probe-f.mjs   # toast 遮挡几行几列
D:/nodejs/install/node.exe .dispatch/verify-v3c/probe-g.mjs   # done 后 step 卡在 awaiting
```

结果 JSON：`results-a.json`…`results-g.json`；截图：`shots/*.png`（27 张）。

---

## 1. V1–V15 逐条读数

### V1 初始收起态 —— PASS
```json
{"dataAiOpen":"false","drawerExists":true,"drawerW":0,"drawerH":0,"drawerDisplay":"none"}
```
> `#root[data-ai-open]="false"`，抽屉 `display:none` 且宽 0。
> 证据：`.dispatch/verify-v3c/results-a.json`(V1)、`shots/a-v5-collapsed-1280.png`

### V2 rail-settings 真点开 / Esc 关 —— PASS
```json
{"clickResult":{"clicked":true},
 "v2open":{"exists":true,"w":620,"h":712,"display":"flex","backdropHidden":false},
 "v2closed":{"modalW":0,"modalH":0,"backdropHidden":true}}
```
> **真 click() 了 `[data-role="rail-settings"]`**（不是直接调内部函数），模态 620×712 出现；真 `Input.dispatchKeyEvent` 发 Esc 后 backdrop `hidden=true`、模态宽 0。用户最痛的一条确实修好了。
> 证据：`results-b.json`(V2)、`shots/b-v2-settings-open.png`

### V3 设置页五块 —— PASS
```json
{"autonomyCount":3,"autonomyValues":["strict","balanced","loose"],"autonomySelected":["balanced"],
 "allowlistInput":true,"allowlistMode":"prefix","allowlistModeOptions":["prefix","exact"],
 "allowlistAdd":true,"allowlistList":true,
 "reviewOpts":[{"v":"__off__","t":"关闭审阅（不推荐）"},{"v":"__same__","t":"与对话模型相同"},
   {"v":"shuaiapi/gpt-6-luna"},{"v":"commandcode/deepseek/deepseek-v4.1-flash"}, … 共 8 项],
 "basePrompt":{"tag":"TEXTAREA","placeholderLen":83},
 "gatewayInfo":"地址：http://127.0.0.1:3425可达性：可达模型数：6探测耗时：9ms"}
```
> 3 个档位、balanced 默认选中、白名单四件套齐全且默认 prefix、审阅下拉「关闭审阅」+「与对话模型相同」+ 6 个真模型 id 全在、textarea 的 placeholder 是内置默认、网关只读信息有内容。
> 证据：`results-b.json`(V3)、`shots/b-v4-settings-filled.png`

### V4 改设置 → 保存 → API 回读 + **磁盘真读** —— PASS
操作：档位点「宽松」、白名单加 `mkdir`(prefix)、审阅选「关闭审阅」、提示词填「你是核验者写的一句中文提示词。」→ 点 `settings-save`。
```json
"v4ui":{"looseSelected":true,"allowItems":1,"allowText":"mkdir前缀匹配停用删除","reviewValue":"__off__"},
"saveStatus":{"status":"已保存","tone":"ok","modalW":0},
"configPath":"C:\\Users\\41807\\AppData\\Local\\Temp\\vv3c-cfg-PPELOV\\config.json",
"apiStatus":200,
"apiBody":{"model":"commandcode/…","autonomy":"loose",
  "allowlist":[{"pattern":"mkdir","mode":"prefix","enabled":true}],
  "reviewModel":"","basePrompt":"你是核验者写的一句中文提示词。"},
"diskRaw":"{\n  \"model\": null,\n  \"autonomy\": \"loose\",\n  \"allowlist\": [\n    {\n      \"pattern\": \"mkdir\",\n      \"mode\": \"prefix\",\n      \"enabled\": true\n    }\n  ],\n  \"reviewModel\": \"\",\n  \"basePrompt\": \"你是核验者写的一句中文提示词。\"\n}\n",
"apiOk":true,"diskOk":true
```
> 四项一致；**文件里也一致**（`fs.readFileSync` 真读 `config.json`，路径在我自己的临时目录）。`reviewModel:"__off__"→""`、`basePrompt` 非空串，符合卡里 §6.4 的映射。
> 证据：`results-b.json`(V4)、`shots/b-v4-settings-saved.png`

### V5 把手几何 1280×760 / 829×721 —— PASS
```json
1280: {"handle":{"x":1260,"y":315.5,"w":20,"h":96,"right":1280},"main":{"right":1280,"centerY":363.5},
       "flushGap":0,"centerGap":0,"scrollW":1280,"clientW":1280}
 829: {"handle":{"x":809,"y":296,"w":20,"h":96,"right":829},"main":{"right":829},
       "flushGap":0,"centerGap":0,"scrollW":829,"clientW":829}
```
> 两个视口 flushGap=0（贴 main 右边缘）、centerGap=0（与 main 中心完全对齐，标准是 ≤8）、宽 20≤24、高 96≤100、无横向滚动条。
> 证据：`results-a.json`(V5-1280 / V5-829)、`shots/a-v5-collapsed-1280.png`、`shots/a-v5-collapsed-829.png`

### V6 点把手展开抽屉 + 终端 cols 真变小 —— PASS
```json
{"before":{"sessions":[{"cols":169,"rows":37}]},
 "after":{"aiOpen":"true","drawerW":360,"mainW":872,"handleDisplay":"none","handleHidden":true,
          "scrollW":1280,"clientW":1280,"sessions":[{"cols":118}]},
 "colsDelta":51}
829×721：{"drawerW":360,"mainW":421,"scrollW":829,"clientW":829,"sessions":[{"cols":55}]}（展开前未取，收起态 main 781 → 展开 421）
```
> 抽屉 360（±2 内）、main 由 1232 缩到 872、把手 `display:none`、无横向滚动、**xterm cols 169→118 真的 refit 了**（读的是 `__termDebug()` 里 session.cols，与 `.xterm-screen` 宽度 1208→843 互证）。
> 证据：`results-a.json`(V6 / V6-829)、`shots/a-v6-expanded-1280.png`、`shots/a-v6-expanded-829.png`

### V7 审批帧 → 角标 + toast，等 6 秒仍在 —— PASS
注入（`__termDebugFrame`：`agent.start` + `agent.step{status:"awaiting"}` + `agent.approval`）：
```json
immediate: {"badgeText":"1","badgeHidden":false,"handleBadge":"1","toastCount":1,
            "toastText":["!需要确认：mkdir -p logs/2026先建目录去确认×"]}
after6s:   {"toastCount":1,"toastText":["!需要确认：mkdir -p logs/2026先建目录去确认×"],"badgeText":"1"}
```
> 角标 `data-badge="1"`、文字 1、toast 文案含命令；**sleep(6000) 后 toast 仍 1 条**（不自动消失）。
> 证据：`results-b.json`(V7)、`shots/b-v7-toast-immediate.png`、`shots/b-v7-toast-after-6s.png`

### V8 点 toast-action —— PASS
```json
{"aiOpen":"true","cardExists":true,"top":129,"bottom":218,"h":89,"innerHeight":760,
 "toastCount":0,"inViewport":true}
```
> 抽屉展开、`[data-role="agent-approval"]` top=129 ≥0 且 bottom=218 ≤760、该 toast 移除。
> 证据：`results-b.json`(V8)、`shots/b-v8-approval-card.png`

### V9 三个审批按钮的出站 WS 帧 —— PASS（键名逐字对）
给 `WebSocket.prototype.send` 打补丁抓真出站帧（每次注入独立 stepId+approvalId）：
```json
[{"type":"agent.approve","requestId":"req-v7","approvalId":"appr-v9-1","approved":true,"scope":"once"},
 {"type":"agent.approve","requestId":"req-v7","approvalId":"appr-v9-2","approved":true,"scope":"rest"},
 {"type":"agent.approve","requestId":"req-v7","approvalId":"appr-v9-3","approved":false,"scope":"once"}]
```
> `approval-run → approved:true, scope:"once"`、`approval-rest → scope:"rest"`、`approval-skip → approved:false, scope:"once"`。键集合 = `approvalId, approved, requestId, scope, type`，无多余字段。
> **附带发现**：三条帧的 `requestId` 都是 `"req-v7"`（我注入的新审批带的是 `req-v9`）。原因是 `agent-store.onStep/onApproval` 只在 `state.requestId` 为空时才写（`app/core/agent-store.js:112,157`），所以「上一个任务的 requestId」会被继续用。这正是 V15-D5 的同源问题：**前端没有按 requestId/taskId 做作用域隔离**。
> 证据：`results-b.json`(V9)

### V10 同一 stepId 推 3 次 —— PASS
```json
{"count":1,"status":"done","index":"1","outHidden":true,"outText":"a.txt\nb.txt\nverifier-marker"}
点 toggle 后（重新查 DOM，render 会重建节点）：
{"stepCount":1,"hiddenAfter":false,"displayAfter":"block","textAfter":"a.txt\nb.txt\nverifier-marker","toggleLabel":"收起输出"}
```
> 一条 step、`data-status="done"`、输出默认折叠、点开可见 output。
> （第一版探针我对旧节点引用做断言得到 `hiddenAfter:true`，重新查 DOM 后为 false——是探针自己的过期引用，不是产品缺陷，已修正并在 `results-a.json` 里记录。）
> 证据：`results-a.json`(V10)、`shots/a-v10-step-upsert.png`

### V11 指纹引导（空 known_hosts 的临时目录 + 真 UI 点「测试连接」） —— PASS
```json
"hostId":"h-addcf7","createdStatus":201,
"directTest":{"status":200,"body":{"ok":false,"code":"UNKNOWN_HOST_KEY","userText":"这台主机的指纹还没被信任过，先核对指纹。","durationMs":4}},
"knownHostsPath":"…\\vv3c-cfg-YhK2QT\\known_hosts.json","knownHostsBefore":false,
"panel":{"w":212,"h":692,"items":["verify-v3c-local41807@127.0.0.1:22 · 密码编辑删除"]},
"ui":{"cardCount":1,"cardVisible":true,
      "cardText":"首次连接，请核对指纹即将连接 41807@127.0.0.1:22。…指纹（ssh-ed25519）SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0信任并记住取消",
      "hasSha256":true,"hasAccept":true,"acceptText":"信任并记住",
      "statusText":"","statusVisible":false},
"statusFails":false
```
> 临时配置目录、`known_hosts.json` 起初不存在（`knownHostsBefore:false`）；先 API 确认返回 `UNKNOWN_HOST_KEY`，再在真 UI 里点 rail-hosts → 编辑 → 测试连接 → `[data-role="host-trust-card"]` 弹出、有 `SHA256:`、有「信任并记住」、**状态行没有「失败：…」**（实测为空字符串，连"失败"字样都没有）。
> 证据：`results-c.json`(V11)、`shots/c-v11-trust-card.png`

### V12 真键盘输入不回归 —— PASS
```json
{"marker":"V3C_VERIFY_prsu89","focus":{"ok":true},
 "tail":"$ echo V3C_VERIFY_prsu89\nV3C_VERIFY_prsu89\n41807@devpc MINGW64 ~\n$ "}
```
> `.xterm-helper-textarea.focus()` + `Input.insertText` + `Input.dispatchKeyEvent{Enter}`，终端回显出现该随机串。
> 证据：`results-a.json`(V12)、`shots/a-v12-typed.png`

### V13 不回归：新建标签 + rail-hosts —— PASS
```json
{"before":{"tabs":1,"debug":1},"after":{"tabs":2,"debug":2},
 "hostsPanel":{"exists":true,"x":48,"y":35,"w":212,"h":692,"display":"flex","visible":true}}
```
> 点「+」标签数 1→2（服务端会话数同步 1→2）；点 rail-hosts 后主机面板 212×692 可见。
> 证据：`results-a.json`(V13)、`shots/a-v13-hosts-panel.png`

### V14 色值纪律 —— PASS
```
$ grep -rn "#[0-9a-fA-F]\{3,8\}" app/styles/*.css
app/styles/tokens.css:21..118  （共 42 行，全在 tokens.css）
$ grep -rn "#[0-9a-fA-F]\{3,8\}" app/styles/components.css app/styles/layout.css | wc -l
0
$ grep -rn "rgb(\|rgba(\|#[0-9a-fA-F]\{3,8\}" app/styles/components.css app/styles/layout.css app/ui/*.js app/app.js
（无输出）
```
> components.css / layout.css 里 hex 与 rgb()/rgba() **都是 0**，JS 里也没有内联色值。
> 证据：本节原始命令输出

### V15 主动挑刺 —— 7 个具体结论（详见 §2）
`D0–D7` 全部 PASS（即缺陷都被真复现）。证据：`results-d.json`、`results-f.json`、`results-g.json` + `shots/d-*.png`。

---

## 2. V15 的具体结论（每条都给「会不会真出错」+ 复现路径）

> 复现载体：`probe-d.mjs` / `probe-f.mjs` / `probe-g.mjs`，用页面 debug 口 `__termDebugFrame` 注入帧形状与内核 `src/ai/agent.mjs` 实际发送的帧**逐字一致**。

### D1 toast 关掉后会被下一次 store 通知重新弹出 —— **会真出错（minor）**
- 现象：点 × 关 toast → `toasts:0`；随后任何一次 agent-store 通知（新步骤）→ `toasts:1` 又回来了。
- 复现：批准一条不处理、点 `toast-close`、再注入一个 `agent.step`。
  ```json
  afterClose:{"toasts":0}, afterNotify:{"toasts":1}, verdict:"关掉后被重新弹出（缺陷）"
  ```
- 原因：`app/ui/toast.js:86-101` 的 `render()` 以「`pendingApprovals` 里存在且 `nodes` 里没有」为准无条件重建；关闭只是 `nodes.delete`，没有记「用户已忽略」。
- 影响：用户明确关掉的通知会自己回来（符合卡里「不自动消失」的字面，但违背用户意图）。不阻塞主路径。

### D2 另一个 requestId 的 `agent.error`（BUSY）会静默清空正在等待的审批 —— **会真出错（major）**
- 现象：有一条待确认时发第二个问题，内核回 `agent.error{code:"BUSY"}`（`src/ai/agent.mjs:184-191`），前端 `onError` 直接 `pendingApprovals = []` → 审批卡 + toast + 角标全没了，但步骤还写着「等待确认」。
  ```json
  beforeBusy:{"pending":["apprA"],"toasts":1,"cards":1,"status":"awaiting"}
  afterBusy :{"pending":[],"toasts":0,"cards":0,"status":"error",
              "error":{"code":"BUSY","userText":"上一个任务还在跑，等它结束或点停止。"},
              "stepEls":[{"id":"stepA","status":"awaiting"}]}
  ```
- 复现：`probe-d.mjs` D2。
- 原因：`app/core/agent-store.js:200-211` 的 `onError()` 不判断 `frame.requestId/taskId` 是否属于当前任务，一律清空。
- 影响：**用户会以为「我刚才那条危险命令已经被取消了」**，而内核里那条审批仍然挂着（120s 超时后自动拒绝，或用户以为系统坏了）。A 卡之后加了「一连接一任务」的限制，第二条必然 BUSY，所以这个路径很容易撞上。

### D3 `agent.done` 不清 `error`：错误框与成功总结同时显示 —— **会真出错（major，与 D7 同源）**
- 现象：`error` 后收到 `agent.done` → `status:"done"`、`error` 仍在、UI 同时有 `agent-error` 和 `agent-summary`。
  ```json
  {"status":"done","error":{"code":"SOMETHING"},"summary":"已经做完了。","errorBox":true,"summaryBox":true}
  ```
- 复现：`probe-d.mjs` D3。
- 原因：`agent-store.js:192-198` 的 `onDone()` 只清 `pendingApprovals`，不清 `state.error`；`ai-drawer.js:379-395` 两个块独立渲染。

### D4 点了审批按钮后步骤永久停在「等待确认」，但审批卡已消失 —— **会真出错（major）**
- 现象：
  ```json
  afterApprove:{"pending":[],"cards":0,"stepEls":[{"id":"stepE","status":"awaiting"}],"status":"running"}
  ```
- 复现：`probe-d.mjs` D4（点 `approval-run`）。
- 原因：`agent-store.removeApproval()`（`agent-store.js:180-190`）只从 `pendingApprovals` 里删，不改对应 step 的 `status`；设计上依赖内核随后推 `agent.step{running}`（`src/ai/agent.mjs:317`）。只要那一帧晚到/丢了（或用户点了 skip 后内核走 `denied` 帧但前端已断线），界面就长时间显示「等待确认」但没有可点的按钮 —— **用户会以为按钮没生效，反复点击**。
- 严重性：正常主路径下内核会推 `running`，≈即时纠正，所以是 major（可感知的状态错乱），不是 blocker。

### D5 前端完全没有 requestId/taskId 作用域隔离：另一个任务的步骤混进同一条时间线 —— **会真出错（major，D2/V9 的根因）**
- 现象：当前 `requestId:"A"` 的时间线里出现 `requestId:"F2"` 的 `f2-step1`：
  ```json
  {"requestId":"A","taskId":"taskF1","stepEls":[{"id":"stepA"},{"id":"f1-step1"},{"id":"f2-step1"}]}
  ```
- 复现：`probe-d.mjs` D5；V9 里三条 `agent.approve` 的 `requestId` 全是旧的 `req-v7` 也是同一原因（`agent-store.js:112` / `:157` / `:161` 只在 `requestId` 为空时赋值）。
- 影响：内核同时只跑一个任务，所以「两个任务并发」在主路径上不会发生；但 D2/D6 显示「上一个任务的残帧 + 新任务」会混在一起，且**审批帧会带错的 requestId 发出去**（内核按 approvalId 找，所以不会崩，但协议语义已错）。

### D6 等待确认时发第二个问题：前端直接 `beginRun()` 清空待确认，无任何门禁 —— **会真出错（major）**
- 现象：
  ```json
  before:{"pending":["apprG1"],"cards":1,"toasts":1,"status":"awaiting"}
  sendState:{"sendDisabledWhileAwaiting":false}
  after :{"pending":[],"cards":0,"toasts":0,"status":"running","stepEls":[]}
  ```
- 复现：`probe-d.mjs` D6（把出站帧挡掉只看前端）。
- 原因：`ai-drawer.js:406-407` 永远 `sendButton.disabled = false`；`app/app.js:573-598` 的 `onAsk` 无「正在跑/待确认」门禁，`agentStore.beginRun()` 直接 `state = emptyState()`（`agent-store.js:105-111`）。
- 影响：**一条危险命令的审批卡会因用户随手再问一句话而凭空消失**（内核那边仍在等，120s 后自动拒绝；用户看不到任何痕迹）。这是我认为最该修的一条。

### D7 5 秒「内核未就绪」看门狗在慢网关上误报，且之后永不消失 —— **会真出错（major）**
- 现象：发问后 5s 内没有 `agent.*` 帧 → `failLocally({code:"AGENT_NOT_READY"…})`；第 6 秒真帧到达（`agent.start/step/done`）→ `status:"done"`、总结正常显示，但 `error` 仍在、错误框还在：
  ```json
  afterWatchdog:{"status":"error","error":{"code":"AGENT_NOT_READY","userText":"AI 内核还没就绪（TASK-V3-D 未合入）…"},"errorBox":true}
  afterRealFrames:{"status":"done","summary":"做完了。","errorBox":true,"summaryBox":true,"steps":[{"id":"slow-1","status":"done"}]}
  ```
- 复现：`probe-d.mjs` D7。
- 影响：**网关慢（首 token >5s）时用户会看到「AI 内核还没就绪（TASK-V3-D 未合入）」这句错误话术，即使任务其实成功了**。`agent.start` 只清 `readyWatchdog`（`ai-drawer.js:411-417`），从不清 `agent-store.error`。执行者报告 §CC-notready 的截图正是同一路径的真实现场。

### D8（附加）toast 会盖住终端右下角 1 行 × 46 列 —— **会真出错（minor）**
- 现象（1280×760）：
  ```json
  {"stack":{"top":687.8,"left":932,"right":1272},"screen":{"top":40.5,"bottom":706.5,"left":52,"right":1260},
   "rowH":18,"colW":7.15,"overlapH":18.7,"overlapW":328,"rowsCovered":1,"colsCovered":46}
  ```
  829×721 同样重叠。
- 卡里 §6.3 明写「不遮住终端输入区」。实测遮 1 行、右侧 46 列（正好是命令行末尾、光标所在区域）。因为 toast 可以关、且终端会滚动，判 minor。

### D9（附加）`agent.done` 后 step 卡在 awaiting（与 D4 同源，另一条路径）
```json
before:{"steps":[["z1","awaiting","1等待确认rm -rf build…"]]}
after :{"pending":0,"toasts":0,"cards":0,"steps":[["z1","awaiting"]],"stopHidden":true,"summary":"任务结束。"}
```
（`probe-g.mjs`）审批超时/内核收尾走 done 时，步骤文字还写着「等待确认」，总结已经出来 —— 自相矛盾的状态。

---

## 3. 全量回归

| 项 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `D:/nodejs/install/node.exe --test` | **tests 348 / pass 348 / fail 0**（11.5s） |
| doctor | `DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs` | **33/33 assertions passed**（含 D7-2b 浏览器计算值 `#1e1e2e`、D7-1a browserAutoTab sessionCount=1 xtermCount=1） |

两项都一次通过，不需要等 120s 重跑。

交叉验证（执行者探针）：`D:/nodejs/install/node.exe .dispatch/v3c-probe.mjs` → **17/17 PASS**，关键读数与我的一致（CC4 `flushGap:0 centerGap:0`、CC5 `cols 169→118`、CC6 6 秒后 `toastCount:1`、CC8 三帧字段与我抓到的逐字相同、CC10 指纹 `SHA256:zMoSsET…`）。**它的 S6.7 那一项真跑通了内核**（2 步 `ls -Ap|…` + 大白话总结），说明 D 卡内核确实在跑。

---

## 4. 额外发现的问题（分级）

| # | 级别 | 问题 | 位置 |
|---|---|---|---|
| 1 | **major** | 待确认时发第二个问题 → `beginRun()` 清空 `pendingApprovals`，审批卡/toast/角标全部消失，内核仍在等（D6） | `app/core/agent-store.js:105-111`、`app/ui/ai-drawer.js:406-407`、`app/app.js:573-598` |
| 2 | **major** | `agent.error` 不区分 requestId（BUSY 也会清空正在等待的审批）（D2） | `app/core/agent-store.js:200-211` |
| 3 | **major** | 5s「内核未就绪」看门狗误报后错误永不消失，成功总结与错误框并存（D7 / D3） | `app/ui/ai-drawer.js:434-448`、`app/core/agent-store.js:192-198` |
| 4 | **major** | 点完审批后 step 永久停在 `awaiting`（卡片已消失），依赖内核补帧（D4/D9） | `app/core/agent-store.js:180-198` |
| 5 | **major** | 无 requestId/taskId 作用域：残帧混入、`agent.approve` 带错 requestId（D5/V9） | `app/core/agent-store.js:112,157,161` |
| 6 | minor | 关掉的 toast 会在下一次 store 通知时复现（D1） | `app/ui/toast.js:86-101` |
| 7 | minor | toast 遮挡终端右下角 1 行 × 46 列（§6.3 要求不遮输入区）（D8） | `app/styles/layout.css:196-210` |
| 8 | minor | 设置模态高 712px，在 721 高的视口里只留 24px 边距、body 需内部滚动（`scrollH 670 > clientH 587`，按钮仍可见，可用） | `app/ui/settings-panel.js` + `components.css` |

> 反向确认（**不是**缺陷）：V14 色值全走变量；`buildTrustCard` 的 `onTrusted` 可选参数没破坏旧路径（V11 只重跑测试、没建会话）；把手点击热区用 `::after` 向左侧扩、展开时 `display:none`，符合 §6.1；抽屉宽度只由一个变量控制，两个视口都无横向滚动。

---

## 5. 结论

**C 卡可以放行（pass_with_issues）。** 15 条硬指标 15/15 通过（V1–V14 全 PASS；V15 的 7 条挑刺全部真复现），用户最痛的两点（设置页打不开、AI 栏在底部）确实修好了，几何/落盘/toast 常驻/指纹引导都有我自己的独立读数；全量回归 348/348 与 33/33 也都是干净的。

但 `agent-store.js` 的状态机有 5 个 major 级状态错乱问题，都集中在「多个 requestId 交叉 / 超时 / 看门狗」这些异常路径上——主路径（问一句 → 审批 → 执行 → 总结）不受影响，所以不阻塞放行；**建议作为 V3-C-fix1 立刻跟进**，尤其是第 1、2 条（会静默吞掉用户的待确认审批）。

---

## 6. 原始证据清单

```
.dispatch/verify-v3c/
├─ harness.mjs / server-boot.mjs / cdp.mjs      # 我自己的起服务与 CDP 封装
├─ probe-a.mjs → results-a.json                 # V1 V5 V6 V10 V12 V13
├─ probe-b.mjs → results-b.json                 # V2 V3 V4 V7 V8 V9
├─ probe-c.mjs → results-c.json                 # V11
├─ probe-d.mjs → results-d.json                 # D1–D7（V15 缺陷复现）
├─ probe-e.mjs → results-e.json                 # 设置模态小视口 / toast 重叠
├─ probe-f.mjs → results-f.json                 # toast 遮挡行列数
├─ probe-g.mjs → results-g.json                 # done 后 step 卡 awaiting
└─ shots/ (27 png)
   a-v5-collapsed-1280.png / a-v5-collapsed-829.png / a-v6-expanded-1280.png / a-v6-expanded-829.png
   a-v10-step-upsert.png / a-v12-typed.png / a-v13-hosts-panel.png
   b-v2-settings-open.png / b-v4-settings-filled.png / b-v4-settings-saved.png
   b-v7-toast-immediate.png / b-v7-toast-after-6s.png / b-v8-approval-card.png
   c-v11-trust-card.png
   d-d1-toast-resurface.png / d-d2-busy-wipe.png / d-d3-error-and-summary.png / d-d4-stale-awaiting.png
   d-d5-mixed-tasks.png / d-d6-second-send.png / d-d7-watchdog-sticky.png
   e-settings-829x721.png / e-settings-1280x760.png / e-toast-829x721.png / e-toast-1280x760.png
   f-toast-overlap.png / g-done-stale-step.png
```
