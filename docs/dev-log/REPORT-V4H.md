# REPORT-V4H — AI 会话模型重写（多轮 / 会话列表 / 审阅角标）

- 任务卡：`TASK-V4-H.md`
- 交付状态：**待验收**（未 commit、未标「成品/已验收」）
- 执行日期：2026-11-24
- 基线：`HEAD 8295595`，工作区起始干净
- 只按 `docs/PROTOCOL-AGENT.md` §5 / §5.1 与 `docs/mockups-v4/`（v4b）+ `CHANGES-V4.md` §1.2 §1.3 §2 D4 D5 §4 实现

---

## 0. 一句话结论

AI 从「一问一跑一总结」改成了真正的多轮会话 agent：会话落盘在 `stateDir()/ai-sessions/`、
追问能引用上一轮的真实命令输出（真网关实测两轮）、抽屉里有按终端分组的会话下拉与来源徽标、
工具卡/思考块/总结块重画、确认卡右下角有了四态审阅角标与两段 tooltip、`strict` 档不再跳过审阅。

**证据总览（全部本机实跑，原始输出在 `.dispatch/v4h-probe/`）**

| 项 | 结果 |
|---|---|
| 全量测试（`node --test`，不带路径参数） | `tests 673 / pass 673 / fail 0`，18.5s |
| `doctor` | `33/33 assertions passed`，RC=0 |
| `rg reviewWhy src app test scripts` | **0 命中**（exit=1） |
| 真浏览器走查（47 条断言） | `pass=47 fail=0` |
| 服务端端到端（真网关 + 真 PTY + 真 WS，14 条） | `pass=14 fail=0` |
| 真模型 + 真浏览器两轮追问（7 条） | `fail=0` |

---

## 1. 代码改动（文件 → 关键行）

### 1.1 新增 `src/ai/sessions.mjs`（546 行，§5.1）

| 落点 | 内容 |
|---|---|
| `sessions.mjs:26-36` | 上限常量：`MAX_MESSAGES=200`、`MAX_SESSION_BYTES=512KB`、`TRIM_KEEP_MESSAGES=40`、`MESSAGE_TEXT_MAX=4000`、`MAX_SESSIONS=100`、`TITLE_MAX=80` |
| `sessions.mjs:44` | `sessionsDir()` → `path.join(stateDir(), "ai-sessions")`（现算，测试指到临时目录时一起跟着走） |
| `sessions.mjs:147-200` | `trimSession()` 纯函数：先砍到最近 40 条 → 单条截到 4000 字 → 步骤输出截到 800 字 → 仍超就从最旧丢；写 `trimNote` |
| `sessions.mjs:226` | `writeAtomic()`：目录 700 → 临时文件 600 → rename |
| `sessions.mjs:250` | `withLock(id, fn)`：按会话 id 串行写链（同一会话不交错，不同会话不互相阻塞） |
| `sessions.mjs:293` `createSession` / `370` `listSessions` / `395` `findByTerminal` / `408` `appendMessage` / `437` `upsertStep` / `466` `renameSession` / `488` `deleteSession` / `505` `markBusy` | 卡片要求的全部 API |
| `sessions.mjs:488` | `deleteSession` 先查 `busy` → 返回 `{ok:false, code:"SESSION_BUSY"}`（HTTP 层映射 409） |

### 1.2 `src/ai/agent.mjs`（多轮 + 落盘 + 流式，940 行）

| 行 | 内容 |
|---|---|
| `agent.mjs:60-64` | `AGENT_HISTORY_RULES`：多轮补充段（用 `· ` 不编号，保住「硬性规则十条」逐字契约） |
| `agent.mjs:111` | `summarizeStepForHistory()`：每条命令 + 输出截到 800 字 |
| `agent.mjs:134` | `buildHistoryMessages()`：user→`user`、assistant→`assistant`、工具结果→该轮的步骤摘要，相邻同角色合并 |
| `agent.mjs:196` | `extractReasoning()`：从 `steps[].reasoningText` / `reasoning[]` 捞思考过程 |
| `agent.mjs:298` | `resolveSession()`：显式 `aiSessionId` → 该终端最近会话 → 新建（服务端兜底） |
| `agent.mjs:255` | `chainPersist()` / `:267 waitPersisted()`：同一会话写盘串行链（下一轮读历史前先等它落地） |
| `agent.mjs:350` | `start()` 新增 `aiSessionId` / `terminal` 参数 |
| `agent.mjs:433` | `recordStep()`：每步 upsert 进会话（失败只记日志不打断） |
| `agent.mjs:788-825` | `streamText` + `textStream` 逐字推 `agent.text`；**只取 `stream.text` / `stream.steps` 两个 getter**（展开对象会把所有 getter 变 Promise，中止时集体 unhandledRejection，实测崩进程） |
| `agent.mjs:835` | `agent.reasoning` 帧 |
| `agent.mjs:698-712` | `persistFinish()`：写助手消息 +（停止时）标状态；`:751` done 帧在落盘完成后再发 |
| 全部 `agent.*` 帧 | `emit()` 统一补 `sessionId` |

