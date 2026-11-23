# V4 设计稿变更记录（v4b 收尾）

本文件记录本轮设计稿改了什么、落在哪个文件的哪条规则上、以及怎么复核。
只记录**已经落在文件里**的东西；没有实测数据的数字一律不写。

- 设计稿目录：`docs/mockups-v4/`
- 样式：`docs/mockups-v4/assets/v4.css`（2128 行）
- 交互：`docs/mockups-v4/assets/v4.js`（623 行）
- 页面：`ai-chat.html` / `layout.html` / `hosts-files.html`
- 截图：`docs/mockups-v4/shots/v4b-*.png`（19 张）

复核命令都在仓库根目录执行。

---

## 0. 一句话结论

用户三条硬改全部落地（选中态去线条、审阅角标四态 + 两段 tooltip + 常显开关、输入区重做），
上一轮审出的 6 个缺陷全部修完，19 张 v4b 截图重出并逐张核过尺寸与色数。

---

## 1. 用户三条硬改

### 1.1 ① 删除全站「靠线条标记选中」的样式

**规则**（逐字写进了 `assets/v4.css:173`）：

> 选中态只用底色 + 文字色 + 图标色，不用竖条/顶条/边框发光。

删掉的三处标记线：

| 位置 | 原来的做法 | 现在 |
|---|---|---|
| `assets/v4.css:163-172` `.rail-btn` | `.rail-btn[aria-pressed="true"]::before` 画 `inset 2px` 竖条 | 只留 `background: var(--v4-accent-soft)` + `color: var(--v4-accent)`（`.rail-btn[aria-pressed="true"]`，v4.css:172） |
| `assets/v4.css:206-229` `.tab` | `.tab[aria-selected="true"]::before` 画顶部指示条 | 只留 `background: var(--v4-term-bg)` + `color: var(--v4-fg-2)`（v4.css:223-227），图标单独提亮到 accent（v4.css:229） |
| `assets/v4.css:1785-1790` `.sess-group` | `.sess-group[data-current="true"]` 用 `inset 0 1px` 画左侧竖线 | 只留极淡底 `rgba(120, 160, 220, 0.05)` + 标题/计数提亮（v4.css:1788-1790、1838），代码里留了注释「没有竖线」（v4.css:1787） |

不是「标记线」而是「控件自身的轮廓」，本轮保留，验收时别误判：

- `.tab[aria-selected="true"]` 还有 `border-color: var(--v4-line)`（v4.css:225）——这是 tab 与下方终端面板的接缝轮廓，不是选中标记。
- `.file[data-selected="true"]` 用 `border-color: var(--v4-accent-line)`（v4.css:533-536）——文件格子的边界。
- `.seg button[aria-selected="true"]` 用 `box-shadow: 0 0 0 1px var(--v4-line-2) inset`（v4.css:1483）——分段控件凸起胶囊的 1px 内圈。**这条是唯一还带「选中描边」味道的规则**，见 §5 待确认项。

**grep 验证（两条命令 + 实际结果）：**

```bash
# 1) 竖条标记用的 2px inset
grep -c 'inset 2px' docs/mockups-v4/assets/v4.css
# → 0

# 2) 会话组竖线用的 1px inset
grep -c 'inset 0 1px' docs/mockups-v4/assets/v4.css
# → 0
```

口径说明：直接 `grep -n inset` 仍有 4 处命中，都不是标记线，别拿它当回归失败：

| 行 | 内容 | 是什么 |
|---|---|---|
| `v4.css:346` | `box-shadow: inset 0 7px 14px rgba(0,0,0,0.34)` | 文件面板上沿的内投影（D6） |
| `v4.css:1290` | `inset: 0 0 26px 48px` | 主机的绝对定位 |
| `v4.css:1483` | `box-shadow: 0 0 0 1px ... inset` | 分段控件内圈（见上） |
| `v4.css:2008` | `inset: 2px` | 设置页单选圆点的内填充 |

