---
id: TASK-V3-C
title: 界面重构——右侧 AI 抽屉 + 设置页 + 红点/toast + 指纹引导
status: approved
plan_version: PLAN-V3.md (Gate 2 已批，approved by 用户 m02763「B」)
approval_ref: 用户 m02763 回复「B」；需求原话 m02580 / m02629 / m02632
priority: P0
executor: pi (sub-agent)
model_tier: provider=magpie, model=commandcode/deepseek/deepseek-v4.1-flash
attempt: 1
retry_budget: 2
session_policy: new_session_required (session-id magpie-terminal-v3c)
inputs:
  - docs/PROTOCOL-AGENT.md   # WS 帧协议（唯一权威）+ §7 前端状态模型
  - docs/PLAN-V3.md
  - C:/Users/41807/magpie-terminal （仓库根）
---

# 1. 背景与现状

用户三条原话（逐字）：
1. 「AI栏应该要靠右，默认收起，收起中间有个突起，如果有消息需要用户手动确认就显示一个小红点，右下角也要弹出通知让用户点击确认按钮」
2. 「现在设置页面打不看，点击设置按钮没反应」
3. 「我面向的用户不一定看的懂命令行终端的内容，我需要ai会话是一个真正的类似hermes的agent」

病因（已读代码确认，不是猜测）：

| 现象 | 真实位置 |
|---|---|
| 设置页点了没反应 | `app/ui/rail.js:59-64` 的 settings 监听体是空的，注释写「本卡只渲染，点击无副作用」 |
| AI 栏在底部 | `app/styles/layout.css:67` 起 `[data-role="aibar"]` 是 44px 底栏；`app/index.html:24` `#root` 上 `data-ai-open="true"` 默认展开 |
| 没有红点/toast | `app/app.js:397` `arriveAiResult()` 只给 rail 图标点圆点（`store.setAiUnread`），不区分「有回答」与「待确认」；全项目无 toast |
| 测试连接首连必失败 | `app/ui/hosts-panel.js:376-382` 测试分支只 `setStatus("失败："+userText)`；只有 `connectHost()` → `checkFingerprint()`（`hosts-panel.js:462`）才会弹信任卡 |

# 2. 目标

把 AI 从「底部命令行助手」改成「右侧抽屉里的 agent 会话」：默认收起、把手上显示待确认角标、右下角弹不自动消失的 toast、设置页可打开且能配档位/白名单/审阅模型/基础提示词。

**内核是 TASK-V3-D 的工作**（多步执行 + 分级链 + 第二 AI 审阅）。本卡只做前端 + 一个指纹引导，它按 `docs/PROTOCOL-AGENT.md` 的帧契约对接，不自己发明帧。

# 3. 非目标

- **禁止修改 `src/`、`test/`、`package.json`、`package-lock.json`**（那是 TASK-V3-D 的范围，同时开工）。
- 不做流式渲染（逐字流式吐字）；步骤帧到了就整条更新，够了。
- 不改 SSH 建连、PEY、文件树的任何逻辑（除 `hosts-panel.js` 测试连接那一处）。
- 不做多任务并行 UI（内核一个连接只跑一个任务）。
- 不做主题切换、国际化、快捷键自定义。

# 4. 涉及范围

修改：
- `app/index.html` — 网格加第三列（抽屉），删掉底部 `.aibar`，加 toast 容器与设置模态宿主
- `app/styles/layout.css` — 三列网格 + 抽屉/把手尺寸 + 收起态
- `app/styles/components.css` — 抽屉、时间线、步骤、审批卡、toast、设置模态
- `app/styles/tokens.css` — 只加需要的变量（尽量复用现有）
- `app/app.js` — 删除底部 AI 条接线，改为抽屉 + 设置 + toast 接线
- `app/ui/rail.js` — settings 真正打开设置页；rail-ai 改为开合抽屉
- `app/ui/hosts-panel.js` — 测试连接遇 `UNKNOWN_HOST_KEY` 弹信任卡

新增：
- `app/ui/ai-drawer.js` — 抽屉整体（标题栏/模型下拉/时间线/输入条/停止）
- `app/ui/agent-timeline.js` — 步骤时间线渲染（可选拆出，合并也行）
- `app/ui/approval-card.js` — 审批卡（可选拆出）
- `app/ui/toast.js` — toast 栈
- `app/ui/settings-panel.js` — 设置模态
- `app/core/agent-store.js` — 按 `PROTOCOL-AGENT.md` §7 的状态模型

