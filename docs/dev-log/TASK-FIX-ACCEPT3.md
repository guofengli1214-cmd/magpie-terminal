# TASK-FIX-ACCEPT3：把手宽度、标签/状态栏高度、模型选择挪进输入框

四项一起改，都是「验收剩余项」。所有改动必须用真浏览器量数据，不许只贴截图。

## 现状事实（已核对，直接照此定位）
- 仓库 `C:/Users/41807/magpie-terminal`，HEAD `fefbc2f`，工作区已有未提交改动（`app/core/api.js`、`app/styles/{components,layout,tokens}.css`、`app/ui/{ai-drawer,file-panel,hosts-panel}.js`、`test/server/fs-route.test.mjs`、新增 `test/app/api-delete.test.mjs`）——**这些是已验收的成果，不要回滚、不要重写**，只做本卡四项。
- Node：`D:/nodejs/install/node.exe`（v24.16.0）。测试：`D:/nodejs/install/node.exe --test`（当前基线 **679/679**）。
- 变量：`app/styles/tokens.css:82-83` `--term-handle-width:22px` / `--term-handle-height:78px`；`:85` `--term-tabbar-height:34px`；`:86` `--term-statusbar-height:33px`；`:97` `--term-handle-hit:48px`。
- 把手：`app/styles/layout.css:153-205`，`[data-role="ai-handle"]` 宽 `var(--term-handle-width)`，其 `::before` 用 `left: calc(var(--term-handle-width) - var(--term-handle-hit) - 1px)` 造 48px 命中区（展开态另有规则 `:198-201`），这就是「隐形热区盖住终端最右 26–30px 文字、从该带起拖选不中字」的原因（`VERIFY-ACCEPT.md` V04 FAIL）。
- 状态栏：`app/styles/layout.css:23` 网格行高 `var(--term-statusbar-height)`；`:115` 高度同变量；toast 已用 `bottom: calc(var(--term-statusbar-height) + var(--term-gap))`（`:261`），改高度会自动跟随。
- 输入区：`app/ui/ai-drawer.js:198-247` —— `composer-box`（内含 `composer-grip`、`agent-input`、`composer-hint`（文字「Enter 发送 · Shift+Enter 换行」））+ 下方 `.composer-bar`（内含 `model-select` 纯文本按钮、`agent-stop`、`agent-send`「↑」、`model-menu`）。CSS：`app/styles/components.css:821-970`（`.composer` / `.composer-box` / `[data-role="agent-input"]` / `.composer-hint` / `.composer-grip` / `.composer-bar` / `[data-role="model-select"]` / `[data-role="model-menu"]`）。
- `app/ui/ai-drawer.js:620-635` 打开模型菜单时按 `composer-box` 顶边算 `maxHeight`（clamp 80–240）。改结构后这段必须仍成立。
- `test/` 里没有任何测试引用 `composer-bar` / `model-select` / `statusbar` / `tabbar` / `rail-`（已 grep 确认）。

## 任务

### 1. 把手：视觉 24px、命中也是 24px，取消隐形扩展
- `--term-handle-width` 22 → **24px**；`--term-handle-hit` 48 → **24px**。
- 删掉 `::before` 的两条扩展规则（收起态 `layout.css:187-196` 与展开态 `:198-201`；若 `::before` 只用于命中区，整块删除；若还承担其它视觉，保留视觉部分但去掉超出元素本体的 `left/right` 负向扩展）。
- 要求：`elementFromPoint` 在「把手矩形左边缘再往左 2px、垂直中点」必须命中终端画布（不是 `ai-handle`）；把手自身矩形宽 **24px**（含 1px 边框），高 78px。
- 圆角、配色、边框、`handle-icon`（‹）、`handle-text`（AI）、`handle-badge` 位置与样式不变，视觉上只宽 2px。

### 2. 标签栏 34 → 40px
- `--term-tabbar-height: 40px`。**不改**标签条内部字号/图标尺寸/最小宽度，允许纵向 padding 自适应居中。
- 要求：标签条高度实测 40；标签项文字不截断、不溢出（`scrollHeight <= clientHeight`）；关闭按钮仍可点（28×28 热区不变）。

### 3. 状态栏 33 → 26px
- `--term-statusbar-height: 26px`。
- 状态栏内的按钮/控件（重连、语言、版本等）若当前是 28×28，改成 **24×24** 并保持垂直居中，不得溢出 26px 行高。
- 要求：状态栏高度实测 26；所有子元素 `rect.top >= 状态栏.top` 且 `rect.bottom <= 状态栏.bottom + 0.5`（图标不得被裁）；toast 与状态栏相交面积仍为 **0**，toast 底边距状态栏顶边 ≥6px。