### 1.2 ② 确认卡右下角审阅角标

**四态**（`assets/v4.css:931-957`，类名 `.review-mark[data-review=...]`）：

| 状态 | `data-review` | 颜色 | 语义 |
|---|---|---|---|
| 绿 | `ok` | `--v4-ok` #7ee787，底 `rgba(126,231,135,.11)`，边 `rgba(126,231,135,.34)` | safe，已审可放行 |
| 琥珀 | `caution` | `--v4-warn` #e3b341，底 `.11`，边 `.36` | 有改动 / 可撤销性存疑 |
| 红 | `danger` | `--v4-danger` #ff7b72，底 `.13`，边 `.38` | 危险，一律确认 |
| 灰 | `none` | `--v4-dim`，底 `rgba(255,255,255,.03)`，边 `--v4-line` | 未审阅 / 审阅不可用 |

角标本体：`position: absolute; right: 9px; bottom: 9px; 20×20`（v4.css:932-933），`cursor: help`，
`role="img"` + `aria-label="审核 AI 判定：caution，需要注意"`（`ai-chat.html:184`、`layout.html:451`）。

**tooltip 两段标题，逐字为**（`ai-chat.html:187`、`190`；`layout.html:453`、`456`）：

```
执行后会发生什么
为什么需要你确认
```

- 展开方式：`:hover`、`:focus-visible`、`[data-open="true"]` 三条并列（v4.css:972-974），键盘可达。
- 结构：`b` 标题 + `p` 正文 + `.rt-sep` 分隔线 + `b` 标题 + `p` 正文 + `.rt-foot` 元信息（v4.css:975-994）。
- 卡片必须 `overflow: visible`（v4.css:879-880），否则 tooltip 会被裁掉——这条是硬约束。

**设置页开关**「在确认卡上常显 AI 的效果评估」：

- 文案与说明：`ai-chat.html:550-556`
- 默认关：`aria-checked="false"`（`ai-chat.html:556`），说明里写明「默认关（图中是开启态）」
- 行为：`assets/v4.js:420-431`，`setEffect(on)` 同步所有 `[data-toggle="effect"]` 与 `.approval-effect` 的 `hidden`
- 打开后卡片多一行（在按钮上方，不改其他结构）：

  ```html
  <p class="approval-effect" hidden><b>执行后会发生什么：</b>…</p>
  ```

  见 `ai-chat.html:178`、`layout.html:442-443`；样式 `assets/v4.css:915-926`（虚线边 + 深一档底）。
  截图钩子：`?effect=1`（v4.js:623 附近 `if (params.get("effect") === "1") setEffect(true)`）。

### 1.3 ③ 输入区

| 要求 | 落点 | 实现 |
|---|---|---|
| 模型名是纯文本按钮，无边框无底色，带小下箭头 | `ai-chat.html:207-210`；`assets/v4.css:1071-1082` | `.model-text` 只有 `height:22px; padding:0 3px`，无 `border`、无 `background`；只有 hover 才给 `--v4-panel-2` 底。图标 `9×9` 的 `#i-chevron-down` |
| 点它弹列表 | `assets/v4.js:575-586` | `[data-menu-toggle]` 控制 `#menu-model` 的 `hidden` 与 `aria-expanded`；菜单位置 `style="bottom:40px;right:8px"`（`ai-chat.html:211`） |
| Enter / Shift+Enter 提示移入 textarea 内部右下角 | `ai-chat.html:203`；`assets/v4.css:1044-1050` | `.composer-hint { position:absolute; right:9px; bottom:4px; pointer-events:none }`，挂在 `.composer-box`（`position: relative`，v4.css:1015-1016）里；框体 `padding-bottom: 19px` 给它留位，不另占行高（v4.css:1021-1022） |
| textarea 自动增高 1→6 行 | `assets/v4.js:458-478` | `LH = 12.5*1.55 = 19.375`，`MAX_AUTO = round(LH*6) = 116`；`growOne()` 先 `height:auto` 再读 `scrollHeight`，上限 116px；`:input` 时清掉 `data-manual` 回到自动 |
| 拖拽把手可拉到抽屉高 40% | `assets/v4.js:480-507` | `cap = max(116, round(host.clientHeight * 0.4))`（v4.js:490），`host` 取 `.drawer` 或 `.drawer-zoom`；拖动中 `.composer[data-resizing="true"]` 让把手变 accent（v4.css:1067-1068） |
| 高度写 localStorage | `assets/v4.js:461 / 470-472 / 502` | key `v4-composer-h`；`pointerup` 时写入 `ta.dataset.manual`；刷新后 `savedH > 0` 就回填 `data-manual` |

