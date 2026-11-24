# ACCEPT-LAYOUT：magpie-terminal 页面布局验收

- 任务：`TASK-ACCEPT-L1.md`
- 日期：2026-11-24
- 证据目录：`.dispatch/accept-l1/`
- 原始数值：`.dispatch/accept-l1/measure.json`（28 个状态样本）
- 截图：`.dispatch/accept-l1/shots/`（28 张）

## 1. 结论

**有明显问题（可用，但不建议按当前状态直接交付）。**

两档视口下 `document.documentElement.scrollWidth - clientWidth = 0`，12 个状态都真实到达，28/28 截图通过像素方差检查；但 AI 唯一入口把手实测只有 **22×78px**（宽度小于 28px）、主机/文件/会话的编辑删除全部 **hover-only**、确认卡与选中档位文字对比度只有 **2.39–2.94:1**、toast 实测压住状态栏 **17px**，已经把“可发现性 / 可读性 / 可用性”问题从观感层面拉到了 P1。

## 2. 环境与方法

- 服务：`startServer`，端口 **3682**；未触碰 3480 / 3477 / 3488 / 3496。
- 浏览器：headless Chrome，`Emulation.setDeviceMetricsOverride`，`deviceScaleFactor: 1`，模拟 `prefers-color-scheme: dark`（与 `docs/mockups-v4` 暗色基准一致）。
- 视口：`1440×900`、`1280×760`；每个状态先 `sleep(300)` + 两次 `requestAnimationFrame`。
- 状态数据：
  - S3 用服务端 `handle.aiSessions` 写入 3 条会话，再通过 `agent.done` 触发前端 `GET /api/ai/sessions` 重拉；**没有直接注入 DOM**。
  - S4 真跑 `agent.run`，问题为「列出当前目录前三个大文件」；两档视口最终状态都是 `done`。
  - S5 通过 `window.__termDebugFrame` 注入 `agent.start` + 4 条 `agent.approval` 帧（safe/caution/danger/null），**没有伪造 DOM**。卡里“并排”按“四态同屏”执行；产品时间线本身是纵向排列，没有为截图强改布局。
  - S6 用真实右键事件展开远程主机的「编辑 / 删除」工具子项；当前实现没有可展开的树形子项，按保守解释用这一层作为“子项”。
  - S8 用真实远程主机 `h-8cd47b`（`192.168.10.24:22`）连接，文件面板切到 `/tmp`，成功。
  - S11 / S12 的待确认通过注入 `agent.approval` 帧构造。
  - S7 的“默认”按“默认本地目录”解释；实现中 `readStoredOpen()` 无存储时返回 `false`，所以本次是点 `rail-files` 后截图。若产品要求首屏默认显示文件面板，需要另判（见 §6）。
- 截图非空白检查：读取 PNG IHDR/IDAT，反滤波后抽样像素。28 张全部 `nonBlank=true`；最小方差 **92.27**，最小唯一色数 **57**，最小非背景像素比例 **0.0169**（S1 大面积终端空白，属正常）。
- 局限：S4 的真实 AI 输出两档不完全相同（1440 生成 2 个工具卡，1280 生成 1 个），因此 S4 的内容高度不是纯布局差异；涉及布局的比较只取容器/工具卡自身的 rect。

## 3. 状态覆盖与关键测量

