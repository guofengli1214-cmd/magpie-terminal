---
id: TASK-FIX-UI-REST
title: 收尾 UI（把手垂直居中 + 文件条目动作条溢出）
status: approved
plan_version: 用户 m02595「1B」批准
approval_ref: 用户消息 m02595「1B 2A」
priority: P1
executor: sub-agent
model_tier: commandcode/deepseek/deepseek-v4.1-flash（--thinking max）
attempt: 1
retry_budget: 2
escalation_policy: ask_human
session_policy: new_session_required
session_id: fix-ui-rest-1
inputs:
  - C:/Users/41807/magpie-terminal（仓库根，HEAD 1fb3dc2）
  - app/ui/file-panel.js（虚拟滚动已在卡 4 落地）
  - app/styles/components.css
  - app/styles/layout.css
  - app/index.html
quality_benchmark: 不适用（缺陷修复卡，以「无溢出 + 点在格内 + 动作全可用」为门槛）
verification: 详见第 11 节
verifier: independent_new_session
depends_on: []
---

# 1. 背景与现状（大白话）

先纠正一个前提，免得你重复实现已有功能：

**「AI 栏靠右、默认收起、收起态中间突起、待确认小红点、右下角通知」这四件事已经做完了，验收也过了。** 主 agent 刚用真浏览器复测：

- 收起态把手 `[data-role="ai-handle"]`：`24×78` 贴主区右缘、`border-radius: 8px 0 0 8px`、`right: 0`、`data-ai-open="false"` → 突起已成立。
- 待确认角标 `[data-role="ai-handle-badge"]`：`app/app.js:665-682 syncAgentBadge()` 按 `pendingApprovals.length` 同步文字/`hidden`/`title`，实测 0 条时 `hidden=true`。
- 右下角通知 `app/ui/toast.js`：每条待确认一条不自动消失的 toast，点「去确认」跳卡片。
- 验收报告 `ACCEPT-FUNC.md` 里 **F10 PASS**（toast 0→1、badge 显示「1」、点跳转正常）。

**所以本卡只剩两个真实缺陷。**

## 缺陷 1：收起态把手没有落在视口中心（差 13px）

主 agent 实测（1440×900，真浏览器）：

```
viewportCenter: 450
handleCenter:   437      ← 差 -13px
mainCenter:     437      ← 把手对齐的是「主区」中心，不是视口中心
```

原因：把手 `position: absolute` 挂在 `.main` 里，`.main` 高度是 `874px`（视口 900 减去底部状态栏 26px），所以它的 `top:50%` 算出来是主区中心 437，不是视口中心 450。

`ACCEPT-FUNC.md` 的 F09 就是因此判 FAIL（当时量到 16.5px，现在 13px，因为状态栏从 33px 改成了 26px）。

## 缺陷 2：文件条目动作条横向溢出 50px，盖住图标

主 agent 实测（1440×900 与 1280×760 两档，真浏览器）：

| 视口 | 格子宽 | 动作条宽 | 左溢出 | 按钮 |
|---|---|---|---|---|
| 1440 | 110.4px | 156px | **49.6px** | 查看28·编辑28·重命名38·下载28·删除28 = 150 |
| 1280 | 117.3px | 156px | **42.7px** | 同上 |

结构：`app/ui/file-panel.js:592` 建 `.file-panel-fmore`（含 5 个 `.file-panel-action` 文字按钮），`:611` 建 `.file-panel-more-toggle`（⋯，28×28）；`app/styles/components.css:2429-2444` 给它 `position:absolute; top:3px; right:3px; display:none` + hover/selected 时 `display:flex`。

**为什么不能靠「把按钮缩小」解决**：5 个按钮 × 24px 本身就有 120px，加间隙与内边距超过 110px 的格子——把按钮压到 24px 仍然溢出（主 agent 提这个方案时算错了，这里纠正）。文字标签（「重命名」三个字）也不可能塞进 20px 宽。

**本卡采用的方案**：把「行内横条」改成「面板级弹出菜单」。点行内 ⋯ 在格子附近弹出一个竖排文字菜单（查看/编辑/重命名/下载/删除），位置钳制在文件面板内，绝不出界。好处：文字可读、零溢出、每行 DOM 从 6 个按钮降到 1 个（141 行 → 少 700+ 个 button）。

