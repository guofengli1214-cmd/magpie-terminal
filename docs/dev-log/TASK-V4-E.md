---
id: TASK-V4-E
title: 布局与 AI 抽屉重做（V4-E）
status: approved
plan_version: docs/mockups-v4（v4b 定稿）+ docs/mockups-v4/CHANGES-V4.md + 用户 m03646 / m03751 / m03760 三条硬改
approval_ref: 用户 m03646 第 1/2/3/4/5/7/8/9/11 条；m03696 选 A；m03751+m03760 三条硬改
priority: P0
executor: pi
model_tier: 人类指定 commandcode/deepseek/deepseek-v4.1-flash（provider magpie）
attempt: 1
retry_budget: 2
escalation_policy: ask_human
session_policy: new_session_required
session_id: null
inputs:
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/layout.html（布局总稿，权威视觉）
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/ai-chat.html（抽屉/输入区/会话区）
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/hosts-files.html（主机面板与文件区，本卡只借主机面板与分界）
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/assets/v4.css（颜色与度量来源）
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/CHANGES-V4.md（§1 三条硬改、§2 D1-D6、§4 十五条实现硬约束）
quality_benchmark: 以 docs/mockups-v4/shots/ 里 1440×900 与 1280×760 的 v4b 截图为对照基准；可比理由=同一信息架构、同一配色 token、同一窗口尺寸；借鉴其几何与视觉层次，不照搬其演示用假数据。
verification: 主 agent 独立 CDP 探针 + node --test + doctor + 真机截图对照
verifier: independent_new_session
depends_on: []
---

# 1. 背景与现状（大白话）

插件已经能跑：本地终端、远程 SSH、文件树、AI 任务 agent 都在。但用户列了 13 条问题，其中 9 条是布局与交互，必须按已经定稿的设计稿重做。设计稿在 `docs/mockups-v4/`（三份 HTML + 一份 60KB 的 v4.css + 19 张截图），已经过两轮迭代和用户三条硬改，是**唯一视觉权威**。

# 2. 目标

把这 9 条真正修好，且**不改坏**已有的终端 / 远程 / agent 功能：

1. 打开插件时终端里出现两三行重复提示符。
2. 整体布局差（要按设计稿重排）。
3. 去掉左边栏的 AI 按钮和下边状态栏的 AI 开关按钮。
4. 保留右边缘把手；点把手开、再点收起；去掉抽屉顶上那个「收起」按钮。
5. 模型选择放到发送框左侧，发送按钮改成向上箭头。
7. 开合 AI 抽屉会让终端多一行空回车。
8. 抽屉已经展开时不再弹右下角通知。
9. 按设计稿把全局布局做到位。
11. 左侧主机面板点面板外部就收起。

（第 6、10、12、13 条不在本卡：6 属于 TASK-V4-H，10 属于 TASK-V4-G，12/13 属于 TASK-V4-F。不要顺手做。）

# 3. 非目标（做了算越界）

- 不改 `src/` 下任何文件（本卡纯前端）。若你确信某条只能在服务端修，停下返回 `needs_clarification`，不要自己动。
- 不改 `docs/mockups-v4/` 下任何文件（那是规范，不是产物）。
- 不改 `package.json`，不新增任何依赖，不引入前端框架。
- 不做会话列表/多轮对话/流式输出/确认卡审阅角标（那都是 V4-H）。
- 不做文件面板、不做本机 shell 选择、不做「+」新建标签下拉（V4-F/G）。
- 不改 `app/vendor/xterm/*`（第三方库）。
- 不允许把 `assets/v4.css` 直接 link 进应用页面：必须把需要的规则**移植**进 `app/styles/{tokens,layout,components}.css`。

# 4. 涉及范围

`app/index.html`、`app/app.js`、`app/ui/rail.js`、`app/ui/ai-drawer.js`、`app/ui/status-bar.js`、`app/ui/toast.js`、`app/ui/hosts-panel.js`、`app/ui/terminal-view.js`、`app/ui/tab-bar.js`、`app/styles/layout.css`、`app/styles/components.css`、`app/styles/tokens.css`。测试目录如需补测试可改，但不许删已有断言。