| 状态 | 截图（1440 / 1280） | 关键测量 | 问题 |
|---|---|---|---|
| S1 首屏，AI 收起 | `shots/1440x900-S1.png` / `shots/1280x760-S1.png` | 文档横向溢出 0；`main` 内部 `scrollWidth-clientWidth=385`（`overflow-x:hidden`，无用户可见滚动）；把手 22×78；<28px 点击目标 3 个；对比度失败 0 | AI 入口只有 22px 宽（L1-02）；状态栏技术信息占 33px |
| S2 AI 展开，会话空态 | `shots/1440x900-S2.png` / `shots/1280x760-S2.png` | 会话菜单 350×103；文档溢出 0；<28px 目标 6；空态文案「还没有会话。发送第一条消息时创建。」完整可见 | 空列表和加载中无视觉区分；菜单盖住 AI 空态提示（浮层预期） |
| S3 3 条会话，当前高亮 | `shots/1440x900-S3.png` / `shots/1280x760-S3.png` | 菜单 350×227；3 条；当前项 item/title/badge 左边缘分别 1079/1106/1274.6，列内偏差 0px；<28px 目标 12 | 会话标题 11px、meta 9px 偏小；改名/删除 hover-only（L1-03） |
| S4 真实对话：思考 + 工具卡 + 结论 | `shots/1440x900-S4.png` / `shots/1280x760-S4.png` | `status=done`；工具卡 2 / 1 个；summary 1 个；timeline 高 689 / 549；文档溢出 0；<28px 目标 9 / 8 | 工具命令 `white-space:nowrap + ellipsis`（L1-10）；1280 下结论需要滚动（正常） |
| S4b 同一轮滚到底部（补充） | `shots/1440x900-S4b.png` / `shots/1280x760-S4b.png` | summary 高度 340.4（1280）；无横向溢出 | 无新增布局问题；用于证明结论存在 |
| S5 确认卡四态 | `shots/1440x900-S5.png` / `shots/1280x760-S5.png` | 4 张卡，单卡高 132.1；四态 `ok/caution/danger/none` 齐全；对比度失败 4（2.94）；<28px 目标 23；四卡在两档均完整可见 | 跳过按钮 2.94:1（正文阈值 4.5）；why 2.94:1（次要阈值 3）；角标 20×20（L1-01/L1-13） |
| S6 主机面板 | `shots/1440x900-S6.png` / `shots/1280x760-S6.png` | 面板宽 212，高 833/693；host-item 2 个；远程地址截断 `+37px`，隐藏 7 字（端口与「密码」）；地址对比度 2.39:1；<28px 目标 10 | 编辑/删除 hover-only；地址无 title；面板内容稀疏（L1-03/L1-09） |
| S7 文件面板（本地） | `shots/1440x900-S7.png` / `shots/1280x760-S7.png` | 文件面板 1392/1232×225；141 个 entry；文档溢出 0；对比度失败 0；<28px 目标 10 | 文件操作 hover/选中才显示；工具栏/网格/状态左内边距 6/9/10px 不一致（L1-03/L1-16） |
| S8 文件面板（远程 `/tmp`） | `shots/1440x900-S8.png` / `shots/1280x760-S8.png` | 远程连接成功；路径 `/tmp`；9931 个 entry；42,677 个 button 节点；长文件名最多隐藏 26 字，但 entry 有完整 `title`；文档溢出 0 | 大目录无分页/虚拟化，9931 个 entry 全量渲染（L1-15） |
| S9 设置页 | `shots/1440x900-S9.png` / `shots/1280x760-S9.png` | 设置模态 620×852 / 620×712；选中档位说明对比度 2.39:1；<28px 目标 12 | 选中「平衡」卡的说明文字过暗（L1-01）；模态底部覆盖状态栏 9px（固定浮层预期） |
| S10 模型下拉 + 放大输入框 | `shots/1440x900-S10.png` / `shots/1280x760-S10.png` | 输入框 342×111；模型菜单 291×233.5；composer-box 364×132；菜单与输入框重叠 **38,162px²**；<28px 目标 6 | 菜单压住放大后的输入框（L1-06）；模型按钮高 22px |
| S11 收起态待确认 | `shots/1440x900-S11.png` / `shots/1280x760-S11.png` | toast 340×56；把手角标 16×16；toast 与状态栏重叠 **5,780px²（340×17）**；<28px 目标 6 | toast 压住状态栏/重连入口（L1-04）；关闭按钮 19.6×19.6 |
| S12 窄屏压力：多条会话 + 长标题 + 确认卡 | `shots/1440x900-S12.png` / `shots/1280x760-S12.png` | 9 条会话；菜单 350×430；长标题最多隐藏 26 字；菜单与确认卡重叠 46,249px²；<28px 目标 29；对比度失败 2（2.94） | 长标题无 title；菜单打开时确认卡被遮住（S12b 补充） |
| S12b 关闭会话下拉（补充） | `shots/1440x900-S12b.png` / `shots/1280x760-S12b.png` | 9 条会话；确认卡完整可见；<28px 目标 11 | 用于证明确认卡本身未坏；问题在浮层遮挡 |

> 说明：`main` 的 `+385px` 是 xterm 内部内容宽度（`overflow-x:hidden`），两档视口固定出现；文档根节点没有横向溢出，用户也不会看到横向滚动条。原始条目在 `measure.json` 的 `overflows` 中，未计入 UI 缺陷。

