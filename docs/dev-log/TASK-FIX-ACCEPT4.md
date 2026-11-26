# TASK-FIX-ACCEPT4：文件面板虚拟滚动 + 左侧 rail 换 SVG 图标

两项，都是布局/性能收尾。**本卡在 TASK-FIX-ACCEPT3 完成并提交后才可开工**（同一批 CSS 文件，避免互相覆盖）。

## 现状事实
- 仓库 `C:/Users/41807/magpie-terminal`，HEAD `7e40301`，Node `D:/nodejs/install/node.exe` v24.16.0，测试基线 **679/679**（`node --test`）。
- 文件面板：`app/ui/file-panel.js`（约 1100 行），网格容器 `[data-role="file-panel-grid"]`，每个条目 `[data-role="file-entry"]`（`<button>`，内含图标、名称、`⋯` 更多按钮）。渲染入口是遍历 `state.entries` 全量 `appendChild`（见 `renderGrid`/`renderEntry`）。远程目录 `/tmp` 实测 **9931 项 → 42677 个 button 节点**（ACCEPT-LAYOUT.md L1-15），首次渲染与滚动明显卡。
- rail：`app/index.html:24-43` 四个按钮 `rail-term` / `rail-hosts` / `rail-files` / `rail-settings`，图标是字符 `▣ 🖧 🗀 ⚙`（`<span aria-hidden="true">`），样式在 `app/styles/layout.css`（`.rail` 区段）与 `app/styles/components.css`。ACCEPT-LAYOUT.md L1-12：设计稿（`docs/mockups-v4/`）是描边 SVG 图标，当前是 emoji/字形，跨平台字形不一致。

## 任务 1：文件面板虚拟滚动（只渲染可视窗口）
目标：10000 项目录下 **DOM 里 `[data-role="file-entry"]` 不超过 400 个**，滚动、点击、更多菜单、删除、双击查看、上传按钮全部照常。

- 做法自由，但必须满足：
  1. `[data-role="file-panel-grid"]` 是可滚动容器（若现在滚动在外层，改成网格自身 `overflow-y: auto`），滚动条高度按「全量条目」计算，能滚到底看到最后一项。
  2. 只渲染可视行 ± 2 行；用上下 spacer（或 padding-top/bottom）占位，保证滚动位置与内容不错位。
  3. 列数变化（窗口宽度变化 / 拖高）要重算每行条目数并重渲染窗口；`ResizeObserver` 或 `window.resize` 均可。
  4. 选中态、`⋯` 菜单、双击打开、删除后刷新、上传后刷新、`data-more-open` 等既有行为不得回退。
  5. 小目录（≤400 项）行为与现在一致（截图对比不得出现布局差异）。
- 验收数字（真浏览器量）：
  - 构造一个 10000 项的合成目录（`.dispatch/fix-accept4/bigdir/` 下生成 10000 个 0 字节文件，或服务端注入？**用真文件**，用 Node 循环写，别改 `src/`），打开该目录后：
    - `[data-role="file-entry"]` 计数 ≤ 400；
    - `.file-panel-grid` `scrollHeight / clientHeight` ≥ 20（可滚动）；
    - 滚到底部后最后一项 `data-name` 出现在 DOM 中且可见；
    - 点击中间某个条目能选中（`data-selected="true"` 或现有选中样式），`⋯` 菜单能打开；
    - 从打开到渲染完成耗时（`performance.now()` 包裹）记录，与改动前 baseline 对比（baseline 你自己改前跑一次）。
  - 远程真主机 `h-8cd47b` 的 `/tmp`（9931 项）也要打开一次，确认不再卡死、DOM 节点数 ≤ 400；若该主机不可达，如实记为 skip 并写清原因，不算通过。

## 任务 2：rail 图标换成内联 SVG
- 四个按钮的字符/emoji 换成 **16×16 内联 SVG**（`fill="none"`、`stroke="currentColor"`、`stroke-width="1.6"`、`stroke-linecap="round"`、`stroke-linejoin="round"`、`viewBox="0 0 24 24"`、`aria-hidden="true"`、`focusable="false"`）：
  - `rail-term`：终端（方框 + `>` 提示符）；
  - `rail-hosts`：服务器/主机（两层矩形或机架）；
  - `rail-files`：文件夹；
  - `rail-settings`：齿轮。
- `<span class="rail-label">` 与按钮的 `data-role` / `title` / `aria-pressed` / `hidden` 属性全部保留；`app/ui/rail.js` 的选择器与事件不得改坏。
- 视觉：图标 16px、颜色 `currentColor`（跟随现有状态色），active/hover 与现在一致；`docs/mockups-v4/` 里若有对应图标，按它的形状抄。
- 验收：四个按钮 `svg` 存在且 `width/height <= 18`；按钮点击仍分别触发「终端 active」「主机面板」「文件面板」「设置」原行为；截图与改前对比，图标区不出现 emoji 字体回退方块。

## 不做
- 不改 `src/`、`test/app/`、`test/server/`（除新增探针与必要的文件面板单元测试例外：如你为虚拟窗口逻辑抽了纯函数，可在 `test/app/` 下加测试，其它不动）。
- 不改把手/标签栏/状态栏/输入区（TASK-FIX-ACCEPT3 范围）。
- 不提交 git（禁止 `git add` / `git commit` / `git stash`）。

## 自测与交付
1. `.dispatch/fix-accept4/probe.mjs`：真 headless Chrome（`.dispatch/cdp.mjs`），暗色，**1440×900 与 1280×760**，起真服务（端口 3705/3706；token 用 `server.token`），跑上面全部数字；原始 JSON → `.dispatch/fix-accept4/measure.json`，截图 → `.dispatch/fix-accept4/shots/`（含 bigdir 顶部/中间/底部、rail 特写）。
2. 回归：`node --test` **679/679+**（新增测试可超过 679，但 fail 必须 0）→ `.dispatch/fix-accept4/node-test.txt`；`DOCTOR_PORT=3707 node scripts/doctor.mjs` **33/33** → `.dispatch/fix-accept4/doctor.txt`。**注意**：用户真实 `~/.config/magpie-terminal/config.json` 现在 `defaultShell="pwsh"`，而 doctor 只会 bash 语法（`echo M-$((1+1))`/`stty`），直接把 defaultShell=pwsh 传进去会 STEP_TIMEOUT。做法：把真实 config 复制到 `.dispatch/fix-accept4/state/config.json`，把 `defaultShell` 置 null，用 `MAGPIE_TERMINAL_CONFIG_PATH=<该文件>` 起 doctor，并如实记录这一前提。
3. `REPORT-FIX-ACCEPT4.md`（仓库根）：before/after 数字（DOM 节点数、渲染耗时、滚动高度、远程 9931 项）、rail 图标截图、回归结果、遗留风险。标「待验收」。

## 边界
- 不做卡外决策；有歧义返回 needs_clarification。
- 合成目录生成脚本放 `.dispatch/fix-accept4/`，跑完删掉那 10000 个文件（不要留在磁盘上）。