# 5. 现状与病根（已实测，别重复排查）

1. **重复提示符有三个来源，必须全断**：
   - `app/app.js:140` 的 `session.created` 分支里调 `attachActive()`，服务端 `src/server/ws.mjs` 的 `attachSession()` 回 `session.resumed` 带 `recentOutput`；`app/app.js:209` 的 `terminalView.replay(id, frame.recentOutput)` 把已经实时流过的内容又写一遍。
   - `app/app.js:92` 的 `createTab()` 发 `{"type":"pty.create"}` **不带 cols/rows**，服务端按 80×24 建，随后前端 `sendResize` 到真实尺寸，bash 收到 SIGWINCH 重画一遍。
   - 抽屉挤压终端：`app/styles/layout.css` 的网格用 `--term-drawer-width`，展开时终端变窄 → `app/ui/terminal-view.js:111` 的 `ResizeObserver` → `scheduleFit` → `pty.resize` → bash 重画。
2. **抽屉现在是挤压式**（grid 列宽变化），必须改成**覆盖式**（absolute，压在终端之上，不改终端宽度）。
3. `app/index.html` 里 `data-ai-open="true"`（默认展开），要改成 `false`（默认收起）。
4. `app/ui/rail.js` 有一段 `rail-ai` 的渲染与点击；`app/index.html` 有 `rail-ai` 按钮与 `rail-unread` 圆点；`app/ui/status-bar.js:134-139` 每次 render 都会造一个 `status-ai-toggle` 按钮 → 这三处都要删。
5. `app/ui/ai-drawer.js:89` 是 `ai-close`「收起」按钮 → 删。
6. `app/ui/ai-drawer.js:82` 的 `model-select` 现在是有边框的 `<select>` → 改成设计稿那种纯文本按钮（`data-role` 名字不变）。
7. `app/ui/ai-drawer.js:109` 的 `agent-send` 文本是「发送」→ 改向上箭头 `↑`。
8. `app/ui/toast.js:85` 的 `render(snapshot)` 只看 `pendingApprovals`，不看 `snapshot.aiOpen` → 抽屉开着也会弹 toast。
9. `app/ui/hosts-panel.js` 的主机面板目前只能靠按钮或 Esc 关，点面板外没反应。

# 6. 执行步骤（照做，不要自己发挥架构）

## 第 0 步：先读规范（不许跳过）

按顺序读：
1. `docs/mockups-v4/CHANGES-V4.md` 的 §1、§2、§4（§4 是十五条硬约束，逐条记下来，最后要自查）。
2. `docs/mockups-v4/layout.html` + `docs/mockups-v4/ai-chat.html`，在浏览器里打开看实际效果（`python -m http.server` 或直接 file:// 都行，自己看就行）。
3. `docs/mockups-v4/assets/v4.css`，重点找 `.drawer`、`.handle`、`.composer*`、`.rail`、`.tab`、`.sess-group`、`.approval*` 的规则。
4. 现有 `app/index.html`、`app/styles/*.css`、`app/ui/ai-drawer.js`。

## 第 1 步：骨架（index.html）

- 删 `rail-ai` 按钮与其 `rail-unread` 圆点。
- 保留 `data-role="ai-handle"`，把 `ai-handle-badge` 移到把手**内部**（绝对定位 `top:4px; right:3px`），把手贴 `main` 右边缘、垂直居中，尺寸按设计稿（约 22×78，圆角只在左侧）。
- `#root` 的 `data-ai-open` 默认 `"false"`。
- 抽屉 `data-role="ai-drawer"` 保留，改为覆盖式容器；里面按设计稿重建三段：会话区（本卡先保留现有时间线容器）、输入区（新的 composer）、底部（无）。
- 删抽屉头部的「收起」按钮（渲染代码在 ai-drawer.js）。