## 4. 测量结果与批判维度

### 4.1 横向溢出 / 重叠 / 对齐

- **横向溢出**：两档 × 12 状态，`documentElement.scrollWidth > clientWidth` 全部为 **0**。没有页面级横向滚动。
- **内部溢出**：`main` 固定 `+385px`（xterm 内容，`overflow-x:hidden`）；其他真实溢出主要是会话长标题（`+156…+225px`）、远程主机地址（`+37px`）、远程 `/tmp` 长文件名（`+130…+147px`）。这些均有 `overflow:hidden`，没有撑破页面。
- **重叠**：
  - 设计允许：drawer 覆盖 terminal、hosts 面板覆盖 terminal、settings 覆盖全屏、session/model 菜单浮在抽屉上。
  - 非预期：S10 `composerBox × modelMenu = 38,162px²`，菜单把 132px 高的输入框盖住；S11 `toastStack × statusbar = 5,780px²`（17px 高），toast 压住状态栏。
  - S12 `sessionsMenu × approval1 = 46,249px²`：菜单打开时确认卡被遮，属于浮层交互设计问题（用户可先关菜单，但同屏看不到待确认）。
- **对齐**：
  - S3 / S12 会话项的 item / title / badge 左边缘在每个列内完全一致（S12 两档均为 item 1079/919、title 1106/946、badge 1274.6/1114.6，列内偏差 0px）。
  - S5 四张确认卡的 head / cmd / actions 左边缘一致：1440 为 1075/1075/1075，1280 为 915/915/915，偏差 0px。
  - S4 工具卡 head / cmd / why / out 左边缘一致（0px）。
  - **不一致**：抽屉头部左 padding 10px、上下文条 12px、时间线 10px，导致三行左边缘相差 2px；文件面板工具栏左 padding 6px、网格 9px、状态行 10px，左边缘相差 3–4px（L1-16）。

### 4.2 间距

实测值来自 `measure.json.spacing`：

- 抽屉头：`padding 0 8px 0 10px`，`gap 4px`。
- 上下文条：`padding 0 12px`，`gap 6px`。
- 时间线：`padding 10px`，`gap 10px`。
- 一轮对话：`gap 8px`。
- 确认卡：`padding 8px`，`gap 6px`；按钮组 `gap 6px`，右侧 `30px` 给角标。
- 输入区：`padding 9px 10px 8px`；底栏 `gap 8px`。
- 文件面板：工具栏 `padding 0 8px 0 6px / gap 5px`；网格 `padding 6px 14px 8px 9px / gap 2px 4px`；状态行左右 `10px`。
- 设置：body `padding 12px / gap 14px`；block `gap 6px`；档位卡 `padding 8px / gap 3px`。

结论：同一层里 **4 / 5 / 6 / 8 / 10 / 12 / 14px** 混用，其中抽屉三行 10/12/10 和文件面板三行 6/9/10 是可量化的左边缘不一致；不是“感觉不齐”。

### 4.3 对比度（WCAG 2.1）

完整失败项见 `measure.json` 的 `contrast.failing` 与 `summary.txt`。核心三处：

| 位置 | 文本 | 实测前景/背景 | 比值 | 阈值 |
|---|---|---|---|---|
| 确认卡「跳过」按钮 | 跳过 | `rgb(128,128,128)` / `rgb(62,56,46)` | **2.94** | 4.5 |
| 确认卡 why 说明 | 例如「长标题 + 多条会话…」 | `rgb(128,128,128)` / `rgb(62,56,46)` | **2.94** | 3.0 |
| 主机列表地址（hover） | `devuser@192.168.10.24:22 · 密码` | `rgb(128,128,128)` / `rgb(55,71,95)` | **2.39** | 3.0 |
| 设置选中档位说明 | 「审阅判定安全且可撤销…」 | `rgb(128,128,128)` / `rgb(55,71,95)` | **2.39** | 3.0 |

根因不是单个组件，而是暗色主题没有覆盖 `--term-muted`：`app/styles/tokens.css:17` 仍是 `var(--magpie-muted)`（实测 `#808080`），暗色块只覆盖了 `--term-dim`（`tokens.css:117`）。`#808080` 在 `#14171c` 上是 4.55:1，看似刚过；但落到确认卡的 warn-soft 背景 `#3e382e` 就掉到 2.94，落到 hover/选中背景 `#37475f` 掉到 2.39。设计稿用的是 `--v4-muted #9aa4b0`，在上述两个背景分别是 4.59 / 3.73。

