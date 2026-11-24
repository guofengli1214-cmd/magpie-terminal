# REPORT-FIX-UI-REST

> 状态：**待验收**（本卡执行报告，未经独立 verifier 复核）
> 任务书：`TASK-FIX-UI-REST.md`（plan_version 用户 m02595「1B」批准）
> 仓库：`C:/Users/41807/magpie-terminal`，起始 HEAD `1fb3dc2`
> 会话：`fix-ui-rest-1` / `commandcode/deepseek/deepseek-v4.1-flash`（`--thinking max`）
> 节点：`D:/nodejs/install/node.exe`（v24.16.0）
> 探针端口：**3780**（起服务前确认空闲；未使用 3480）

---

## 1. 一句话结论

两个缺陷都修好了，并有真浏览器证据：

1. **AI 把手回到视口正中**：1440×900 下 `437 → 450`（Δ=0），1280×760 下 `367 → 380`（Δ=0），收起态与抽屉展开态都对。
2. **文件条目不再横向溢出**：本卡 fixture 的 64 条条目 `scrollWidth ≤ clientWidth + 1` 全部成立（改前文件条目的 156px 动作条在 110.4px 的格子里左侧溢出 49.6px）；每行 button 数 `6 → 1`；5 个动作改成点 `⋯` 弹面板级菜单，两档视口都完整落在文件面板内、不遮自己那一行的图标与文件名。

全量回归 `722 tests / 722 pass / 0 fail`；探针 **70 条断言全 PASS**（含最小面板 150px 的极端几何）。

---

## 2. 改了什么（逐文件）

| 文件 | 改动 |
|---|---|
| `app/styles/layout.css` | `[data-role="ai-handle"]` 的 `top: 50%` → `top: calc(50% + var(--term-statusbar-height) / 2)`，补回状态栏半高（`.main` 高度 = 视口 − 26px 状态栏）。只改这一条；`[data-ai-open="true"]` 的 `right` 规则一字未动。 |
| `app/ui/file-panel.js` | ① 新增导出的纯函数 `actionsForEntry(entry)` / `menuSizeFor(count)` / `clampMenuPosition({btn, anchor, menu, panel})` 与常量 `MENU_ITEM_HEIGHT/MENU_CHROME/MENU_WIDTH/MENU_GAP/MENU_MARGIN`。② `renderEntry()` 删掉整段 `.file-panel-fmore`（5 个 `.file-panel-action` 文字按钮）与 `data-more-open` 逻辑，行内只留 `[data-role="file-more-toggle"]` 的 `⋯`（`aria-haspopup="menu"` + `aria-expanded`）。③ 新增面板级菜单：`div.file-panel-action-menu[data-role="file-action-menu"][role="menu"]` 挂在 `.file-panel` 根（不在 grid、不在 card），`openActionMenu` / `closeActionMenu` / `positionActionMenu` / `onMenuKeydown` / `onDocumentPointerDown` / `onDocumentKeydown` / `syncActionMenuToDom`；菜单项 `button.file-panel-menu-item[data-role="file-action-item"][data-action][role="menuitem"]`，点击走**未改名的** `runAction(action, entry)`。④ 关闭路径：再点同一个 `⋯`、`Esc`（焦点还给该行 `⋯`）、点菜单外、滚动、`ResizeObserver`、`refresh()/render()`、切目录、收起面板、锚点行被虚拟滚动卸载。⑤ `dispose()` 移除 document 级监听。 |
| `app/styles/components.css` | 删 `.file-panel-fmore` / `.file-panel-action` / `[data-more-open]` 全部规则；`⋯` 的提亮改用 `[aria-expanded="true"]`；新增 `.file-panel-action-menu`（`position:absolute`、`min-width:120px`、`z-index:12`）与 `.file-panel-menu-item`（`height:26px`，与 JS 常量对齐；删除项 hover 走危险红）。 |
| `test/app/file-panel-menu.test.mjs` | **新增 17 条**纯函数单测：`actionsForEntry` 的目录 3 项 / 文件 5 项逐字、`null` 走文件分支、每次返回新数组；`menuSizeFor`；`clampMenuPosition` 的 8 条边界（正常在下方、靠底边翻上、右边缘改侧放、面板比菜单还窄不出负数、上下都放不下、`anchor` 使菜单不压自身行、`placement` 几何自洽、DOMRect 风格入参、缺参数不抛）。 |
| `.dispatch/fix-ui/` | `make-fixture.mjs`（fixture 64 项 + bigdir 10000 项）、`probe.mjs`（端口 3780、独立状态目录、私有 CDP 端口 9413）、`cdp.mjs`（`../cdp.mjs` 的私有副本，只改调试端口与 profile 前缀）、`probe.txt`、`summary.txt`、`node-test.txt`、`measure.json`、`shots/*.png`（18 张）、`dispatch.txt`、`probe-run.log`。 |

