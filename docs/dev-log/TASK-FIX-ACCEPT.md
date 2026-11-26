# TASK-FIX-ACCEPT：按功能/布局验收结论返工

## 0. 约束

- 仓库：`C:/Users/41807/magpie-terminal`。Node：`D:/nodejs/install/node.exe`。
- 这是一张**修复卡**：只修下面列出的缺陷，不许顺手改功能、改文案语义、加新依赖、动 `docs/mockups-v4`。
- 验收报告原文（必须读）：
  - 功能：`ACCEPT-FUNC.md`（结论表 + 关键取证细节 + 末尾口径说明）
  - 布局：`ACCEPT-LAYOUT.md`（§3 状态测量、§5 缺陷清单、§6 与设计稿偏差）
  - 原始数据：`.dispatch/accept-f1/`、`.dispatch/accept-l1/measure.json`、`.dispatch/accept-l1/shots/`
- 完成后必须：`node --test` 全绿（当前基线 674 条）、`DOCTOR_PORT=3684 node scripts/doctor.mjs` 33/33。
- 不许问人；卡里没写清的按"最小改动 + 与 `docs/mockups-v4/assets/v4.css` 对齐"处理，并在报告里写明你的判断。

## 1. 必须修（按优先级，逐条给前后证据）

### A. P1 功能缺陷：文件面板删除被误判为失败

- 现象：磁盘上文件/目录确实删掉了，但界面提示「本地服务返回 HTTP 200，请重试。」，列表仍留着旧条目，手动刷新才消失。
- 根因（已定位）：`app/core/api.js` 的 `del()` 只在 `response.status === 204` 时返回成功；服务端 `DELETE /api/fs` 返回的是 **200 + JSON**（`src/server/routes/fs.mjs` 的 `DELETE` 分支）。
- 改法：`del()` 改为**任何 2xx 都算成功**（`if (response.ok) return { ok: true, data: body }`，204 走 `data: null`）。非 2xx 仍按现有 `{code,userText}` 透出。
- 验收：真浏览器里对本地文件与空目录各点一次「删除 → 永久删除」，**不刷新**列表条目立即消失；磁盘上文件真的没了；非空目录不勾递归仍收到 409 文案。远程主机删除同理（若远程可连）。
- 回归：在 `test/` 里补一条能锁住这个行为的测试。若 `app/core/api.js` 因依赖 DOM 不可单测，则用最小的 DOM 桩（已有类似做法就复用）或对 `src/server/routes/fs.mjs` 的 DELETE 补 200+JSON 契约测试，并在报告里写清"为什么客户端逻辑靠浏览器实测兜底"。

### B. P1 对比度：暗色 `--term-muted` 太暗

- 现象：`--term-muted: #808080` 导致确认卡「跳过」/why 2.94:1、主机地址 2.39:1、设置页选中档位说明 2.39:1。
- 改法：暗色块 `--term-muted` 改为 `#9aa4b0`（验收报告已算过：#9aa4b0 在 `#3e382e` 为 4.59:1、在 `#37475f` 为 3.73:1）。同时把确认卡的边框/底色对齐设计稿（`L1-05`）：边框 `rgba(227,179,65,0.38)`、背景 `rgba(227,179,65,0.07)`，新增 token 而不是散写色值；卡内 padding 8→10，按钮组右侧 30→40。
- 验收：重算这些文本的对比度（正文 ≥4.5、次要 ≥3），把色值 + 比值写进报告；截图 `确认卡 / 主机面板 / 设置页` 各一张。

### C. P1 可点区域：AI 把手只有 22×78

- `app/styles/layout.css:153-165` 的 `[data-role="ai-handle"]` 视觉宽 22px；`--term-handle-hit: 48px`（`tokens.css:94`）已声明但没用。
- 改法：保留 22px 视觉宽，把命中区扩到 ≥48px（推荐 `::before { content:""; position:absolute; inset:0 -13px; }`，并把 `left/right` 与 `z-index` 处理干净，别挡住终端文字点击）。
- 验收：`getBoundingClientRect()` 或命中测试证明可点宽度 ≥48px；点把手最外侧 5px 内也能展开；终端文字仍可正常选中。

### D. P1 可发现性：编辑/删除/更多操作全是 hover-only

- 位置：`components.css:1629-1638`（主机工具）、`2298-2311`（文件条目更多）、`2869-2879`（会话改名/删除），默认 `display:none` 或 `opacity:0`。
- 改法：默认可见（弱化配色即可），hover 时再提亮；至少补 `@media (hover: none) { ... opacity:1; display:flex }`。不要新增图标体系，沿用现有字符/符号。
- 验收：不 hover、不右键时，会话行有可见的改名/删除入口，主机行有编辑/删除，文件行有「⋯」；截图 + DOM computed style 证明 `opacity/display` 非隐藏。