### 4.4 点击目标

`measure.json.clickTargets` 中共有 27 种唯一尺寸/选择器组合。重点：

| 元素 | 实测尺寸 | 出现状态 |
|---|---|---|
| `[data-role="ai-handle"]` | **22×78** | 所有状态（唯一 AI 入口） |
| `[data-role="approval-review"]` | 20×20 | S5 / S12 |
| `[data-role="tab-close"]` | 17.6×14 | 所有有标签状态 |
| `[data-role="toast-close"]` | 19.6×19.6 | S11 |
| `[data-role="file-panel-up"]` / `[data-role="file-panel-close"]` | 22×22 | S7 / S8 |
| `[data-role="agent-session-rename"]` / `[data-role="agent-session-delete"]` | 31×17.5 | S3 / S12 |
| `[data-role="host-edit"]` / `[data-role="host-delete"]` | 27.5×35 | S6 |
| `[data-role="hosts-close"]` | 26.2×22 | S6 |
| `[data-role="settings-x"]` | 27×22 | S9 |
| `[data-role="setting-show-effect"]` | 34×18 | S9 |
| `[data-role="agent-new"]` | 26×26 | S2 / S3 / S4 / S5 / S10 / S12 |
| `[data-role="approval-run/rest/skip"]` | 高 25.3 | S5 / S12 |
| `[data-role="file-panel-refresh"]` / `newdir` / `newfile` / `upload` | 高 24–26 | S7 / S8 |
| `[data-role="agent-input"]` | 342×19.4（单行） | S2–S5 |
| `[data-role="model-select"]` | 238×22 | S2–S5 / S10 / S12 |
| `[data-role="status-retry"]` | 68×23.3 | 所有状态 |
| `[data-role="settings-save"]` | 60×27.5 | S9 |

S5 每档 23 个、S12 每档 29 个小于 28×28 的可点目标；完整清单见 `.dispatch/accept-l1/summary.txt` 的 `## unique click targets <28`。

### 4.5 文字截断

| 元素 | 完整文本 | 可见前缀 | 被截掉 | 证据 |
|---|---|---|---|---|
| 会话标题 | 把 app/styles/components.css 里所有圆角值统一成 6/8/10 三档并输出差异清单 | 把 app/styles/components.css | 26 字 | S12：`scrollWidth-clientWidth=225` |
| 会话标题 | 把文件面板从本地目录切到远程主机 /tmp 再切回来并确认目录跟随没有丢 | 把文件面板从本地目录切到远程 | 22 字 | S12：`+198` |
| 会话标题 | 给确认卡四态补上键盘可达性并检查 20×20 角标是否满足点击目标要求 | 给确认卡四态补上键盘可达性并 | 21 字 | S12：`+183` |
| 主机地址 | `devuser@192.168.10.24:22 · 密码` | `devuser@192.168.10.24:` | 7 字（隐藏 `22 · 密码`） | S6：`+37` |
| 远程文件名 | `ai-novel-branch-switcher-e2e-restart-…` | `ai-novel-branch-s` | 最多 26 字 | S8：`+147`，但 entry 有完整 `title` |
| 工具命令 | 任意长命令 | 一行尾部省略 | 无法估计 | CSS `nowrap + ellipsis`（L1-10） |

会话标题和主机地址都没有 `title` 属性；远程文件名有，所以后者不算缺陷。

### 4.6 响应式差异

- `1440 → 1280`：`main` / `terminal` 宽度减少 160px；`statusbar` 上移 140px；`drawer` 仍是 385px 宽，高度减少 140px。抽屉不参与挤压，终端列宽只随视口自然缩小。
- 会话菜单在两档都是 350px 宽；S2 高度 103，S3 227，S12 430，没有塌陷/换行。
- 文件面板高度两档都是 225px（声明 224，边框多 1px）；宽度从 1392 降到 1232，仍是 2 行网格。
- 设置模态高度从 852 降到 712（`max-height: calc(100vh - 48px)`），body 滚动；没有横向溢出。
- S10 输入框放大后 timeline 高度从 597 降到 457；模型菜单仍 291×233.5，因此相对输入框的遮挡更明显。
- 1280 下没有出现水平滚动条，也没有关键元素消失；主要变化是纵向空间收紧和长标题截断更多。

