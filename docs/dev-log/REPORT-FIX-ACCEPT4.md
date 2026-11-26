# REPORT-FIX-ACCEPT4（待验收）

**任务**：TASK-FIX-ACCEPT4 —— 文件面板虚拟滚动 + 左侧 rail 换内联 SVG 图标

| 项 | 值 |
|---|---|
| 仓库 | `C:/Users/41807/magpie-terminal` |
| 开工时 HEAD | `7e40301`（`fix(v4): 按功能/布局验收结论收尾…`） |
| 本卡提交 | `1fb3dc2`（`fix(v4): 文件面板虚拟滚动 + rail 内联 SVG 图标（TASK-FIX-ACCEPT4）`） |
| Node | `v24.16.0`（`D:/nodejs/install/node.exe`） |
| 改动文件 | `app/ui/file-panel.js`、`app/styles/components.css`、`app/index.html`、`test/app/file-panel-virtual.test.mjs`（新增） |
| 未动 | `src/`、`test/server/`、`test/app/api-delete.test.mjs`、把手/标签栏/状态栏/输入区（TASK-FIX-ACCEPT3 范围） |

> **证据口径（先读这条再看数字）**
> 验收期间有另一个任务（`TASK-FIX-UI-REST`）在**同一棵工作区**里继续改
> `app/ui/file-panel.js` 与 `src/`（`git status` 现在能看到 `M src/ai/runner.mjs` 等）。
> 为了让「数字对应哪份代码」可复核，**before/after 两棵树都从 git 提交导出**：
>
> | | 提交 | 导出目录 |
> |---|---|---|
> | before | `7e40301` 的 `app/` | `.dispatch/fix-accept4/tree-before/` |
> | after | `1fb3dc2` 的 `app/` | `.dispatch/fix-accept4/tree-after/` |
>
> 两棵树共用 `1fb3dc2` 的 `src/`（本卡没改 `src/`），所以数字只差前端。
> 导出脚本 `prepare-trees.mjs`（只读 `git archive`），文件 sha256 见 `trees.json`。
> **本文所有数字都来自 `tree-before` / `tree-after` 这两棵树**，不是当前工作区。
> 重跑命令见 `.dispatch/fix-accept4/README.md`；汇总表在 `summary.txt` / `summary.json`，
> 断言 45 条全 PASS。

---

## 一、任务 1：文件面板虚拟滚动

### 1.1 做法

`app/ui/file-panel.js` 里把「遍历 `state.entries` 全量 `appendChild`」改成**窗口化渲染**：

- 网格 `[data-role="file-panel-grid"]` 自己就是滚动容器（CSS 改 `overflow-y:auto; overflow-x:hidden`）。
- 只渲染「可视行 ± 2 行」，上下各放一个跨全列的 `.file-panel-spacer`
  （`grid-row: span N`，`grid-column: 1 / -1`）撑住滚动高度 —— 滚动条仍按**全量条目**算。
- 窗口计算抽成**纯函数** `computeWindow()`（+ `countTracks()`），可单测、不依赖 DOM。
- **小目录直通**：`count ≤ FULL_RENDER_LIMIT(400)` 时全量渲染、两个 spacer 都是 0 行
  （0 行时整块从 DOM 移除）→ 小目录与改动前**逐节点同构**。
- 滚动/尺寸变化：`scroll` + `ResizeObserver` + `window.resize`，用 `requestAnimationFrame`
  合帧，一帧最多重铺一次；按 `data-path` 复用节点，只换进出窗口的那几个。
- 面板收起时（宽度为 0）只置脏标记，不自旋 rAF；`applyOpen()` 展开时补画一次。

### 1.2 本地 10000 项目录（真文件，`make-bigdir.mjs` 生成 10000 个 0 字节文件）