### 1.3 `src/ai/judge.mjs` / `src/ai/review.mjs`（审阅全档位）

| 行 | 内容 |
|---|---|
| `judge.mjs:121` | 唯一的「不调审阅」出口只剩 `reviewModel === ""`（设置页的全局开关），**没有 strict 分支了** |
| `judge.mjs:136-160` | 三档都 `doReview(...)`；失败 → `REVIEW_FAILED` 日志 + `reviewUnavailable` 返回 |
| `judge.mjs:176` | 每次审阅写一行 `[REVIEW]`（含 risk/effect/confirmWhy/reversible/reviewModel/durationMs，**不含完整命令**） |
| `judge.mjs:199` | `strict`：只展示结论，绝不自动放行 |
| `judge.mjs:204` | `safe && reversible` → auto（balanced/loose） |
| `judge.mjs:208` | `loose` 额外放行 `caution && reversible`；`danger` 任何档位都不 auto |
| `review.mjs:19-31` | 提示词按 PROTOCOL §5.1 逐字追加 effect / confirmWhy 两段 |
| `review.mjs:37-44` | zod schema 同步成 `risk / effect / confirmWhy / reversible`（`why` 删除） |

### 1.4 `src/server/ws.mjs`（会话接线 + 终端归属）

- `ws.mjs:76` `agent.run` 新增可选顶层 `sessionId`（AI 会话 id，与 `context.sessionId`＝PTY id 分开）
- `ws.mjs:84` `context` 新增 `terminalKind / hostId / hostName / hostAddr`
- `ws.mjs:119` `shellLabel()`：本机徽标形如 `bash 5.2.37`
- `ws.mjs:131` `hostAddrOf()`：远程 `host:port`（22 端口不写）
- `ws.mjs:154` `const aiSessions = opts.aiSessions || createSessionStore({log})`（REST 与 WS 共用一个实例，写链才串行）
- `ws.mjs:171` `createAgentRunner({log, runner, sessions: aiSessions})`
- `ws.mjs:543` `handleAgentRun` 组 `terminal` 对象（id/kind/shell/hostId/hostName/hostAddr）传给 agent
- `ws.mjs:743` 返回 `agentSessions`

### 1.5 `src/server/http.mjs`（REST + config 字段）

- `http.mjs:42` 引 `TITLE_MAX, createSessionStore`
- `http.mjs:363` `const aiSessions = options.aiSessions || createSessionStore({log})`
- `http.mjs:389-478` `handleAiSessionsRequest()`：GET 列表 / GET 全文 / PATCH 标题 / DELETE（409 SESSION_BUSY）
- `http.mjs:941`、`1050` GET/PUT `/api/config` 带 `showApprovalEffect`
- `http.mjs:1157/1177` handle 暴露 `aiSessions`

### 1.6 `src/config/store.mjs`

- `store.mjs:42` `KNOWN_FIELDS` 加 `showApprovalEffect`
- `store.mjs:75` `DEFAULT_CONFIG.showApprovalEffect = false`
- `store.mjs:250-254` 非法类型 → `INVALID_SHOW_EFFECT`
- `store.mjs:302-303` `normalize()` 非 boolean 回落 false
- `store.mjs:319` `publicConfig()` 透出

### 1.7 `app/core/agent-store.js`（单会话 → 多会话，785 行重写）

| 行 | 内容 |
|---|---|
| `agent-store.js:50` | `draftKey(terminalId)`：草稿会话 key |
| `agent-store.js:302` | `setSessionsList()`：草稿到达列表时就地并到该终端最近的已落会话（刷新后能看到历史） |
| `agent-store.js:352` | `focusTerminal()`：切标签 → 切该终端会话；没有就草稿 |
| `agent-store.js:396` | `restoreSession()`：从 `GET /api/ai/sessions/:id` 全文还原多轮时间线 |
| `agent-store.js:458` | `beginRun()`：在当前会话里开新的一轮（`turns[]`） |
| `agent-store.js:554` | `onApproval()`：`risk/effect/confirmWhy/reversible/reviewModel` 全收（`risk=null` 也留，前端画灰角标） |
| `agent-store.js:611/626` | `onText()` / `onReasoning()` 落到最新一轮 |
| 快照 | `pendingApprovals` 是**所有会话并集**（把手角标要看到别的标签），`sessionPending` 只有当前会话（时间线只画自己的） |

### 1.8 `app/ui/ai-drawer.js`（重写 1321 行）

