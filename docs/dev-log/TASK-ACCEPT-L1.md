# TASK-ACCEPT-L1：magpie-terminal 页面布局验收（独立执行会话）

## 0. 你是谁、能碰什么

- 项目根：`C:/Users/41807/magpie-terminal`。Node 用 `D:/nodejs/install/node.exe`。
- **只允许写**：`.dispatch/accept-l1/**` 与仓库根的 `ACCEPT-LAYOUT.md`（新建）。
- **禁止修改**任何产品代码（`src/`、`app/`、`index.mjs`、`docs/`、`test/`、`scripts/`）。发现缺陷只记录 + 给改法建议。
- 不允许问人类问题；卡里没写清的按最保守解释执行并写明。

## 1. 目标

对界面做一次**测量驱动**的布局验收：真服务 + 真 headless Chrome，两档视口各截 12 个状态，量出溢出 / 重叠 / 对齐 / 间距 / 对比度 / 点击目标 / 截断，再按下面的维度批判，产出可执行的缺陷清单。
**不要输出主观形容词代替数据**（"有点丑""不够现代"这类不算发现）。

## 2. 环境与方法

- 驱动：`.dispatch/cdp.mjs` 的 `withPage / evaluate / screenshot / sleep`；视觉参考实现见 `.dispatch/v4h-probe/v4h-ui.mjs`。
- 起服务：`import { startServer } from "../../src/server/http.mjs"`，端口用 **3682**（功能验收同时占用 3681，别撞）。不要碰 3480（用户实例）。
- 视口：`1440×900` 与 `1280×760`，deviceScaleFactor 1（用 `Emulation.setDeviceMetricsOverride`，照抄 v4h 探针）。
- 每次测量前先等界面稳定：`await sleep(300)` + 两个 `requestAnimationFrame`。
- token：GET `/` 带 `sec-fetch-mode: navigate`，从 `<meta name="magpie-term-token">` 取；接口用 `x-magpie-term-token`。
- 截图目录：`.dispatch/accept-l1/shots/<视口>-<状态>.png`。每张图落地后要用像素方差检查非空白（读取 PNG 尺寸 + 抽样像素，别只看文件大小）。
- 设计语言基准：`docs/mockups-v4/`（`assets/v4.css`、`layout.html`、`ai-chat.html`、`hosts-files.html`）与 `app/styles/*.css`。判断"是否一致"要以这两处实际值为准，不要凭印象。

## 3. 必须覆盖的 12 个状态（每档视口都要）

| 编号 | 状态 | 怎么造出来 |
|---|---|---|
| S1 | 首屏：终端有提示符，AI 收起 | 默认加载 |
| S2 | AI 展开，会话列表空态 | 点右侧突起把手 |
| S3 | AI 展开，会话列表有 3 条、当前项高亮 | 通过 `/api/ai/sessions` 造数据或真跑 |
| S4 | AI 展开，对话内容：思考块 + 工具调用卡 + 结论 | 真跑一轮（如「列出当前目录前三个大文件」） |
| S5 | 确认卡四态并排（ok/caution/danger/none） | 伪造接口响应或直接注入 DOM（标注你用了哪种） |
| S6 | 主机面板展开（本机 + 远程主机 + 展开的子项） | 点主机按钮 |
| S7 | 文件面板（终端下方，本地目录） | 默认 |
| S8 | 文件面板（远程 `/tmp`） | 有远程可用则跑，不可用则记录并说明 |
| S9 | 设置页 | 点设置 |
| S10 | 模型下拉展开 + 输入框已放大 | 点模型名、拖输入框 grip |
| S11 | 收起态有待确认：把手小红点 + 右下角 toast | 造一条待确认 |
| S12 | 窄屏压力：1280 下会话列表多条 + 长标题 + 确认卡 | 造长标题 |

## 4. 必须量的指标（对每个状态，能量就量）

1. **横向溢出**：`document.documentElement.scrollWidth > clientWidth`，以及每个面板 `scrollWidth > clientWidth`（列出元素选择器与像素差）。
2. **重叠**：取关键元素 rect，两两求交；重点检查 右侧 AI 栏 vs 终端/文件面板、把手 vs 面板、toast vs 输入框、工具卡 vs 会话头。
3. **对齐**：同一列元素左边缘 x 差（≤1px 视为对齐）；会话列表项、卡片内文字、按钮组。
4. **间距**：面板内 padding、卡片 gap、按钮组 gap，报实际像素值，标出同一层里不一致的（如 8 vs 10 vs 12 混用）。
5. **对比度**：文本色 vs 实际背景色，算 WCAG 比值；正文 ≥4.5、次要文字 ≥3、图标 ≥3。列出不达标项及色值与比值。
6. **点击目标**：所有可点元素 rect 小于 28×28 的列出来。
7. **文字截断**：`scrollWidth > clientWidth + 1` 或命中 `text-overflow: ellipsis` 的关键文案（模型名、徽标、会话标题、路径、按钮文字），列元素 + 被截掉的字符。
8. **响应式**：同一状态在 1440 与 1280 下的差异（哪些元素塌了/换行了/被压扁）。

## 5. 批判维度（每条至少给 1 个具体证据）

- **信息层次**：用户第一眼该看到什么？现在是否被次要信息（路径、元数据、按钮）抢走注意力。指出具体元素与字号/颜色的实际值。
- **一致性**：与 `docs/mockups-v4/assets/v4.css` 的圆角/边框/阴影/间距阶梯是否一致；同类元素是否用了不同写法。
- **密度与留白**：面板内是否有大片空白或过度拥挤（给 padding 实测值）。
- **可发现性**：AI 栏收起把手、发送键、模型选择、文件操作入口是否一眼可见；是否需要 hover 才出现（hover-only 操作在触控/新用户上等于不存在）。
- **状态完备**：空态、加载态、错误态、禁用态是否都有；缺哪个。
- **微观细节**：分隔线粗细、圆角混用、图标尺寸不齐、日期/次要文字过浅（给色值+对比度）。
- **窄屏可用性**：1280 下是否出现挤压、截断、需要横向滚动。

## 6. 产物

1. `.dispatch/accept-l1/`：探针脚本、`measure.json`（每状态每指标的原始数值）、截图（24 张以上）、`*.txt` 日志。
2. 仓库根 `ACCEPT-LAYOUT.md`：
   - 结论段：整体是否可用于交付（能用 / 有明显问题 / 不可用），一句话理由。
   - 每状态一张小表：状态 / 截图路径 / 关键测量 / 问题。
   - 缺陷清单：编号、位置（CSS 选择器或文件:行）、现象（带数值）、严重级别（P0 阻断 / P1 明显影响使用 / P2 观感）、**具体改法建议**（建议 CSS 属性与目标值）。
   - 与 `docs/mockups-v4` 的偏差清单（哪些地方实现和设计稿不一样，是否算问题）。
3. 最后一条消息返回 JSON，`summary` ≤200 字：

```json
{"status":"done|failed","states":0,"shots":0,"defects":[{"id":"L1","severity":"P0|P1|P2","where":"selector","what":"..."}],"report":"ACCEPT-LAYOUT.md","evidence_dir":".dispatch/accept-l1"}
```

## 7. 硬性要求

- 结论必须能追到 `measure.json` 里的某个数；不许出现没有数据支撑的判断。
- 不许为了"看起来更好"改产品代码；只写建议。
- 结束后关掉你起的服务与浏览器，不留进程；不碰 3480/3477/3488/3496。
- 全程中文。