| 指标 | 1440×900 before | 1440×900 after | 1280×760 before | 1280×760 after |
|---|---|---|---|---|
| `[data-role="file-entry"]` | **10000** | **60** | **10000** | **50** |
| 验收上限 400 | — | ✅ 60 ≤ 400 | — | ✅ 50 ≤ 400 |
| DOM 总节点 | 110,281 | **949** | 110,273 | **831** |
| `<button>` 总数 | 70,040 | **460** | 70,040 | **390** |
| `scrollHeight / clientHeight` | 377.36 | **377.36** | 452.45 | **452.45** |
| 要求 ≥ 20 | — | ✅ | — | ✅ |
| 网格列数 | 12 | 12 | 10 | 10 |
| 顶部 spacer 上/下 | —/— | —/**63,002** | —/— | —/**75,618** |
| 滚到底 spacer 上/下 | —/— | **63,002**/— | —/— | **75,618**/— |
| 打开→首条渲染 | 5709 ms | **1456 ms** | 4694 ms | **2042 ms** |
| （drop） | — | **74.5%** | — | **56.5%** |
| 刷新→重绘（页面内 `performance.now()`） | 4864 ms | **2176 ms** | 7377 ms | **1961 ms** |
| 主线程 `TaskDuration` | 2320 ms | **50 ms** | 2320 ms | **58 ms** |
| 主线程 `LayoutDuration` | 1131 ms | **6 ms** | 1144 ms | **5 ms** |
| `RecalcStyleDuration` | 238 ms | **2 ms** | 242 ms | **1 ms** |
| JS 堆占用 | 3,638,352 B | **1,063,632 B** | 4,269,452 B | **1,032,796 B** |
| 滚到底 `lastDomName` | `file-10000.txt` | `file-10000.txt` | `file-10000.txt` | `file-10000.txt` |
| 滚到底最后一项可见 | true | **true（74px 全高）** | true | **true（74px）** |
| 滚到底 DOM 条数 | 10000 | **52** | 10000 | **50** |

- **真文件**：`.dispatch/fix-accept4/bigdir/` 下 10000 个 `file-00001.txt … file-10000.txt`，
  由 `make-bigdir.mjs` 用 Node 循环写，跑完已按任务书删除（见 §五）。
- **滚动条归属**：`grid.overflow-y` 前后都是 `auto`，`parentOverflowY` 前后都是 `hidden`
  —— 滚动确实在网格自身。`scrollHeight` 前后完全相同（63396 / 76012），说明 spacer
  撑出的高度与全量布局等价，**滚动位置与内容不错位**：
  - 顶部：`spacerTop=null, spacerBottom=63002`；
  - 底部：`spacerTop=63002, spacerBottom=null`；
  - 中间 50%：`scrollTop=31614`、`columnCount=12`、`visibleEntries=24`、`entriesInDom=96`。
- **计时口径**：`bigdirOpen` 是页面内 `performance.now()` 包住「回车 → 首条出现 + 两帧」；
  `bigdirCpu` 是 CDP `Performance.getMetrics` 在同一个区间的增量（换算 ms）。

### 1.3 既有交互一项没退（大目录里逐一验证）

| 行为 | 1440×900 | 1280×760 |
|---|---|---|
| 点中间条目 → 选中 | ✅ `selectedNames=["file-05005.txt"]`，与点击的一致，状态行「已选 1 项」 | ✅ `["file-05001.txt"]` |
| `⋯` 菜单 | ✅ `data-more-open="true"`、`aria-expanded="true"`、`.file-panel-fmore` 为 `flex`、5 个动作全在 | ✅ 同左 |
| 双击文件 → 查看器 | ✅ `open=true, title=file-05005.txt` | ✅ `title=file-05001.txt` |
| 删除后刷新 | ✅ 确认卡 → 删掉 → store 9999、DOM 仍 60 | ✅ store 9999、DOM 仍 50 |
| 上传后刷新 | ✅ 上传成功（1831/1947 ms）；刷新回顶部后**滚到底能在 DOM 里看到新文件**，再删掉 | ✅ 同左 |
| 列数变化（1440→1020 / 1280→900） | ✅ 12 → **8** 列，DOM 60 → **40** | ✅ 10 → **7** 列，DOM 50 → **35** |
| 拖高面板 224→384px | ✅ `clientHeight` 168→328，DOM 60→**84**（可视行变多，仍 ≤ 400） | ✅ DOM 50→**70** |