把手本体：`.composer-grip` 52×10、`top:-5px`、居中，`::before` 是 36×3 的短横，hover 变 42px accent（v4.css:1052-1068）。

---

## 2. 六个缺陷的修法

### D1 抽屉把手被压 / 角标歪

- **边不再用 inset 线**：`--v4-shadow-drawer` 只剩 `-20px 0 48px rgba(0,0,0,.46)`（v4.css:56），注释写明「那条线会压住右侧把手与角标」；边改由 `.drawer { border-left: 1px solid var(--v4-line-2) }` 提供（v4.css:611）。
- **把手压在边上**：`.ai-handle { right: 0; z-index: 32 }`，抽屉 `z-index: 30`（v4.css:602-628）；展开时 `right: var(--v4-drawer-w)`，跟着抽屉一起走。
- **角标回到把手内部**：`.ai-badge { top: 4px; right: 3px; left: auto; 16×16; box-shadow: 0 0 0 2px var(--v4-panel-2) }`（v4.css:656-671），与把手同一条轴线，不再甩到外侧。
- **审批卡右下角不被按钮压**：`.approval-acts { padding: 9px 40px 10px 10px }`（v4.css:908-912），右侧留 40px 给 20px 的角标；`.approval { overflow: visible }`（v4.css:874-881）让 tooltip 能出卡。

### D2 文件网格右侧安全边距

`.file-grid` 的 `padding` 从四边等距改成不对称：`padding: 6px 14px 8px 9px`（v4.css:511-521），
右侧 14px、左侧 9px，最后一列不再贴抽屉边。网格本身 `repeat(auto-fill, minmax(108px, 1fr))`、行高 78px、`gap: 2px 4px` 未变。

### D3 灰字对比度（真实计算，不是估的）

**两个前景（v4.css:28-29 当前值）：**

- `--v4-muted` = `#9aa4b0`
- `--v4-dim` = `#8f99a4`

**五种底色（v4.css:16-20）：** `--v4-bg` #0b0e13、`--v4-term-bg` #0d1117、`--v4-panel` #14171c、`--v4-panel-2` #181d24、`--v4-raise` #1c222b。

**公式（WCAG 2.1）：** 先做 sRGB 线性化 `c/12.92`（c ≤ 0.04045）或 `((c+0.055)/1.055)^2.4`；
相对亮度 `L = 0.2126R + 0.7152G + 0.0722B`；对比度 `(L_亮 + 0.05) / (L_暗 + 0.05)`。
本稿正文 9–13px，全部按「普通文本」取 4.5:1（没有 18.66px 粗体/24px 以上的大文本）。

