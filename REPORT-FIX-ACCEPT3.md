# REPORT-FIX-ACCEPT3（待验收）

四项都是布局收尾：把手 24px、标签栏 40px、状态栏 26px、模型选择挪到输入框左侧并把 Enter 提示放进框内。

- 仓库：`C:/Users/41807/magpie-terminal`
- HEAD：`fefbc2f`（**未提交**；工作区里本卡之前已验收的改动保持原样）
- Node：`D:/nodejs/install/node.exe`（v24.16.0）
- 探针：`.dispatch/fix-accept3/probe.mjs`（真服务 3702 + 真 headless Chrome，`prefers-color-scheme: dark`，1440×900 / 1280×760）
- 原始数据：`.dispatch/fix-accept3/measure-before.json`（改前）、`.dispatch/fix-accept3/measure.json`（改后）
- 断言汇总：`.dispatch/fix-accept3/summary.json` / `summary.txt`（`allPass=true`，两档视口所有本卡断言 PASS）
- 运行日志：`probe-before.stdout.txt`、`probe.stdout.txt`、`probe-before.log`、`probe.log`

## 0. 改前 / 改后一句话

| 项 | 改前实测 | 改后实测 |
|---|---|---|
| 1 把手 | 视觉 22px，命中 bbox **48×79**（48px 隐形扩展） | 视觉 **24×78**，命中 bbox **24×78** |
| 2 标签栏 | 34px | **40px**（标签项文字 34/34、标题 19/19 不裁切） |
| 3 状态栏 | 33px | **26px**（所有子元素仍在栏内，toast 与状态栏间距 8px） |
| 4 输入区 | 模型在框下方，`modelInsideBox=false`，send 在框外 | 模型/正文/发送/提示全在框内，模型 `ratio=0.38`，send 34×34 在框内 |

## 1. 把手：22 → 24，命中区 48 → 24（取消隐形扩展）

代码：
- `app/styles/tokens.css`：`--term-handle-width: 24px`、`--term-handle-hit: 24px`
- `app/styles/layout.css`：删除 `[data-role="ai-handle"]::before` 的两条扩展规则（收起态 48px 左扩、展开态对称扩）

| 测量 | 1440×900 改前 | 1440×900 改后 | 1280×760 改前 | 1280×760 改后 |
|---|---:|---:|---:|---:|
| 把手 rect | 1418..1440，**22×78** | 1416..1440，**24×78** | 1258..1280，**22×78** | 1256..1280，**24×78** |
| 逐像素命中 bbox | **48×79** | **24×78** | **48×79** | **24×78** |
| `elementFromPoint(rect.left-2, 中点)` | `button[data-role=ai-handle]`（被热区盖住） | `div.xterm-screen`，`inTerminal=true` | 同左 | 同左 |
| `elementFromPoint(innerWidth-25, 中点)` | `button[data-role=ai-handle]` | `div.xterm-screen`，`inTerminal=true` | 同左 | 同左 |
| 从 `rect.left-2` 起拖 260px 的选区 | `xtermSelectionRects=0`，`window.getSelection()=""` | `xtermSelectionRects=2`（其中 1 条可见 264×18），**PASS** | 0 | 2，**PASS** |

- 圆角、配色、边框、`handle-icon`（‹）、`handle-text`（AI）、`handle-badge` 的 CSS 没有改；宽度只从 22 变 24（水平中心各让 1px）。
- 截图：`shots/1440x900-closed-after-drag.png`、`shots/1280x760-closed-after-drag.png`（右侧终端文字已被选中）。

## 2. 标签栏：34 → 40

代码：
- `app/styles/tokens.css`：`--term-tabbar-height: 40px`
- 未改标签条字号 / 图标尺寸 / `[data-role="tab"]` 最小宽度。
- 只给 `[data-role="tab-close"]` 加了透明 `::before`：视觉仍是 17.73×14 的 `×`，命中区补到 28×28（验收卡写明「28×28 热区」；改前实测只有 17.73×14，见 `ACCEPT-LAYOUT.md` L1-13 的 17.6×14）。像素采样命中 bbox 为 29×28，是因为元素左边缘在 152.5px 上、整数采样多取一列；CSS 伪元素本身是 28×28。