- `ai-drawer.js:46-56` `REVIEW_STATE` 四态映射 + `TIP_TITLE_EFFECT`/`TIP_TITLE_WHY` 逐字常量
- `ai-drawer.js:141/163` `agent-sessions-toggle`（会话头）/ `agent-new`（新建）
- `ai-drawer.js:282-330` `groupSessions()` / `sourceBadge()`：按终端分组、本机组标题用该标签真名（`bash: 41807`）、本机徽标 `bash 5.2.37`、远程两行
- `ai-drawer.js:333` `renderSessionsMenu()`：`aria-expanded` + `hidden` 折叠、当前组/当前项 `data-current="true"` 只用底色
- `ai-drawer.js:636` `buildReviewMark()`：`data-review` 四态 + tooltip 两段（`overflow` 由卡片保证 visible）
- `ai-drawer.js:687` `buildApprovalCard()`：`showApprovalEffect` 开启时按钮上方追加 `.approval-effect`
- `ai-drawer.js:736` `buildReasoningBlock()`：「思考过程 · N 字」，默认收起
- `ai-drawer.js:765` `buildToolCard()`：状态图标/命令/耗时/输出折叠（默认露 3 行）
- `ai-drawer.js:915` `renderTurn()`：一轮 = 问题 → 思考块 → 工具卡 → 流式块 → 总结块
- `ai-drawer.js:1296` `setShowApprovalEffect()`

### 1.9 `app/app.js` / `app/core/api.js` / `app/core/session-store.js` / `app/ui/tab-bar.js`

- `app.js:366/373` 新增 `agent.text` / `agent.reasoning` 分支
- `app.js:510-580` `terminalMetaOf()` / `shortLabelOf()` / `activeTerminalMeta()` / `refreshAiSessions()` / `focusTerminalSession()` / `restoreSessionIfNeeded()`
- `app.js:988` 切标签 → `focusTerminalSession()`（`lastFocusedTerminalId` 去重）
- `app.js:772` `getTerminalById`（下拉组标题读真名）
- `app.js:940` `onShowEffectChange` → 抽屉立刻反映
- `app.js:155-241` `remoteAddrOf()` + `hostAddr` 写入/补丁
- `api.js` 新增 `aiSessions/aiSession/renameAiSession/deleteAiSession`
- `session-store.js:85` 会话对象带 `hostAddr`
- `tab-bar.js:16-49` **`shellShortName()`（V4-F 遗留小修）**：`PowerShell 5`→`PS5`、`PowerShell 7`→`PS7`、bash 仍是 `bash`

### 1.10 `app/ui/settings-panel.js`

- `:82` `setShowEffect()` 唯一同步点（默认 false）
- `:348-380` 「确认卡」块 + `data-role="setting-show-effect"` 开关
- `:476/492` 打开设置时从 config 读
- `:509` 保存时一起 PUT
- 审阅模型下拉**删掉了「关闭审阅」选项**（§5.3：审阅是固定一步）

### 1.11 样式 `app/styles/components.css`

- `:274-340` 一轮/思考块；`:342-410` 工具卡（状态图标、命令省略、输出 3 行折叠）；`:600-760` 确认卡 + 角标 + tooltip + 总结块（总结块前面一条细横线、字号 13px）
- `:635` `[data-role="agent-approval"] [data-role="approval-review"]`（20×20，`right/bottom:9px`）
- `:682-705` tooltip 两段（`:hover` / `:focus-visible` / `[data-open]` 三条并列）
- `:923` **`max-width: 66%`（V4-E 遗留小修）**：原来 58% 在 384px 抽屉下把模型名截成 `…Command C…`；现在整行可见、不与发送按钮重叠（实测 62% 宽、间隙 8-61px）
- `:2659` 会话下拉；`:3024` 设置开关
- `[data-role="ai-drawer"] .ai-head { z-index: 20 }`：下拉不会被时间线里的确认卡压住

---

## 2. AC1–AC13 逐条

> 「改了什么 + 哪个测试/探针证明了它 + 原始数字」逐条列出。原始输出见 `.dispatch/v4h-probe/*.txt`。

### AC1 同一会话两轮，第二问用指代，能引用上一轮真实输出 → **PASS**

- 改动：`src/ai/sessions.mjs`（会话落盘 + `messages.round`）、`agent.mjs:298 resolveSession` / `:134 buildHistoryMessages`、
  同会话写盘串行链 `chainPersist`/`waitPersisted` + `finish()` 里 done 在落盘之后发、
  `app/core/agent-store.js:458 beginRun`、`app/app.js` 的 `onAsk` 带 `frame.sessionId`
- 证据 1（真网关 + 真 WS）：`.dispatch/v4h-probe/v4h-e2e.txt`
  ```
  AC1 第一轮 sessionId=s-fea36dbe round=1
  第一轮 done: steps=6
  第一轮命令：["echo $0; echo \"---\"; ls | head -5","rg --files --hidden -g '!.git' | xargs … stat -c '%s %n' | sort -nr | head -3","rg --files --hidden -g '!.git' | xargs … du -h | sort -rh | head -3"]
  AC1 第二轮 sessionId=s-fea36dbe round=2
  PASS AC1 第二问是指代且能引用上一轮真实输出 :: {"sameSession":true,"round":2,"vague":false,"citesReal":true,"round1Tokens":["488663 ","244550 ","237916 "]}
  ```
  实测第二轮回答（真模型）：`最大的那个是 app/vendor/xterm/xterm.js，精确大小是 488,663 字节…`，
  三个数字逐字来自第一轮 `stat` / `du` 的真实输出（`round1Tokens` 就是从那几行里抓的）。