### 4.7 信息层次 / 可发现性 / 状态完备 / 微观细节

**信息层次**：S3/S12 抽屉头的主标题是终端名 `bash: 41807`（11.5px / 600 / `#f0f6fc`），当前会话标题在副行，只有 9.5px / `#8f99a4`。用户第一眼看到的应是“当前在聊什么”，实际被终端标签抢走。建议把当前会话标题提到 12px / `--term-fg-2`，终端名降到 10.5px / `--term-dim`（L1-14）。

**可发现性**：
- AI 唯一入口把手 22px 宽，9px 竖排 “AI”，无常态文字标签。
- 文件条目的更多操作 `display:none`，只有 `:hover` 或 `[data-selected]` 才显示（`components.css:2298-2311`）。
- 主机编辑/删除只有 `:hover`、`:focus-within` 或右键才显示（`components.css:1629-1638`）。
- 会话改名/删除只有 `:hover` / `:focus-within` 才显示（`components.css:2869-2879`）。
  触控设备没有 hover；新用户也不会把鼠标悬停在每一行上找操作。

**状态完备**：
- 已有：AI 空态、运行中、待确认、错误块；文件面板空目录/错误/加载文案；主机表单错误、指纹核对；发送按钮在待确认时 `disabled`。
- 缺/弱：会话列表没有“加载中”标记，空列表和请求未返回看起来一样；模型加载只有 `aria-busy`，没有可见 loading；远程大目录没有分页/虚拟化（S8 9931 条）。
- 未触发：AI 错误态（本次网关正常），只能确认代码路径存在，不能算实测通过。

**微观细节**：
- 1px 漂移：drawer-head 声明 48、实测 49；ai-ctx 声明 30、实测 31；file-panel 声明 224、实测 225；file-panel-toolbar 声明 34、实测 35。原因是这些元素没有 `box-sizing:border-box`，边框加到高度外（L1-11）。
- 图标语言混用：rail 用 `▣ / 🖧 / 🗀 / ⚙` 文本/emoji（`app/index.html:26-39`，16px），mockup 用 18px 单色 SVG `currentColor`（`v4.css:174`）。截图里主机/文件图标出现彩色 emoji，与单色 UI 不一致（L1-12）。
- 确认卡边框/底色比设计稿重：实现 `border:1px solid var(--term-warn)` + `background:var(--term-warn-soft)`（`components.css:523-533`，暗色 warn-soft 为 `rgba(255,204,128,0.18)`）；mockup 为 `rgba(227,179,65,0.38)` + `rgba(227,179,65,0.07)`（`v4.css:874-880`）。这既偏离设计，也是 2.94 对比度的直接原因之一。
- 当前分组底色：实现 `--term-accent-soft` 为 `rgba(120,160,220,0.18)`（`components.css:2705`），mockup 当前组只有 `rgba(120,160,220,0.05)`（`v4.css:1788`）；S3 整组明显偏蓝。

## 5. 缺陷清单