# 2. 目标

1. 收起态把手的中心与**视口中心**对齐（1440×900 下 437 → 450）。
2. 文件条目的操作入口在 1440×900 与 1280×760 两档都**完全落在格子/面板内**，不遮文件名、不遮图标。
3. 5 个动作（查看/编辑/重命名/下载/删除）与目录的 3 个动作（打开/重命名/删除）功能一律不变，都能点通。
4. 不回归：虚拟滚动、选中、双击查看、上传刷新、删除刷新、键盘可达性全部保持。

# 3. 非目标（做了算越界）

- **不重新实现**把手/角标/toast —— 它们已经通过验收，本卡只修居中。
- 不改 `src/` 下任何文件（纯前端）。若你确信某条只能服务端修，停下返回 `needs_clarification`。
- 不改 `docs/mockups-v4/`、不改 `docs/PROTOCOL-AGENT.md`。
- 不引依赖、不改 `package.json`、不引前端框架。
- 不碰 AI 抽屉里的东西（会话列表/确认卡/composer 都在别的卡）。
- 不动虚拟滚动算法（`computeWindow`/`applySpacer`）——只改条目内部的按钮与菜单。

# 4. 涉及范围

| 文件 | 动作 |
|---|---|
| `app/styles/layout.css` | 把手 `top` 加状态栏半高偏移 |
| `app/ui/file-panel.js` | 删行内 `.file-panel-fmore`，改面板级弹出菜单 |
| `app/styles/components.css` | 删 `.file-panel-fmore` 相关规则，加菜单样式 |
| `test/app/file-panel-menu.test.mjs` | 新增（纯函数/结构单测） |
| `.dispatch/fix-ui/` | 探针与截图落盘 |

# 5. 现有做法（别打破的约定）

- 文件条目结构：`app/ui/file-panel.js` 的 `buildEntry(entry)` 里 `card` 是 `div.file-panel-entry[data-role="file-entry"][data-path][data-type]`，子节点依次 `.file-panel-ico`、`.file-panel-name`、`.file-panel-fmeta`、`.file-panel-more-toggle`、`.file-panel-fmore`。
- ⋯ 的点击处理在 `app/ui/file-panel.js:619-629`：`event.stopPropagation()`、同时只开一行（`data-more-open="true"`）、`aria-expanded` 同步。
- 网格：`.file-panel-grid` 是 CSS Grid，`grid-template-columns: repeat(auto-fill, minmax(108px,1fr))`，`overflow-y:auto`、`overflow-x:hidden`、`overflow-anchor:none`（虚拟滚动依赖这些）。
- 虚拟滚动：`[data-role="file-panel-spacer-top"]` / `-bottom` 两个 spacer 撑高度；滚动时重渲染窗口内的条目。**因此菜单不能挂在 card 内部**（会被滚动裁掉、也会随重渲染丢失）。
- 文件面板根：`.file-panel`（含 `.file-panel-toolbar` 与 `.file-panel-grid`）。面板整体在 `[data-role="file-panel-host"]` 里。
- 已有成功先例可参考：`app/ui/ai-drawer.js` 的 `[data-role="model-menu"]` 是面板级绝对定位菜单，`app/styles/components.css` 里 `.model-menu` 用 `bottom: calc(100% - 9px)` + `max-height` 钳制。照这个思路做，别自己发明。

# 6. 需求细节

## 6.1 把手垂直居中

`app/styles/layout.css:153-181` 的 `[data-role="ai-handle"]`，把

```css
top: 50%;
```

改成

```css
/* 把手挂在 .main 里，而 .main 高度 = 视口 - 状态栏。要让把手落在「视口」中心，
   需要补回状态栏高度的一半（F09：1440×900 下 437 → 450）。 */
top: calc(50% + var(--term-statusbar-height) / 2);
```

`--term-statusbar-height` 已在 `app/styles/tokens.css` 定义为 `26px`（卡 3 落地）。

**验收判据**：两档视口下 `|handle.centerY - innerHeight/2| ≤ 1`。

## 6.2 文件条目：删掉行内横条

