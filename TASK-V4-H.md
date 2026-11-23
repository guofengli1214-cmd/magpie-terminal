---
id: TASK-V4-H
title: AI 会话模型重写（多轮 / 会话列表 / 审阅角标）（V4-H）
status: approved
plan_version: docs/mockups-v4（v4b）+ docs/PROTOCOL-AGENT.md（已按「审阅全档位」修订）+ 用户 m03646 第 6 条、m03712、m03718、m03751/m03760 第 2 条、m03775
approval_ref: 用户 m03646 第 6 条；m03712；m03718；m03751+m03760；m03775
priority: P0
executor: pi
model_tier: 人类指定 commandcode/deepseek/deepseek-v4.1-flash（provider magpie）
attempt: 1
retry_budget: 2
escalation_policy: ask_human
session_policy: new_session_required
session_id: null
inputs:
  - C:/Users/41807/magpie-terminal/docs/PROTOCOL-AGENT.md（权威协议，已含 effect/confirmWhy 与「审阅全档位强制执行」）
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/ai-chat.html（会话列表 / 卡片 / 确认卡视觉）
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/CHANGES-V4.md §1.2 §1.3 §2 D4 D5 §4
  - C:/Users/41807/magpie-terminal/src/ai/（agent.mjs / judge.mjs / runner.mjs / gateway.mjs 现状）
  - C:/Users/41807/magpie-terminal/app/core/agent-store.js、app/ui/ai-drawer.js（现状）
quality_benchmark: UI 对照 docs/mockups-v4/shots/v4b-*.png（会话下拉、确认卡、工具卡）；会话能力对照 Hermes 自身的使用体验：多轮追问能引用上文、工具调用可见、有思考摘要。
verification: 主 agent 独立实跑（真网关、两轮追问、切标签、重启持久化）+ node --test + doctor
verifier: independent_new_session
depends_on: [TASK-V4-E]
---

# 1. 背景

现在 AI 是「一问一跑一总结」的一次性任务：`agent.run` 跑完就结束，没有会话、没有历史、不能追问；抽屉里只有一条时间线，没有会话选择；确认卡的审阅信息只有 `risk/why`，而且 **strict 档会跳过审阅**（用户明确要求任何档位都要审）。用户要的是「像 Hermes 一样」：多轮对话、看得到工具调用与思考、卡片好看、上方有会话选择与新建、AI 会话跟随终端窗口、列表里能看出这是本机还是哪台主机。

# 2. 目标

1. **会话持久化**：会话存服务端，进程重启后仍在。带标题、终端归属、来源（本机 shell / 远程主机）、消息与步骤时间线。
2. **多轮**：一次 `agent.run` 结束后会话不结束，用户继续说话就在同一会话里追问，模型能看到之前所有轮次与工具输出。
3. **会话跟随终端**：切换终端标签 → 抽屉自动切到该终端绑定的会话；没有就新建空会话；切回标签恢复原会话。
4. **会话列表**：抽屉顶部下拉，按终端分组，当前会话只用底色+文字色标记（**不许竖线**），每条带来源徽标（本机显示 `bash 5.2.37` 一行；远程显示「名称 / IP:端口」两行，宽度 ≤120px），右侧显示消息数；有「新会话」「重命名」「删除」。
5. **卡片重做**：工具调用卡（命令、状态、耗时、输出折叠）、思考摘要（reasoning）折叠块、总结块、错误块，按设计稿的层级与间距。
6. **审阅角标**：确认卡右下角四态（绿 safe / 琥珀 caution / 红 danger / 灰 none）+ 悬停 tooltip 两段（标题逐字「执行后会发生什么」「为什么需要你确认」）；设置页新增开关「在确认卡上常显 AI 的效果评估」，默认关。
7. **审阅全档位**：`strict` 也调审阅；审阅结论只影响「能不能自动放行」，不影响「要不要审」；审阅失败 → 角标灰、一律确认。
8. `reviewWhy` → `confirmWhy` 全仓改名（含 src/、app/、test/、scripts/）。

# 3. 非目标

- 不做跨设备同步、不做云存储；会话只存本地 `stateDir()/sessions/`。
- 不做语义标题生成（标题取首条用户消息前 24 字，可在列表里重命名）。
- 不做分支/回滚对话（下一轮再说）。
- 不做流式 token 输出（本轮用「每步事件」渐进展示；流式列为加分项，做不做都不影响必过项）。
- 不改文件面板、不改 shell 选择（V4-F/G）。

# 4. 现状事实（已实测）