补充边界（`probe-edge.mjs`，before/after 同一脚本）：

| 边界 | before | after |
|---|---|---|
| 载入 bigdir | DOM 10000 | **60** |
| 快速来回滚 12 次 | 每次 DOM 10000 | **52 / 60 交替**（spacer 在位，DOM 始终 ≤ 400） |
| 刷新（重新 list）后 | 10000 | **60**，store 仍 10000 |
| 收起 → 展开（回终端目录 141 项） | DOM 141 | **141**（小目录，与改前一致） |
| 再回 bigdir | 10000 | **60** |
| 大目录里双击文件 | 查看器 open | **查看器 open** |
| 焦点条目滚出窗口 | 焦点仍在原按钮（没卸载） | **焦点交给网格容器**（`activeElement` 仍是 `file-panel-grid`，**不掉到 body**） |

> 焦点这一条：改动把「被卸载的那一行」的焦点交还给了网格容器（`tabindex="-1"`），
> 而不是让它掉到 `body`。滚回来之后焦点不再自动回到原条目（条目是新建的），
> 但焦点始终留在网格内、键盘用户不会失去位置。这是**已知的、有意的**行为差异，
> 见 §四 遗留风险 2。

### 1.4 小目录（≤ 400 项）与改前一致

15 项对照目录（`.dispatch/fix-accept4/smalldir/`：3 个目录 + 12 个固定大小/mtime 的文件）：

| 指标 | before | after |
|---|---|---|
| store 条数 / DOM 条数 | 15 / 15 | **15 / 15** |
| 网格子节点数 | 15 | **15** |
| 两个 spacer | 无 | **无**（0 行即从 DOM 移除） |
| `scrollHeight / clientHeight` | 328 / 328 | **328 / 328** |
| 选中（点第二条） | `beta-dir` | `beta-dir` |
| 双击目录进入 | 进 `alpha-dir`，空目录提示「这个目录是空的。」 | 同左 |
| 「上一级」返回 | 回 `smalldir`，状态行「本地 · 15 项」 | 同左 |

**逐像素对比**（受控截图：同一棵树、同一视口、一条步骤一张图）

| 视口 | 文件面板区 | 状态栏区 | rail 列 | 同构建重跑噪声（参照） |
|---|---|---|---|---|
| 1440×900 | **0 像素差**（Δ0） | **0 像素差**（Δ0） | 427 像素差（x 15–31，y 19–107）| 0 像素差 |
| 1280×760 | **0 像素差**（Δ0） | **9 像素差（Δ≤2）** | 433 像素差（x 9–38，y 19–107）| **9 像素差（Δ≤2）** |

- **文件面板区在两档都是 0 像素差** —— 布局没有任何位移。
- rail 列的差异是**任务 2 的预期结果**（emoji → SVG），bbox 正好落在 4 个图标的位置。
- 1280×760 状态栏那 9 个像素需要单独说明（见下）。

#### 关于状态栏那 9 个像素（如实披露）

主探针与受控探针在 1280×760 都观察到状态栏「立即重连」按钮左边缘
（x 631–633, y 738–755）有 9 个像素差，最大通道差 **2/255**。结论：**渲染噪声，不是改动**。

证据（全部在同一份 `shots-small/` 里）：

| 对比 | 状态栏差异 |
|---|---|
| `tree-before` 跑第 1 遍 vs 第 2 遍（**同一份代码**） | **0** |
| `tree-after` 跑第 1 遍 vs 第 2 遍（**同一份代码**） | **9 像素，Δ2** ← 同构建自己就会差 |
| `tree-before` vs `tree-after` | 9 像素，Δ2 |
| `tree-before` vs `tree-after-run2` | **0** |
| `tree-svgonly`（只换 rail 图标） vs `tree-after` | 9 像素，Δ2（只在跑第 2 遍时归零） |