删除：
- `app/ui/ai-bar.js`（底部条整块不用了，模型下拉搬进抽屉标题栏）
- `app/ui/ai-panel.js` 里的旧浮层确认卡代码（旧的 `ai.ask` 单命令路径仍要走，确认卡留在抽屉里实现即可 —— 见 §6.7）

# 5. 现有做法（改之前必须知道）

- `app/index.html` 的 `#root` 是 grid：`grid-template-columns: var(--term-rail-width) minmax(0,1fr)`，`rail` 在第 1 列第 1 行，`main` 第 2 列第 1 行，`statusbar` 跨两列第 2 行，`#ai-layer` 与 main 同格绝对覆盖。
- `app/app.js` 里 AI 相关函数：`openAiLayer()` `hideAiLayer()` `applyAiOpen(open)` `arriveAiResult()` `toggleAi()`；`handleFrame(frame)` 是 WS 帧总入口（`app/app.js:260` 附近），已处理 `ai.reply` / `ai.error` / `ai.result` 等。
- `app/core/ws-client.js` 暴露 `send(frame)`；`app/core/store.js` 有 `getSnapshot/subscribe/setAiUnread/setAiOpen`。
- `app/core/api.js` 已有 `getConfig()` / `putConfig(patch)` / `models()` / `policy()`；本卡要 PUT 的新字段 `autonomy/allowlist/reviewModel/basePrompt`，服务端会在 D 卡里支持，**前端只管原样发**，不要因为 400 就自己改写。
- `app/ui/terminal-view.js:111` 用 `ResizeObserver` 自动 `scheduleFit`，所以抽屉开合会让终端自动重排。
- `app/ui/hosts-panel.js` 已有 `buildTrustCard({host, algo, fingerprint, mismatch, knownFingerprint, knownAlgo})`（约 420 行）与 `trustModal`，信任按钮发 `api.trustHost(id, fingerprint)` 后调 `onCreateSession(host)`。测试连接分支在 347-391 行。
- `app/styles/tokens.css` 定义 `--term-rail-width` 等；颜色一律走变量，**不许写死色值**。

# 6. 需求细节

## 6.1 骨架（`index.html` + `layout.css`）

```html
<div id="root" data-role="app" data-ai-open="false">
  <nav class="rail" data-role="rail">…（不变）…</nav>
  <section class="main" data-role="main">
    <div data-role="tabbar"></div>
    <div data-role="terminal-host"></div>
    <div data-role="model-note" hidden></div>
    <!-- 收起态的把手：绝对定位在 main 的右边缘，垂直居中 -->
    <button type="button" data-role="ai-handle" data-badge="0" title="打开 AI 助手">
      <span class="handle-icon" aria-hidden="true">✦</span>
      <span class="handle-badge" data-role="ai-handle-badge" hidden>0</span>
    </button>
  </section>
  <aside class="drawer" data-role="ai-drawer" aria-label="AI 助手">…</aside>
  <div data-role="statusbar"></div>
  <div data-role="toast-stack"></div>
  <div data-role="settings-host"></div>
</div>
```

网格：

```css
[data-role="app"] {
  display: grid;
  grid-template-columns: var(--term-rail-width) minmax(0, 1fr) var(--term-drawer-width);
  grid-template-rows: minmax(0, 1fr) auto;
}
[data-role="app"][data-ai-open="false"] { --term-drawer-width: 0px; }
[data-role="app"][data-ai-open="true"]  { --term-drawer-width: 360px; }
[data-role="ai-drawer"] { grid-column: 3; grid-row: 1; overflow: hidden; }
[data-role="app"][data-ai-open="false"] [data-role="ai-drawer"] { display: none; }
[data-role="ai-handle"] { position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  width: 20px; height: 96px; }  /* 露在终端右边缘的突起，点击区域 48px 宽可直接用 padding 补 */
```

要求：
- 把手**必须**是终端右边缘的「突起」，视觉上是半圆/竖条贴在边缘，不要在抽屉展开时也显示（`data-ai-open="true"` 时 `display:none`）。
- 抽屉展开时终端列变窄，但**任何视口都不许出现横向滚动条**。
- 底部原来的 `.aibar` 整块删掉。

## 6.2 抽屉内容（`app/ui/ai-drawer.js`）

