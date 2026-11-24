# REPORT-FIX-ACCEPT

- 任务：`TASK-FIX-ACCEPT.md`（按 `ACCEPT-FUNC.md` / `ACCEPT-LAYOUT.md` 返工）
- 仓库：`C:/Users/41807/magpie-terminal`
- 日期：2026-11-24
- 证据目录：`.dispatch/fix-accept/`
- 结论：**A–H 全部完成；未做清单里的项目按卡片要求保持现状。**
- 回归：`node --test` **679/679**（基线 674 + 新增 5 条），`DOCTOR_PORT=3684 node scripts/doctor.mjs` **33/33**。

## 0. 环境、命令与证据布局

- Node：`D:/nodejs/install/node.exe`。
- 服务：`startServer` 真服务；主探针端口 **3686**，远程删除探针端口 **3687**；未触碰 3480 / 3477 / 3488 / 3496。
- 浏览器：headless Chrome（`Emulation.setDeviceMetricsOverride`，`prefers-color-scheme: dark`），两档视口 `1440×900`、`1280×760`。
- 状态：临时配置目录（复制本机 config / secrets / known_hosts），结束后删除 secrets；未写用户真实配置目录。
- 探针：
  - `.dispatch/fix-accept/probe.mjs`：主测量 + 截图；`before` / `after` 两次运行。
  - `.dispatch/fix-accept/probe-remote.mjs`：远程主机 `h-8cd47b` 真 SSH 删除；`before` / `after` 两次运行。
  - `.dispatch/fix-accept/summarize.mjs`：把 before/after/remote 的 `measure.json` 压成 `summary.json`。
- 原始数据：
  - `.dispatch/fix-accept/before/measure.json`、`before/probe.log`、`before/shots/`
  - `.dispatch/fix-accept/after/measure.json`、`after/probe.log`、`after/shots/`
  - `.dispatch/fix-accept/remote-before/measure.json`、`remote-after/measure.json`
  - `.dispatch/fix-accept/summary.json`（before → after 对照）
  - `.dispatch/fix-accept/logs/node-test.txt`、`logs/doctor.txt`、`logs/probe-after.txt`、`logs/probe-remote-after.txt`

复现命令：

```bash
"D:/nodejs/install/node.exe" --test
DOCTOR_PORT=3684 "D:/nodejs/install/node.exe" scripts/doctor.mjs
"D:/nodejs/install/node.exe" .dispatch/fix-accept/probe.mjs after
"D:/nodejs/install/node.exe" .dispatch/fix-accept/probe-remote.mjs after
"D:/nodejs/install/node.exe" .dispatch/fix-accept/summarize.mjs
```

`before` 数据是在应用修复前跑同一探针得到的；`after` 是最终代码再跑一次。

---

## A. P1 文件面板删除被误判为失败