| 测量 | 改前（两档相同） | 改后 1440×900 | 改后 1280×760 |
|---|---:|---:|---:|
| `[data-role=tabbar]` 高度 | **34** | **40** | **40** |
| 标签项 rect 高度 | 29 | 35 | 35 |
| 标签项 `scrollHeight/clientHeight` | 28 / 28 | **34 / 34** | **34 / 34** |
| 标题 `scrollHeight/clientHeight` | 19 / 19 | **19 / 19** | **19 / 19** |
| 关闭按钮视觉 rect | 17.73×14 | 17.73×14（视觉不变） | 17.73×14 |
| 关闭按钮命中 bbox | 同视觉（无伪元素） | **29×28**（CSS 28×28） | **29×28** |
| 实际点击第二个标签的关闭按钮 | 可关（closed=true） | 可关（closed=true） | 可关（closed=true） |

- 标签项没有纵向裁切：`tab scrollHeight=clientHeight=34`，`title 19/19`。
- 截图：`shots/1440x900-closed.png`、`shots/1280x760-closed.png`。

## 3. 状态栏：33 → 26

代码：
- `app/styles/tokens.css`：`--term-statusbar-height: 26px`
- toast 的 `bottom: calc(var(--term-statusbar-height) + var(--term-gap))` 自动跟随为 34px（26+8）。

| 测量 | 1440 改前 | 1440 改后 | 1280 改前 | 1280 改后 |
|---|---:|---:|---:|---:|
| 状态栏高度 | **33** | **26** | **33** | **26** |
| 子元素全部 `top>=bar.top && bottom<=bar.bottom+0.5` | true（无越界） | **true（offenders=[]）** | true | **true** |
| 重连按钮 rect | 68×23.25 | 68×23.25 | 68×23.25 | 68×23.25 |
| 重连按钮垂直位置 | 872.38..895.63 | 875.88..899.13 | 732.38..755.63 | 735.88..759.13 |
| toast rect | 340×56.19 | 340×56.19 | 340×56.19 | 340×56.19 |
| toast 与状态栏相交面积 | 0 | **0** | 0 | **0** |
| toast 底边距状态栏顶边 | 8 | **8**（≥6） | 8 | **8** |

- 本构建状态栏里没有「语言 / 版本」控件，实际只有 5 个 `status-item` span + 1 个 `status-retry` button。重连按钮当前 **68×23.25**，不是 28×28，所以没有按「28×28 → 24×24」改（改成 24×24 会把「立即重连」文字裁掉）；23.25 已落在 26px 行高内且垂直居中。
- 截图：`shots/1440x900-closed.png`、`shots/1280x760-closed.png`；原始 toast 数据在 `measure.json` 的 `checks.toast`。

## 4. 模型选择挪到输入框左侧 + Enter 提示进框

代码：
- `app/ui/ai-drawer.js`：`model-select`、`agent-input`、`composer-hint`、`composer-send/stop`、`model-menu` 全部移入 `composer-box`；删除 `.composer-bar` 及其 CSS。停止/发送放进 `.composer-actions`。事件的 `data-role` 名字未改。
- `app/styles/components.css`：`.composer-box` 改为 Grid：
  `grid-template-columns: auto minmax(0,1fr) auto; grid-template-areas: "model input send" "hint hint send"`；`composer-hint` 从绝对定位改成第二行网格项；`model-select` 去边框、透明底、内部 `.model-label` 尾部省略、`title` 写全名；模型列上限 `40cqw`（= 框内容宽 40%，现代 Chromium/WebView2 支持；两档实测均 0.38 倍框宽）。
- `modelMenu` 仍在 `composer-box` 内，`bottom: calc(100% + 2px)`；`toggleModelMenu()` 按 `composer-box` 顶边算 `maxHeight` 的逻辑保持可用。

### 4.1 单行状态（1440×900 / 1280×760 数值不同但结论相同）

