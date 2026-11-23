# TASK V2-A：布局重写（方案 A）+ 模型选择器

你是编码 agent。本卡是唯一工作单。**先把第 0 节读完再动手。**

---

## 0. 开工前必读

1. `docs/mockups/layout-v2.html` —— **方案 A 的唯一视觉与尺寸基准**，在浏览器里打开它，点「方案 A」，量它。CSS 直接照抄它的 `.a .rail` / `.aibar` / `.card` / `.hosts` 规则，变量名沿用 `app/styles/tokens.css` 里已有的。
2. `app/index.html`、`app/app.js`、`app/ui/ai-panel.js`、`app/ui/terminal-view.js`、`app/ui/tab-bar.js`、`app/ui/status-bar.js`、`app/styles/layout.css`、`app/styles/tokens.css`、`app/styles/components.css`
3. `src/ai/gateway.mjs`、`src/server/ws.mjs`、`src/server/http.mjs`、`src/server/routes/ai.mjs`
4. `.trellis/spec/frontend/ui-structure.md`、`theme-tokens.md`、`state-management.md`
5. `docs/security.md` 第 2 节（口令与门禁），**不要放宽任何一条**

冲突时以本卡为准，本卡没写到的以 `docs/` 主文档为准；仍冲突就停下报 `needs_clarification`。

---

## 1. 为什么要改（事实，别自己重新论证）

- magpie 主区实测可用尺寸 **829×721 px**（左侧 magpie 侧栏占 380px）。
- 现状 `app/styles/layout.css:21` 是 `grid-template-columns: minmax(480px, 1fr) 320px`，终端只剩 ~489px ≈ **64 列**，AI 栏常驻吃 320px。
- AI 是**间歇动作**，终端是**常驻动作**。把间歇动作从常驻宽度里挪走，终端才能拿回宽度。
- 目标：终端 **≥100 列**（方案 A 实测 779px ≈ 103 列）。

---

## 2. 目标（本卡范围）

### 2.1 新布局骨架（方案 A）

`app/index.html` 的 `#root[data-role=app]` 内部改成三层：图标栏 + 主区 + 状态栏。

```
#root[data-role=app][data-ai-open="false"]
  nav.rail[data-role=rail]                48px，固定左
  section.main[data-role=main]            1fr，纵向 flex
    div.tabbar[data-role=tabbar]          现有标签条，原样迁移
    div[data-role=terminal-host]          1fr，吃满
    div.aibar[data-role=aibar]            44px，贴底，AI 输入条 + 模型下拉
  div[data-role=ai-layer]                 AI 结果浮层（绝对定位，覆盖在终端之上，默认 hidden）
  div.statusbar[data-role=statusbar]      现有状态栏，原样迁移
```

图标栏内容（本卡只做两个真按钮 + 一个占位）：
- `data-role=rail-term`：终端，默认 active
- `data-role=rail-hosts`：主机，**本卡只渲染按钮并 `hidden`，点击 no-op 且不报错**（下一张卡接管）
- `data-role=rail-ai`：AI，切换 `#root[data-ai-open]` 与 `.aibar` / `#ai-layer` 的可见性；有未读 AI 回复时按钮上加一个小圆点（`data-unread="true"`）
- 底部 `data-role=rail-settings`：设置，本卡只渲染，点击无副作用

**尺寸硬指标**（用真浏览器量，别口算）：
- `.rail` 宽 48px；`.aibar` 高 44px；两者不参与终端 flex 计算。
- 终端可视宽 ≥ 779px @ 829px 视口 → `cols ≥ 100`。
- 页面 `overflow-x` 必须为 0（任何视口 800×600 ~ 1600×900）。
- 视口 < 720px 宽时：`.rail` 不变，`.aibar` 允许折行成两行（选择器+输入一行、按钮一行），终端仍不横向溢出。

**必须删掉的**：
- `aside.ai-panel` 的右栏形态（改成 `.aibar` + 浮层）
- `app/styles/layout.css` 里 `grid-template-columns: minmax(var(--term-min-main), 1fr) var(--term-ai-width)` 与 `@media (max-width: 900px)` 折叠块

**必须保留的行为（回归锁，逐条写测试或走查）**：
- 标签条：新建 / 关闭 / 切换 / 中键关闭 / `Ctrl+Shift+T` `Ctrl+Shift+W` `Ctrl+Shift+←/→`
- 终端：自动建首个标签、断线重连后 `pty.attach` 认领会话、`SESSION_GONE` 掉标签、resize 去抖
- 确认卡：`Esc` 关闭、焦点困在卡内、关闭后焦点回触发点、**不点不执行**、`decision==="auto"` 才自动写 PTY

### 2.2 AI 输入条