### 改了什么

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/core/api.js` | `del()`，91–120 行 | `if (response.status === 204)` → `if (response.ok)`；204 返回 `data:null`，其他 2xx 解析 JSON 后返回 `{ok:true,data}`；非 2xx 仍走原来的 `{code,userText}` 透出。 |
| `test/app/api-delete.test.mjs` | 新增 | 最小 DOM 桩 + 替换 `fetch`，锁住三个行为：200+JSON 成功、204 成功且 `data:null`、409 透出 `DIR_NOT_EMPTY`。 |
| `test/server/fs-route.test.mjs` | 新增 `DELETE 契约组`，367–384 行 | 锁住服务端 `DELETE /api/fs` 成功时是 **200 + JSON `{path,type}`**（不是 204 空 body），且磁盘文件消失。 |

### 前后实测（两档视口一致）

本地文件 `fix-del-file.txt`：

| 指标 | before | after |
|---|---|---|
| 磁盘文件删除后是否消失 | `false`（已删） | `false`（已删） |
| 列表条目是否还在 DOM | **`true`** | **`false`** |
| 状态栏提示 | **「本地服务返回 HTTP 200，请重试。」** | **「已删除 fix-del-file.txt」** |

本地空目录 `fix-del-empty-dir`：

| 指标 | before | after |
|---|---|---|
| 列表条目是否还在 DOM | **`true`** | **`false`** |
| 状态栏提示 | 「本地服务返回 HTTP 200，请重试。」 | 「已删除 fix-del-empty-dir」 |

非空目录 `fix-del-nonempty`（不勾递归）：

| 指标 | before | after |
|---|---|---|
| 列表条目是否还在 DOM | `true` | `true` |
| 磁盘目录是否还在 | `true` | `true` |
| 状态栏提示 | 「这个目录不是空的（1 项）。要连内容一起删就先勾选「递归删除」。」 | 同左（409 文案保持） |

远程主机 `h-8cd47b`（192.168.10.24，`/tmp`，真实 SSH）：

| 指标 | before | after |
|---|---|---|
| 连接 / 导航 `/tmp` | `connected=true`、`pathOk=true` | `connected=true`、`pathOk=true` |
| 删除后条目是否还在 DOM | **`true`** | **`false`** |
| 状态栏提示 | **「本地服务返回 HTTP 200，请重试。」** | **「已删除 magpie-fix-remote-…txt」** |
| 远端文件 | `NOT_FOUND`（真的删了） | `NOT_FOUND`（真的删了） |

证据截图：

- 本地：`.dispatch/fix-accept/before/shots/1440x900-A-file-delete-after.png`（旧条目仍在）
- 本地：`.dispatch/fix-accept/after/shots/1440x900-A-file-delete-success.png`、`…-A-file-delete-after.png`
- 远程：`.dispatch/fix-accept/remote-before/remote-delete-after.png`、`remote-after/remote-delete-after.png`
- 两档：`1280x760-A-file-delete-success.png` / `…-A-file-delete-after.png`

### 为什么客户端逻辑也做了单测

`app/core/api.js` 只依赖 `document.querySelector` 读 token 和全局 `fetch`，因此新增 `test/app/api-delete.test.mjs`，用最小 DOM 桩直接验证 `del()`；同时保留浏览器端真删除作为最终兜底（真服务 + 真磁盘 + 真远程 SSH）。

---

## B. P1 暗色 `--term-muted` 太暗 + 确认卡配色

### 改了什么

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/tokens.css` | 25–26、113–116 行 | 新增 `--term-warn-border` / `--term-warn-bg`；暗色块新增 `--term-muted: #9aa4b0`；暗色确认卡 token 对齐 mockup：边框 `rgba(227,179,65,0.38)`、背景 `rgba(227,179,65,0.07)`。 |
| `app/styles/components.css` | 525–534、604–608 行 | 确认卡改用新 token；`padding: 8px → 10px`；按钮组右留白 `30px → 40px`。 |

> 判断：明色主题没有 mockup 基准，新增 token 用同色相的低透明度值（`rgba(122,74,0,0.38/0.07)`），避免散写；暗色严格按 `v4.css` 的 `rgba(227,179,65,…)`。

### 前后实测（`1440×900`，`1280×760` 同值）

| 文本 | 背景 | before 前景/背景 → 比值 | after 前景/背景 → 比值 | 阈值 |
|---|---|---|---|---|
| 确认卡「跳过」 | 确认卡 | `rgb(128,128,128)` / `rgb(62,56,46)` → **2.95** | `rgb(154,164,176)` / `rgb(34,34,31)` → **6.31** | 正文 ≥4.5 |
| 确认卡 why | 确认卡 | 同上 → **2.95** | 同上 → **6.31** | 次要 ≥3 |
| 主机地址（hover） | host hover | `rgb(128,128,128)` / `rgb(55,71,95)` → **2.39** | `rgb(154,164,176)` / `rgb(55,71,95)` → **3.73** | 次要 ≥3 |
| 设置页选中档位说明 | 选中卡 | `rgb(128,128,128)` / `rgb(55,71,95)` → **2.39** | `rgb(154,164,176)` / `rgb(55,71,95)` → **3.73** | 次要 ≥3 |

确认卡结构值：

| 指标 | before | after |
|---|---|---|
| `border-color` | `rgb(255,204,128)`（满亮） | `rgba(227,179,65,0.38)` |
| `background` | `rgba(255,204,128,0.18)` | `rgba(227,179,65,0.07)` |
| `padding` | `8px` | `10px` |
| 按钮组 `padding` | `2px 30px 2px 0px` | `2px 40px 2px 0px` |

截图：