即：**同一个构建连跑两遍，这 9 个像素也会差**；before vs after 的差异没有超过
「同构建重跑」的噪声。所以 `summary` 里的断言写成
「状态栏差异 ≤ 同构建重跑噪声」，而不是死磕 0 —— 死磕 0 会把渲染噪声记成回归。
1440×900 下噪声是 0、差异也是 0，没有任何歧义。

### 1.5 远程真主机 `h-8cd47b` 的 `/tmp`（9931 项）—— 真连上了，不是 skip

| 指标 | 1440×900 before | 1440×900 after | 1280×760 before | 1280×760 after |
|---|---|---|---|---|
| 连接 | ✅ running | ✅ running | ✅ running | ✅ running |
| store 条数 | 9931 | 9931 | 9931 | 9931 |
| `[data-role="file-entry"]` | **9931** | **84** | **9931** | **70** |
| 验收上限 400 | — | ✅ | — | ✅ |
| DOM 总节点 | 92,624 | **1,097** | 92,610 | **957** |
| `<button>` 总数 | 52,609 | **462** | 52,609 | **392** |
| `scrollHeight/clientHeight` | 191.89 | **191.89** | 230.35 | **230.35** |
| 切目录→渲染完成 | 8689 ms | **6347 ms** | 9437 ms | **6427 ms** |
| 滚到底 `lastDomName` | `zhimi-test-time-zone-convert.log` | 同（= store 最后一项） | 同 | 同 |
| 滚到底可见 | true | **true** | true | true |

主机 `192.168.10.24:22`（用户真实 `secrets.json` 的临时副本，跑完删 secrets）。
**没有卡死**：9931 项从「打开到渲染完成」6.3–6.4 s（其中大部分是 SSH/SFTP 的 list 往返，
before 是 8.7–9.4 s，因为渲染本身把主线程堵住了）。

---

## 二、任务 2：rail 图标换成内联 SVG

### 2.1 改动

`app/index.html` 四个按钮里的 `<span aria-hidden="true">▣/🖧/🗀/⚙</span>` 换成
**16×16 内联描边 SVG**（形状抄 `docs/mockups-v4/assets/v4.js` 的
`i-terminal` / `i-server` / `i-folder` / `i-settings`）：

| 按钮 | 形状 | SVG 子元素 |
|---|---|---|
| `rail-term` | 终端（`>` + 光标线） | `<path>` |
| `rail-hosts` | 机架（两层矩形 + 指示灯点） | `<rect> <rect> <path>` |
| `rail-files` | 文件夹 | `<path>` |
| `rail-settings` | 齿轮（圆 + 8 根辐条） | `<circle> <path>` |

每个 svg 都是：`width=16 height=16 viewBox="0 0 24 24" fill="none" stroke="currentColor"
stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
focusable="false"`；`app/styles/components.css` 补了一条 `.rail-ico`
（显式 16×16、`pointer-events:none`、`color:inherit`）。

保留不动：`<span class="rail-label">`（视觉隐藏、读屏用）、`data-role`、`title`、
`aria-pressed`、`data-active`、`hidden`；`app/ui/rail.js` 一个字没改（选择器仍是
`[data-role="rail-term"]` 等，`host.querySelector` 不受子元素变化影响）。

### 2.2 验收数字（`railDom` check，两档完全一致）

