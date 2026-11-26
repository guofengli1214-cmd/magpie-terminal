# REPORT-V4E — 布局与 AI 抽屉重做（待验收）

- 任务卡：`TASK-V4-E.md`
- 执行状态：**待验收**（未 commit）
- 执行范围：仅 `app/`（HTML / JS / CSS）；未改 `src/`、未改 `docs/mockups-v4/`、未改 `package.json`、未新增依赖。
- 设计依据：`docs/mockups-v4/layout.html`、`ai-chat.html`、`assets/v4.css`、`CHANGES-V4.md` §1/§2/§4。

---

## 1. 做了什么

### 1.1 骨架与布局

- `app/index.html`
  - 删除 `rail-ai` 按钮与 `rail-unread` 圆点。
  - `#root[data-ai-open="false"]` 保持默认收起。
  - 把手 `ai-handle` 留在主区右缘，角标 `ai-handle-badge` 留在把手内部；补上 `aria-expanded`。
  - 抽屉移到 `main` 内，成为不占网格列的覆盖层。
- `app/styles/layout.css`
  - `#root` 回到 `rail(48px) + main(1fr)` 两列 + 状态栏一行。
  - 抽屉：`position:absolute; top:0; right:0; bottom:0; width:384px`，收起 `translateX(100%)`、展开 `translateX(0)`；关闭态 `pointer-events:none`。
  - 抽屉边只由 `border-left: 1px solid var(--term-line-2)` 画，没有 inset 线 / `::before` 边。
  - 把手 22×78，垂直居中；展开时 `right:384px` 跟到抽屉左缘；`z-index:32` 高于抽屉 `30`。
  - 标签条 34px、状态栏 33px；终端容器 padding 归零，xterm 自己留 2px。
- `app/styles/tokens.css`
  - 补充 V4 需要的语义 token：`--term-panel-2 / --term-raise / --term-line / --term-line-2 / --term-line-3 / --term-fg-2 / --term-dim / --term-accent-line / --term-radius-lg / --term-tabbar-height / --term-statusbar-height`。
  - 暗色一组按设计稿落地；组件 CSS 不出现颜色字面量。

### 1.2 选中态

- 删除/未引入竖线、顶条、边框发光：
  - rail 选中态只留底色 + 文字色。
  - tab 选中态只留底色 + 文字色 + 图标色（保留 tab 与终端的接缝 border，这是轮廓不是标记线）。
- `grep 'inset 2px'` / `grep 'inset 0 1px'` 在 `app/styles/*.css` 中均为 0；rail/tab 选中态没有 `::before`。

### 1.3 输入区 / 模型菜单

- `app/ui/ai-drawer.js`
  - 删除头部「收起」按钮（`ai-close` 不再生成）。
  - 模型从 `<select>` 改为纯文本按钮 `model-select`：无边框、无常态底色、只有 9px 下箭头；菜单 `model-menu` 锚定 `bottom:40px; right:8px`，点外部 / Esc 关闭。
  - 输入区改为 `.composer` + `composer-box` + `textarea[data-role="agent-input"]` + 框内右下 `composer-hint` + 顶部 `agent-grow`。
  - 发送按钮文本 `↑`，保留 `aria-label="发送"`；`agent-stop` 保留。
  - 自动增高 1→6 行（19.375px/行，上限 116px）；拖 `agent-grow` 到宿主高度 40%（不小于 116px），写 `localStorage['magpie.term.composerHeight']`；重新输入回到自动增高。
- `app/styles/components.css`
  - 移植设计稿的 composer / composer-box / composer-hint / composer-grip / model-text / model-menu / send 样式。
  - `composer-box` 用 `box-sizing:border-box; padding:0 10px 19px`，保证框高 = 输入框高 + 19px padding + 2px border。

### 1.4 开合 / toast / 主机面板

- `app/app.js`
  - 把手 click → `toggleAi()`（开一次、再点收起）。
  - `applyAiOpen()` 只改 `#root[data-ai-open]` 与 `aria-expanded/title`，**删掉 `terminalView.resizeAll()`**。
  - `attachActive()` 不再在 fit 前用初始 80×24 `sendResize`，避免多一次 SIGWINCH。
  - 新建标签 `pty.create` 带真实 `cols/rows`（`terminalView.proposeDimensions()`），并记 `pendingCreateCount`；命中 `session.created` 时只建标签 + attach，不走恢复式 replay。
- `app/ui/toast.js`
  - `render(snapshot)` 开头：`snapshot.aiOpen === true` 时清空渲染节点并 return，不动 agentStore 的待确认数据。
  - 同时订阅 agentStore 与 sessionStore；抽屉从开→关会重新渲染，toast 重新出现。
- `app/ui/hosts-panel.js`
  - 打开时在 `document` 捕获阶段挂 `mousedown`；点面板外关闭。
  - 排除 `hosts-panel / rail-hosts / ai-drawer / settings-host / confirm-backdrop`，不干扰设置、AI 抽屉、确认卡和表单。