- 证据 2（真模型 + 真浏览器）：`.dispatch/v4h-probe/v4h-live.txt`
  ```
  第一问：当前目录下一共有多少个 .md 文件？
  → steps=["ls -1 *.md 2>/dev/null | wc -l; echo \"---\"; rg --files -g '*.md' . | wc -l"]，回答 2
  第二问：那刚才那个数字，乘以 2 是多少？
  → "刚才说的…"（引用上一轮的 2）
  PASS 第二轮复用同一会话 / PASS 两轮都在时间线里 / PASS 指代被正确理解
  会话列表：{"count":1,"titles":["当前目录下一共有多少个 .md 文件？只告诉我数… / 6"]}
  ```
- 证据 3（单测）：`test/ai/agent.test.mjs`
  - `AC1：同一会话连续两问，第二问的模型输入里有上一轮的真实输出`（断言第二轮 `messages` 里含第一轮问题、`12M a.txt` 输出、助手结论）
  - `§5.2：不带 aiSessionId 也能按终端找回最近会话`、`§5.2：不同终端各自一个会话，互不串味`

### AC2 重启服务后 `GET /api/ai/sessions` 仍能列出、`GET /api/ai/sessions/:id` 能还原 steps → **PASS**

- 改动：`src/ai/sessions.mjs`（文件落盘，无内存依赖）、`http.mjs:389 handleAiSessionsRequest`
- 证据：`.dispatch/v4h-probe/v4h-e2e.txt`
  ```
  PASS AC2 重启服务后 GET /api/ai/sessions 仍列出该会话 :: {"listed":1,"id":"s-fea36dbe"}
  PASS AC2 GET /api/ai/sessions/:id 能还原 steps :: {"steps":7,"messages":6}
  ```
  （3514 关掉 → 3515 新实例，只靠磁盘。steps=7 / messages=6 是两轮累积的真实条数）
- 单测：`test/server/ai-sessions-route.test.mjs` → `重启服务后 GET /api/ai/sessions 仍能列出会话，全文能还原 steps（AC2）`（11/11 通过）；`test/ai/sessions.test.mjs`（18/18，含落盘/回读/裁剪/并发写串行/删除忙会话）

### AC3 两个终端标签各一句，切标签抽屉跟着切，切回历史还在，新标签空态能新建 → **PASS**

- 改动：`app/core/agent-store.js:352 focusTerminal` / `:302 setSessionsList`（草稿并到已落会话）/ `:396 restoreSession`、`app/app.js:560 focusTerminalSession` + `:988` 监听 `activeId`
- 证据：`.dispatch/v4h-probe/v4h-ui.txt`（真浏览器，真开两个 bash 标签）
  ```
  PASS 能开第二个终端标签 :: ["4638886c-…","42bb70dc-…"]
  PASS AC3：切到标签 1 → 抽屉落在该终端的会话 :: {"current":"s-fbfb790e","terminal":"7c8aa9a2-…"}
  PASS AC3：切到标签 2 → 会话跟着切（不是同一个） :: {"current":"s-a8cbf201","terminal":"93b716fa-…"}
  PASS AC3：切回来历史还在（时间线还原） :: 176
  PASS §5.5 重命名走行内输入框（不弹 window.prompt），服务端标题已改 :: {"ok":true,"title":"改名探针","hasInputGone":true}
  PASS §5.5 删除要先过行内二次确认，确认后服务端 404 :: {"ok":true,"sid":"s-5fd746c5","status":404}
  ```
- 重命名/删除：**不用 `window.prompt` / `window.confirm`**——
  本机 CDP 实测 `window.prompt` 在 headless/沙箱 WebView 里会直接阻塞（`Runtime.evaluate` 超时），
  所以改成行内输入框（Enter 存 / Esc 取消 / 失焦存）与行内二次确认条（点「删」才真删）。
- 空态：`ai-drawer.js` 的 `renderEmptyState()` 在 `hasSessions === false` 时渲染 `.empty-note`
  「会话属于终端：发第一条消息时创建，切标签会回到那个终端最近的会话」，`agent-new` 按钮可建新草稿
- 单测：`test/ai/agent-store.test.mjs` → `focusTerminal：切终端 → 会话跟着切；切回来还是原来那个`、
  `setSessionsList：草稿就地并到该终端最近的已落会话`、`newDraft：再点「新会话」不覆盖当前会话的历史`

### AC4 会话列表按终端分组、当前项只有底色无竖线、本机徽标 `bash 5.2.37`、远程两行 ≤120px → **PASS**