**未碰**：`src/**`、`docs/**`、`app/ui/ai-drawer.js`、`app/ui/toast.js`、`package.json`、`.git`。没 commit、没 stash、没引依赖。

### 2.1 与任务书字面的一处偏差（请 verifier 注意）

§6.3 给的定位公式是「下方放不下 → 翻到上方 → 仍不行就取 `panel.top + 4`」，且用 `⋯` 按钮的 rect 作垂直基准。实测发现两个问题，做了两处**必要**调整：

1. **垂直基准改成整张卡片**（`clampMenuPosition` 新增可选 `anchor` 参数，`positionActionMenu` 传 `card.getBoundingClientRect()`）。按 `⋯` 按钮算时，菜单底边正好落在按钮下方 2px，会**横向盖住自己这一行的文件名**（实测相交 302–312 px²）—— 违反 §2 目标 2「不遮文件名」。改成按卡片对齐后相交为 **0**。不传 `anchor` 时行为与任务书公式一致（单测里两种都锁了）。
2. **上下都放不下时优先改到卡片旁边**（`placement: "side"`），而不是硬贴面板顶边。原因：默认面板高 224px、网格可视 168px，而 5 项菜单高 134px + 一行卡片 74px = 208px > 168px —— 任何「上下摆」都必然压住某一行。面板只有两三行高时，「压住你正在操作的那一行」比「摆到旁边」难理解得多。`side` 仍严格钳在面板内（`left/right/top/bottom` 四边都验过），右边缘列会自动翻到卡片左侧。真正的「面板比菜单还窄」才落到 `placement: "fit"`（贴面板左上角 + 4px，永不出现负数）。

菜单**必然覆盖相邻格子**（120×134 的浮层 vs 110×117 的格子），这在 §7 里明确允许（「不用管…菜单本来就可以覆盖相邻格子」）。探针同时记录了两个数字：锚点行文件名/图标相交 `0`，与全页所有文件名相交 `2868–3082 px²`（仅供参考，不作断言）。

---

## 3. 改前 / 改后数字对照表

| 指标 | 改前（实测基线） | 改后（探针实测） | 结论 |
|---|---|---|---|
| 把手 centerY @1440×900（视口中心 450） | 437（Δ −13） | **450（Δ 0）** | 居中 |
| 把手 centerY @1280×760（视口中心 380） | 367（Δ −13） | **380（Δ 0）** | 居中 |
| 把手 centerY（抽屉展开态）@1440×900 | 437 | **450（Δ 0）** | 两态都对 |
| 把手尺寸 / 贴边 / 圆角 | 24×78、`right:0`、`8px 0 0 8px` | **24×78、`right:0`、`8px 0px 0px 8px`** | 未回归 |
| 文件条目动作条宽 | 156px（5 个文字按钮 + 间隙 + 内边距） | **不存在**（`.file-panel-fmore` = 0、`.file-panel-action` = 0） | 已删除 |
| 动作条左溢出 @1440（格子 110.4px） | −49.6px | **0** | 已修 |
| 动作条左溢出 @1280（格子 117.3px） | −42.7px | **0** | 已修 |
| 格子内横向溢出（64 项 fixture，全量扫描） @1440 | 文件条目（5 按钮那条 156px）溢出 49.6px（156 − 110.4 + 3 ≈ 49） | **0/64 条溢出** | 已修 |
| 格子内横向溢出（64 项 fixture，全量扫描） @1280 | 文件条目溢出 42.7px（156 − 117.3 + 3 ≈ 42） | **0/64 条溢出** | 已修 |
| 每行 `<button>` 数 | 6（1 个 `⋯` + 5 个动作） | **1**（只有 `⋯`） | 任务书里的 141 行目录 → 少 705 个 button；本卡 fixture 64 行 → 384 降 64 |
| 菜单宽 / 高（文件 5 项） | — | **120 × 134** | 固定，不测量 |
| 菜单是否出面板（1440 / 1280 / 右边缘列 / 面板底部） | — | **全部在面板 rect 内** | 4 处都验 |
| 菜单与锚点行文件名相交 | — | **0 px²** | 不遮 |
| 菜单与锚点行图标相交 | — | **0 px²** | 不遮 |
| 10000 项目录 DOM 条目数（滚到底） | 卡 4 已虚拟化（本卡未改算法，只改条目内部按钮） | **88 @1440 / 80 @1280**（窗口 ± overscan） | 虚拟滚动未回归 |
| 全量测试 | 700 tests / 699 pass / **1 fail**（`PS：runner 按 shellNameResolver 选分支`，属 TASK-FIX-PS-SHELL） | **722 tests / 722 pass / 0 fail**（其中 17 条是本卡新增；其余增量来自并行 PS-SHELL 卡对 `test/ai/runner.test.mjs` 的修改） | 0 fail |