### E. P1 toast 压住状态栏

- `app/styles/layout.css:237-249`，`bottom: 16px`，实测与 33px 状态栏重叠 17px，盖住「立即重连」。
- 改法：`bottom: calc(var(--term-statusbar-height) + var(--term-gap));`。
- 验收：收起态有待确认时，toast 底边与状态栏顶边不重叠（rect 相交面积 0），两档视口各测一次。

### F. P2 模型下拉遮住输入框

- `components.css:947-964`，菜单 `bottom:40px`；输入框放大到 132px 高后被盖住 38,162px²。
- 改法：菜单锚到 `composer-box` 顶边（`bottom: calc(100% - 10px)` 或按 `composerBox.getBoundingClientRect()` 动态定位），保留 max-height 与滚动。
- 验收：输入框放大到 132px 后打开菜单，菜单 rect 与 `[data-role=composer-box]` rect 相交面积为 0，且菜单仍完整可见（不超出抽屉顶部）。

### G. P2 输入框拖拽方向反了

- 现象：向下拖变小、向上拖变高？实测「向上拖会缩到 59px」。要求：**向上拖变高、向下拖变矮**，且高度限制在 min 19.375px / max（现有上限）之间。
- 验收：记录拖动 40px 后的高度变化方向与数值。

### H. P2 其余低成本修正（逐条做，别扩大范围）

1. `L1-08`：会话标题 `<b>` 加 `title`（全文），长标题最多两行截断（`-webkit-line-clamp:2`），不再"只显示 26 字且无提示"。
2. `L1-09`：主机地址加 `title`（完整 `user@host:port · 认证方式`）。
3. `L1-10`：工具命令改为 `white-space: pre-wrap; overflow-wrap: anywhere;`（长命令不省略）。
4. `L1-11`：`drawer-head`、`ai-ctx`、`file-panel`、`file-panel-toolbar` 补 `box-sizing: border-box`，声明高度即实际高度（49/31/225/35 → 48/30/224/34）。
5. `L1-13`：审核角标、toast 关闭、会话操作、文件图标按钮的可点区统一 ≥28×28（视觉尺寸可不变，用 `::before` 扩热区或 `min-width/min-height`）。
6. `L1-16`：文件面板工具栏/网格/状态的左内边距统一成 9px。
7. `L1-14`：抽屉头里"终端名"不该比"当前会话名"更抢眼——`.sess-title` 12px/600、`.sess-sub` 10.5px/`--term-dim`（顺序也可调，但要说明理由）。

## 2. 明确**不改**（写进报告"未做清单"，不要动）

- `F04` 模型选择位置：验收卡的「输入框左侧」是卡片措辞问题；实际实现是「输入框下方一行，模型名在发送键左侧、无边框」，符合用户原始要求（模型名占原提示行、提示移入框内）。**保持现状**，只修 F 项（菜单遮挡）。
- `F09` 把手与视口中心差 16.5px：把手对齐的是 `.main` 中心（它所在的那条边），不是缺陷。
- `L1-07` 标签栏 34px / 状态栏 33px 与设计稿 40/26 的差：属设计选择，需人类拍板，不在本卡改。
- `L1-12` rail 图标换 SVG：视觉语言改造，超出返工范围。
- `L1-15` 远程大目录虚拟列表：性能改造，单独立项。
- `F17` 无 token 返回 403（不是 401）：403 已是拒绝，语义可接受；`C:/Windows` 可读属本机文件管理器设计范围，不收紧。

## 3. 交付

1. 代码改动 + 测试。
2. 仓库根 `REPORT-FIX-ACCEPT.md`：逐条（A–H）写「改了什么文件/行、前后数值、验证命令与原始输出路径、截图路径」；末尾写「未做清单」与「风险」。
3. 证据落 `.dispatch/fix-accept/`（探针脚本、日志、截图）。
4. 最后一条消息返回 JSON（`summary` ≤200 字）：

```json
{"status":"done|failed","fixed":["A","B"],"skipped":["L1-07"],"tests":"674/674","report":"REPORT-FIX-ACCEPT.md","evidence":".dispatch/fix-accept"}
```

## 4. 结束前自检（写进报告）

- [ ] 全量测试 + doctor 通过，且没有删/放宽任何既有断言。
- [ ] 每条修复都有"改前 → 改后"的实测数值，不是"看起来好了"。
- [ ] 没有引入新依赖、没有改 `docs/`、没有改用户可见文案的语义。
- [ ] 没残留自己起的服务/浏览器进程（3480/3477/3488/3496 一律不碰）。