| 编号 | 严重级别 | 位置 | 现象（带数值） | 具体改法建议 |
|---|---|---|---|---|
| L1-01 | **P1** | `app/styles/tokens.css:17,117`；`components.css:578-583,625-628,1256-1258,1621-1624` | 暗色下 `--term-muted` 仍是 `#808080`；确认卡「跳过」/why 2.94:1，主机地址 2.39:1，设置选中档位说明 2.39:1 | 在 dark 块补 `--term-muted: #9aa4b0;`（实测 #9aa4b0 在 `#3e382e` 为 4.59、在 `#37475f` 为 3.73）；确认卡背景改用 mockup 的 `rgba(227,179,65,0.07)` 可进一步把 skip 拉到 4.59 以上 |
| L1-02 | **P1** | `app/styles/tokens.css:79,94`；`app/styles/layout.css:153-165` | AI 唯一入口把手实测 **22×78px**；`--term-handle-hit:48px` 已声明但未使用 | 保留 22px 视觉宽，给 `[data-role="ai-handle"]` 增加 48px 透明命中区（`min-width:48px; padding:0 13px; box-sizing:border-box;` 或 `::before { inset:0 -13px; }`），确保命中宽 ≥28px |
| L1-03 | **P1** | `components.css:1629-1638`（host tools）、`2298-2311`（file more）、`2869-2879`（session actions） | 主机编辑/删除、文件更多操作、会话改名/删除默认 `display:none` 或 `opacity:0`，只有 hover/focus/右键才出现；触控与新手不可发现 | 每行常显一个 24×24 的 `⋯` 菜单按钮（或把 `sess-actions` 的 opacity 默认改为 1）；至少在 `@media (hover:none)` 下全部常显 |
| L1-04 | **P1** | `app/styles/layout.css:237-249` | toast 栈 `bottom: calc(var(--term-gap)*2)=16px`；实测 340×56 的 toast 与 33px 状态栏重叠 **5,780px² / 17px**，盖住「立即重连」区域 | 改为 `bottom: calc(var(--term-statusbar-height) + var(--term-gap));`（当前即 `33px + 8px = 41px`），并回归 S11 两档 |
| L1-05 | P2 | `components.css:523-534`；对照 `v4.css:874-880` | 确认卡边框用满亮 `--term-warn`，背景 `rgba(255,204,128,0.18)` 合成 `#3e382e`；mockup 是 `rgba(227,179,65,0.38)` 边框 + `rgba(227,179,65,0.07)` 背景 | 增加 `--term-warn-bg: rgba(227,179,65,0.07)`；`.agent-approval { border-color: rgba(227,179,65,0.38); background: var(--term-warn-bg); }`；卡内 padding 从 8px 调到 10px，按钮组右侧留白从 30px 调到 40px，贴近设计稿 |
| L1-06 | P2 | `components.css:947-964` | 模型菜单 `bottom:40px`，实测 291×233.5；放大后输入框 364×132，重叠 **38,162px²**，输入文字被菜单遮住 | 把菜单锚到 composer-box 上方：`bottom: calc(100% - 10px)`（抽屉宽/高度变化时仍跟 composer 顶边），或 JS 按 `composerBox.getBoundingClientRect()` 动态设置 `bottom`；保留 `max-height` 防溢出 |
| L1-07 | P2 | `app/styles/tokens.css:82-83`；对照 `v4.css:193-199,1127-1134` | tabbar 实测高 **34px**，mockup **40px**；statusbar 实测高 **33px**，mockup **26px** | 若以 v4 稿为准，设 `--term-tabbar-height:40px; --term-statusbar-height:26px;`；若产品刻意改了，写入设计偏差说明并同步设计稿 |
| L1-08 | P2 | `app/ui/ai-drawer.js:458`；`components.css:2850-2861` | 5 条 80 字会话标题被截，最多隐藏 **26 字**；标题 `<b>` 没有 `title`，无法查看全文 | 在 `el("b", {}, item.title…)` 增加 `title: item.title`，或改成两行 `-webkit-line-clamp:2`；重命名输入框已能显示全文，但 hover 无提示 |
| L1-09 | P2 | `app/ui/hosts-panel.js:721`；`components.css:1621-1624` | `devuser@192.168.10.24:22 · 密码` 可见前缀只到 `devuser@192.168.10.24:`，隐藏 **7 字**（端口和认证方式） | 给 `.host-addr` 加 `title` 完整地址 + 认证方式；或允许两行/换行显示，面板宽 212px 时优先保留 `:22 · 密码` |
| L1-10 | P2 | `components.css:447-459`；对照 `v4.css:836-844` | 工具命令 `white-space:nowrap; text-overflow:ellipsis`；长命令只显示一行省略，mockup 是 `pre-wrap + break-all` | 改成 `white-space:pre-wrap; overflow-wrap:anywhere; text-overflow:clip;`；若必须单行，给命令加 `title` 并允许展开查看完整命令 |
| L1-11 | P2 | `components.css:199-208`（drawer-head）、`2968-2981`（ai-ctx）、`2030-2045`（file-panel）、`2082-2091`（file-panel-toolbar） | 声明 48/30/224/34，实测 49/31/225/35；边框额外加 1px，导致设置/面板节奏偏移 | 给这些元素补 `box-sizing:border-box`（或全局 `*,*::before,*::after { box-sizing:border-box; }`），保持声明高度即最终高度 |
| L1-12 | P2 | `app/index.html:26-39`；对照 `v4.css:163-174` | rail 用 `▣/🖧/🗀/⚙` 文本与彩色 emoji，16px；mockup 是 18px 单色 SVG `currentColor` | 换成统一 inline SVG（18×18，`fill:none;stroke:currentColor`），或至少把 emoji 统一成 `aria-hidden` 的单色字符并设 `font-size:18px;color:currentColor` |
| L1-13 | P2 | `components.css:635-651`、`layout.css:153-165`、`components.css:2181-2195`、`components.css:89-95` 等 | 除把手外，仍有 20×20 审核角标、17.6×14 标签关闭、19.6×19.6 toast 关闭、27.5×35 主机工具、31×17.5 会话操作、22×22 文件面板图标按钮等；S5 每档 23 个、S12 每档 29 个 <28×28 | 统一最小命中区 28×28：给 `.sess-action/.review-mark/.toast-close/.file-panel-icon-btn` 加 `min-width:28px; min-height:28px;` 或用透明 `::before` 扩热区；视觉尺寸可保持 |
| L1-14 | P2 | `app/ui/ai-drawer.js:535-556`；`components.css:2605-2635` | 抽屉头终端名 11.5px/600/`#f0f6fc`，当前会话名 9.5px/`#8f99a4`；次要的终端名比主要任务更抢眼 | 交换层级：`.sess-title` 12px / 600 / `--term-fg-2`，`.sess-sub` 10.5px / `--term-dim`；或把当前会话放在第一行 |
| L1-15 | P2 | `app/ui/file-panel.js:272-335`；`measure.json` S7/S8 `counts` | 远程 `/tmp` 9931 个 entry 一次性渲染，产生 42,677 个 button 节点；相对 S7 的 141 个 entry / 743 个 button，分别是 **70.4 倍 / 57.4 倍** | 增加分页/“显示更多”（首屏 200–500 条）或虚拟列表；保留当前滚动/选择逻辑，避免一次创建全部条目和每条的 3–4 个隐藏操作按钮 |
| L1-16 | P2 | `components.css:2082-2091`（toolbar 6px）、`2205-2214`（grid 9px）、`2330-2342`（status 10px） | 文件面板标题/路径、文件项、状态文字左边缘相差 3–4px（工具栏/网格/状态分别 6/9/10px padding） | 统一文件面板左侧内边距为 9px（或都 10px），例如 `.file-panel-toolbar { padding-left:9px; } .file-panel-status { padding-left:9px; }`，网格维持 9px |