`app/ui/file-panel.js:592-608` 的整段 `.file-panel-fmore` 构建（含 `actions` 数组与 `more` 循环）**删除**，改成：

1. 把「这个条目有哪些动作」抽成一个可单测的纯函数（导出它）：

```js
/**
 * 条目可执行的动作清单（顺序即菜单顺序）。
 * @param {{type?: string}} entry
 * @returns {Array<{label: string, action: string}>}
 */
export function actionsForEntry(entry) {
  if (entry && entry.type === "dir") {
    return [
      { label: "打开", action: "open" },
      { label: "重命名", action: "rename" },
      { label: "删除", action: "delete" },
    ];
  }
  return [
    { label: "查看", action: "view" },
    { label: "编辑", action: "edit" },
    { label: "重命名", action: "rename" },
    { label: "下载", action: "download" },
    { label: "删除", action: "delete" },
  ];
}
```

2. 行内只留 `⋯`（`app/ui/file-panel.js:611-630` 的 `moreToggle`），点它 → 打开面板级菜单（见 §6.3），不再切 `data-more-open`。
3. `card` 上 `data-more-open` 属性与 `.file-panel-entry[data-more-open="true"] .file-panel-fmore` 规则一并删除。

## 6.3 面板级弹出菜单

新建（同名文件内即可）：

- 容器：`div.file-panel-action-menu[data-role="file-action-menu"]`，`role="menu"`，**挂到 `.file-panel` 根节点**（不是 card、不是 grid），`position: absolute`。
- 结构：每个动作一个 `button.file-panel-menu-item[data-role="file-action-item"][data-action="view|edit|rename|download|delete|open"]`，文案即 `label`，`role="menuitem"`。
- 打开：设置 `data-open-path`（当前条目路径），按 ⋯ 按钮的 `getBoundingClientRect()` 定位，再**钳制在 `.file-panel` 的 rect 内**：

```
left = clamp(btnRect.left, panelRect.left + 4, panelRect.right - menuWidth - 4)
top  = btnRect.bottom + 2;  若 top + menuH > panelRect.bottom - 4 则 top = btnRect.top - menuH - 2
```

（菜单宽度用固定 `min-width: 120px`，高度按条目数 × 行高算，别依赖测量后再定位——测量会闪。）

- 关闭条件（全部要实现）：点菜单外任意处、按 `Esc`、面板滚动、`refresh()`/重渲染、切换到别的目录、再点同一个 ⋯。
- 无障碍：打开后焦点移到第一项；`↑`/`↓` 在项间移动；`Esc` 关闭并把焦点还给该行的 ⋯。
- 点击菜单项 → 调用现有 `runAction(action, entry)`（**函数名与签名不变**），然后关闭菜单。
- 滚动/重渲染时如果该条目已不在视口内，直接关闭菜单（不要留一个悬空的菜单指向不存在的行）。

**关键约束**：菜单**不进 grid**，所以不会被 `overflow-y:auto` 裁掉，也不会被虚拟滚动重渲染丢掉。

## 6.4 键盘与鼠标的可达性（不许退化）

现在 hover 与 selected 会显示横条；改完之后：
- hover 行 → ⋯ 保持常显（卡 4 已是常显 `opacity`），不新增 hover-only 元素。
- 双击条目仍是「查看/打开」（现有行为，别动）。
- 单击选中仍是选中（现有行为，别动）。
- `data-role="file-more-toggle"` 这个 role 名**必须保留**（现有测试与探针按它选元素）。

# 7. 执行步骤

1. 读 `app/ui/file-panel.js` 全文（尤其 `buildEntry`、`refresh`、`runAction`、滚动监听），读 `app/styles/components.css:2380-2470`、`app/styles/layout.css:150-240`、`app/styles/tokens.css`。
2. 按 §6.1 改 `layout.css`（一行）。
3. 按 §6.2/§6.3 改 `file-panel.js` 与 `components.css`。
4. 写 `test/app/file-panel-menu.test.mjs`：
   - `actionsForEntry({type:"dir"})` 逐字等于 3 项且 `action` 依次 `open/rename/delete`。
   - `actionsForEntry({type:"file"})` 逐字等于 5 项且依次 `view/edit/rename/download/delete`。
   - `actionsForEntry(null)` 走文件分支（5 项）。
   - 若你把位置钳制抽成纯函数（**建议抽**，如 `clampMenuPosition({btn, menu, panel})` → `{left, top}`），补 4 条：正常出现在按钮下方、靠近底边时翻到上方、靠近右边缘时左移、面板比菜单还窄时不产生负数坐标。