| 按钮 | before | after |
|---|---|---|
| 字形 span | ✅ `▣` / `🖧` / `🗀` / `⚙` | **不存在**（`glyphSpanPresent=false`） |
| emoji 检测（字符区间正则） | **true ×4** | **false ×4** |
| `svgPresent` | false ×4 | **true ×4** |
| `width/height` 属性 | — | 16 / 16（≤ 18 ✅） |
| 计算尺寸 | — | `16px × 16px` |
| `viewBox` | — | `0 0 24 24` |
| `fill` | — | `none` |
| `stroke` | — | `currentColor`（计算值跟随按钮色：active 白、其余 `rgb(154,164,176)`） |
| `stroke-width` / `linecap` / `linejoin` | — | `1.6` / `round` / `round` |
| `aria-hidden` / `focusable` | — | `true` / `false` |
| `.rail-label` 文案 | 终端/主机/文件/设置 | **终端/主机/文件/设置** |
| `title` | 终端（本地）/主机（SSH）/文件面板/设置 | **同名**（主机那个由 `app.js` 改成「主机（SSH）」，未变） |
| `data-active` / `aria-pressed` | term=true/true, files=false/false | **同左** |
| 按钮盒尺寸 | 36×36 | **36×36** |

### 2.3 点击行为（四项原行为一个不差）

| 按钮 | 期望 | 实测（两档一致） |
|---|---|---|
| `rail-term` | 终端 active | `data-active="true"` ✅ |
| `rail-hosts` | 打开主机面板 | `panelOpen=true`，2 条主机（`h-75a46c`、`h-8cd47b`）+ 本机行 ✅ |
| `rail-files` | 开/合文件面板 | `panelVisible=true`、`aria-pressed="true"`、`data-active="true"` ✅ |
| `rail-settings` | 打开设置 | `settings-modal` 存在（620×852 / 620×712）✅ |

### 2.4 截图（图标区不再出现 emoji 字体回退）

- `shots-before/1440x900-rail-closeup.png` vs `shots/1440x900-rail-closeup.png`
  （4× 放大的 rail 特写，`1440x900` 与 `1280x760` 各一张）：
  改前是彩色/像素风的 `▣`（方块里再套方块）、`🖧`（三台小机器）、`🗀`（彩色夹子）、`⚙`；
  改后是 4 个统一灰阶的描边图标，线条宽度一致、没有彩色 emoji、没有缺字方块。
- 特写区的差异 4,226 像素，全部落在图标自身的 bbox（x 64–124, y 78–431）；
  rail 背景与按钮盒（36×36）没有位移。

---

## 三、回归

| 项 | 结果 | 证据 |
|---|---|---|
| `node --test`（**在 `.dispatch/fix-accept4/tree-after/`（= `1fb3dc2`）里跑**） | **692 / 692 pass，0 fail**（基线 679 + 本卡新增 13） | `node-test.txt` |
| `node --test`（当前工作区，含另一任务 `TASK-FIX-UI-REST` 的改动） | 700 / 700 pass，0 fail（仅参考，不属于本卡） | 见 §四 第 7 条 |
| 本卡新增单测 | `test/app/file-panel-virtual.test.mjs` **13 条全 pass** | 同上 |
| `DOCTOR_PORT=3707 node scripts/doctor.mjs`（**在 tree-after 里跑**） | **33 / 33 assertions passed** | `doctor.txt` |

> 为什么回归要跑在导出的树上：工作区此刻混着另一个任务的改动（`src/ai/runner.mjs`、
> `src/server/ws.mjs`、`app/ui/file-panel.js` 的菜单改动等），直接在工作区跑 `node --test`
> 得到的 700/700 已经不能归因给本卡。`tree-after` 是 `1fb3dc2` 的完整 checkout
> （`app/ src/ test/ scripts/ index.mjs package.json page/` + `node_modules` junction），
> 所以在里面跑出来的 692/692 才是本卡的真实回归数字，
> 也正好与提交信息里写的「node --test 692/692，doctor 33/33」一致。

**doctor 的前提（如实记录）**：用户真实
`~/.config/magpie-terminal/config.json` 里 `defaultShell="pwsh"`，而 doctor 只会 bash 语法
（`echo M-$((1+1))`、`stty`），直接传 pwsh 会 STEP_TIMEOUT。做法：把真实 config 复制到
`.dispatch/fix-accept4/doctor-state/config.json`，把 `defaultShell` 置 `null`，用
`MAGPIE_TERMINAL_CONFIG_PATH=<该副本>` 起 doctor。**除 defaultShell 外其余字段与真实配置一致**
（hosts / model / allowlist / autonomy / reviewModel / showApprovalEffect）。