## 6. 与 `docs/mockups-v4` 的偏差清单

| 项 | 实现实测/源码 | mockup 基准 | 判断 |
|---|---|---|---|
| 标签栏高度 | 34px（`tokens.css:82`，实测 34） | 40px（`v4.css:193-199`） | 偏差 6px；影响终端可用高度与设计节奏，算问题（L1-07） |
| 状态栏高度 | 33px（`tokens.css:83`，实测 33） | 26px（`v4.css` `.app` 网格行 26px / `.statusbar`） | 偏差 7px；算问题（L1-07） |
| 抽屉头/上下文条/文件面板高度 | 49 / 31 / 225（声明 48/30/224，边框外扩） | 48 / 30 / 224（全局 `box-sizing:border-box`） | 1px 微观偏差，算小问题（L1-11） |
| 确认卡边框/底色 | 满亮 warn 边框 + `rgba(255,204,128,0.18)` 背景 | `rgba(227,179,65,0.38)` 边框 + `rgba(227,179,65,0.07)` 背景 | 明显更重，且导致对比度失败；算问题（L1-01/L1-05） |
| 确认卡内容 padding / 按钮组右留白 | 8px / 30px | 内容 10px / 右侧 40px | 偏紧；算小问题（L1-05） |
| 工具命令换行 | nowrap + ellipsis | pre-wrap + break-all | 长命令不可见；算问题（L1-10） |
| 当前会话分组底色 | `--term-accent-soft` = `rgba(120,160,220,0.18)` | 当前组 `rgba(120,160,220,0.05)` | 明显更重；S3/S12 整组偏蓝，算观感偏差（P2） |
| 暗色 muted 色 | `--term-muted` = `#808080`（GrayText） | `--v4-muted` = `#9aa4b0` | 系统性对比度根因；算问题（L1-01） |
| rail 图标 | 16px 文本/emoji `▣🖧🗀⚙` | 18px 单色 SVG `currentColor` | 图标语言不统一；算问题（L1-12） |
| 文件面板默认 | `readStoredOpen()` 无值时 `false`（`file-panel.js:144-147`） | 设计稿文件面板是常驻区域（`.files`） | 若产品要求首屏常驻，这是状态偏差；本次按“点 rail 打开”验收，建议产品明确默认值 |
| 主机面板内容 | 本机行只有 1 个 shell select + 2 条远程；无搜索/无本机设备信息/无 shell 网格 | mockup 有主机搜索、本机卡片（用户/系统/架构 + shell 网格）、5 条 SSH | 实现精简；面板高 833/693 内只有 3 行，留白明显。若不算功能裁剪，至少是密度偏差（P2） |
| 设置页宽度 | 620px | mockup 设置页宽度按内容（未直接给 620） | 没有明显冲突；不列为问题 |