结构（data-role 是验收探针，必须逐字）：

| data-role | 元素 | 说明 |
|---|---|---|
| `ai-drawer-head` | div | 标题栏 |
| `model-select` | select | 模型下拉（从 `/api/models` 拉，沿用 ai-bar.js 的失败记忆与 `__retry__` 逻辑） |
| `ai-close` | button | 收起抽屉 |
| `agent-timeline` | div | 对话时间线容器 |
| `agent-question` | div | 用户提问气泡 |
| `agent-step` | div | 一个步骤；属性 `data-status` ∈ `pending/running/awaiting/done/failed/denied/skipped`，属性 `data-index` 从 1 |
| `agent-step-cmd` | code | 该步命令（等宽字体，超出省略） |
| `agent-step-out` | pre | 该步输出（可折叠，默认折叠，点击展开） |
| `agent-summary` | div | 最终总结（`agent.done.text`） |
| `agent-approval` | div | 审批卡容器 |
| `approval-run` | button | 只执行这一条 → 发 `agent.approve{approved:true,scope:"once"}` |
| `approval-rest` | button | 剩下的自动执行 → `scope:"rest"` |
| `approval-skip` | button | 跳过 → `approved:false` |
| `agent-input` | input | 输入框，placeholder「用中文说要干什么，AI 会自己动手…」 |
| `agent-send` | button | 发送 → 发 `agent.run` |
| `agent-stop` | button | 停止，仅 `status==="running"` 时可见 → `agent.stop` |

行为：
- 发问：`wsClient.send({ type:"agent.run", requestId, question, model, context:{cwd,shell,recentOutput,sessionId} })`（字段逐字按 `PROTOCOL-AGENT.md` §3.1）
- 每个 `agent.step` 帧按 `stepId` upsert 同一条 `[data-role="agent-step"]`（**不要每次都 append 新行**）
- `agent.approval` → 在时间线尾部插入审批卡；同时抬头角标 + toast（见 §6.3）
- `agent.done` → 显示总结，停止按钮隐藏，待确认清空
- `agent.error` → 时间线尾部显示红色错误行 + 中文 userText
- 旧的 `ai.reply` / `ai.error` 帧仍要能渲染（降级路径）：`ai.reply` 当成一个只有一条命令的简化展示，`decision==="confirm"` 时也用同一张审批卡（发 `ai.confirm`？——**不要**：旧路径的确认仍是本地直接 `pty.input`，保持原行为，只把确认卡搬进抽屉）

## 6.3 红点与 toast（`app/ui/toast.js`）

- 有 `pendingApprovals.length > 0` 时：
  - `[data-role="ai-handle-badge"]` 显示条数，`data-badge` 属性同步
  - 右下角插一条 `[data-role="toast"]`，文案「需要确认：`<command>`」，文案节点 `data-role="toast-text"`，按钮 `data-role="toast-action"` 文案「去确认」
  - **toast 不自动消失**；点「去确认」→ 打开抽屉 + 滚到审批卡 + 该条 toast 移除
  - 点 toast 上的关闭 `data-role="toast-close"` 也能关
- toast 栈 `[data-role="toast-stack"]` 固定右下角，`z-index` 高于状态栏，不遮住终端输入区（宽度 ≤ 360px）

## 6.4 设置页（`app/ui/settings-panel.js`）

`rail-settings` 点击 → `[data-role="settings-modal"]` 出现（模态，Esc 与点遮罩关闭）。五块：

| 块 | data-role | 控件 |
|---|---|---|
| 自动执行档位 | `autonomy-group` / `autonomy-option` (`data-value="strict\|balanced\|loose"`) | 三个单选卡，默认 `balanced`；每张卡下有一行中文说明（严格=只有只读命令自动跑；平衡=只读 + AI 判安全的；宽松=连可撤销的写操作也自动跑） |
| 命令白名单 | `allowlist-input`（input）/ `allowlist-mode`（select: prefix=前缀匹配, exact=完全相同）/ `allowlist-add`（button）/ `allowlist-list` / `allowlist-item`（带 `data-enabled="true\|false"`）/ `allowlist-toggle`（button）/ `allowlist-remove`（button） | 添加后立刻本地渲染，保存时一起 PUT |
| 审阅模型 | `review-model-select` | 选项：`__off__`「关闭审阅（不推荐）」/ `__same__`「与对话模型相同」/ 逐个模型 id；保存时 `__off__`→`""`，`__same__`→`null` |
| 基础提示词 | `base-prompt` | textarea，placeholder 显示内置默认；空 → `null` |
| AI 网关 | `gateway-info` | 只读文本：baseUrl、可达性、模型数（来自 `/api/models`） |