`.aibar` 从左到右：模型下拉（`select[data-role=model-select]`，宽 190px，`min-width:0`）→ 提问输入（`input[data-role=ai-question]`，`flex:1`）→ 「问」按钮（`data-role=ai-submit`）。
- 输入框：`Enter` 提交、`Shift+Enter` 换行、（原来是 textarea，改成单行 input 即可，**但 `Enter` 提交与空输入拦截行为不许退化**）
- 提问后：`.aibar` 保持可见，`#ai-layer` 淡入，把回答/确认卡渲染在浮层里，浮层内可滚动、可关闭
- 浮层最大高 `calc(100% - 88px)`，宽度贴合 `.main`，不遮住 `.rail` 和 `.aibar`

### 2.3 模型选择器

**服务端**

新增 `GET /api/models`（要求 token，与 `/api/health` 同一道门）：

```json
{
  "gateway": { "reachable": true, "durationMs": 41, "baseUrl": "http://127.0.0.1:3425" },
  "default": "commandcode/deepseek/deepseek-v4.1-flash",
  "models": [
    { "id": "commandcode/deepseek/deepseek-v4.1-flash",
      "label": "DeepSeek V4.1 Flash (latest) · Command Code",
      "contextLength": 1000000,
      "available": true,
      "note": null },
    { "id": "anyrouter/claude-fable-5-2", "label": "...", "contextLength": 1000000,
      "available": false, "note": "上次调用失败：HTTP 502 网关返回网页" }
  ]
}
```

规则：
- 列表来自 `GET {gatewayBaseUrl()}/v1/models` 的 `data[]`，`label` 取 `magpie_label`，缺省回落 `id`，`contextLength` 取 `context_length`。
- **可用性不做启动探测**（6 个模型逐个探最坏 34s，会拖死页面）。改为**失败后记忆**：`askGateway` 失败且错误码是 `GATEWAY_HTTP_404` / `GATEWAY_HTTP_502` / `GATEWAY_BAD_JSON` 时，记 `{modelId: {note, at}}`，`/api/models` 里该模型 `available:false` 并给出 `note`；记忆 TTL 10 分钟；**成功一次即清除**。
- 网关不可达时 `/api/models` 仍返回 200，`gateway.reachable:false`，`models:[]`，`default` 照常给出。（前端据此显示「网关不可用，点重试」，不能是空白下拉。）
- `probeGateway()` 改成返回模型清单（保留 `count`/`durationMs` 字段给现有调用方），**不要破坏现有调用方**。

新增 `GET /api/config` 与 `PUT /api/config`：

```json
// GET -> { "model": "commandcode/deepseek/deepseek-v4.1-flash" }
// PUT body 同形，只接受已知字段，model 必须是 /api/models 里出现过的 id，否则 400 INVALID_MODEL
```

- 落盘 `path.join(os.homedir(), ".config", "magpie-terminal", "config.json")`，目录 700、文件 600，写入用「临时文件 + rename」原子替换。
- 文件不存在 / 损坏 → 返回默认值，不抛错。
- **本卡只落 model 一个字段**；下一张卡会往里加 `hosts`，所以读取实现要能容忍未知字段并原样保留（读-改-写）。

**WebSocket**

- `ai.ask` 帧新增可选 `model: z.string().max(200).optional()`（在 `src/server/ws.mjs` 的 `InputFrame` 里加）。
- `handleAsk` 把 `model` 透传给 `askGateway({question, context, model})`。**当前是丢弃的，这是本卡要修的核心 bug 之一。**
- 请求的 model 不在 `/v1/models` 清单里时，不要拒绝，直接交给网关（网关会报错），错误原样返回给前端。

**前端**

- 启动时并行拉 `/api/models` 与 `/api/config`；下拉默认选中 `config.model`，配置里没有就选 `default`。
- 下拉项显示 `label`；`available === false` 的项**仍可选但标灰 + 尾注「（上次失败）」**，选中时在 `.aibar` 下方一行小字提示 `note`。
- 切换即 `PUT /api/config`；`PUT` 失败时保留本地选择并在状态栏闪现「模型偏好没存住」。
- 提问时帧里带 `model`。回答渲染里若 `frame.model` 存在，在回答头显示用了哪个模型。

---

## 3. 非目标（做了就是越界）

- 不做 SSH / 远程主机 / 文件树（下一张卡）
- 不做 `.hosts` 滑出层（`data-role=rail-hosts` 只留按钮）
- 不做主题编辑器、字号设置、分屏、搜索框
- 不引入任何新 npm 依赖（本卡纯前端 + 现有 fetch）
- 不改 `page/` 带路页
- 不改口令门禁强度（token 校验、Host/Origin 白名单、CSP 都不许放宽；`style-src` 现状保留）
- 不改 `docs/`、`.trellis/spec/`、`TASK.md`、`TASK-V2-A.md`、`LICENSE`、`.gitignore`

---

## 4. 新增/改动文件清单（照此，不多不少）