- 改动：`ai-drawer.js:282 groupSessions` / `:333 renderSessionsMenu` / `:315 sourceBadge`、`components.css:2659+`（当前项只用 `--term-accent-soft` 底色，无 `inset`/`border-left`）、`:2915+` 徽标 `max-width:120px` + 两行 `flex-direction:column`
- 证据：`.dispatch/v4h-probe/v4h-ui.txt`（computed style 实测）
  ```
  PASS AC4：按终端分组（≥2 组） :: ["bash: 41807","prod-web-01","bash: 41807"]
  PASS AC4：当前组标记唯一 :: 1
  PASS AC4：当前项只有底色（无竖线、无 box-shadow） :: {"boxShadow":"none","borderLeftWidth":"0px","background":"rgba(120, 160, 220, 0.18)"}
  PASS AC4：本机徽标形如 `bash 5.2.37` :: ["bash 5.2.37","bash 5.2.37"]
  PASS AC4：远程徽标两行 :: [{"cls":"src-badge k-ssh","w":68,"h":26,"dir":"column"}]
  PASS AC4：远程徽标宽度 ≤120px :: [68]
  PASS AC4：组折叠走 aria-expanded + hidden（成对翻转，再点还原） :: {"before":{"expanded":"true","hidden":false},"after":{"expanded":"false","hidden":true},"afterSecond":{"expanded":"true","hidden":false}}
  ```
- 截图：`.dispatch/v4h-shots/1280-sessions.png`、`1440-sessions.png`

### AC5 工具卡命令/状态/耗时/输出可展开；有 reasoning 显示折叠「思考过程」→ **PASS**

- 改动：`ai-drawer.js:765 buildToolCard` / `:736 buildReasoningBlock`、`components.css:342-410`（`.tool-status-icon` 四态 + `.tool-cmd` 省略 + `[data-collapsed]` 3 行高）、`:288-340` 思考块
- 证据：`.dispatch/v4h-probe/v4h-ui.txt`
  ```
  PASS AC5：工具卡显示命令 :: git diff --stat app/styles/layout.css
  PASS AC5：工具卡有状态图标 :: ✓
  PASS AC5：工具卡有耗时 :: 1ms
  PASS AC5：输出默认折叠（露 3 行） :: 46.59375
  PASS AC5：点「展开输出」后能看到更多（折叠标记消失） :: {"h":47,"collapsed":null}
  PASS AC5：思考块存在且默认收起 :: {"hidden":true,"label":"▸思考过程 · 64 字"}
  PASS AC5：思考块标题含「思考过程 · N 字」 :: ▸思考过程 · 64 字
  PASS AC5：点开后能看到推理正文 :: {"hidden":false,"label":"▾思考过程 · 64 字"}
  ```
- 真模型侧：`.dispatch/v4h-probe/v4h-live.txt` → `各轮 reasoning 字数：[609,441]`、`PASS 有 reasoning 时渲染折叠的思考块（DOM）:: {"label":"▸思考过程 · 609 字","hidden":true}`
- 截图：`1280-tool-card.png`、`1280-reasoning.png`（真模型视角 `1280-live-turn2.png` 里能看到 609 字的思考块展开）

### AC6 角标四态可辨（构造帧注入 ok/caution/danger/none），tooltip 两段标题逐字 → **PASS**

- 改动：`ai-drawer.js:46-56` + `:636 buildReviewMark`、`components.css:635-705`
- 证据：`.dispatch/v4h-probe/v4h-ui.txt`
  ```
  PASS AC6：四态齐全 ok/caution/danger/none :: ["ok","caution","danger","none"]
  PASS AC6：tooltip 两段标题逐字 :: ["执行后会发生什么","为什么需要你确认"]
  PASS AC6：悬停后 tooltip 可见 :: {"display":"block","w":276,"h":140,"cardOverflow":"visible"}
  PASS AC6：确认卡 overflow=visible（tooltip 能出卡） :: visible
  PASS AC6（1440）：角标落在确认卡右下角 9px :: {"state":"caution","w":20,"h":20,"rightGap":10,"bottomGap":10}
  ```
- 截图：`1280-approval-states.png`（四态同屏）、`1440-approval.png`（tooltip 展开）

### AC7 设置开关默认关；开启后确认卡常显 effect；关掉消失；PUT/GET 一致 → **PASS**

- 改动：`settings-panel.js:82/348`、`config/store.mjs:250`、`http.mjs:941/1050`、`ai-drawer.js:687` + `:1296`、`styles:3024`
- 证据：`.dispatch/v4h-probe/v4h-ui.txt`（走真实设置页与真实 `PUT /api/config`）
  ```
  PASS AC7：默认关（确认卡没有常显 effect 行） :: false
  PASS AC7：开关存在且默认 off :: {"checked":"false","role":"switch"}
  PASS AC7：点一下变 on :: true
  PASS AC7：保存后 GET config 里 showApprovalEffect=true :: {"status":200,"show":true}
  PASS AC7：开启后确认卡常显 effect 文本 :: 执行后会发生什么：test/fixtures 下 3 个 30 天前的 .log 被删除，释放 1.8 MB。
  PASS AC7：再点回 off :: false
  PASS AC7：关掉后 effect 行消失，PUT/GET 一致（false） :: {"show":false,"lines":0}
  ```
- 单测：`test/config/agent-fields.test.mjs` → `TASK-V4-H §6：showApprovalEffect 默认关，PUT 后 GET 一致，非法类型 400 INVALID_SHOW_EFFECT`
- 截图：`1280-settings-effect.png`、`1280-approval-effect.png`