## 第 2 步：布局（layout.css）

- `[data-role="app"]` 网格回到 **rail(48px) + main(1fr)** 两列（抽屉不再占列）。
- `[data-role="ai-drawer"]` 改 `position:absolute; top:0; right:0; bottom:0; width:384px;`，默认 `transform: translateX(100%)` 隐藏；`#root[data-ai-open="true"] [data-role="ai-drawer"]` 时 `translateX(0)`。层级：抽屉 < 把手。
- 抽屉的左边界只由 `.drawer` 的 `border-left` 画 1px（`--v4-line-2` 对应 token）；**禁止**再用 `box-shadow: inset` 或额外 `::before` 画边。
- 把手永远可见（抽屉开着也在抽屉左缘同位置），点击切换开合。
- 终端区、标签条、状态栏按设计稿的间距与高度重排（标签条 34px、状态栏 33px 这一档，以设计稿实测为准）。
- 全站删除「用线条标记选中」的样式：`.rail-btn[aria-pressed="true"]::before`、`.tab[aria-selected="true"]::before`、`.sess-group[data-current="true"]` 的 inset 竖线一律删掉，选中态只用底色 + 文字色 + 图标色。

## 第 3 步：输入区（ai-drawer.js + components.css）

- `composer` 结构：外层 `.composer-box`（1px 边框、圆角、`padding-bottom:19px`）；内部 `<textarea data-role="agent-input">`；右下角绝对定位的提示 `Enter 发送 · Shift+Enter 换行`（`right:9px; bottom:4px; pointer-events:none;`，不占行高）；左下角模型名按钮 `data-role="model-select"`（纯文本 + 9px 下箭头，无边框无底色）；右下角发送 `data-role="agent-send"` 文本改为 `↑`（`aria-label="发送"`）；上方 4px 高的拖拽把手 `data-role="agent-grow"`。
- 模型菜单锚定在输入区右下（`bottom:40px; right:8px`），点外部关闭，键盘 Esc 关闭。
- 输入框自动增高 1→6 行（1 行 19.375px，6 行 116px），超过 6 行内部滚动；用户拖 `agent-grow` 可把高度拉到**宿主高度的 40%**（不小于 116px），高度写 `localStorage` key **`magpie.term.composerHeight`**，下次打开回填；用户重新输入即回到自动增高。
- `agent-stop` 保留，样式按设计稿。

## 第 4 步：开合行为（app.js）

- 删掉 `rail-ai` 相关接线（`toggleAi` 的 button 绑定），改由 `ai-handle` 的 click 调 `toggleAi()`。
- `applyAiOpen(open)` 只改 `#root[data-ai-open]` 与 `aria-expanded`，**删掉**里面的 `terminalView.resizeAll()` 调用（宽度不变，不需要 fit；fit 会触发 SIGWINCH 重画）。
- 抽屉打开时 `toast` 不渲染（见第 5 步）。
- 保留 `data-role="ai-handle-badge"` 的待确认角标逻辑（条数、`data-badge`）。

## 第 5 步：toast（toast.js）

- `render(snapshot)` 开头：若 `snapshot.aiOpen === true`，把栈清空并 return（**不要**销毁待确认数据，只是不渲染）。
- 抽屉从开→关时重新渲染一次（现有 subscribe 会驱动，确认它真的会重跑）。

## 第 6 步：重复提示符（三处一起断）

- `createTab()`：先从 `terminalView` 拿到当前 cols/rows（没有就按容器尺寸算），`wsClient.send({type:"pty.create", cols, rows})`；让服务端一次就按正确尺寸建。
- 新建会话不再 replay：给刚发的 `pty.create` 记一个 `pendingCreate` 标记（数组或计数），收到 `session.created` 时若命中标记 → **不调** `attachActive()`、不 replay，直接建标签并 `attach`；只有用户切换标签/重连/远程恢复这些「恢复已有会话」的路径才 replay。
- 服务端若在 `session.created` 里已经推过 `pty.output`，确保不会重复 attach 两次（`attachActive` 只在需要时调）。
- 自测必须验证：新开标签后 xterm 缓冲区里提示符只出现一次；连续开关抽屉 3 次仍然是 1 次。