- `src/server/ws.mjs` 的 `agent.run` → `src/ai/agent.mjs` → `src/ai/runner.mjs`（`createAgentRunner`）→ `src/ai/gateway.mjs`。
- `src/ai/judge.mjs` 现在返回 `{risk, why, reversible, model}`（`reviewWhy` 命名），三处引用。
- `src/policy/` 里 `decide()` 的分级链在 strict 档会跳过审阅（PROTOCOL 已改，代码要跟上）。
- `app/core/agent-store.js` 是单会话状态机；`app/ui/ai-drawer.js` 601 行，`data-role` 名单在文件头注释里（验收探针用它）。
- 仓库里 `reviewWhy` 出现在：`src/ai/agent.mjs`、`src/ai/judge.mjs`、`app/core/agent-store.js`、`app/ui/ai-drawer.js`、`test/ai/judge.test.mjs`、`scripts/agent-smoke.mjs`（另根目录历史报告不用改）。
- `docs/PROTOCOL-AGENT.md` 已更新：`agent.approval` 帧含 `risk/effect/confirmWhy/reversible/reviewModel`；§5 第 4 步「审阅全档位强制执行」。

# 5. 执行步骤

## 5.1 服务端：会话存储 `src/ai/sessions.mjs`（新）

- 目录 `stateDir()/ai-sessions/`，每个会话一个 `<id>.json`（原子写：`.tmp` + rename；目录 700、文件 600）。
- 会话结构：
  ```json
  { "id":"s-…", "title":"…", "createdAt":0, "updatedAt":0,
    "terminalId":"…", "terminalKind":"local|remote",
    "shell":"bash 5.2.37", "hostId":"h-…|null", "hostName":"…|null", "hostAddr":"…|null",
    "messages":[{ "role":"user|assistant|tool", "text":"…", "at":0, "reasoning":"…|null" }],
    "steps":[{ "stepId":"…","command":"…","decision":"auto|confirm","status":"…","output":"…","startedAt":0,"endedAt":0 }] }
  ```
- 上限：单会话 `messages` ≤ 200 条、文件 ≤ 512 KB（超了从最旧的轮次裁剪，保留最近 40 条并在总结里说明）；会话总数 ≤ 100（超了删最久未更新且非当前的）。
- API：`listSessions()`（返回摘要，不返回全文）、`getSession(id)`、`createSession(meta)`、`appendMessage`、`renameSession`、`deleteSession`、`findByTerminal(terminalId)`。
- 并发写同一会话要串行（写链），不许两个请求交错覆盖。

## 5.2 服务端：多轮

- `agent.run` 帧新增可选 `sessionId`；不带就新建。
- 新会话第一轮：`terminalId` 取当前活跃终端；服务端从「该终端的会话」里找最近一个，找不到才新建（前端也会传，但服务端要兜底）。
- `runner` 把会话历史转成模型消息：user → `user`，assistant 总结 → `assistant`，工具结果 → 上一轮的步骤摘要（压缩成每条命令 + 摘要输出，单条 ≤ 800 字符）。
- `agent.done` 后会话保持 `open` 状态；下一次 `agent.run` 复用同一 `sessionId`。
- 所有 `agent.*` 出站帧新增 `sessionId` 字段（前端靠它区分）。

## 5.3 服务端：审阅全档位

- `src/ai/judge.mjs`：返回 `{risk, effect, confirmWhy, reversible, model}`；提示词按 PROTOCOL §5.1 逐字追加 effect / confirmWhy 三段；zod schema 同步。
- 删掉任何「strict 跳过」分支；`decide()` 三档都调用审阅，只有「结论怎么用」按档位不同（PROTOCOL §5 第 4 步逐字为准）。
- 审阅失败/超时 8s：`risk=null/effect=null/confirmWhy=null/reversible=null`，`decision=confirm`，`reason="审阅服务不可用，按需要确认处理"`，日志写 `REVIEW_FAILED`（不许静默）。
- 每次审阅写一行日志 `[REVIEW] {command, risk, effect, confirmWhy, reversible, model, ms}`，独立于其它日志。

## 5.4 服务端：会话 REST

- `GET /api/ai/sessions` → `{sessions:[{id,title,updatedAt,terminalId,terminalKind,shell,hostName,hostAddr,messageCount,current}]}`
- `PATCH /api/ai/sessions/:id` `{title}`（≤80 字）
- `DELETE /api/ai/sessions/:id`（正在跑的会话拒绝 409 `SESSION_BUSY`）
- `GET /api/ai/sessions/:id` → 全文（含 steps，供切回时恢复时间线）
- 与现有 token 门一致。

## 5.5 前端：会话状态

- `app/core/agent-store.js` 改成多会话：`sessions[]`、`currentSessionId`、每会话自己的 `steps/pendingApprovals/status`。
- 切终端标签（现有 `attachActive()` 路径）→ 调 `store.focusTerminal(terminalId)`：有绑定会话就切，没有就建一个空的本地草稿会话（第一次发消息才落盘）。
- 抽屉顶部下拉：分组标题「本机」「<主机名>」，组内列表；当前项 `data-current="true"` 只用底色；箭头折叠用 `aria-expanded` + `hidden`；当前组默认展开。
- 新建按钮 `data-role="agent-new"`；重命名/删除放在每条的悬浮菜单里。

## 5.6 前端：卡片