底部：`settings-save`（保存）、`settings-cancel`（关闭）、`settings-status`（成功/失败提示）。

保存逻辑：
- 拉 `/api/config` 初始化控件
- 点保存 → `api.putConfig({ autonomy, allowlist, reviewModel, basePrompt })`
- 成功 → `settings-status` 显示「已保存」+ 3 秒后淡出（可以自动消失）；关掉模态
- 失败 → 显示服务端 `userText`（D 卡会返回 `INVALID_AUTONOMY` 等 code），**保留用户输入不清空**

## 6.5 指纹引导（`app/ui/hosts-panel.js`）

在测试连接分支里，`probe.data.code === "UNKNOWN_HOST_KEY"`（或 `probe.code === "UNKNOWN_HOST_KEY"`）时：

1. 不显示「失败：…」
2. 改调 `api.hostFingerprint(host.id)` 拿 `{algo, fingerprint}`
3. 复用 `buildTrustCard({host, algo, fingerprint, mismatch:false, onTrusted: ...})` 弹卡
4. 用户点「信任并记住」→ 信任成功后再自动重跑一次 `api.testHost(host.id)`，把结果写进 `setStatus`
5. 用户取消 → 什么都不做（主机已经存住了，只是没信任指纹）

`buildTrustCard` 现在内部写死了 `onCreateSession(host)` 回调；要加一个可选 `onTrusted` 参数，有就用它，没有才走 `onCreateSession`。

## 6.6 状态栏

状态栏保留。原来显示 `模型：xxx` 的地方改为显示当前任务状态（`空闲` / `执行中` / `待确认 N`），模型名移到抽屉标题栏。

## 6.7 服务端未就绪时的降级

本卡与 D 卡同时在改仓库，D 可能还没把 `/api/config` 的四字段和 `agent.*` 帧做完。要求：

- 发 `agent.run` 后如果收到 `pty.error{code:"BAD_FRAME"}` 或 5 秒内无任何 `agent.*` 帧 → 时间线显示「AI 内核还没就绪（TASK-V3-D 未合入）」，**不要假装成功**
- 设置页保存若返回 `UNKNOWN_FIELD` / 400 → 照实显示服务端 userText，不要静默吞掉

# 7. 执行步骤

1. 读 `docs/PROTOCOL-AGENT.md`（§3 帧格式、§7 状态模型）与本文档。
2. 改 `index.html` + `layout.css`：三列网格、把手、删底部条、加 toast/设置宿主。
3. 写 `app/core/agent-store.js`（§7 状态模型 + subscribe）。
4. 写 `app/ui/ai-drawer.js`（标题栏/模型下拉/时间线/输入条/停止/审批卡）。
5. 写 `app/ui/toast.js`。
6. 写 `app/ui/settings-panel.js`。
7. 改 `app/ui/rail.js`：settings 打开设置页；rail-ai 开合抽屉。
8. 改 `app/app.js`：删 createAiBar 接线，加抽屉/设置/toast 接线；`handleFrame` 加 `agent.start/step/approval/done/error` 分支。
9. 改 `app/ui/hosts-panel.js` 指纹引导（§6.5）。
10. 写 `components.css` 样式（复用 tokens 变量，不写死色值）。
11. 自测见 §10。测试脚本放 `.dispatch/v3c-*.mjs`（不进 git）。
12. 写 `REPORT-V3C.md`。

# 8. 示例与模板

## 8.1 步骤渲染示例

```html
<div data-role="agent-step" data-index="2" data-status="awaiting">
  <div class="step-head"><span class="step-idx">2</span><span class="step-state">等待确认</span></div>
  <code data-role="agent-step-cmd">mkdir -p logs/2026</code>
  <div class="step-why">需要先建好日志目录，不然下一步写文件会失败。</div>
  <div data-role="agent-approval">
    <div class="risk risk-caution">风险：可撤销的写操作</div>
    <div class="review-why">审阅：会新建目录，不影响已有文件。</div>
    <button data-role="approval-run">执行这一条</button>
    <button data-role="approval-rest">剩下的都自动执行</button>
    <button data-role="approval-skip">跳过</button>
  </div>
</div>
```