## 第 7 步：主机面板点外部关闭（hosts-panel.js）

- 面板打开时在 `document` 上挂 `mousedown`（捕获阶段），若 `event.target` 不在面板内、也不是打开它的按钮 → 关闭。
- 不要影响设置模态、AI 抽屉、文件面板的点击。

## 第 8 步：自查与自测

1. `D:/nodejs/install/node.exe --test`（在仓库根、**不带任何路径参数**）→ 必须 0 fail。
2. `DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs` → 33/33。
3. 自己起服务（`DOCTOR_PORT=3495` 之类，别占 3480）用 Chrome headless + CDP 做几何与交互探针，逐条跑第 9 节的 AC，原始输出落盘到 `.dispatch/v4e-probe/*.txt`。
4. 截图：1280×760 与 1440×900 各一组（收起/展开/输入框拉高/主机面板），存 `.dispatch/v4e-shots/`，用 PIL 确认非空白并记 unique colors。
5. 逐条对照 `CHANGES-V4.md §4` 的十五条硬约束自查，在 REPORT 里打勾。

# 7. 必须保持不变的契约（改了就红）

- 以下 `data-role` 名字**逐字不许改**：`app`、`rail`、`rail-term`、`rail-hosts`、`rail-settings`、`main`、`tabbar`、`terminal-host`、`ai-handle`、`ai-handle-badge`、`ai-drawer`、`agent-timeline`、`agent-input`、`agent-send`、`agent-stop`、`model-select`、`agent-step`、`agent-step-cmd`、`agent-step-out`、`agent-approval`、`approval-run`、`approval-rest`、`approval-skip`、`toast-stack`、`toast`、`settings-*`、`host-*`、`file-*`。
- 允许**新增** `data-role`：`agent-grow`、`composer-box`、`composer-hint`、`model-menu`。
- `agent-send` 的文本可以变成 `↑`，但 `data-role` 与 `aria-label="发送"` 必须保留。
- 不许删 `data-role="rail-hosts"`（V4-F 要用）。

# 8. 执行约束

- 独立新会话，只按本卡执行；不直接问人类；不做卡外决策；遇到卡壳返回 `needs_clarification`。
- 不许留后台进程：所有 CDP 探针在 `finally` 里 `process.exit(0)`，并自带 `setTimeout(() => process.exit(9), 60000)` 硬超时；Chrome 用 `spawn` 起的必须 `kill`。
- 不许改 `.gitignore` 之外的状态；不许 commit。
- 未定稿标「草稿」，送审产物标「待验收」，不得标「成品」或「已验收」。
- 交付前以使用者视角自查：打开插件→看提示符→开关抽屉→打字→切标签→点主机→开设置→关设置，全程无报错、无多余空行。

# 9. 验收标准（主 agent 用 CDP 独立复跑）