### AC8 `strict` 档下审阅确实被调用（日志有 `[REVIEW]`），risk=safe 仍 confirm → **PASS**

- 改动：`judge.mjs:121`（删掉 strict 跳过分支）、`:136`（三档都调）、`:176`（`[REVIEW]` 日志）、`:199`（strict 只展示）
- 证据：`.dispatch/v4h-probe/v4h-e2e.txt`（真审阅模型）
  ```
  PUT autonomy=strict → 200
  AC8 审阅日志：[{"code":"REVIEW","risk":"caution","ms":4005,...},{"code":"REVIEW","risk":"safe","ms":2895,...},{"code":"REVIEW","risk":"safe","ms":...}]
  PASS AC8 strict 档确实调用审阅（日志有 [REVIEW] 行） :: {"reviewLines":3,"failed":0}
  PASS AC8 strict 下审阅 risk=safe 的命令仍返回 confirm（不自动执行）
       :: [{"command":"tree -L 1","decision":"confirm","risk":"safe",…},{"command":"uname -a","decision":"confirm","risk":"safe",…}]
  ```
- 单测：`test/ai/judge.test.mjs` → `AC6 / AC8：mkdir testdir —— strict → confirm，但审阅确实被调用`（`review.calls.length === 1`）、
  `AC8：审阅 safe + strict → 仍是 confirm`、`AC8：三档都调审阅`、`每次审阅写一行 [REVIEW] 日志`

### AC9 审阅模型换成不存在的 id → 角标 none、decision=confirm、reason 是协议原文、任务不崩 → **PASS**

- 改动：`judge.mjs:153`（`REVIEW_FAILED` 日志 + `risk=null/effect=null/confirmWhy=null/reversible=null`）、`ai-drawer.js:46`（`none` → 灰角标）
- 证据：`.dispatch/v4h-probe/v4h-e2e.txt`
  ```
  AC9 用时 102ms，日志=["REVIEW_FAILED"]
  PASS AC9 审阅模型不存在 → decision=confirm + risk=null（角标 none）+ 协议原文 reason
       :: {"decision":"confirm","risk":null,"reason":"审阅服务不可用，按需要确认处理","ms":102}
  PASS AC9 审阅失败写 REVIEW_FAILED（不静默） :: {"failed":1,"ms":102}
  ```
- 单测：`test/ai/judge.test.mjs` → `AC9：审阅返回 risk:null（模型不存在 / 超时）→ 三档都 confirm + 角标 none + 协议原文 reason`（三档循环）

### AC10 `rg reviewWhy src app test scripts` 0 命中 → **PASS**

```
$ rg reviewWhy src app test scripts ; echo exit=$?
exit=1
```
（0 命中。改名落在 `judge.mjs`、`review.mjs`、`agent.mjs`、`agent-store.js`、`ai-drawer.js`、`test/ai/judge.test.mjs`、`scripts/agent-smoke.mjs`）

### AC11 `node --test` 0 fail；`doctor` 33/33 → **PASS**

```
$ timeout 240 D:/nodejs/install/node.exe --test
ℹ tests 673
ℹ pass 673
ℹ fail 0
ℹ duration_ms 18506.1846

$ DOCTOR_PORT=3489 timeout 260 D:/nodejs/install/node.exe scripts/doctor.mjs
doctor: 33/33 assertions passed   (RC=0)
```
原始输出：`.dispatch/v4h-probe/doctor.txt`、`.dispatch/v4h-probe/full-test.txt`

> 基线对照：卡开始时同一台机器同样命令是 `tests 610 / pass 610 / fail 0`。
> 新增 63 条（sessions 18 + agent-store 17 + ai-sessions-route 11 + judge/prompt/agent 的补充）。
> 逐用例名核对：**没有删测试，没有放宽断言**（judge 里原来「strict 必须跳过审阅」的那条按 §5.3 反向改成「strict 也必须调」，
> 这是任务卡 §5.3 授权的行为变更，不是放水；prompt 那条只是加了多轮段的新断言）。
>
> **稳定性（本卡自己修的两个真竞态）**：同一份代码连跑 6 次全量 → 4 次 `673/673/0`，其余 2 次只挂已知 flaky
> `test/ssh/registry.test.mjs` 的「建连后立刻 close」（卡片 §4 已列、单跑 17/17 绿、与本卡无关）。
> 诊断过程中发现并修掉两个真实竞态（不修就会在真机偶发，不是测试写法问题）：
> 1. `recordStep` 是即发即忘的异步写盘，第二轮可能在第一轮写盘前就读历史 → 同会话落盘改成串行链
>    （`agent.mjs` 的 `chainPersist` / `waitPersisted`），并且 `agent.done` 改成「落盘完成后再发」
>    （done 就是「这一轮已存好」的信号）。修前在并行全量下稳定复现「第二轮丢掉第一轮的工具输出」。
> 2. Windows 上两个 `rename` 撞同一目标会拿到 `EPERM`（暂时态）→ `sessions.mjs` 的 `writeAtomic`
>    加了平台限定的重试（最多 12 次、退避 15→125ms），失败仍然抛错不吞数据。

