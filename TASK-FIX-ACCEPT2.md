# TASK-FIX-ACCEPT2：审核角标命中区 26×26 → ≥28×28（仅一项）

## 背景（实测事实，勿再论证）
独立复验 `VERIFY-ACCEPT.md` 的 V10 判 FAIL，差异已定位：

- 目标元素：`app/styles/components.css:637-652` `[data-role="agent-approval"] [data-role="approval-review"]`，`width/height:20px`、`box-sizing:border-box`、`border:1px`。
- 现有命中层：同文件 `:659-663`
  ```css
  [data-role="agent-approval"] [data-role="approval-review"]::before {
    content: ""; position: absolute; inset: -4px;
  }
  ```
- 原因：绝对定位伪元素的包含块是按钮的 **padding box**（20 − 2×1px 边框 = 18px），`inset:-4px` 得到 **26×26**，不是 28×28；右/下各差约 2px 命中不到。
- 复验实测：`::before` computed 26×26；逐像素命中 bbox 26×27（右侧 +3px、下侧 +4px 已落到卡片）。

## 任务（只做这一件）
把该伪元素的命中区改成实际 **≥28×28**，视觉元素不动。

- 允许做法（任选其一，自己用探针证明结果）：`inset:-5px`；或显式 `left:50%; top:50%; width:28px; height:28px; transform:translate(-50%,-50%);`。
- 不得改：按钮自身 20×20 / 圆角 5px / 1px 边框 / 配色 / 位置（right:9px; bottom:9px）/ 图标字号。
- 不得改其它任何文件；不得 `git commit`、`git add`、`git stash`（我负责提交）。只允许写 `.dispatch/fix-accept2/**`。

## 自测（必须真跑，原始结果落盘）
写 `.dispatch/fix-accept2/probe-badge.mjs`，用仓库现有 `.dispatch/cdp.mjs`（`withPage/evaluate/screenshot`，真 headless Chrome，`prefers-color-scheme:dark`），两档视口 1440×900 与 1280×760 各跑一次：

1. 起真服务（`import { startServer } from "./src/server/http.mjs"`，端口用 3701，避免 3480/3477/3488/3496；token 取 `server.token`）。
2. 页面加载后用 `evaluate` 在 AI 抽屉容器里注入一张最小确认卡 DOM（`<div data-role="agent-approval"><button type="button" data-role="approval-review" data-review="ok">✓</button></div>`，外层定位到卡片右下角附近即可），仅用于测量，量完移除。
3. 记录：按钮 `getBoundingClientRect()`；伪元素 computed `width/height/left/top/right/bottom`；换算出的伪元素实际矩形。
4. 逐像素命中：以按钮中心为原点，向 x、y 正负方向 1px 步进调用 `document.elementFromPoint`，求出命中 `[data-role="approval-review"]` 的最大矩形，要求宽 ≥28、高 ≥28，且四边各比按钮自身矩形外扩 ≥4px。
5. 截图存 `.dispatch/fix-accept2/shots/1440x900-badge.png`、`1280x760-badge.png`。

原始 JSON 落 `.dispatch/fix-accept2/measure.json`，日志落 `.dispatch/fix-accept2/probe.log`。

## 回归门槛
`D:/nodejs/install/node.exe --test` 必须 **679/679 pass、0 fail**（把输出落到 `.dispatch/fix-accept2/node-test.txt`）。doctor 不用跑。

## 交付
1. 代码改动（只 `app/styles/components.css`）。
2. `REPORT-FIX-ACCEPT2.md`（仓库根）：改了什么、两档实测数字（伪元素矩形 + 命中矩形 + 外扩）、回归结果、核对清单。
3. 白话说一句结论。
4. 未定稿标「草稿」；完成后在报告里标「待验收」，不得自称「成品/已验收」。

## 边界
- 不做卡外决策；有歧义返回 needs_clarification，不要自己扩大改动。
- 不要碰 `app/styles/layout.css`（把手热区另案处理）。