| 前景 | 前景值 | 背景 token | 背景值 | 对比度 | ≥ 4.5:1 |
|---|---|---|---|---|---|
| `--v4-muted` | #9aa4b0 | `--v4-bg` | #0b0e13 | 7.65 | 是 |
| `--v4-muted` | #9aa4b0 | `--v4-term-bg` | #0d1117 | 7.49 | 是 |
| `--v4-muted` | #9aa4b0 | `--v4-panel` | #14171c | 7.11 | 是 |
| `--v4-muted` | #9aa4b0 | `--v4-panel-2` | #181d24 | 6.70 | 是 |
| `--v4-muted` | #9aa4b0 | `--v4-raise` | #1c222b | 6.33 | 是 |
| `--v4-dim` | #8f99a4 | `--v4-bg` | #0b0e13 | 6.68 | 是 |
| `--v4-dim` | #8f99a4 | `--v4-term-bg` | #0d1117 | 6.54 | 是 |
| `--v4-dim` | #8f99a4 | `--v4-panel` | #14171c | 6.21 | 是 |
| `--v4-dim` | #8f99a4 | `--v4-panel-2` | #181d24 | 5.85 | 是 |
| `--v4-dim` | #8f99a4 | `--v4-raise` | #1c222b | 5.53 | 是 |

**最低 5.53（`--v4-dim` on `--v4-raise`），最高 7.65（`--v4-muted` on `--v4-bg`）。**

补充两条，避免验收时对不上：

1. CSS 注释里写的「元信息 ≥ 3.5:1」是下限，实算最低 5.53，比注释更严。
2. 半透明底会轻微压低比值：审批卡 `rgba(227,179,65,.07)` 叠在 `--v4-panel` 上合成 ≈ #22221f，
   `--v4-dim` 在其上为 5.51，仍 ≥ 4.5。

### D4 会话组折叠

- 组头是**真按钮**：`<button class="sess-group-head" aria-expanded="true|false">`（`ai-chat.html:68/94/103`，规格面板 `357-411`）。
- 交互：`assets/v4.js:410-418` —— 读 `aria-expanded` 取反写回，并把兄弟节点 `.sess-items` 的 `hidden` 设为取反值。
- 视觉：箭头 `transition: transform .15s`，折叠态 `rotate(-90deg)`（v4.css:1803-1804）；组间距用 `.sess-group + .sess-group` 的 1px 上边线（v4.css:1786）。
- 兜底：全局 `[hidden] { display: none !important; }`（v4.css:83），保证 `.sess-items` 的 padding 不会让折叠后留空。
- 默认态：当前组 `aria-expanded="true"`，其余 `false` 且 `.sess-items` 带 `hidden`——两处都成对写，刷新不会闪一下全展开。
- 截图钩子：`?sess=N` 只数 `offsetParent !== null` 的组（v4.js:588-597），避免隐藏面板里的同名组被算进去。

### D5 远程徽标两行

`.src-badge.k-ssh` 第二段规则（v4.css:1875-1895）：

- `max-width: 120px`（原来会撑到 156px），`height: 26px`（工具条里 30px）
- `flex-direction: column; align-items: flex-start; gap: 1px; line-height: 1.15`
- 两行分别是 `.sb-t`（主机名）与 `.addr`（地址），都 `max-width:100%` + 省略号
- 两行版把左侧 `> .ico` 隐藏（v4.css:1886），宽度才收得住
- 工具条场景 `.badge-row .src-badge.k-ssh { height: 30px; padding: 3px 8px }`（v4.css:1895）

### D6 终端与文件面板的分界

- 产品样式：`.files { border-top: 1px solid var(--v4-line-3) }` + `box-shadow: inset 0 7px 14px rgba(0,0,0,.34)`（v4.css:335-347）。
  `--v4-line-3` #4a515b 比普通过线 `--v4-line` #232a33 亮一档，注释写明「分界要看得出能拖」（v4.css:344）。
- 拖拽条常显：`.files-grip` 11px 高、`top:-5px`、`z-index:3`，`::before` 46×4 的胶囊，`opacity: 1`（不再只在 hover 冒出来），hover / `[data-drag="true"]` 变 72px accent（v4.css:360-379）。
- 规格页复刻同一套：`hosts-files.html:16-33`（`.hf-term-strip` 34px 终端残条 + `.hf-files-board .files-zoom` 同样的 `border-top: 1px solid var(--v4-line-3)` 与内投影）。