| 测量 | 改前 1440 | 改后 1440 | 改前 1280 | 改后 1280 |
|---|---:|---:|---:|---:|
| `composer-box` rect | 364×40.38 | **364×48** | 364×40.38 | **364×48** |
| `model-select` rect | 238.25×22 | **138.39×22** | 193.13×22 | **138.39×22** |
| `modelInsideBox` | false（在框下 bar 里） | **true** | false | **true** |
| `model.right <= input.left` | false | **true**（1213.39 ≤ 1221.39） | false | **true**（1053.39 ≤ 1061.39） |
| 模型宽 / 框宽 | 0.65 | **0.38** | 0.53 | **0.38** |
| 模型 border-width | 0 | **0** | 0 | **0** |
| 模型常态 background | transparent | **transparent** | transparent | transparent |
| 模型 `scrollWidth/clientWidth` | 240 / 238 | **138 / 138** | 193 / 193 | **138 / 138** |
| 模型 `title` | `选择模型` | **完整模型名** | `选择模型` | **完整模型名** |
| `agent-send` rect | 34×34 | **34×34** | 34×34 | **34×34** |
| `sendInsideBox` | false | **true** | false | **true** |
| `composer-hint` inside / 与 input 相交 / 与 send 相交 | true / 0 / 0（绝对定位） | **true / 0 / 0**（grid 第二行） | true / 0 / 0 | **true / 0 / 0** |
| model/input/send 两两相交面积 | 0 | **0** | 0 | **0** |
| `agent-stop` 隐藏时 display | none | **none** | none | none |
| 停止显示后 rect / 是否在框内 / 与 send/input 相交 | 45×26 / false / 0 | **45×26 / true / 0** | 45×26 / false / 0 | **45×26 / true / 0** |
| 停止再隐藏后 send/model 位置 | 与隐藏前一致 | **与隐藏前一致** | 一致 | **一致** |

模型名截断证据：`model-select` 自身 `scrollWidth=clientWidth=138`；内部 `.model-label` `scrollWidth=223 / clientWidth=122`（1440，Visible ellipsis），`title` 为全名 `DeepSeek V4.1 Flash (latest) · Command Code`。

### 4.2 菜单（点模型名）

| 测量 | 改前 1440 | 改后 1440 | 改前 1280 | 改后 1280 |
|---|---:|---:|---:|---:|
| 可见 | true | **true** | true | **true** |
| rect | 291.11×240 | **291.11×240** | 274.91×240 | **274.91×240** |
| 底边 ≤ box 顶边 | 778.63 ≤ 778.63 | **817 ≤ 818** | 638.63 ≤ 638.63 | **677 ≤ 678** |
| 与 composer-box 相交面积 | 0 | **0** | 0 | 0 |
| `menu.top >= drawer.top` | true | **true**（577 ≥ 0） | true | **true**（437 ≥ 0） |
| 模型项数 / 是否可滚动 | 8 / true | **8 / true** | 8 / true | **8 / true** |
| `scrollHeight/clientHeight` | 292 / 238 | **292 / 238** | 292 / 238 | **292 / 238** |

### 4.3 三行输入、拖拽、模型切换

| 测量 | 改前 1440 | 改后 1440 | 改前 1280 | 改后 1280 |
|---|---:|---:|---:|---:|
| 单行 `agent-input` 高 | 19.38 | **19.38** | 19.38 | **19.38** |
| 三行 `agent-input` 高 | 58 | **58（> 单行）** | 58 | **58** |
| 三行 `composer-box` 高 | 79 | **84** | 79 | **84** |
| 三行时 模型/正文/发送/提示 全在框内、两两相交 0 | 模型/send 不在框内 | **true / 全 0** | 同左 | **true / 全 0** |
| 拖 `composer-grip` 上 40px | 58 → 98 | **58 → 98** | 58 → 98 | **58 → 98** |
| 再向下 40px | 98 → 58 | **98 → 58** | 98 → 58 | **98 → 58** |
| `localStorage['magpie.term.composerHeight']` | `98` → `58` | **`98` → `58`** | `98` → `58` | **`98` → `58`** |
| 切模型后 `PUT /api/config` | `auto/deepseek-v4.1-flash` | **`auto/deepseek-v4.1-flash`**（1440） | `shuaiapi/gpt-6-luna` | **`shuaiapi/gpt-6-luna`**（1280） |
| 下一次请求帧 model | 与新值一致 | **`agent.run.model` = 新值** | 一致 | **`agent.run.model` = 新值** |