### 4. 模型选择挪到输入框左侧 + Enter 提示挪进框内
目标形态（用户的原始要求）：输入区一行里，**左边是模型名（纯文本、无边框、点击开菜单）**，中间输入框，**右下角是向上箭头的发送按钮**；「Enter 发送 · Shift+Enter 换行」显示在**输入框内部**（不与正文重叠）。

- DOM：`model-select` 与 `model-menu` 从 `.composer-bar` 移入 `.composer-box` 内部；`agent-send` / `agent-stop` 也放进 `composer-box` 右侧（`.composer-bar` 若空了就删掉，连同其 CSS）。
- 布局建议（可实现你自己的等价方案）：`.composer-box` 用 CSS Grid，例如
  `grid-template-columns: auto minmax(0,1fr) auto; grid-template-areas: "model input send" "hint hint send";`
  让 `input` 自动增高时格子跟着长，`send` 垂直居中或贴底（自行取好看的一种，但必须落在框内）。
- 硬性要求（逐条用探针量）：
  - `model-select` 矩形完整落在 `composer-box` 内，且 `model.right <= input.left`（在输入框左侧）。
  - `model-select` `border-width: 0`、常态 `background-color` 透明；文字不被截断（`scrollWidth <= clientWidth + 1`），若模型名太长则尾部省略但 `title` 为全名。
  - `agent-send` 34×34（现规格），矩形完整落在 `composer-box` 内；`agent-stop` 隐藏时不影响布局。
  - `composer-hint` 矩形完整落在 `composer-box` 内，且与 `agent-input` 矩形**不相交**（面积 0），与 `agent-send` 不相交。
  - 点 `model-select` 后 `model-menu` 可见，底边 ≤ `composer-box` 顶边（相交面积 0），完整可见（`menu.top >= drawer.top`），6 项列表可滚动。
  - 输入框自动增高：输入 3 行文本后 `agent-input` 高度 > 单行高度，`model-select` / `send` 不重叠；拖 `composer-grip` 向上 40px 高度增大、向下 40px 变小（G 项行为不得回归），`localStorage['magpie.term.composerHeight']` 仍写入。
  - 宽 384px 抽屉（1440 与 1280 两档视口都要）下，框内三块（模型名 / 正文 / 发送）不重叠、不溢出；模型名最多占框宽 40%，超出省略。
- 保留 `data-role` 名字不变：`composer-box`、`composer-hint`、`model-select`、`model-menu`、`agent-send`、`agent-stop`、`agent-input`、`agent-grow`。事件绑定随 DOM 移动即可。
- 模型切换功能不得回退：切到另一个模型后 `PUT /api/config` 生效、下一次 `agent.start` 请求体里是新模型（可用现有测试或探针证明）。

## 不做
- 不动 `src/`、`file-panel.js`、`hosts-panel.js`、`test/app/`、`test/server/`（除本卡新增探针）。
- 不做虚拟列表、不换 rail 图标（下一张卡）。
- 不改明色主题 token 结构。
- 不提交 git（`git add` / `git commit` / `git stash` 一律禁止），我负责提交。

## 自测与交付（必须真跑，原始结果落盘）
1. `.dispatch/fix-accept3/probe.mjs`：用仓库 `.dispatch/cdp.mjs` 的 `withPage/evaluate/screenshot`，真 headless Chrome，`prefers-color-scheme: dark`，**1440×900 与 1280×760 两档**，起真服务（`import { startServer } from "./src/server/http.mjs"`，端口 3702；token 用 `server.token`）。
   - 量并打印：把手 `{rect, hitBBox, xtermHitAtRight-25}`；终端选区测试（从把手左侧 2px 处起拖，`window.getSelection()` 或 xterm selection rects 数量 ≥1）；标签栏高度、标签项 `scrollHeight/clientHeight`；状态栏高度与每个子元素 rect；toast 与状态栏相交面积；`model-select` / `agent-input` / `agent-send` / `composer-hint` / `composer-box` 的 rect 与相交面积；菜单 rect 与相交面积；拖拽前后高度与 localStorage 值。
   - 原始 JSON → `.dispatch/fix-accept3/measure.json`；截图（收起 + 展开 + 菜单打开 + 三行输入）→ `.dispatch/fix-accept3/shots/`。
2. 回归：`D:/nodejs/install/node.exe --test` 必须 **679/679 pass、0 fail**，日志 → `.dispatch/fix-accept3/node-test.txt`；`DOCTOR_PORT=3704 D:/nodejs/install/node.exe scripts/doctor.mjs` 必须 **33/33**，日志 → `.dispatch/fix-accept3/doctor.txt`。
3. `REPORT-FIX-ACCEPT3.md`（仓库根）：每项 before（现测）→ after（改后）数字表、探针路径、截图路径、回归结果、未做项、遗留风险。标「待验收」，不得自称成品。

## 边界
- 不做卡外决策；有歧义返回 needs_clarification。
- 任何一项做不到就如实写失败，不要用截图糊过去。