---

## 3. 截图清单（19 张，全部 `shots/v4b-*.png`）

尺寸与色数由 PIL 读出（`Image.open(...).convert("RGB")` + `getcolors(10**7)`），不是手写的。
`@2x` 表示按元素/区域裁的近景，像素是 CSS 尺寸的 2 倍。

| # | 文件 | 尺寸 (px) | unique colors | 场景 |
|---|---|---|---|---|
| 1 | `v4b-1280-approval-tip.png` | 726×572 @2x | 4205 | `layout.html?ai=open&tip=1`，卡片 + tooltip 近景 |
| 2 | `v4b-1280-composer-grow.png` | 758×436 @2x | 1136 | `layout.html?ai=open&grow=1`，输入区近景 |
| 3 | `v4b-1280-files.png` | 1280×760 | 6521 | `hosts-files.html?view=files` |
| 4 | `v4b-1280-overview-closed.png` | 1280×760 | 6483 | `layout.html`，抽屉收起 |
| 5 | `v4b-1280-overview-open.png` | 1280×760 | 6487 | `layout.html?ai=open` |
| 6 | `v4b-1280-sessions-collapsed.png` | 1280×760 | 6615 | `ai-chat.html?view=sessions`，仅当前组展开 |
| 7 | `v4b-1280-settings-effect.png` | 1280×760 | 5196 | `ai-chat.html?view=settings&effect=1` |
| 8 | `v4b-1440-approval-tip.png` | 782×580 @2x | 4182 | 同 1，1440 视口 |
| 9 | `v4b-1440-chat-effect.png` | 968×445 @2x | 4015 | `ai-chat.html?view=chat&effect=1`，常显效果行 |
| 10 | `v4b-1440-composer-grow.png` | 814×406 @2x | 1220 | 同 2，1440 视口 |
| 11 | `v4b-1440-edge-handle.png` | 520×816 @2x | 904 | `layout.html`，抽屉右缘把手裁切 |
| 12 | `v4b-1440-files.png` | 1440×900 | 6347 | `hosts-files.html?view=files` |
| 13 | `v4b-1440-hosts.png` | 1440×900 | 5896 | `hosts-files.html?view=hosts` |
| 14 | `v4b-1440-overview-closed.png` | 1440×900 | 6409 | `layout.html` |
| 15 | `v4b-1440-overview-open.png` | 1440×900 | 6518 | `layout.html?ai=open` |
| 16 | `v4b-1440-sessions-collapsed.png` | 1440×900 | 6468 | `ai-chat.html?view=sessions` |
| 17 | `v4b-1440-sessions-expanded.png` | 1440×900 | 6785 | `ai-chat.html?view=sessions&sess=2`，非当前组也能点开 |
| 18 | `v4b-1440-settings-effect.png` | 1440×900 | 5361 | `ai-chat.html?view=settings&effect=1` |
| 19 | `v4b-1440-settings.png` | 1440×900 | 5321 | `ai-chat.html?view=settings` |

复核方式：

```bash
node docs/mockups-v4/scripts/shoot-v4b.mjs          # 全部重出
python -c "from PIL import Image; im=Image.open('docs/mockups-v4/shots/v4b-1440-files.png'); print(im.size, len(im.convert('RGB').getcolors(10**7)))"
```

产图脚本 `scripts/shoot-v4b.mjs:15-38` 是唯一事实来源：里面 19 条 JOB 与上表一一对应，
近景用 `sel` / `union` / `clip`，`scale: 2`。

---

## 4. 未来实现时必须遵守的约束

实现阶段（写 `app/`、`src/`）照抄设计稿时，下面这些是**硬约束**，改了就不算实现这一版：