### AC12 停止按钮：喊停后不再执行后续步骤、已跑完输出保留、会话标「已停止」→ **PASS**

- 改动：`agent.mjs`（`task.stop()` → abort + 清 pending；`finish()` 里 `sessions.setStatus(..., "stopped")`）、`agent-store.js:715 markStopped`
- 证据：`.dispatch/v4h-probe/v4h-e2e.txt`
  ```
  AC12 第一步 done command=ls
  PASS AC12 喊停后不再有新步骤 :: {"steps":1,"commands":["ls"]}
  PASS AC12 已跑完的输出保留 :: {"outputs":["ile://devpc/c/Users/41807/magpie-terminal\u001b\\AGENTS.md    packa…"]}
  PASS AC12 会话标「已停止」 :: {"stopped":true,"status":"stopped","steps":1}
  ```
- 单测：`test/ai/agent.test.mjs` → `AC12：stop 后 pending approval 全部 resolve 成 aborted，并发 agent.done{stopped:true}`、
  `AC12：stop 之后只发一次 done`、`AC12：停止后会话标「已停止」，已跑完的输出保留`；
  `test/ai/sessions.test.mjs` → `setStatus 记「已停止」（AC12）`；`agent-store.test.mjs` → `markStopped`

### AC13（加分）AI 文本流式逐字出现 → **PASS（做了）**

- 改动：`agent.mjs:788-825`（`streamText` + `textStream` → `agent.text` 帧）、`app/app.js:366`、`agent-store.js:611 onText`、`ai-drawer.js:915`（`.agent-stream`）
- 证据：`.dispatch/v4h-probe/v4h-e2e.txt`
  ```
  PASS AC13 agent.text 流式帧（加分项） :: {"frames":159,"firstChunk":"我先"}
  ```
  （159 个增量帧；历史上真模型第一轮实测 113-159 帧）
- 单测：`test/ai/agent.test.mjs` → `AC13：extractReasoning 从 steps 里捞 reasoningText`；`agent-store.test.mjs` → `onText / onReasoning 落到最新一轮`
- 探针：`v4h-ui.txt` → `PASS AC13：agent.text 逐字追加到流式块 :: 最大的文件是 a.txt。`；截图 `1280-stream.png`

---

## 3. 打折项（如实列）

1. **流式是「按增量追加文本」，不是 token 级 SSE 直通前端**。做法是服务端 `streamText().textStream` → `agent.text` 帧 → 前端追加。
   工具卡与审批仍走原来的 `agent.step` / `agent.approval`（卡片 §3 非目标允许）。AC13 是加分项，按卡片口径算做到。

2. **roadmap 里「会话总数 ≤100 超了删最久未更新」的裁剪只有在 `createSession` 时触发**（`sessions.prune()`）。
   如果用户只追加消息、永不新建，就不会触发修剪。理由：卡片只要求「超了删」，没要求每次写都扫目录；每次写都扫 100 个文件会把追问延迟抬高。
   实测数字：`test/ai/sessions.test.mjs` → `会话总数 ≤ 100：超了删最久未更新的，keep 里的不动`（101 个文件 → 绣到 100，keep 保留）。

3. **`trimSession` 里单条消息正文被截到 4000 字（`MESSAGE_TEXT_MAX`）**。卡片只写了「messages ≤200 条、文件 ≤512KB，超了裁剪到最近 40 条」。
   实测：如果不截单条正文，40 条 × 每条 600KB 的日志根本塞不进 512KB（先前的版本实测文件 1.84MB），所以加了单条截断，并在 `trimNote` 里说明。
   这是对卡片字面要求的一处必要补充（只放宽了「怎么裁」，没放宽上限）。

4. **审阅的 `reviewModel === ""`（全局关闭）仍然保留**。卡片 §5.3 要求「删掉任何 strict 跳过分支」，删了；
   但 PROTOCOL §1 的 `reviewModel: ""` 语义（用户明确的全局开关）不属于「档位跳过」，保留了，并且那时一律 confirm。
   设置页已经**移除了「关闭审阅」选项**（`settings-panel.js:renderReviewModels`），老配置文件里遗留的 `""` 会被当成 null 读、保存时写 null。

5. **远程徽标宽度实测 68px**（限 120px），因为测试主机的名字只有 8 个字符。上限已经用 CSS `max-width:120px` 锁住，
   但没有一条「长主机名裁到 120px」的实测——探针里没有超长主机名的数据。

6. **V4-E 遗留小修（model-select 宽度）**：改成 `max-width:66%` + `flex:0 1 auto` + `min-width:0`。
   实测 1280px 下 `ratio = 62%`、与发送按钮间隙 `8px`（1440px 下 61px），模型名 `DeepSeek V4.1 Flash (latest) · Command Code` 整行可见。
   卡片的「省略在 `(latest)` 之后」：现在整行不省略，所以不存在省略位置问题。