5. 真浏览器探针 `.dispatch/fix-ui/probe.mjs`（自己起服务，端口 **3780**，**别占 3480**；状态目录独立并复制真实 `config.json` 与 `secrets.*`；用 `.dispatch/cdp.mjs` 的 `withPage/evaluate/screenshot`）。要量：
   - 两档视口（1440×900 / 1280×760）下 `|handle.centerY - vh/2| ≤ 1`。
   - 文件面板打开后点第一条「文件」的 ⋯：菜单 rect 完全落在 `.file-panel` rect 内（`left ≥ panel.left`、`right ≤ panel.right`、`top ≥ panel.top`、`bottom ≤ panel.bottom`）；菜单**不覆盖**任何 `.file-panel-name`（用相交面积判定，允许 0）。
   - 存在 5 个 `[data-role="file-action-item"]`，文案依次「查看/编辑/重命名/下载/删除」。
   - 换一条「目录」的 ⋯：3 项，文案「打开/重命名/删除」。
   - 点「查看」→ 查看器打开（现有 `.file-viewer` 或对应 role，照现有实现判定），菜单消失。
   - 按 `Esc` → 菜单消失、焦点回到该行 ⋯（`document.activeElement` 是该 toggle）。
   - 点菜单外 → 菜单消失。
   - 滚动网格 → 菜单消失。
   - 靠近面板底部的行：菜单翻到按钮上方且仍在面板内（无负坐标、无溢出）。
   - 溢出复核：菜单 rect 与格子 rect 的关系不用管（菜单本来就可以覆盖相邻格子），但要确认**格子内不再有横向溢出元素**——`card.scrollWidth <= card.clientWidth + 1`。
   - 每档至少 2 张截图（收起态把手特写、菜单打开），PIL 判非空白。
6. 回归 `D:/nodejs/install/node.exe --test`（仓库根，不带路径参数）必须 0 fail。注意后台可能有别的卡在跑测试，只看你自己那次的输出文件。
7. 写 `REPORT-FIX-UI-REST.md`（仓库根）+ `.dispatch/fix-ui/summary.txt`（一行一条断言 PASS/FAIL）。

# 8. 示例与模板

## 正例：菜单定位（1440，第一条文件在面板底部附近）

```
btnRect:   {left: 1320, top: 700, bottom: 728}
panelRect: {left: 48, top: 640, right: 1432, bottom: 866}
menuSize:  {w: 120, h: 5*26 + 2 = 132}
→ 下方放不下（700+2+132=834 < 866？放得下则 top = 730）
→ 若放不下：top = 700 - 132 - 2 = 566，但 566 < panel.top(640) → 取 panel.top + 4 = 644
left = clamp(1320, 52, 1308) = 1308
```

## 反例（会失败，别做）

- ❌ 只把 `.file-panel-action` 缩到 24px —— 5×24=120 > 110 格宽，仍然溢出。
- ❌ 菜单挂在 card 里（哪怕 `position:fixed`）—— 虚拟滚动重渲染会把它丢进虚空。
- ❌ 用 `window.prompt`/`window.confirm`（headless 下会阻塞，仓库里已有教训）。
- ❌ 把 `data-role="file-more-toggle"` 改名 —— 现有测试与探针按它选元素。
- ❌ 顺手把 `runAction` 改名或改签名。

# 9. 执行约束

- 独立新会话，只按本卡执行；不得直接向人类提问；卡外决策返回 `needs_clarification`。
- 不 commit、不 stash、不动 `.git`。
- 不碰 `src/`、不碰 `docs/`、不碰 `app/ui/ai-drawer.js` 与 `app/ui/toast.js`（把手/角标/toast 已通过验收，本卡只改 `layout.css` 的一行 `top`）。
- 交付前按使用者视角自查：一个不懂命令行的用户，能在文件面板里一眼找到对某个文件的操作，且菜单不会被边角切掉。
- 未定稿标「草稿」，送审产物标「待验收」，不得标「成品/已验收」。