---

## 4. 11 条 AC 逐条结果

| 编号 | 内容 | 结果 | 证据 |
|---|---|---|---|
| **AC1** | 两档视口 `\|handle.centerY − vh/2\| ≤ 1` | **PASS** | 1440：450 vs 450（Δ 0）；1280：380 vs 380（Δ 0）。抽屉展开态同样 Δ 0。`probe.txt` AC1/AC1b |
| **AC2** | 把手 24×78、贴右缘、左侧圆角、`data-ai-open="false"` | **PASS** | `width:24px`、`height:78px`、`right:0`、`border-radius:8px 0px 0px 8px`、`data-ai-open=false`。`probe.txt` AC2 |
| **AC3** | 格子内无横向溢出（`scrollWidth ≤ clientWidth + 1`），动作条 DOM 已不存在 | **PASS** | 64 条全部溢出 0；`.file-panel-fmore=0`、`.file-panel-action=0`、每行 button=1；锚点格 `scrollWidth 115 ≤ clientWidth 115`。AC3a/AC3b/AC3c/AC3d |
| **AC4** | 菜单两档都在面板 rect 内，四边都满足 | **PASS** | 文件菜单、目录菜单、右边缘列、面板底部、**面板压到最小 150px** 共 10 组 rect 比对，`left/top/right/bottom` 均在面板内、无负坐标。AC4a–AC4g |
| **AC5** | 文件 5 项、目录 3 项，文案与顺序逐字正确 | **PASS** | 文件 `查看/编辑/重命名/下载/删除`（`view/edit/rename/download/delete`）；目录 `打开/重命名/删除`（`open/rename/delete`）；`role=menuitem`、打开后焦点在第一项。单测另锁 17 条。AC5a/AC5b/AC5c |
| **AC6** | 点「查看」真的打开查看器且菜单消失 | **PASS** | `[data-role="file-viewer"]` 出现、`file-viewer-body` 带 `readonly`、内容 `fixture file 1`、菜单 `hidden`。AC6 |
| **AC7** | `Esc` / 点外部 / 滚动 三种关闭路径；`Esc` 后焦点回到该行 `⋯` | **PASS** | Esc：`menuOpen=false` + `document.activeElement` 是该行 `⋯` + `aria-expanded=false`；点外部、滚动（列表真的滚了 `scrollTop=376`）；另外补验「再点同一个 `⋯`」「刷新」「切目录」三条 §6.3 路径。AC7a–AC7g |
| **AC8** | 面板底部附近的条目，菜单翻到上方且不出界 | **PASS** | 面板拉到 520px（真实双击把手）后滚到底：`placement=above`，菜单 `bottom 629 ≤ 按钮 top 632`（间隙 3px），四边都在面板内、无负坐标、不遮锚点行。AC8a/AC8b |
| **AC9** | 全量测试 0 fail（基线 692 + 新增） | **PASS** | `722 tests / 722 pass / 0 fail`（基线实为 700 tests / 699 pass，见 §3 备注）。`.dispatch/fix-ui/node-test.txt` |
| **AC10** | 虚拟滚动不回归：10000 项目录滚到底仍能选中/查看/删 | **PASS** | 两档均：`total=10000`、DOM 88/80 条、`atBottom=true`、最后一项 `file-10000.txt` 可见；滚到底能选中它、点开 5 项菜单、打开查看器；删除一条临时文件后列表刷新且该条消失。AC10a–AC10d |
| **AC11** | 目录菜单点「打开」能进入该目录 | **PASS** | 点「打开」后 `state.path === dir-alpha`、`entries=1`、`manualPath=true`。AC11 |

**70 条断言全 PASS，0 FAIL，0 SKIP。**

---

## 5. 回归数字

- 全量：`node --test` → **722 tests / 722 pass / 0 fail / 0 cancelled / 0 skipped**（`EXIT=0`）。
- 新增单测：`test/app/file-panel-menu.test.mjs` → 17 tests / 17 pass。
- 数字口径：本卡基线在同一工作区跑出 700 tests（当时并行卡尚未加测试）；当前 722 = 700 + 本卡 17 + 并行卡在 `test/ai/runner.test.mjs` 新增的 5 条。本卡只新增 `test/app/file-panel-menu.test.mjs` 一个文件。
- 基线（本卡动手前同一台机器实测）：700 tests / 699 pass / **1 fail** —— `test/ai/runner.test.mjs:248 PS：runner 按 shellNameResolver 选分支`，属 `TASK-FIX-PS-SHELL` 范围（那个卡正在并行改 `src/ai/runner.mjs`），本卡未碰 `src/`。单独跑 `test/ai/runner.test.mjs` 时 48/48 pass（flaky，取决于并行卡的工作区状态）。
- 未回归的项目（探针实测）：单击选中、双击查看/打开、拖放上传（上传后列表刷新，~126ms）、虚拟滚动窗口与 spacer、右边缘列条目、面板收起/展开。