- `app/ui/rail.js` / `app/ui/status-bar.js`
  - 删除 rail-ai 渲染与点击接线、未读圆点。
  - 删除 `status-ai-toggle` 按钮及其 `onToggleAi` 参数。
- `app/ui/terminal-view.js`
  - 新增 `proposeDimensions()`：新建标签前用现成 xterm 或临时量一个同尺寸终端，保证 `pty.create` 一次就按正确尺寸建。
  - 新增只读调试出口 `__termDebugBuffer()`（仅在 loopback 页面暴露），供 CDP 读 xterm 缓冲区验证提示符次数。

---

## 2. 验收结果

探针原始输出：

- `.dispatch/v4e-probe/probe-run.txt`（本次完整 stdout，末尾 `SUMMARY 13/13 failed=0`）
- `.dispatch/v4e-probe/probe-output.txt`
- `.dispatch/v4e-probe/probe-results.json`
- `.dispatch/v4e-probe/ac3-geometry.txt`
- `.dispatch/v4e-probe/node-test.txt`
- `.dispatch/v4e-probe/doctor.txt`
- 截图：`.dispatch/v4e-shots/`

| 编号 | 结果 | 实际证据摘要 |
|---|---|---|
| AC1 | **PASS** | 新标签 xterm 缓冲区：`promptCount=1`，`prompts=["$"]`，`nonEmptyLines=["41807@devpc MINGW64 ~","$"]`；`cols=169 rows=38`。 |
| AC2 | **PASS** | 连开连关 3 次前后均为 `promptCount=1`、`totalLines=38`，行数增长 0。 |
| AC3 | **PASS** | `terminal-host.clientWidth` 1232 → 1232；`term.cols` 169 → 169；`data-ai-open=true`。 |
| AC4 | **PASS** | `rail-ai / rail-unread / status-ai-toggle / ai-close` 四项全为 `null`。 |
| AC5 | **PASS** | 把手 `w=22 h=78`，中心 363.5 = main 中心 363.5，右缘 896 ≈ 抽屉左边 895；展开时仍可见；两次 click 后 `data-ai-open` 依次 `false → true`。 |
| AC6 | **PASS** | `model-select` 四边 `0px`、背景 `rgba(0,0,0,0)`；菜单展开且 6 个模型；选 `shuaiapihermes/gpt-6.2-sol` 后 `GET /api/config` 从 `commandcode/deepseek/deepseek-v4.1-flash` 变为该 id。 |
| AC7 | **PASS** | `agent-send` 文本 `↑`、`aria-label=发送`；hint 在 `composer-box` 内、`pointer-events:none`；`boxHeight=40.375`，`taHeight=19.375`，差 21px（19px padding + 2px border，在 ±2 内）。 |
| AC8 | **PASS** | 6 行文本 `textarea height=116`；拖把手到 `291`（宿主 727 × 40% = 291，±6 内）；`localStorage['magpie.term.composerHeight']='291'`；关/开抽屉后仍为 291。 |
| AC9 | **PASS** | 构造 `agent.approval`：抽屉开时 `toast-stack children=0`、`badge=1`、`pending=1`；关抽屉后 `toast children=1`。 |
| AC10 | **PASS** | 点终端区 mousedown → 面板关闭；点面板 header 内部 mousedown → 面板仍打开。 |
| AC11 | **PASS** | `app/styles/*.css` 中 `inset 2px` = 0、`inset 0 1px` = 0；rail/tab 选中态无 `::before`。 |
| AC12 | **PASS** | `node --test`：404 tests / 404 pass / 0 fail；`doctor`：33 assertions / 33 pass / 0 fail。 |
| AC13 | **PASS** | CDP 真实键入 `echo V4E_REAL_$((1+2))` 后缓冲区出现 `V4E_REAL_3`；点 `+` 后 tab 数 1→2；点第一条主机条目产生可观测反馈（本次临时 sshd 不可用，状态栏提示 `本地服务返回 HTTP 502，请重试。`）。 |
| AC14（加分） | **PASS** | 1280×760：`docScrollW=1280 docClientW=1280`；1440×900：`docScrollW=1440 docClientW=1440`；body 同样无溢出。 |

### 2.1 截图（PIL 实测）

| 文件 | 尺寸 | unique colors |
|---|---|---|
| `.dispatch/v4e-shots/1280-closed.png` | 1280×760 | 791 |
| `.dispatch/v4e-shots/1280-open.png` | 1280×760 | 1170 |
| `.dispatch/v4e-shots/1280-composer-growth.png` | 1280×760 | 1177 |
| `.dispatch/v4e-shots/1280-hosts.png` | 1280×760 | 1718 |
| `.dispatch/v4e-shots/1440-closed.png` | 1440×900 | 786 |
| `.dispatch/v4e-shots/1440-open.png` | 1440×900 | 1176 |
| `.dispatch/v4e-shots/1440-composer-growth.png` | 1440×900 | 1183 |
| `.dispatch/v4e-shots/1440-hosts.png` | 1440×900 | 1723 |