# 10. 验收标准

| 编号 | 级别 | 内容 | 验证方法 | 证据位置 |
|---|---|---|---|---|
| AC1 | 必过 | 两档视口 `|handle.centerY - vh/2| ≤ 1` | 真浏览器探针 | `.dispatch/fix-ui/probe.txt` |
| AC2 | 必过 | 把手仍是 24×78、贴右缘、左侧圆角、`data-ai-open="false"` | 同上 | 同上 |
| AC3 | 必过 | 格子内无横向溢出（`scrollWidth ≤ clientWidth + 1`），动作条 DOM 已不存在 | 同上 | 同上 |
| AC4 | 必过 | 菜单两档都在面板 rect 内，四个边界都满足 | 同上 | 同上 |
| AC5 | 必过 | 文件 5 项、目录 3 项，文案与顺序逐字正确 | 同上 + 单测 | 同上 + `node --test` |
| AC6 | 必过 | 点「查看」真的打开查看器且菜单消失 | 同上 | `.dispatch/fix-ui/probe.txt` |
| AC7 | 必过 | `Esc`/点外部/滚动 三种关闭路径都生效；`Esc` 后焦点回到该行 ⋯ | 同上 | 同上 |
| AC8 | 必过 | 面板底部附近的条目，菜单翻到上方且不出界 | 同上 | 同上 |
| AC9 | 必过 | 全量测试 0 fail（基线 692 + 新增） | `node --test` | `.dispatch/fix-ui/node-test.txt` |
| AC10 | 必过 | 虚拟滚动不回归：10000 项目录滚动到底仍能选中/查看/删 | 探针（可跳过远程） | `.dispatch/fix-ui/probe.txt` |
| AC11 | 加分 | 目录菜单点「打开」能进入该目录 | 探针 | 同上 |

# 11. 核验要求

关键项 11 条（AC1–AC11）。AC11 允许记 `skip` 若探针环境不便构造，其余必过项不得 skip。

# 12. 交付物

- 代码改动（`app/ui/file-panel.js`、`app/styles/components.css`、`app/styles/layout.css`、`test/app/file-panel-menu.test.mjs`）
- `.dispatch/fix-ui/probe.mjs` + `probe.txt` + `shots/*.png`（≥4 张，PIL 判非空白）
- `.dispatch/fix-ui/node-test.txt`
- `REPORT-FIX-UI-REST.md`（仓库根）
- `.dispatch/fix-ui/summary.txt`（机器可读，一行一条断言）
- `.dispatch/fix-ui/dispatch.txt`

# 13. 风险与回退

| 风险 | 处理 |
|---|---|
| 菜单定位算法在边角算错 | 先抽成纯函数单测四条边界，再接进 UI |
| 虚拟滚动重渲染把菜单搞丢 | 菜单挂 `.file-panel` 根；重渲染/滚动时一律关闭 |
| 改 `layout.css` 影响抽屉展开态 | 只改 `top`，`[data-ai-open="true"]` 的 `right` 规则不碰；探针两态都量 |
| 端口冲突 | 用 3780，起服务前确认空闲，**不要碰 3480** |
| 探针留孤儿 | 每轮结束关会话与 `server.close()`，`process.exit(0)`，不要写 `while` 长循环 |

# 14. 澄清记录

- 主 agent 已实测确认「把手/红点/toast」三项已实现并通过 F09/F10，本卡不重复实现。
- 用户 m02595「1B」已批准本卡开工。

# 15. 执行报告要求

`REPORT-FIX-UI-REST.md` 含：改了什么（逐文件）、**改前改后数字对照表**（把手 centerY、溢出像素、每行 button 数）、11 条 AC 逐条结果、回归数字、审计信息（session_id / 模型 / 工具调用数）、`plain_summary`（≤200 字白话：以前文件条目的操作横条会盖住图标、悬在格子外 50px；现在点 ⋯ 弹一个不越界的菜单；AI 把手也回到了屏幕正中）。