- 模型切换探针会在点击菜单项后轮询 `GET /api/config`，确认落盘；随后挂 `WebSocket.prototype.send` 记录 UI 真实发出的 `agent.run` 帧（记录后立即恢复，不把请求发到网关）。两档 `runFrameModelMatches=true`。服务端 `src/server/ws.mjs:555-558` 把 `frame.model` 原样交给 `agent.start`；现有 `test/ai/agent.test.mjs` 也断言 `agent.start` 带 `model`。本卡未改 `src/`。
- 截图：
  - 收起：`shots/1440x900-closed.png`、`shots/1280x760-closed.png`
  - 展开：`shots/1440x900-expanded.png`、`shots/1280x760-expanded.png`
  - 菜单打开：`shots/1440x900-menu.png`、`shots/1280x760-menu.png`
  - 三行输入：`shots/1440x900-three-lines.png`、`shots/1280x760-three-lines.png`
  - 拖选：`shots/1440x900-closed-after-drag.png`、`shots/1280x760-closed-after-drag.png`
  - 放大核对：`shots/crop-three-lines.png`

## 5. 回归

| 命令 | 结果 | 原始日志 |
|---|---|---|
| `D:/nodejs/install/node.exe --test` | **679 / 679 pass，0 fail**（suites 0 / cancelled 0 / skipped 0） | `.dispatch/fix-accept3/node-test.txt` |
| `DOCTOR_PORT=3704 D:/nodejs/install/node.exe scripts/doctor.mjs`（本机原配置） | **7 / 9**，`STEP_TIMEOUT: 3 echo M-2` | `.dispatch/fix-accept3/doctor-exact-config.txt` |
| 同上 + `MAGPIE_TERMINAL_CONFIG_PATH=.dispatch/fix-accept3/doctor-state/config.json` | **33 / 33** | `.dispatch/fix-accept3/doctor.txt` |

### doctor 的环境前提（如实说明，不是本卡代码问题）

本机 `~/.config/magpie-terminal/config.json` 里已有 `defaultShell: "pwsh"`（本卡没改它，`doctor-diag.txt` 里 `session.created.shell.name = "PowerShell 7"`）。`scripts/doctor.mjs` 的第 3 步发的是 bash 语法 `echo M-$((1+1))`，在 pwsh 里不会产生 `M-2`，所以原命令稳定停在 **7/9**（跑了两次都是同一处超时，不是偶发）。

为了让 doctor 的「默认自动探测 bash」前提成立，我用仓库已有的测试隔离变量 `MAGPIE_TERMINAL_CONFIG_PATH` 指向**用户配置的临时副本**，只把 `defaultShell` 改为 `null`（`.dispatch/fix-accept3/doctor-state/config.json`），原用户配置没有修改、没有删除。该命令 **33/33**，日志在 `doctor.txt`。如果验收环境本身是干净配置（没有 `defaultShell`），原命令会直接 33/33。

## 6. 未做 / 遗留风险

- 未做本卡之外的任何事：没有虚拟列表、没有换 rail 图标、没有改明色主题 token、没有动 `src/`、`file-panel.js`、`hosts-panel.js`、`test/app/`、`test/server/`。
- 未 `git add` / `git commit` / `git stash`；提交由你完成。
- 遗留风险 1：`40cqw` + `container-type: inline-size` 依赖 Chromium ≥105。本机 Chrome/WebView2 实测生效（模型宽 138.39 = 框内容宽 40%）；极旧 WebView2 会忽略该条，模型名可能按旧 `auto` 轨道撑宽。
- 遗留风险 2：标签关闭的 28×28 命中层是透明 `::before`，横向会压住标题末尾约 5px；点标题最后几个像素会命中关闭（标准「扩大点击目标」的取舍）。
- 遗留风险 3：模型菜单现在嵌在 `.composer-box` 内，若后续给 `.composer-box` 加 `overflow: hidden`，菜单会被裁；当前没有该属性。
- 遗留风险 4：doctor 原命令受本机既有 `defaultShell=pwsh` 影响（见 §5），不是本卡四项改动导致；本卡没有为了让它绿而改用户配置或 `src/`。
- 状态栏「重连」按钮是 68×23.25 文本按钮，没有 28×28 的方形控件，所以「28×28 → 24×24」这条在本构建没有适用对象。

## 7. 结论

四项的改后数字均由 `.dispatch/fix-accept3/probe.mjs` 在真 Chrome 里测得，`summary.json` 两档视口全部 PASS；`node --test` 679/679。**标「待验收」**，不自称成品。