截图不是空白（`getbbox()` 均为整图；unique colors 均 > 700），1280/1440 各四张：收起 / 展开 / 输入框拉高 / 主机面板。

---

## 3. CHANGES-V4 §4 十五条硬约束自查

| # | 约束 | 本卡结论 |
|---|---|---|
| 1 | 不新造主色，颜色只从 token 取 | ✅ 组件/布局 CSS 无颜色字面量；新增值只写在 `tokens.css`。 |
| 2 | 选中/当前态只用底色 + 文字色 + 图标色 | ✅ rail / tab 已按此实现，无竖条/顶条/发光。 |
| 3 | 审阅角标四态语义固定 | ⏭ 本卡不含确认卡审阅角标（V4-H）；未改动相关语义。 |
| 4 | tooltip 两段标题逐字固定 | ⏭ 本卡不含审阅 tooltip（V4-H）。 |
| 5 | 确认卡 `overflow: visible`、按钮区右侧 ≥40px | ⏭ 本卡未改确认卡结构（V4-H）。 |
| 6 | 设置项「常显效果评估」默认关 | ⏭ 本卡未改设置项（V4-H）。 |
| 7 | 模型名纯文本按钮，菜单 `bottom:40px; right:8px` | ✅ 已实现并通过 AC6。 |
| 8 | Enter 提示在框内右下、不占行高 | ✅ 已实现并通过 AC7。 |
| 9 | 自动增高 1→6 行；拖拽上限宿主 40%、≥116；localStorage 回填；重新输入回自动 | ✅ 已实现并通过 AC8。 |
| 10 | 抽屉边只由 border-left；把手 z-index 更高；角标 `top:4px; right:3px` | ✅ 已实现；AC5 几何通过。 |
| 11 | 文件网格右侧 ≥14px、左侧 9px | ⏭ 本卡不含文件网格（V4-F）。 |
| 12 | 灰字只用两个 token、只放规定底色 | ✅ 本卡灰字都用 `--term-muted/--term-dim` 类 token；未新增灰字底色。 |
| 13 | 会话组折叠 `aria-expanded + hidden` | ⏭ 本卡未实现会话组（V4-H）。 |
| 14 | 远程徽标两行、≤120px | ⏭ 本卡不含远程徽标（V4-F）。 |
| 15 | 终端/文件面板分界三样 | ⏭ 本卡不含文件面板（V4-F）。 |

说明：标 ⏭ 的条目在任务卡 §3 已明确不属于 V4-E，本卡没有改坏对应既有代码；后续卡实现时仍需遵守。

---

## 4. 契约保持

- 以下 `data-role` 未改名：`app / rail / rail-term / rail-hosts / rail-settings / main / tabbar / terminal-host / ai-handle / ai-handle-badge / ai-drawer / agent-timeline / agent-input / agent-send / agent-stop / model-select / agent-step / agent-step-cmd / agent-step-out / agent-approval / approval-run / approval-rest / approval-skip / toast-stack / toast / settings-* / host-* / file-*`。
- 新增的允许名字：`agent-grow / composer-box / composer-hint / model-menu`。
- `agent-send` 文本为 `↑`，`data-role` 与 `aria-label="发送"` 保留。
- `rail-hosts` 保留。
- 未删除既有测试断言；`node --test` 404/404。

---

## 5. 自测命令与原始结果

```bash
# 仓库根，不带路径参数
D:/nodejs/install/node.exe --test
# → exit 0；tests 404 / pass 404 / fail 0

DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs
# → exit 0；doctor-report.json：33 assertions / passed true / 0 failed

# CDP 探针（自带 60s 硬超时；finally kill Chrome / close server / process.exit）
D:/nodejs/install/node.exe .dispatch/v4e-probe/probe.mjs
# → SUMMARY 13/13 failed=0
```

探针通过临时配置目录运行（复制 `~/.config/magpie-terminal` 到临时目录后设置 `MAGPIE_TERMINAL_CONFIG_PATH`），因此 AC6 的模型切换只写临时配置，没有改用户真实模型偏好。

---

## 6. 未做 / 打折 / 环境说明

1. 本卡未实现任何 V4-F/G/H 内容：文件面板、本机 shell 选择、新建标签下拉、会话列表、多轮/流式、确认卡审阅角标与常显效果开关，均未顺手做。
2. AC9 使用构造的 `agent.approval` 帧验证前端 toast / 角标行为，没有真跑模型；符合任务卡 §10 对 V09 的允许。
3. AC13 的远程主机连接：临时 sshd 环境本次不可用，点主机条目得到的是可观测错误提示（HTTP 502），满足「点主机条目有反应」；没有强行改服务端或伪造 SSH 成功。
4. 探针为验证提示符与 toast 写入了 loopback 专用调试出口 `__termDebugBuffer`；不参与业务路径，非 loopback 不暴露。
5. 没有 git commit；没有改 `src/`、`docs/mockups-v4/`、`package.json`。