1. **不新造主色**。颜色只能取 `assets/v4.css:2-11` 的映射表（源自 `app/styles/tokens.css` 暗色一组）；设计稿里的暗色值只是为了在文档目录预览时落地一次。
2. **选中/当前态只用底色 + 文字色 + 图标色**。禁止竖条、顶条、边框发光、左侧 `box-shadow: inset 2px` 这类标记线。要新增选中态先回来改这条规则。
3. **审阅角标四态语义固定**：ok=绿、caution=琥珀、danger=红、none=灰；`data-review` 的值不许改名。审阅失败必须是 `none`，不是隐藏角标。
4. **tooltip 两段标题逐字固定**：「执行后会发生什么」「为什么需要你确认」。第一段讲事实（动到什么、增删什么），第二段讲「为什么要你点」，两段不许合并、不许换词。
5. **确认卡 `overflow` 必须是 `visible`**，否则角标 tooltip 出不了卡；按钮区右侧至少留 40px 给角标。
6. **设置项「在确认卡上常显 AI 的效果评估」默认关**。开启时只追加 `.approval-effect` 一行，位置在按钮上方，不改卡片其他结构。
7. **模型名是纯文本按钮**：无边框、无常态底色、只有一枚 9px 下箭头；菜单锚定在输入区右下（`bottom:40px; right:8px`）。
8. **Enter 提示必须在输入框内部右下角**，且不占行高：`.composer-box` 的 `padding-bottom` 保持 19px，提示绝对定位 `right:9px; bottom:4px`，`pointer-events:none`。
9. **输入框高度规则**：自动增高 1→6 行（1 行 = 19.375px，6 行 = 116px，四舍五入取整）；拖拽上限 = 宿主（`.drawer` 或 `.drawer-zoom`）高度的 40%，且不小于 116px；用户重新输入即回到自动增高；拖完写 localStorage（key `v4-composer-h`），下次打开回填。
10. **抽屉的边只能由 `.drawer` 的 `border-left` 画**，不要再用 `inset` 线或 `box-shadow` 描边；把手 `z-index` 必须高于抽屉，角标必须落在把手内部（`top:4px; right:3px`）。
11. **文件网格右侧安全边距 ≥ 14px**，左侧 9px；不要为了多放一列把它吃掉。
12. **灰字只用 `--v4-muted` / `--v4-dim` 两个 token**，且只放在 §D3 那五种底色（或审批卡的 7% 琥珀合成底）上；任何新底色都要重跑对比度，普通文本 ≥ 4.5:1。
13. **会话组折叠必须走 `aria-expanded` + `hidden`**，箭头折叠态 `rotate(-90deg)`；当前组默认展开，其余默认折叠，markup 里 `aria-expanded` 与 `hidden` 要成对，不能靠 JS 初始化才正确。
14. **远程徽标固定两行、宽度 ≤ 120px**，两行版不放图标；不要为了塞全地址把 max-width 放开。
15. **终端与文件面板的分界必须同时有三样**：`--v4-line-3` 的 1px 亮线、`inset 0 7px 14px` 内投影、常显的 46×4 把手。少一样就退回「看不出能拖」。

---

## 5. 待确认项（本轮没动，留给下一轮拍板）

1. `v4.css:1483` 分段控件选中态仍有 `box-shadow: 0 0 0 1px var(--v4-line-2) inset`。它画的是凸起胶囊的轮廓，不是贴边标记条，本轮按「控件轮廓」保留；如果验收口径是「选中态零描边」，这里要改成纯底色。
2. `ai-chat.html` 的 `view=sessions` 规格面板里同时摆了「当前组展开」和「其他组折叠」两套 markup（`357-411`），是靠 `hidden` 区分的静态样例，不是两份真实数据。
3. 抽屉宽度 `--v4-drawer-w: 384px` 在 `.app[data-ai="open"]` 里又写了一遍同值（v4.css:616），保留是因为它承担「只改变量、不改终端列数」的说明作用；实现时合一即可。