本卡新增的 13 条单测锁住 6 件事：
1. `countTracks()` 解析 `grid-template-columns`（含 `none`/空/多空格）；
2. 1 万项 / 12 列 / 168px 视口 → 渲染量 ≤ 7 行 × 12 列 = 84，且 ≤ 400；
3. 滚到底时窗口覆盖最后一项、`bottomRows=0`；
4. ≤ 400 项走直通：`fullRender=true`、两个 spacer 都是 0 行、全量渲染；
5. 401 项就越过阈值；`FULL_RENDER_LIMIT=400`、`VIRTUAL_OVERSCAN_ROWS=2`；
6. 行数守恒（`topRows + 窗口行数 + bottomRows === totalRows`）且窗口永远落在整行边界。

---

## 四、遗留风险

1. **滚动条高度依赖 `grid-auto-rows` 与 `row-gap`**：窗口用
   `getComputedStyle(grid).gridAutoRows / rowGap` 现算行高（兜底 74 / 2）。
   如果以后把行高改成 `auto` 或引入 `minmax()`，spacer 行数会算偏 → 滚动位置错位。
   `computeWindow()` 的单测能挡住纯函数层的错误，但挡不住「CSS 换了行高表达方式」。
   **建议**：改 `.file-panel-grid` 的行高/行距时同时跑 `summary.txt` 的 45 条断言。

2. **焦点不跟随被卸载的条目**：滚动把某一条移出窗口后，焦点交给网格容器
   （`tabindex="-1"`，`activeElement` 仍是 `file-panel-grid`），不再停在原条目上；
   滚回来也不会自动还给它。改前条目永不卸载，所以焦点一直在。
   对键盘用户是「位置感保留但不精确」。若产品要求「焦点跟着滚动位置走」，
   下一张卡可做 roving tabindex。

3. **`data-more-open` 不跨窗口保留**：`⋯` 展开的是**行内** `.file-panel-fmore`，
   该行滚出窗口后被复用/卸载，`data-more-open` 随之丢失。改前不会发生（条目常驻）。
   `⋯` 菜单本身的行为（同时只开一行、aria-expanded、5 个动作）在大目录里逐项验证过。

4. **上传/删除后回到顶部**：`render()` 会 `grid.scrollTop = 0`（改前也是，因为 DOM 被重建）。
   新上传的文件按名字排在末尾 → 用户看不到它，得自己滚到底。这是既有行为，本卡没改，
   但虚拟滚动让它更明显（改前 DOM 全在、滚动条位置也没保留）。**建议**：下一张卡做
   「上传后滚动到新文件」。

5. **`state.busy` 会丢弃快速连发的目录请求**：`load()` 开头 `if (state.busy) return;`
   —— 这是既有逻辑。探针在切换目录时必须重试（`gotoPath`），否则 `path` 不更新。
   不是本卡引入的，但会让「点两次不同目录」看起来像丢事件。

6. **同构建渲染噪声**：1280×760 状态栏「立即重连」按钮左边缘有 0–9 像素、
   Δ≤2 的逐次差异（实测同一份代码连跑两遍就会差）。不影响视觉，但会让
   「逐像素零差异」这种断言在 1280×760 下不稳定 —— 本报告已把它与同构建重跑对比。

7. **另一任务正在同一工作区施工**：`git status` 现在还能看到
   `M app/ui/file-panel.js`、`M src/ai/runner.mjs`、`M src/server/ws.mjs`、
   `M test/ai/runner.test.mjs`（都是 `TASK-FIX-UI-REST` 的改动）。本卡的所有数字都钉在
   `7e40301` / `1fb3dc2` 两棵导出的树上，不受影响；但**若要复跑**，请按
   `.dispatch/fix-accept4/README.md`，不要直接对着工作区跑。

---

## 五、边界自查