---

## 6. 疑问 / 需要人类知道的判断

1. **「菜单不覆盖任何 `.file-panel-name`」按字面不可能达成。** 任务书 §7 的这条与 §7 末尾「菜单本来就可以覆盖相邻格子」自相矛盾：120×134 的浮层落在 110×117 的格子矩阵上，必然压住相邻格子里的某些名字。本卡按「**不遮锚点行自己的文件名与图标**」执行（这是 §2 目标 2 的原话），并额外记录「与全页所有文件名相交」作为参考值。若验收方坚持字面口径，需要把菜单改成 `position: fixed` 的模态或改成分页动作面板 —— 那是另一个方案，本卡不做。
2. **任务书写的类名 `.file-panel-name` 在产品里不存在**，实际是 `.file-panel-fname`。探针两个选择器都数了：`.file-panel-name` 恒为 0，`.file-panel-fname` 64。
3. **默认面板高度（224px）下，5 项菜单在垂直方向没有「既不出面板、又不碰任何一行」的解**（134 + 74 > 168）。所以正常态下菜单走 `side`（摆在卡片右侧），只有面板拉到足够高（≥ 520px）时才会出现典型的 `above`/`below`。这是几何必然，不是实现取巧。
4. **共享 CDP 端口 9411 会被并行卡互相 `taskkill` 打断**（本卡实测两次 `CDP timeout: Runtime.evaluate`）。本卡在 `.dispatch/fix-ui/cdp.mjs` 里用了私有端口 **9413** 与 `fix-ui-cdp-` profile 前缀；`.dispatch/cdp.mjs` 本身未改。
5. `docs/PROTOCOL-AGENT.md`、`src/ai/runner.mjs`、`src/server/ws.mjs`、`test/ai/runner.test.mjs` 在工作区里显示为已修改 —— 那是并行的 `TASK-FIX-PS-SHELL` 卡改的，**不是本卡**（本卡未碰 `src/` 与 `docs/`）。

---

## 7. 审计信息

| 项 | 值 |
|---|---|
| session_id | `fix-ui-rest-1` |
| 模型 | `commandcode/deepseek/deepseek-v4.1-flash`（`--thinking max`） |
| 会话文件 | `C:\Users\41807\.pi\agent\sessions\--C--Users-41807-magpie-terminal--\2026-11-24T13-09-54-525Z_fix-ui-rest-1.jsonl` |
| 起始 HEAD | `1fb3dc2`（未 commit、未 stash） |
| 起始基线测试 | 700 tests / 699 pass / 1 fail（PS flaky，非本卡） |
| Node | v24.16.0（`D:/nodejs/install/node.exe`） |
| 探针端口 | 3780（服务）+ 9413（CDP，私有） |
| 探针轮次 | 十余轮（每轮覆盖落盘 `measure.json` / `probe.txt`，最终一轮 70/70 全 PASS）。其中大部分失败是**探针自身**的 bug（共享 CDP 端口被并行卡 taskkill、`peval` 包裹多语句触发 `SyntaxError`、页面里有两个 `confirm-backdrop` 取错了那一个、`clickMoreToggle` 里的 `scrollIntoView` 自己先把菜单滚关了）；另有三处是探针揭出的**产品真问题**，已按 §2.1 修掉（菜单压住自己那一行的文件名 / 默认面板高度下垂直没有解 / 面板 1px 边框让间隙从 2px 掉成 1px）。单测另抓出一处越界分支（`above` 只判下界没判上界），也一并修了。 |
| 耗时 | 约 1h20m（21:09 → 22:25） |
| 证据文件 | `.dispatch/fix-ui/probe.txt` / `summary.txt` / `node-test.txt` / `measure.json` / `shots/*.png`（18 张，两档各 9 张；PIL 判非空白：colors 164–2213） |

---

## 8. plain_summary（白话，≤200 字）

以前文件面板每个条目的操作是一条横着的按钮带，比格子还宽 50px，悬在格子外面把图标盖住了；现在每个条目只剩一个「⋯」，点它弹出一个不越界的竖排菜单（查看/编辑/重命名/下载/删除，目录是打开/重命名/删除），上下左右都被钳在面板里，不会切边。AI 助手那个把手原来贴在主区中间，比屏幕正中低了 13px，现在补回状态栏一半高度，正好回到视口正中。全量测试 722 条全过。