## 8.2 反例（必须避免）

- ❌ 把手做成固定浮在窗口右边中部的独立条，和终端之间留缝 → 用户要的是「收起中间有个突起」，贴边。
- ❌ toast 3 秒自动消失 → 用户明确要求「让用户点击确认」，必须等他动手。
- ❌ 每次 `agent.step` 都 append 一行 → 同一步会显示成十几行。
- ❌ 设置页把 PUT 失败当成功（只 console.error）→ 用户改了白名单以为生效了。
- ❌ 写死 `#ff0000` 之类色值 → 主题换肤会坏；一律 `var(--…)`。
- ❌ 改 `src/` 下任何文件。

# 9. 执行约束

- 只按本卡与 `PROTOCOL-AGENT.md` 执行。协议里没写的交互自己定，但 data-role 命名必须是本卡表格里的那些（验收跑探针）。
- **禁止修改 `src/`、`test/`、`package.json`、`package-lock.json`、`TASK-V3-C.md`、`docs/`、`.trellis/`、`TASK.md`**。
- 不加新前端依赖（不引框架、不引 UI 库）。所有 UI 手写原生 DOM。
- 复用现有：`api.js`、`ws-client.js`、`store.js`、`terminal-view.js`、`hosts-panel.js` 的 `buildTrustCard`、`tokens.css` 变量。
- 服务端口一律用 **3490**（3480 是宿主 magpie 占着的，3481 是 doctor 用的）。启动方式：`PORT=3490 MAGPIE_TERMINAL_CONFIG_PATH=$TMPDIR/v3c-config.json node src/index.mjs`（自己确认入口文件名，`package.json` 里有）。
- 自测可以用 CDP（`.dispatch/cdp.mjs` 有现成的 `withPage(url, fn)`），但**探针脚本必须自己退出**：末尾 `process.exit(0)`，且 spawn 的子进程要在 finally 里 `taskkill /PID x /T /F`（上一轮就因为探针不退导致 pi 挂死 20 分钟）。
- 交付前以用户视角自查：一个不懂命令行的人打开抽屉、问一句话、看到确认卡、点「执行这一条」、看到总结——这条路径要顺。
- 产物标「待验收」，不许标「成品」。

# 10. 验收标准

| 编号 | 必过/加分 | 场景 | 预期结果 | 验证方法 | 证据位置 |
|---|---|---|---|---|---|
| CC1 | 必过 | 设置页打开 | 点 `[data-role="rail-settings"]` → `[data-role="settings-modal"]` 可见；Esc 关闭 | CDP 探针 | REPORT-V3C.md §CC1 + 截图 |
| CC2 | 必过 | 设置五块齐全 | 档位三选项（默认 balanced 选中）、白名单输入+模式+添加、审阅模型下拉含「关闭审阅」、基础提示词 textarea、网关信息 | CDP 探针断言元素存在与选中态 | REPORT-V3C.md §CC2 |
| CC3 | 必过 | 设置保存与回读 | 改 4 个字段 → 保存 → `GET /api/config` 回读一致 → 重开设置页控件值仍对 | 探针 + 服务端日志 | REPORT-V3C.md §CC3 |
| CC4 | 必过 | 抽屉默认收起 + 把手 | 初始 `#root[data-ai-open="false"]`；`[data-role="ai-handle"]` 可见且贴右边缘、垂直居中（±8px） | 几何断言 | REPORT-V3C.md §CC4 + 截图 |
| CC5 | 必过 | 抽屉展开不溢出 | 点把手 → 抽屉宽 360px、终端列变窄、`documentElement.scrollWidth <= clientWidth`、终端 cols 减少 | 几何 + xterm cols 断言 | REPORT-V3C.md §CC5 + 截图 |
| CC6 | 必过 | 角标与 toast | 注入一个 `agent.approval` 帧 → 角标显示 `1`、`[data-role="toast"]` 出现；等 6 秒仍存在（不自动消失） | 探针等待 6s 再断言 | REPORT-V3C.md §CC6 + 截图 |
| CC7 | 必过 | toast 去确认 | 点 `[data-role="toast-action"]` → 抽屉展开、审批卡在视口内、该 toast 移除 | 探针 | REPORT-V3C.md §CC7 |
| CC8 | 必过 | 审批三按钮发对帧 | 点 run/rest/skip 各发一次对应 `agent.approve`（用假 ws 或真连抓帧） | 抓帧断言 | REPORT-V3C.md §CC8 |
| CC9 | 必过 | 步骤 upsert | 同一 stepId 推 3 次不同 status → 时间线只有 1 个该步的 `[data-role="agent-step"]`，status 是最新值 | 探针 | REPORT-V3C.md §CC9 |
| CC10 | 必过 | 指纹引导 | 删 known_hosts 里某条 → 点「测试连接」→ 弹 `[data-role="host-trust-card"]`，不再只显示「失败：…」 | 探针 + 截图 | REPORT-V3C.md §CC10 |
| CC11 | 必过 | 不回归 | 终端能建标签、能输入、远程主机面板能开、文件树能列 | 探针（复用 `.dispatch/e5.mjs` 的做法） | REPORT-V3C.md §CC11 |
| CC12 | 必过 | 范围干净 | 你自己新增/修改的文件全部在 `app/` 下（含 `app/index.html`）；`git status --porcelain` 里 `src/`、`test/`、`package.json`、`package-lock.json` 的改动**不是你造成的**（TASK-V3-D 同时在做），报告里逐条列出你自己碰过的文件完整路径 | 报告里贴 `git status --porcelain` 原文 + 你的文件清单 | REPORT-V3C.md §CC12 |
| CC13 | 加分 | 抽屉空态 | 没提问过时显示一句引导文案（「说你想要什么结果，我来动手」） | 目视/探针 | 截图 |