## 7. 证据文件

- `probe.mjs`：本次探针（真服务 + CDP + 12 状态 × 2 视口 + 截图/测量/PNG 方差）。
- `measure.json`：每状态原始测量（doc/overflow/overlap/alignment/spacing/contrast/clickTargets/truncation/rects/counts/fonts）。
- `summary.txt`：按状态汇总 + 唯一对比度失败 / 点击目标 / 截断清单。
- `probe.log` / `probe-run.txt`：服务与截图时间线；S4 两档均记录 `AGENT_DONE`。
- `shots/`：28 张 PNG（12 个主状态 × 2 视口 + S4b/S12b 补充）。
- `state/`：隔离状态目录（运行后已删除 `secrets.json` / `secrets.key`；未写用户配置目录）。

### 附：点击目标完整类型（<28×28）

| selector / 角色 | 实测最小尺寸 | 备注 |
|---|---|---|
| `[data-role="tab-close"]` | 17.6×14 | 标签关闭 |
| `[data-role="toast-close"]` | 19.6×19.6 | toast 关闭 |
| `[data-role="approval-review"]` | 20×20 | 四态角标；tooltip 触发 |
| `[data-role="ai-handle"]` | 22×78 | 唯一 AI 入口 |
| `[data-role="file-panel-up"]` / `file-panel-close` | 22×22 | 文件面板图标按钮 |
| `[data-role="hosts-close"]` | 26.2×22 | 主机面板关闭 |
| `[data-role="settings-x"]` | 27×22 | 设置关闭 |
| `[data-role="agent-new"]` | 26×26 | 新建会话 |
| `[data-role="host-edit"]` / `host-delete` | 27.5×35 | 宽 <28 |
| `[data-role="setting-show-effect"]` | 34×18 | 高 <28 |
| `[data-role="agent-session-rename"]` / `delete` | 31×17.5 | 高 <28 |
| `[data-role="approval-run"]` / `rest` / `skip` | 高 25.3 | 三个审批按钮 |
| `[data-role="agent-stop"]` | 45×26 | 高 <28 |
| `[data-role="file-panel-refresh"]` / `newdir` / `newfile` / `upload` | 高 24–26 | 文件工具栏 |
| `[data-role="status-retry"]` | 68×23.3 | 状态栏重连 |
| `[data-role="settings-cancel"]` / `settings-save` | 48×25.5 / 60×27.5 | 设置底部 |
| `[data-role="allowlist-add"]` / `allowlist-mode` | 48×26 / 70×26 | 白名单工具 |
| `[data-role="toast-action"]` | 56.5×23.3 | 去确认 |
| `[data-role="host-add"]` / `hosts-open-files` | 53.5×22 / 74×25.5 | 主机头/标签 |
| `[data-role="host-add-footer"]` / `host-local-shell-select` | 195×25.5 / 199×25 | 主机底部/本机 shell |
| `[data-role="model-select"]` | 238×22 | 模型按钮 |
| `[data-role="review-model-select"]` | 266×26 | 审阅模型 |
| `[data-role="agent-input"]` | 342×19.4 | 单行输入框 |
| `[data-role="file-panel-path"]` | 高 26 | 路径输入 |
| `[data-role="allowlist-input"]` | 高 26 | 白名单输入 |
| `[data-role="agent-reasoning-toggle"]` | 107.5×20 | 思考块展开 |
| `[data-role="agent-step-out-toggle"]` | 362×24 | 工具输出展开 |

> 完整逐元素清单（含每个状态的出现次数）在 `.dispatch/accept-l1/summary.txt` 的 `## unique click targets <28`。