| 文件 | 动作 |
|---|---|
| `app/index.html` | 重写骨架（保留 `<meta name="magpie-term-token">` 注入点与 vendor 引用） |
| `app/styles/layout.css` | 重写为 rail/main/aibar/ai-layer 布局 |
| `app/styles/tokens.css` | 只加变量（`--term-rail-width:48px` `--term-aibar-height:44px` `--term-model-width:190px` 等）；**颜色仍只允许出现在此文件** |
| `app/styles/components.css` | 改 AI 栏相关选择器、新增 rail 与 ai-layer 样式 |
| `app/ui/rail.js` | 新增 |
| `app/ui/ai-bar.js` | 新增（输入条 + 模型下拉） |
| `app/ui/ai-panel.js` | 改成浮层结果列表 + 保留确认卡全部逻辑 |
| `app/ui/status-bar.js` | 加「模型」一栏；AI 按钮保留 |
| `app/app.js` | 接新骨架；`toggleAi()` 改浮层；接线 rail；提问带 model |
| `app/core/session-store.js` | 若需存 `model` 就加字段，别改现有字段语义 |
| `src/ai/gateway.mjs` | `probeGateway()` 返回清单；新增失败记忆表；`askGateway` 记录失败 |
| `src/server/http.mjs` | 加 `/api/models`、`/api/config`（GET/PUT） |
| `src/config/store.mjs` | 新增（读-改-写 JSON，原子落盘，容错） |
| `test/server/models.test.mjs` | 新增 |
| `test/config/store.test.mjs` | 新增 |

---

## 5. 验收命令（必须自己跑，贴真实输出）

按顺序全跑，缺一条不许报完成：

```
D1. "D:/nodejs/install/node.exe" --test        -> 必须 0 fail
D2. node --test                                 -> 必须 0 fail（两个 node 版本都要绿）
D3. "D:/nodejs/install/npm.cmd" test            -> exit 0
D4. node scripts/doctor.mjs                     -> 原断言数不减，全过
D5. 布局量测（真浏览器，headless Chrome + CDP，可复用 scripts/browser-probe.mjs）
    视口 829x721 与 1024x768 各量一次：
      - .rail 宽 = 48
      - .aibar 高 = 44
      - 终端 clientWidth >= 779 @829 视口
      - xterm cols >= 100 @829 视口
      - document.documentElement.scrollWidth <= clientWidth（无横向溢出）
    把两行数字贴进 REPORT
D6. 模型下拉（真浏览器 + 真网关 3425）
      - /api/models 返回 6 个模型，贴出此刻真实的 id 列表与 available 值
      - 下拉渲染出 6 个 option
      - 选 commandcode/deepseek/deepseek-v4.1-flash 提一个新问题，能拿到回答
      - 刷新页面，下拉仍停在刚选的模型（证明 PUT /api/config 真落盘）
      - 贴 ~/.config/magpie-terminal/config.json 的真实内容
D7. 负向 fixture（必须真做，不是口头）
      把 gatewayBaseUrl 指向一个必然 502 的地址（用 test/fixtures 里现成的 stub，不要打真网关），
      断言 /api/models 返回 200 且 gateway.reachable === false 且 models 为空数组，
      前端该分支渲染出「网关不可用」文案而不是空白下拉。
D8. 模型失败记忆（必须真做）
      对 anyrouter/claude-fable-5-2 真提一次问题（它会 502），贴出真实错误；
      再 GET /api/models，断言该模型 available === false 且 note 非空。
      （这一次真调会花 ~34s，可接受，只做一次）
D9. 回归走查（真浏览器，页面在 magpie 里或裸 Chrome 都要过）
      - 打开页面自动建一个标签
      - 打字进终端，输出回显
      - Ctrl+Shift+T 新建、Ctrl+Shift+W 关闭
      - AI 问「看看当前目录有多少个文件」-> auto 执行
      - AI 问「删除当前目录所有 .log 文件」-> 弹确认卡；Esc 关闭后文件仍在
D10. 密钥扫描：仓库内不得出现真实 token/口令
```

D5/D6/D9 的原始输出（命令 + 打印）追加到 `REPORT-V2A.md`，不许只写「已验证」。

---

## 6. 禁止

- 不许改测试期望来让测试变绿；新行为加新用例
- 不许把 `/api/models` 或 `/api/config` 做成免 token
- 不许把 model 硬编码成唯一选项（必须来自网关清单）
- 不许在页面里写死 `127.0.0.1:3425`（走 `gatewayBaseUrl()` / 服务端下发）
- 不许 `git add` / `git commit`
- 不许引入新依赖
- 不许留下 `.tmp-*.mjs` 之类的临时文件在仓库根

---

## 7. 报告

写 `REPORT-V2A.md`，含：
1. 改了什么（按文件）
2. 第 5 节每条命令的真实输出（原样贴，不许总结）
3. 布局量测的两组数字与截图路径
4. 没做到 / 打折的地方（老实写）
5. 下一张卡需要的接口你留下了什么（`/api/config` 的字段、`rail-hosts` 按钮的 id、`src/config/store.mjs` 的导出签名）

最后用一段话说清：终端现在多少列、模型下拉里有几个真能用、还剩什么没做。