- 确认卡：`.dispatch/fix-accept/before/shots/1440x900-B-approval-card.png` → `.dispatch/fix-accept/after/shots/1440x900-B-approval-card.png`
- 主机面板：`.dispatch/fix-accept/before/shots/1440x900-D-hosts-panel.png` → `after/…/D-hosts-panel.png`
- 设置页：`.dispatch/fix-accept/before/shots/1440x900-B-settings.png` → `after/…/B-settings.png`

---

## C. P1 AI 把手命中区只有 22×78

### 改了什么

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/layout.css` | 187–201 行 | 保留 22px 视觉宽；新增透明 `::before`，收起态向左扩 26px（视口右缘裁掉的部分不浪费），展开态左右各 13px，命中宽 48px。用 `--term-handle-hit`（tokens.css 已声明）。 |

### 前后实测

| 指标 | before | after |
|---|---|---|
| 视觉尺寸 | 22×78 | **22×78（不变）** |
| `getBoundingClientRect()` 宽度 | 22 | 22（视觉） |
| 命中测试连续宽度 | **22px** | **48px** |
| 左侧外 4px 命中 | `false` | `true` |
| 点最外侧 5px 内是否展开 | 否 | **`true`（`data-ai-open=true`）** |
| 终端文字选择（xterm selection rects） | 2 | 2（把手热区外开始拖动） |

截图：`.dispatch/fix-accept/before/shots/1440x900-C-handle.png` → `after/…/C-handle.png`；两档均有。

> 判断：把手贴在视口右缘，`inset: 0 -13px` 右半边会被视口裁掉，实际只有 35px，达不到 48px。因此收起态把整条 48px 放在把手左侧；展开后两侧都有空间再对称。这样会在终端最右侧形成一条 26px 宽的透明热区（只覆盖把手 78px 高），热区外的终端文字仍可正常选中（实测 selection rects=2）。如果产品不能接受这 26px，需要把把手移进主区或改成更大的视觉宽，属于设计改动，不在本卡范围。

---

## D. P1 编辑/删除/更多操作 hover-only

### 改了什么

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/components.css` | 1644–1656 行 | 主机工具默认 `display:flex; opacity:.55`，hover/focus/`data-tools` 时 `opacity:1`；按钮 `min-height:28px`、`white-space:nowrap`。 |
| `app/styles/components.css` | 2935–2962 行 | 会话操作默认 `opacity:.55`，hover/focus 时 1；`.sess-action` 命中区 `min-width/min-height:28px`。 |
| `app/styles/components.css` | 2323–2365 行 | 文件条目新增常显 `.file-panel-more-toggle`（⋯，28×28，opacity .7）；点开/选中/hover 展开 `.file-panel-fmore`。 |
| `app/ui/file-panel.js` | 323–338 行 | 每行创建「⋯」按钮，维护 `data-more-open` 与 `aria-expanded`；点击/双击选择逻辑加保护。 |
| `app/styles/components.css` | 3176–3184 行 | `@media (hover:none)` 下工具/会话操作/文件更多 opacity 1。 |

### 前后实测（不 hover、不右键，鼠标移到 4,4）

| 元素 | before | after |
|---|---|---|
| 主机编辑/删除 | `display: none` | **`display: flex`、`opacity: 0.55`** |
| 主机编辑按钮尺寸 | 0×0（隐藏） | **32×28** |
| 会话改名/删除 | `opacity: 0` | **`opacity: 0.55`** |
| 会话按钮尺寸 | 31×17.5 | **31×28** |
| 文件行「⋯」 | 不存在 | **存在，`display:grid`、`opacity:0.7`、28×28** |

截图：

- 会话：`.dispatch/fix-accept/before/shots/1440x900-D-session-actions.png` → `after/…/D-session-actions.png`
- 主机：`…/D-hosts-panel.png`
- 文件：`…/D-file-panel-no-hover.png`（每行可见「⋯」）、`…/D-file-actions-expanded.png`（点开后动作）
- 两档均有。

---

## E. P1 toast 压住状态栏