7. **V4-F 遗留小修（titleFor 区分 PS5/PS7）**：`tab-bar.js:16 shellShortName()`，映射
   `bash→bash`、`PowerShell 5*→PS5`、`PowerShell 7*→PS7`、`pwsh N→pwsh`、`名称 版本→名称`。
   单测 5 条（`test/ai/agent-store.test.mjs` 前 5 条）。原始映射输出见 `.dispatch/v4h-probe/titlefor.txt`。

8. **一次环境事故（与本卡代码无关）**：首次跑 e2e 时 PTY 报
   `bash: fatal error - console device allocation failure - too many consoles in use, max consoles is 128`，
   原因是本机累积了 139 个**父进程已死**的孤儿 `git.exe`/`bash.exe`（多张卡的历史探针残留）。
   清掉孤儿后 PTY 恢复，e2e 14/14、live fail=0。没有杀 3480/3470 的宿主进程。

9. **`test/ssh/registry.test.mjs` 的「建连后立刻 close」在并行全量下偶发**（卡片已列的 flaky）：最后一次连跑 6 次全量，
   2 次只挂这一条（其余 4 次 `673/673/0`），单跑 17/17 绿。未追、未改。
   本卡自己的 AC1 / AC12 偶发已经通过「同会话写盘串行 + done 在落盘后发」根治（见 AC11 的「稳定性」段）。

11. **重命名/删除不用 `window.prompt` / `window.confirm`**：本来用 prompt 最省事，但本机 CDP 实测
    `window.prompt` 在 headless / 沙箱 WebView 里**直接阻塞不返回**（`Runtime.evaluate` 30s 超时），
    在 magpie 的 iframe sandbox 里大概率同样不可用。改成行内输入框 + 行内二次确认条（都带 data-role，探针可验）。
    这一处是执行中的自查发现，卡片没点名要求，但不改的话重命名在真实环境里就是死的。

12. **截图集**：1280×760 有 12 张（sessions / ai-history / tool-card / approval-states / approval-effect / settings-effect /
    reasoning / stream / composer / overview / live-turn1 / live-turn2），1440×900 有 3 张（sessions / approval / overview）。
    比卡片要求的「五种场景 × 两个尺寸」多出真模型视角三张，但没有为每个场景都在 1440 重拍（只在 1440 拍了会话列表与确认卡）。

---

## 4. 证据清单

| 路径 | 内容 |
|---|---|
| `.dispatch/v4h-probe/v4h-ui.txt` | 真浏览器走查 45 PASS / 0 FAIL（含 23 个 data-role 齐全性、computed style 实测） |
| `.dispatch/v4h-probe/v4h-e2e.txt` | 真网关 + 真 PTY + 真 WS 端到端（AC1/AC2/AC8/AC9/AC12/AC13） |
| `.dispatch/v4h-probe/v4h-live.txt` | 真模型 + 真浏览器两轮追问（真 reasoning 609/441 字） |
| `.dispatch/v4h-probe/v4h-dbg.txt` | AC5/AC7 单独复现（reasoning DOM + effect 行） |
| `.dispatch/v4h-probe/doctor.txt` | `doctor: 33/33 assertions passed` |
| `.dispatch/v4h-probe/titlefor.txt` | `shellShortName` 映射原表（V4-F 小修） |
| `.dispatch/v4h-probe/v4h-*.mjs` | 三个探针源码（各自带 60-240s 硬超时 + `process.exit(0)`） |
| `.dispatch/v4h-shots/*.png` | 15 张截图（1280×760 ×12 / 1440×900 ×3） |

复跑方式：

```bash
D:/nodejs/install/node.exe .dispatch/v4h-probe/v4h-ui.mjs     # 浏览器走查（约 40s）
D:/nodejs/install/node.exe .dispatch/v4h-probe/v4h-e2e.mjs    # 端到端（约 3min，走真网关）
D:/nodejs/install/node.exe .dispatch/v4h-probe/v4h-live.mjs   # 真模型两轮（约 2min）
DOCTOR_PORT=3489 D:/nodejs/install/node.exe scripts/doctor.mjs
timeout 240 D:/nodejs/install/node.exe --test
```

---

## 5. 白话总结（面向不懂命令行的用户）

以前问 AI 一句它就干一趟活、干完就忘，问「那刚才那个呢？」它只能说不知道。现在它像聊天一样记事了：
上面问过什么、跑过什么命令、命令吐出了什么，它都记得，你可以接着追问，同一个终端标签的对话不会串到别的标签去。
上面多了一个会话选择器，能看到每个终端各聊过几次，还能改名、删除、开新会话；关掉服务再打开，对话还在。

每次它要动你的电脑，右下角都会有一个小盾牌：绿色=它看过没问题、黄色=有改动要注意、红色=危险、灰色=审核没跑成（这种一律问你）。
把鼠标放上去，会用大白话告诉你「运行后会发生什么」和「为什么要你点一下」。设置里可以打开「确认卡上一直显示影响」，不用悬停也能看到。

**产品状态：待验收**（不是成品、不是已验收）。