| 编号 | 必过 | 标准 | 判定方法 |
|---|---|---|---|
| AC1 | 必过 | 新开一个终端标签后，xterm 缓冲区里命令行提示符只出现 1 次（不是 2 次或 3 次） | CDP 读 `term.buffer.active`，统计含 `$` 的提示符行数=1 |
| AC2 | 必过 | 连开连关抽屉 3 次后，提示符仍为 1 次，且终端总行数不增长超过 1 行 | 同上，前后对比 |
| AC3 | 必过 | 抽屉打开前后 `[data-role="terminal-host"]` 的 `clientWidth` 不变（±1px），xterm `cols` 不变 | `getBoundingClientRect()` + `term.cols` |
| AC4 | 必过 | `rail-ai`、`rail-unread`、`status-ai-toggle`、`ai-close` 在 DOM 中都不存在 | `document.querySelector(...) === null` 四项全 null |
| AC5 | 必过 | 把手贴 main 右缘垂直居中，宽 20–26px、高 70–90px；抽屉开着时把手仍可见；点一次开、再点一次关 | 几何 + 两次 click 后 `#root[data-ai-open]` 翻转 |
| AC6 | 必过 | 模型名按钮无边框（computed `border-*-width` 全为 0px）且背景透明；点击弹出菜单；选另一模型后 `GET /api/config` 的 `model` 变了 | computed style + 点击 + 接口回读 |
| AC7 | 必过 | 发送按钮文本是 `↑`；Enter 提示是 `.composer-box` 内部元素（`pointer-events:none`），不占额外行高（box 高度 = textarea 高度 + 19px padding ±2） | `contains()` + computed + 高度差 |
| AC8 | 必过 | 输入 6 行文本后 textarea 高度 ≈116px；拖 `agent-grow` 可到宿主 40%（±6px）；重开抽屉后高度回填一致 | 实测 + `localStorage['magpie.term.composerHeight']` |
| AC9 | 必过 | 抽屉展开时收到 `agent.approval`：`toast-stack` 子节点 0 个，但 `ai-handle-badge` 显示条数；抽屉关闭后 toast 出现 | 用假帧或真 agent 触发 |
| AC10 | 必过 | 主机面板打开后，点终端区域 → 面板消失；点面板内部 → 不消失 | 两次 click + DOM 检查 |
| AC11 | 必过 | 全站无「竖线选中」：`app/styles/*.css` 中 `inset 2px` 与 `inset 0 1px` 均为 0 次；rail/tab 选中态无 `::before` 描边 | `grep` + 视觉 |
| AC12 | 必过 | `node --test` 0 fail；`doctor` 33/33 | 原样命令 |
| AC13 | 必过 | 无回归：本地终端能输入并回显、能开第二个标签、能连已存主机（h-75a46c 临时 sshd 可能已关，连不上不算回归，但「点主机条目有反应」必须成立） | 直连 3480 实测 |
| AC14 | 加分 | 1280×760 与 1440×900 下文档无溢出（`scrollWidth<=clientWidth`）、关键元素无重叠 | 几何探针 |

# 10. 核验要求（你自己先跑，主 agent 会独立复跑）

V01–V13 对应 AC1–AC13，逐条给原始证据路径（命令 + stdout）。V09 用构造的 `agent.approval` 帧即可，不必真跑模型。V13 里若临时 sshd 已关，如实写「环境不可用」并给替代证据。

# 11. 交付物

- `REPORT-V4E.md`：做了什么、每条 AC 的实际结果与证据路径、CHANGES-V4 §4 十五条自查表、未做/打折项。
- `.dispatch/v4e-probe/*.txt`：探针原始输出。
- `.dispatch/v4e-shots/*.png`：截图（1280×760、1440×900 各一套）。
- `.dispatch/pi-v4e` 的 stdout/stderr 由派发方保存，你不用管。
- 返回 JSON 按约定字段（status/summary/artifacts/verification_results…），正文不贴大段日志。

# 12. 风险与回退

- 覆盖式抽屉可能遮挡终端右侧内容 → 用设计稿的宽度 384px，并保证终端仍能滚到最右（xterm 自适应列数）。
- 删 `resizeAll` 后若抽屉内确有元素依赖 fit，改为只在窗口 resize 时 fit。
- 改动集中在 `app/`，出问题可整体 `git checkout -- app/` 回退（主 agent 负责，不要自己 reset）。

# 13. 澄清记录

- 无（用户已明确 13 条，且设计稿定稿）。

# 14. 示例

- 正确：`<button data-role="agent-send" class="agent-send" aria-label="发送">↑</button>`
- 错误：`<button data-role="send-btn">发送</button>`（改了 data-role，探针会挂）
- 正确：抽屉 `transform: translateX(100%)` + `pointer-events:none`（关时）
- 错误：抽屉改 grid 列宽（会挤压终端 → 提示符重画）