### 改了什么

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/layout.css` | 257–261 行 | `bottom: calc(var(--term-gap) * 2)`（16px）→ `bottom: calc(var(--term-statusbar-height) + var(--term-gap))`（41px）。 |

### 前后实测

| 视口 | 指标 | before | after |
|---|---|---|---|
| 1440×900 | toast 与状态栏相交面积 | **5,780px²**（340×17） | **0** |
| 1440×900 | toast 底边 / 状态栏顶边 | 884 / 867 | 859 / 867（8px 间隙） |
| 1440×900 | toast 栈 `bottom` | `16px` | **`41px`** |
| 1280×760 | toast 与状态栏相交面积 | **5,780px²** | **0** |
| 1280×760 | toast 底边 / 状态栏顶边 | 744 / 727 | 719 / 727 |

截图：`.dispatch/fix-accept/before/shots/1440x900-E-toast.png`、`1280x760-E-toast.png` → `after/…/E-toast.png`。

---

## F. P2 模型下拉遮住输入框

### 改了什么

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/components.css` | 952–966 行 | 菜单 `bottom:40px` → `bottom: calc(100% - 9px)`，把菜单底边锚到 `composer-box` 上沿（composer 的 padding-top 是 9px）。 |
| `app/ui/ai-drawer.js` | 616–632 行 | 打开时按 `composerBox.getBoundingClientRect()` 计算可用高度，设置 `maxHeight = clamp(80..240, 可用高度)`，窗口很矮时不顶出抽屉。 |

### 前后实测（输入框放大到 111px，composer-box 高 132px）

| 视口 | 指标 | before | after |
|---|---|---|---|
| 1440×900 | 菜单与 composer-box 相交面积 | **38,163px²** | **0** |
| 1440×900 | 菜单 rect | `top 593.5, bottom 827` | `top 453.5, bottom 687`（正好在 box 上沿 687） |
| 1440×900 | 菜单完整可见（不超抽屉） | `true` | `true` |
| 1280×760 | 菜单与 composer-box 相交面积 | **38,163px²** | **0** |
| 1280×760 | 菜单 rect | `top 453.5, bottom 687` | `top 313.5, bottom 547`（box 上沿 547） |

截图：`.dispatch/fix-accept/before/shots/1440x900-F-model-menu.png` → `after/…/F-model-menu.png`；两档均有。

---

## G. P2 输入框拖拽方向反了

### 改了什么

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/ui/ai-drawer.js` | 1266–1271 行 | `applyManualHeight(startHeight + (moveEvent.clientY - startY))` → `startHeight + (startY - moveEvent.clientY)`：向上拖（clientY 变小）变高，向下拖变矮。 |
| `app/ui/ai-drawer.js` | 1206–1215 行 | 夹紧到 `COMPOSER_LINE_HEIGHT (19.375)` 与现有 `cap` 之间；最小值保留小数，不再四舍五入成 19px。 |

### 前后实测（起点 99px，拖 40px）

| 操作 | before | after |
|---|---|---|
| 向上拖 40px | 99 → **59**（变小） | 99 → **139**（变高） |
| 向下拖 40px | 99 → **139**（变大） | 99 → **59**（变矮） |
| 拖到上限 | 347（1440）/ 291（1280） | 347 / 291（现有上限保持） |
| 拖到下限 | 19.38 | 19.375 |

截图：`.dispatch/fix-accept/before/shots/1440x900-G-composer-drag.png` → `after/…/G-composer-drag.png`。

---

## H. P2 其余低成本修正

### H1. `L1-08` 会话标题 `title` + 两行截断

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/ui/ai-drawer.js` | 458–460 行 | `<b>` 增加 `title: titleText`。 |
| `app/styles/components.css` | 2917–2927 行 | `.mi-main b` 改 `display:-webkit-box; -webkit-line-clamp:2; white-space:normal; overflow-wrap:anywhere`。 |

| 指标 | before | after |
|---|---|---|
| 长标题 `title` | `null` | 完整标题 |
| `-webkit-line-clamp` | `none` | `2` |
| `white-space` | `nowrap` | `normal` |
| 长标题高度 | 16.5px（一行） | 33px（两行） |

截图：`after/…/D-session-actions.png`。

### H2. `L1-09` 主机地址 `title`

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/ui/hosts-panel.js` | 719–722 行 | 地址文本抽成 `addressText`，`.host-addr` 同时设 `title`。 |

| 指标 | before | after |
|---|---|---|
| `.host-addr` `title` | `null` | 完整 `user@host:port · 认证方式`（实测示例含 `127.0.0.1:2222 · 私钥`） |

截图：`after/…/D-hosts-panel.png`。

### H3. `L1-10` 工具命令换行

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/components.css` | 448–462 行 | `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` → `white-space:pre-wrap; overflow-wrap:anywhere; text-overflow:clip`。 |