- 工具卡 `data-role="agent-step"`：左侧状态图标（等/跑/成/败）、命令等宽一行（超长省略、点击展开）、右侧耗时、下方输出折叠（默认 3 行，点「展开」）。
- 思考块 `data-role="agent-reasoning"`：折叠，标题「思考过程 · N 字」，默认收起；没有 reasoning 就不渲染。
- 总结块 `data-role="agent-summary"`：正文字号大一号，前面一条细横线。
- 确认卡：在现有按钮行右侧加角标 `data-role="approval-review"`，`data-review="ok|caution|danger|none"`；tooltip `data-role="approval-review-tip"` 两段标题逐字；`overflow: visible`；按钮区右留 40px。
- 设置页新增开关 `data-role="setting-show-effect"`，写 config 字段 `showApprovalEffect`（boolean，默认 false）；开启时确认卡按钮上方追加 `.approval-effect` 一行常显文本。

## 5.7 测试

- 更新 `test/ai/prompt.test.mjs`（旧提示词契约已失效，改成新契约，不许删断言）。
- 更新 `test/ai/judge.test.mjs`：新字段、strict 也调用、失败兜底。
- 新增 `test/ai/sessions.test.mjs`：落盘/回读/裁剪/并发写串行/删除忙会话。
- 新增 `test/server/ai-sessions-route.test.mjs`。
- `rg reviewWhy`（src/ app/ test/ scripts/）必须 0 命中。

# 6. 契约

- 保留已有 `data-role`：`agent-timeline`、`agent-input`、`agent-send`、`agent-stop`、`agent-step`、`agent-step-cmd`、`agent-step-out`、`agent-approval`、`approval-run`、`approval-rest`、`approval-skip`、`model-select`。
- 新增：`agent-sessions`、`agent-sessions-toggle`、`agent-sessions-menu`、`agent-session-item`、`agent-new`、`agent-session-badge`、`agent-reasoning`、`agent-summary`、`approval-review`、`approval-review-tip`、`setting-show-effect`。
- 已有 WS 帧字段只增不改；`agent.*` 帧加 `sessionId`。
- `config` 新增 `showApprovalEffect`（boolean），进 `KNOWN_FIELDS` 与 `DEFAULT_CONFIG`；非法类型 400 `INVALID_SHOW_EFFECT`。

# 7. 验收标准（主 agent 独立复跑）

| 编号 | 必过 | 标准 |
|---|---|---|
| AC1 | 必过 | 同一会话里连续两问，第二问用指代（如「那最大的那个呢？」），回答能引用上一轮的真实输出（不含「我不知道你指什么」） |
| AC2 | 必过 | 重启服务（`MAGPIE_TERMINAL_CONFIG_PATH` 指向临时目录做的验证）后 `GET /api/ai/sessions` 仍能列出该会话，`GET /api/ai/sessions/:id` 能还原 steps |
| AC3 | 必过 | 开两个终端标签，各问一句；切标签时抽屉里的会话跟着切，切回来历史还在；新标签没有会话时显示空态并能新建 |
| AC4 | 必过 | 会话列表按终端分组，当前项只有底色无竖线；本机徽标形如 `bash 5.2.37`；远程徽标两行且宽度 ≤120px |
| AC5 | 必过 | 工具卡显示命令、状态、耗时，输出可展开；有 reasoning 的模型会显示折叠的「思考过程」 |
| AC6 | 必过 | 确认卡右下角角标四态可辨（用构造帧分别注入 ok/caution/danger/none），tooltip 两段标题逐字正确 |
| AC7 | 必过 | 设置开关默认关；开启后确认卡常显 effect 文本，关掉后消失，PUT/GET config 一致 |
| AC8 | 必过 | strict 档下审阅**确实被调用**（日志有 `[REVIEW]` 行），且 strict 下 risk=safe 的命令仍然返回 confirm（不自动执行） |
| AC9 | 必过 | 审阅模型换成不存在的 id → 角标 `none`、decision=confirm、reason 是「审阅服务不可用，按需要确认处理」，任务不崩 |
| AC10 | 必过 | `rg reviewWhy src app test scripts` 0 命中 |
| AC11 | 必过 | `node --test` 0 fail；`doctor` 33/33 |
| AC12 | 必过 | 停止按钮：喊停后后续步骤不再执行，已跑完的输出保留，会话标「已停止」 |
| AC13 | 加分 | AI 文本流式逐字出现（streamText），不影响工具与审批 |

# 8. 执行约束

- 独立新会话；不改 `docs/mockups-v4/`、`app/vendor/`；不新增依赖（`ai` 与 `@ai-sdk/openai-compatible` 已在用）。
- 会话文件绝不进 git（`stateDir()` 在 `~/.config/magpie-terminal/`，本来就不在仓库里；不要改成仓库内路径）。
- 探针自带 `process.exit` + 60s 硬超时；不许留后台进程。
- 不 commit。交付标「待验收」。

# 9. 交付物

`REPORT-V4H.md`（每条 AC 实测 + 证据路径 + 打折项）、`.dispatch/v4h-probe/*.txt`、`.dispatch/v4h-shots/*.png`（会话下拉、工具卡、思考块、确认卡四态、设置开关；1280×760 与 1440×900）。