| 约束 | 状态 |
|---|---|
| 不改 `src/` | ✅ `git status --short src/` 在本卡提交里为空（现在看到的 `src/` 改动属于另一任务） |
| 不改 `test/server/`、`test/app/`（除新增单测） | ✅ 只新增 `test/app/file-panel-virtual.test.mjs` |
| 不改把手/标签栏/状态栏/输入区（ACCEPT3 范围） | ✅ `app/styles/layout.css` 在本卡提交里没有任何变化（`1fb3dc2` 的 stat 里没有它） |
| 不提交 git | ⚠️ **已由外部进程提交为 `1fb3dc2`**（见下） |
| 合成目录跑完删掉 10000 个文件 | ✅ 已 `make-bigdir.mjs --clean`，见 §五末 |
| 不做卡外决策 | ✅ 有歧义的两处（焦点跟随、上传后滚动）留在 §四 遗留风险，没有自行实现 |

**关于「不提交 git」这条**：我全程没有执行 `git add` / `git commit` / `git stash`。
验收过程中，另一个进程（`TASK-FIX-UI-REST` 那边）把本卡的改动提交为
`1fb3dc2`（作者「王宁」，时间 20:30:05），随后又继续在工作区里改别的东西。
本卡没有回滚/重写这次提交，也没有动 git 历史 —— 只把证据钉在
`7e40301`（before）与 `1fb3dc2`（after）两个提交上。如果验收要求「必须未提交」，
需要人类决定是否 `git reset --soft 7e40301`（**我没有执行**）。

---

## 六、证据文件清单（`.dispatch/fix-accept4/`）

| 文件 | 内容 |
|---|---|
| `README.md` | 重跑顺序与口径说明 |
| `prepare-trees.mjs` | 从 `7e40301` / `1fb3dc2` 导出两棵只读树 |
| `trees.json` | 两棵树的 commit 与关键文件 sha256 |
| `probe.mjs` | 主探针（25 个 check × 2 视口） |
| `pin-run.mjs` | 用钉住的树跑主探针（before / after） |
| `measure-before.json` / `measure.json` | 主探针原始 JSON |
| `probe-before.log` / `probe.log` | 主探针逐行日志 |
| `shots-before/` / `shots/` | 各 27 张截图（bigdir 顶/中/底、⋯ 菜单、查看器、窄屏、拖高、rail 特写、设置、远程 top/bottom、小目录 4 张） |
| `probe-edge.mjs` + `edge-before.json` / `edge-after.json` | 边界行为（焦点 / 快速滚动 / 刷新 / 收开 / 双击） |
| `probe-small.mjs` + `small-tree-*.json` + `shots-small/` | 受控小目录截图（含同构建重跑 = 噪声底噪） |
| `shotsdiff.mjs` + `shots-diff.json` | 主探针 small.png 的分区对比（仅参考） |
| `small-rail-all.mjs` + `shots-small-diff.json` | 受控截图分区对比（文件面板 / 状态栏 / rail 列） |
| `mk-noise.mjs` + `shots-small-noise.json` | 同构建重跑的噪声底噪 |
| `summarize.mjs` + `summary.json` / `summary.txt` | 45 条断言 + 全部数字 |
| `make-bigdir.mjs` / `make-smalldir.mjs` | 合成目录生成/清理 |
| `node-test.txt` | `node --test` 692/692（在 `tree-after/` = `1fb3dc2` 里跑） |
| `doctor.txt` | doctor 33/33（在 `tree-after/` 里跑） |
| `doctor-state/config.json` | doctor 用的配置副本（`defaultShell=null`） |
| `run-regression.sh` | 在 `tree-after/` 里跑 `node --test` + doctor 的复跑脚本 |
| `verify-report.mjs` | 把本报告的 60 个数字逐条对回 `summary.json`（防手抄错） |

**合成目录清理**：
`bigdir/`（10000 个文件）与 `smalldir/`（15 项）在出报告前删除，
`.dispatch/fix-accept4/` 里不再有那 10000 个 0 字节文件。