| 指标（142 字长命令） | before | after |
|---|---|---|
| `white-space` | `nowrap` | `pre-wrap` |
| `overflow-wrap` | `normal` | `anywhere` |
| `scrollWidth / clientWidth` | 1127 / 362 | **362 / 362** |
| `scrollHeight / clientHeight` | 26 / 26（单行省略） | **82 / 82（完整换行）** |
| `fullyVisible` | `false` | **`true`** |

截图：`.dispatch/fix-accept/before/shots/1440x900-H10-tool-command.png` → `after/…/H10-tool-command.png`。

### H4. `L1-11` `box-sizing: border-box`

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/components.css` | 199–208 行（drawer-head）、2050–2062 行（file-panel）、2103–2114 行（file-panel-toolbar）、3039–3053 行（ai-ctx） | 补 `box-sizing: border-box`。 |

| 元素 | 声明 | before 实测 | after 实测 |
|---|---|---|---|
| `drawer-head` | 48 | **49** | **48** |
| `ai-ctx` | 30 | **31** | **30** |
| `file-panel` | 224 | **225** | **224** |
| `file-panel-toolbar` | 34 | **35** | **34** |

截图：`after/…/H14-drawer-head.png`、`D-file-panel-no-hover.png`。

### H5. `L1-13` 可点区 ≥28×28

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/components.css` | 660–665 行 | 审核角标 `::before` 扩 4px（视觉仍 20×20，命中 28×28）。 |
| `app/styles/components.css` | 1150–1160 行 | toast 关闭 `min-width/min-height:28px`。 |
| `app/styles/components.css` | 2949–2963 行 | `.sess-action` `min-width/min-height:28px`。 |
| `app/styles/components.css` | 2203–2217 行 | 文件图标按钮 22×22 → 28×28。 |

| 元素 | before | after |
|---|---|---|
| 审核角标 | 视觉 20×20，命中 20×20 | 视觉 20×20，**命中 28×28（左外 3px 命中）** |
| toast 关闭 | 19.6×19.6 | **28×28** |
| 会话改名/删除 | 31×17.5 | **31×28** |
| 文件图标按钮 | 22×22 | **28×28** |

截图：`B-approval-card.png`、`E-toast.png`、`D-session-actions.png`、`D-file-panel-no-hover.png`。

### H6. `L1-16` 文件面板左内边距统一 9px

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/components.css` | 2103–2114 行（toolbar）、2388–2400 行（status） | toolbar 左 6px → 9px；status 左 10px → 9px；grid 保持 9px。 |

| 区域 | before | after |
|---|---|---|
| 工具栏 | 6px | **9px** |
| 网格 | 9px | **9px** |
| 状态行 | 10px | **9px** |

截图：`after/…/D-file-panel-no-hover.png`。

### H7. `L1-14` 抽屉头字体层级

| 文件 | 位置 | 改动 |
|---|---|---|
| `app/styles/components.css` | 2664–2672 行（`.sess-title`）、2686–2694 行（`.sess-sub`） | `.sess-title` 11.5px → **12px / 600**；`.sess-sub` 9.5px → **10.5px / `--term-dim`**。 |

| 指标 | before | after |
|---|---|---|
| 终端名 `.sess-title` | 11.5px / 600 / `--term-fg-2` | **12px / 600 / `--term-fg-2`** |
| 当前会话 `.sess-sub` | 9.5px / `--term-dim` | **10.5px / `--term-dim`** |

> 判断：卡片同时给了「终端名不该比当前会话名更抢眼」和具体的 `.sess-title` 12px/600、`.sess-sub` 10.5px/dim 两组要求。后者如果交换含义，会与 `docs/mockups-v4/ai-chat.html`、`v4.css` 的「终端名在上、当前会话在副行」结构冲突。因此按**卡片给出的具体字号**执行，不交换 DOM 顺序；副行从 9.5px 提到 10.5px，可读性提升，同时保持设计稿的信息结构。若产品坚持“当前会话在上”，需要单独立项改结构。

截图：`.dispatch/fix-accept/before/shots/1440x900-H14-drawer-head.png` → `after/…/H14-drawer-head.png`。

---

## 回归与自检

### 全量测试

```text
ℹ tests 679
ℹ suites 0
ℹ pass 679
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