# 11. 核验要求

**执行者自测（你）：** CC1–CC12 全部执行（CC13 可做），原始输出与截图落盘到 `.dispatch/v3c-shots/`。

**独立核验者会重点挑：**

| 编号 | 对应 | 挑什么 | 预期 |
|---|---|---|---|
| VC1 | CC1/CC2 | 设置页真能开、五块真在 | 是 |
| VC2 | CC3 | 改字段后**真落盘**（读 config.json），不是只改内存 | 文件里能看到 |
| VC3 | CC4/CC5 | 把手位置与「不溢出」用真实几何断言，不看截图判断 | pass |
| VC4 | CC6 | toast 等 6 秒还在 | 是 |
| VC5 | CC8 | 三个按钮发的帧字段名逐字对 | 是 |
| VC6 | CC9 | 同 stepId 不重复 append | 是 |
| VC7 | CC10 | 指纹卡真弹出 | 是 |
| VC8 | CC11 | 终端/主机/文件树没坏 | 是 |
| VC9 | CC12 | 你自己的改动全在 `app/` 下，`src/`/`test/`/`package.json` 的改动归属 D 卡 | 是 |

# 12. 交付物

- 上述源码改动
- `.dispatch/v3c-shots/` 下截图（至少：收起态、展开态、设置页、toast、审批卡、指纹卡）
- `REPORT-V3C.md`：逐条 CC 结果 + 几何断言数字 + 截图路径 + 白话总结
- 按 §11 JSON 返回

# 13. 风险与回退

| 风险 | 影响 | 回退 |
|---|---|---|
| D 卡未合入，`agent.*` 帧发出去被 BAD_FRAME 拒 | 抽屉里看不到步骤 | 按 §6.7 显示「内核未就绪」，不假装成功 |
| 3490 端口被占 | 起不来 | 换 3492 并在报告里写明实际端口 |
| 改 `index.html` 后 `#ai-layer` 相关的旧 CSS 残留导致布局错 | 终端被遮 | 彻底删掉 `.aibar` / `#ai-layer` 的规则，不要留半套 |
| xterm fit 在抽屉展开后需要时间 | cols 断言过早失败 | 断言前等 300ms 或轮询到 cols 变化 |

# 14. 澄清记录

- 用户 m02580（逐字）：AI 栏靠右、默认收起、收起中间有突起、待确认显示小红点、右下角弹通知可点击确认。
- 用户 m02629：档位放设置页可切换、默认平衡；多步执行选 A（边跑边确认）；白名单前缀+整条都支持、默认前缀。
- 用户 m02632：面向不懂命令行的人；设置页要能设基础提示词。

# 15. 执行报告要求

按 §11 JSON 返回，另加：
- 每个 CC 的实测数字（宽度/位置/条数/cols）
- 截图路径清单
- 哪些项是打折的（例如没真连内核只注入了假帧），如实写