- 原始输出：`.dispatch/fix-accept/logs/node-test.txt`
- 基线 674；本卡新增 5 条：`test/app/api-delete.test.mjs` 3 条 + `test/server/fs-route.test.mjs` 的 `DELETE 契约组` 2 条（组 + 子测试）。
- **没有删除或放宽任何既有断言。**

### doctor

```text
doctor: 33/33 assertions passed
```

- 原始输出：`.dispatch/fix-accept/logs/doctor.txt`
- 运行后快照：`.dispatch/fix-accept/logs/doctor-report.after.json`

### 自检清单

- [x] 全量测试 + doctor 通过，且没有删/放宽任何既有断言。
- [x] 每条修复都有“改前 → 改后”的实测数值（见 `summary.json` 与各节表格），不是“看起来好了”。
- [x] 没有引入新依赖、没有改 `docs/`、没有改用户可见文案的语义（仅新增 `title` 提示；409/错误文案原样保留）。
- [x] 没残留自己起的服务/浏览器进程；3480/3477/3488/3496 一律未碰。探针端口 3686/3687 已关闭，9411 无 LISTENING；Chrome 均由 `withPage` 的 finally `taskkill /T /F` 清理。
- [x] 证据全部落在 `.dispatch/fix-accept/`，含探针、日志、截图、before/after 原始 JSON。

---

## 未做清单（按卡片要求保持现状）

1. **F04 模型选择位置**：验收卡要求“输入框左侧”，实际实现是“输入框下方一行，模型名在发送键左侧、无边框”。卡片明确说这是措辞问题、符合用户原始要求，**保持现状**；本卡只修了 F 项菜单遮挡。
2. **F09 把手与视口中心差 16.5px**：把手对齐的是 `.main` 中心（它所在的那条边），不是缺陷，**不改**。
3. **L1-07 标签栏 34px / 状态栏 33px**：与设计稿 40/26 的差属设计选择，需人类拍板，**不改**。
4. **L1-12 rail 图标换 SVG**：视觉语言改造，超出返工范围，**不改**。
5. **L1-15 远程大目录虚拟列表**：性能改造，单独立项，**不改**。
6. **F17 无 token 返回 403（不是 401）**：403 已是拒绝，语义可接受；`C:/Windows` 可读属本机文件管理器设计范围，不收紧，**不改**。

## 风险与判断

1. **C 的 26px 透明热区**：为了在视口右缘也达到 48px，收起态命中区整体放在把手左侧，会在终端最右侧遮住 26px×78px 的点击/选字。热区外的终端文字选择已实测正常（xterm selection rects=2）。若产品不接受，需要移动把手或增大视觉宽，属于设计变更。
2. **D 的常显工具会压缩文本**：主机工具常显后，212px 面板里地址可见宽度减少（实测 `addrHidden=30px`），已用 `title` 提供全文；会话操作常显后长标题可用宽度减少，已用两行截断 + `title` 补偿。
3. **文件「⋯」是新增的轻量入口**：没有新增图标体系，沿用字符 `⋯`；动作仍复用原有文字按钮。文件条目本身是 `<button>`，内部仍嵌套操作按钮（既有实现就是这样），本次只对点击/双击做了 `closest` 保护，未重构 DOM。
4. **模型菜单高度只在打开时计算**：窗口尺寸变化时不会实时重算 `maxHeight`；当前两档视口都完整可见。若要做成完全响应式，可加 resize 监听，但超出本卡最小改动。
5. **B 的明色 token**：mockup 是暗色基准；明色 `--term-warn-border/bg` 采用同色相值，未做明色视觉验收。
6. **H7 的层级解释**：按卡片给出的具体字号执行，未交换“终端名 / 当前会话”的 DOM 顺序；理由见 H7。
7. **A 的 2xx 解析**：`del()` 对任何 2xx 都成功；如果未来某 DELETE 端点返回 2xx 非 JSON，`data` 会是 `null` 但仍算成功。当前所有 DELETE 端点要么 204，要么 200+JSON。
