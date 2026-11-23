---
id: TASK-V3-D
title: Agent 内核——多步执行 + 分级链 + 第二 AI 审阅 + 白名单
status: approved
plan_version: PLAN-V3.md (Gate 2 已批，approved by 用户 m02763「B」= C 与 D 一起做)
approval_ref: 用户 m02763 回复「B」
priority: P0
executor: pi (sub-agent)
model_tier: provider=magpie, model=commandcode/deepseek/deepseek-v4.1-flash
attempt: 1
retry_budget: 2
session_policy: new_session_required (session-id magpie-terminal-v3d)
inputs:
  - docs/PROTOCOL-AGENT.md   # 唯一权威协议，逐字照做
  - docs/PLAN-V3.md          # 背景与验收口径
  - C:/Users/41807/magpie-terminal （仓库根）
---

# 1. 背景与现状

TERMINAL 现在只能「一句话换一条命令」：`src/ai/gateway.mjs:24` 的 `buildSystemPrompt()` 写死「给出**一条**命令」「只输出 JSON」。用户一句话想要一个结果，得自己拆成十条命令。同时安全判级只有一次静态 `classify()`（`src/server/ws.mjs:368` 的 `handleAsk`），凡是白名单外的都弹确认卡，用户嫌繁琐。

本卡把内核换成真正的 agent：用 Vercel AI SDK 的工具循环，AI 能连续跑多步命令、看真实输出、最后用人话总结；判级从「单次静态分类」升级成五级链（硬禁止 → 用户白名单 → 内置只读 → 第二 AI 审阅 → 兜底）。

# 2. 目标

1. 新增 `agent.run / agent.approve / agent.stop` 三条 WS 入站帧与对应的出站帧，**逐字**按 `docs/PROTOCOL-AGENT.md` §3 实现。
2. AI 能在用户真实 PTY 里连续执行最多 8 步命令，每步把真实输出回喂模型，最后给出中文总结。
3. 判级链按 `PROTOCOL-AGENT.md` §5 实现，含硬禁止清单与第二 AI 审阅。
4. 配置新增 4 个字段 `autonomy / allowlist / reviewModel / basePrompt`，可通过 `PUT /api/config` 读写。
5. 旧的 `ai.ask` 单命令路径**保持可用**（不删、不改行为），作为降级。

# 3. 非目标（别做这些）

- **不改界面**。前端抽屉、设置页、红点、toast 全部属于 TASK-V3-C，本卡一行前端不动（`app/` 目录**禁止修改**）。
- 不删 `src/ai/gateway.mjs` 的 `askGateway` 与 `buildSystemPrompt`（旧路径还要用），只在旁边新增 agent 模块。
- 不改 `src/policy/classify.mjs` 的现有逻辑（它是判级链的第 3 级，直接调用）。
- 不做流式 WS 推送（`streamText`）；本卡用 `generateText`，步进帧在每步结束才发。
- 不做多任务并发：一个连接同时只允许一个 agent 任务，第二个 `agent.run` 直接回 `agent.error{code:"BUSY"}`。
- 不动远程 SSH 的建连/指纹/文件树逻辑。

# 4. 涉及范围

新增：
- `src/ai/agent.mjs` — agent 主循环（PROTOCOL §6）
- `src/ai/runner.mjs` — PTY 命令执行通道（PROTOCOL §4）
- `src/ai/judge.mjs` — 五级分级链（PROTOCOL §5）
- `src/ai/review.mjs` — 第二 AI 审阅（PROTOCOL §5.1）
- `src/policy/forbidden.mjs` — 硬禁止清单（PROTOCOL §8）
- `src/ai/allowlist.mjs` — 用户白名单匹配（PROTOCOL §2）

修改：
- `src/config/store.mjs` — KNOWN_FIELDS / DEFAULT_CONFIG / normalize / 校验
- `src/server/ws.mjs` — InputFrame 加三条帧 + 分发 + agent 帧转发
- `src/server/http.mjs` — `/api/config` 的 400 错误码补齐
- `test/config/store.test.mjs` — KNOWN_FIELDS 断言改成新列表
- `test/ai/prompt.test.mjs` — 旧提示词契约测试保留，但新增 agent 提示词的断言
- `package.json` / `package-lock.json` — 新增两个依赖

新增测试：
- `test/policy/forbidden.test.mjs`
- `test/ai/allowlist.test.mjs`
- `test/ai/judge.test.mjs`
- `test/ai/runner.test.mjs`
- `test/ai/agent.test.mjs`
- `test/config/agent-fields.test.mjs`

# 5. 现有做法（改之前必须知道的事实）

- `src/server/ws.mjs` 的 `InputFrame` 是 zod 判别联合（第 24 行起），新增帧要加进这个联合，否则被 `BAD_FRAME` 拒掉。
- `handleAsk(socket, frame)` 在 `src/server/ws.mjs:368`，`send(socket, frame)` 在文件顶部。
- 本地会话 `sessions.write(id, data)`（`src/pty/session.mjs:232`）；远程 `remote.write(id, data)`（`src/ssh/registry.mjs:341`）。`ws.mjs` 里已有 `registryOf(id)` 帮助函数。
- PTY 输出事件：本地 `sessions.on("pty.output", onOutput)`，远程 `remote.on("pty.output", onRemoteOutput)`，两者载荷都是 `{ id, data }`。agent 要拦这两条流拿自己命令的输出。
- `src/policy/classify.mjs` 的 `classify(command, {allowlist, denylist})` 返回 `{decision:"auto"|"confirm", reason, hit}`，纯函数零 IO 永不抛。
- `src/config/store.mjs:30` `KNOWN_FIELDS = Object.freeze(["model"])`；`updateConfig()` 在 182 行只遍历 KNOWN_FIELDS；`normalize()` 负责回落。
- `test/config/store.test.mjs` 有断言 `KNOWN_FIELDS` 深等于 `["model"]` — 本卡要改成新列表（**这是卡内允许的改动**）。
- `package.json` 现在是 `"type": "module"`，deps `node-pty 1.2.0-beta.15` / `ssh2 1.17.0` / `ws 8.22.0` / `zod 4.6.7`。

# 6. 需求细节

## 6.1 新增依赖（必须锁定版本）

```bash
npm install ai@7.0.179 @ai-sdk/openai-compatible@3.0.94 --save-exact
```

两者都是 Apache-2.0。`zod@4.6.7` 已满足 peer 要求。安装后 `package.json` 的 dependencies 里要出现这两个，版本号不带 `^`。

## 6.2 配置字段

逐字按 `PROTOCOL-AGENT.md` §1 实现。要点：

- `DEFAULT_CONFIG` = `{ model: null, autonomy: "balanced", allowlist: [], reviewModel: null, basePrompt: null }`
- `normalize()` 对非法值回落默认，不抛错（配置文件被人手改坏时不能崩服务）
- `PUT /api/config` 触发的校验在 `src/server/http.mjs` 的 PUT 分支里做（现在那里已有 `INVALID_MODEL` / `UNKNOWN_FIELD` 的处理，照同样风格加）
- 校验错误码：`INVALID_AUTONOMY` / `INVALID_ALLOWLIST` / `INVALID_REVIEW_MODEL` / `INVALID_BASE_PROMPT`

## 6.3 白名单匹配

`src/ai/allowlist.mjs` 导出：

```js
export function matchAllowlist(command, allowlist) -> { hit: string } | null
```

语义见 `PROTOCOL-AGENT.md` §2。要点：prefix 模式必须校验**边界**（`"mkdir"` 命中 `"mkdir a b"`，不命中 `"mkdirx"`）。

## 6.4 硬禁止

`src/policy/forbidden.mjs` 导出 `forbiddenReason(command) -> string | null`。
`PROTOCOL-AGENT.md` §8 的表格就是测试用例表，**21 条全部要写成 `test/policy/forbidden.test.mjs` 的断言**。

实现建议（不是强制）：先 `command.replace(/\s+/g, " ")`，再对每个分类用正则；`rm -rf /` 这类要允许中间有空格差异（`rm  -rf   /` 也要命中）。

## 6.5 分级链

`src/ai/judge.mjs` 导出：

```js
export async function judge({ command, config, cwd, model }) -> {
  decision: "auto" | "confirm",
  reason: string,          // 给用户看的中文
  hit: string | null,      // 命中的规则/白名单条目
  risk: "safe"|"caution"|"danger"|null,
  reviewModel: string|null,
}
```

顺序严格按 §5。`autonomy === "strict"` 跳过第 4 级。

## 6.6 第二 AI 审阅

`src/ai/review.mjs` 导出：

```js
export async function reviewCommand({ command, model, cwd }) -> {
  risk: "safe"|"caution"|"danger", why: string, reversible: boolean, model: string
}
```

实现按 §5.1：强制 toolChoice + `stopWhen: stepCountIs(1)` + `AbortSignal.timeout(8000)`。审阅提示词**逐字**用 §5.1 里那段，一个字不许改。

失败（超时/网关不通/模型返回空）→ 不要抛，返回 `{ risk: null, why: "审阅服务不可用", reversible: null, model }`，由 `judge()` 决定 confirm。

## 6.7 PTY 执行通道

`src/ai/runner.mjs` 导出：

```js
export function createCommandRunner({ sessions, remote, log }) -> {
  setSessionResolver(fn),                  // ws.mjs 注入：sessionId -> "local"|"remote"|null
  run({ sessionId, command, quietMs, timeoutMs }) -> Promise<{ok, exitCode, output, truncated, userText?}>,
  probe(sessionId) -> Promise<boolean>,    // 能力探测，结果按 sessionId 缓存
  dispose(sessionId),                      // 会话关闭时清缓存
}
```

包装串、切分算法、结束判定、能力探测**逐字**按 §4。三个必须做对的点：

1. `lastIndexOf(startMark)` —— 回显里也会出现 startMark。
2. 静默判定要 `quietMs` 且已过 `minWaitMs`，且**必须在该命令自己的输出 buffer 上算**，不能被别的命令的输出刷新。
3. 输出截断到 4000 字符（头部 1000 + 尾部 3000），中间插 `\n…（中间省略 N 字符）…\n`。

## 6.8 Agent 主循环

`src/ai/agent.mjs` 导出：

```js
export function createAgentRunner({ log, runner, config }) -> {
  start({ requestId, question, model, context, sessionId, send }) -> { taskId, stop() },
  resolveApproval({ approvalId, approved, scope }),   // ws.mjs 调
  stopAll(),                                          // 服务关闭时调
}
```

按 §6 实现。几个必须做对的点：

1. `stopWhen: stepCountIs(8)`。
2. 审批挂在 `run_command.execute` 内部 `await`，**不要用 AI SDK 的 `toolApproval`**（实测跨轮必崩）。
3. `agent.start` 帧里的 `model` 是实际用的模型 id（`model || DEFAULT_MODEL`）。
4. `agent.step` 的 `output` 已经 stripAnsi + 截断，不要把原始字节塞进去。
5. 用户拒绝（`approved:false`）→ 工具返回 `{ denied: true, userText: "用户拒绝了这条命令。不要重试同一条…" }`，让模型换路。
6. 任务结束（无论成功/失败/停止）**必须**发且只发一次 `agent.done` 或 `agent.error`。
7. 任务运行中第二次 `agent.run` → 回 `agent.error{code:"BUSY", userText:"上一个任务还在跑，等它结束或点停止。"}`。
8. stop 时 `controller.abort()` + 所有 pending approval resolve 成 `{approved:false, aborted:true}`；**不要杀已在跑的 PTY 命令**。

## 6.9 WS 接线

`src/server/ws.mjs`：

- `InputFrame` 联合加三条（字段名逐字按 §3.1）
- `switch (frame.type)` 加三分支
- agent 出站帧通过传入的 `send` 发回原 socket
- `agent.approve` 要能路由到正确的 agent 实例（`resolveApproval`）
- socket 关闭时该 socket 的 agent 任务要 stop（别让模型继续跑）

# 7. 执行步骤

1. 读 `docs/PROTOCOL-AGENT.md` 全文（**这是唯一权威，字段名一个字都不许自创**）。
2. `npm install ai@7.0.179 @ai-sdk/openai-compatible@3.0.94 --save-exact`，确认 `package.json` 里是精确版本。
3. 写 `src/policy/forbidden.mjs` + `test/policy/forbidden.test.mjs`（先写测试，21 条按 §8 表格）。
4. 写 `src/ai/allowlist.mjs` + `test/ai/allowlist.test.mjs`（含边界用例：`mkdir` vs `mkdirx`）。
5. 改 `src/config/store.mjs` 的 4 个字段 + 往返测试 `test/config/agent-fields.test.mjs`；改 `test/config/store.test.mjs` 的 KNOWN_FIELDS 断言。
6. 写 `src/ai/review.mjs`。写一个手工脚本验证：对 `ls -la`、`rm -rf build`、`sudo rm -rf /` 三条命令各调一次，三条的 `risk` 分别是 safe/caution(或danger)/danger。
7. 写 `src/ai/judge.mjs` + `test/ai/judge.test.mjs`（覆盖 strict/balanced/loose 三档 × 白名单命中/未命中 × 审阅 safe/caution/danger/null）。
8. 写 `src/ai/runner.mjs` + `test/ai/runner.test.mjs`（用假 sessions 对象喂 `pty.output` 事件，验证：正常结束、回显干扰、静默超时、总超时、能力探测失败）。
9. 写 `src/ai/agent.mjs` + `test/ai/agent.test.mjs`（用假 model 或直接 mock `generateText`；验证：2 步完成、审批拒绝、stop、BUSY）。
10. 改 `src/server/ws.mjs` 接三条帧；改 `src/server/http.mjs` 的 config 校验错误码。
11. 跑 `D:/nodejs/install/node.exe --test`（**不带路径参数**，cwd 仓库根）。必须全绿。
12. 跑 `DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs`，必须 33/33。
13. 写 `REPORT-V3D.md`。

# 8. 示例与模板

## 8.1 判级链调用示例

```js
const verdict = await judge({ command: "rm -rf build", config, cwd: "/home/u/p" });
// → { decision: "confirm", reason: "AI 审阅：删除目录不可撤销", hit: null,
//     risk: "danger", reviewModel: "commandcode/deepseek/deepseek-v4.1-flash" }

const v2 = await judge({ command: "ls -la", config, cwd: "/home/u/p" });
// → { decision: "auto", reason: "只读命令", hit: null, risk: null, reviewModel: null }
```

## 8.2 runner 切分示例

PTY 流（已 stripAnsi）：

```
$ printf '\n__MT_S_ab12__\n'; ( ls\n ) 2>&1; printf '__MT_E_ab12__%s\n' "$?"
__MT_S_ab12__
a.txt  b.txt
__MT_E_ab12__0
```

→ `{ exitCode: 0, output: "a.txt  b.txt" }`

## 8.3 反例（必须避免）

- ❌ 用 `indexOf(startMark)` 而不是 `lastIndexOf` → 输出被截成空串
- ❌ 用 AI SDK `toolApproval` → 第 3 轮必崩
- ❌ 在 `agent.step.output` 里塞未 stripAnsi 的原始字节 → 前端渲染乱码
- ❌ 任务结束时忘了发 `agent.done` → 前端永远转圈
- ❌ `modify app/` → 越界，本卡禁止

# 9. 执行约束

- 只按本卡与 `docs/PROTOCOL-AGENT.md` 执行，不做卡外决策。遇到协议没覆盖的情况 → 返回 `needs_clarification`，不要自己发明字段。
- **禁止修改 `app/` 目录下任何文件**（那是 TASK-V3-C 的范围）。
- 复用现有：`classify()`、`gatewayBaseUrl()`、`DEFAULT_MODEL`、`registryOf()`、现有的 zod 校验风格、现有的日志 `log({level, code, msg, ...})` 风格。
- 日志里**禁止**出现完整命令（只打长度 + 前 40 字符），禁止出现密码/私钥。
- 不做卡外重构：不动 `classify.mjs`、不动 SSH 层、不动 PTY 层。
- 交付前自己按用户视角走一遍：一个不懂命令行的人说「把这个仓库的测试跑一遍告诉我有没有失败」，这条路径能不能走通。
- 产物标「待验收」，不许标「成品」。
- 按 §11 格式返回 JSON。

# 10. 验收标准

| 编号 | 必过/加分 | 场景 | 预期结果 | 验证方法 | 证据位置 |
|---|---|---|---|---|---|
| AC1 | 必过 | 依赖安装 | `package.json` dependencies 含 `ai: "7.0.179"` 与 `@ai-sdk/openai-compatible: "3.0.94"`（精确版本，无 `^`） | 读 package.json | REPORT-V3D.md §依赖 |
| AC2 | 必过 | 硬禁止清单 | §8 表格 21 条全部符合期望 | `node --test` 的 `forbidden.test.mjs` 全绿 | test/policy/forbidden.test.mjs |
| AC3 | 必过 | 白名单边界 | `mkdir` 前缀命中 `mkdir a b`，不命中 `mkdirx`；exact 模式只认完全相等；`enabled:false` 跳过 | `allowlist.test.mjs` 全绿 | test/ai/allowlist.test.mjs |
| AC4 | 必过 | 配置四字段 | GET 返回四个默认值；PUT 合法值后回读一致；四个非法值各返回对应 400 错误码 | `agent-fields.test.mjs` + 手工 curl | REPORT-V3D.md §配置 |
| AC5 | 必过 | 分级链顺序 | 硬禁止命令在 loose + 白名单命中的情况下**仍然 confirm** | `judge.test.mjs` 有这条断言 | test/ai/judge.test.mjs |
| AC6 | 必过 | 三档行为差异 | `ls -la`（内置只读）：三档都 auto；`mkdir testdir`：strict=confirm，balanced 且审阅 caution+不可逆=confirm，loose 且审阅 reversible=true=auto | `judge.test.mjs` | test/ai/judge.test.mjs |
| AC7 | 必过 | 审阅真调通 | 对 `ls -la` / `rm -rf build` / `sudo rm -rf /` 三条真调网关，返回三段合法 JSON（含 risk/why/reversible），单次 ≤8s | 手工脚本输出贴进 REPORT | REPORT-V3D.md §审阅实测 |
| AC8 | 必过 | runner 抗回显 | 喂一段含 startMark 回显的假输出，切出的 output 不含标记行、exitCode 正确 | `runner.test.mjs` | test/ai/runner.test.mjs |
| AC9 | 必过 | runner 异常路径 | 静默超时 → exitCode null + 中文 userText；总超时 → 同上；能力探测失败 → EXEC_UNSUPPORTED | `runner.test.mjs` | test/ai/runner.test.mjs |
| AC10 | 必过 | 多步任务 | 用假模型驱动至少 2 步，两次 `agent.step` 帧都发到 socket，最后有 `agent.done` | `agent.test.mjs` | test/ai/agent.test.mjs |
| AC11 | 必过 | 审批拒绝 | `approved:false` → 工具返回 denied，模型不重试；收尾有 `agent.done` 或 `agent.error` | `agent.test.mjs` | test/ai/agent.test.mjs |
| AC12 | 必过 | stop 与 BUSY | stop 后 pending approval 全 reject、发 `agent.done{stopped:true}`；运行中第二次 `agent.run` → `agent.error{BUSY}` | `agent.test.mjs` | test/ai/agent.test.mjs |
| AC13 | 必过 | 全量回归 | `node --test` 全绿（含旧 193 条，行为不变） | 命令原始输出 | REPORT-V3D.md §测试 |
| AC14 | 必过 | 健康检查 | `doctor.mjs` 33/33 | 命令原始输出 | REPORT-V3D.md §doctor |
| AC15 | 必过 | 前端未被改动 | `git diff --stat app/` 输出为空 | 命令原始输出 | REPORT-V3D.md §范围 |

# 11. 核验要求

**执行者自测（你）：** 上面 15 条全部执行，原始输出落盘。

**独立核验者（另一个会话）会重点挑这些：**

| 编号 | 对应 AC | 目的 | 步骤 | 预期 | 原始证据 |
|---|---|---|---|---|---|
| V01 | AC1 | 依赖精确版本 | 读 package.json | 两个都是精确版本 | stdout |
| V02 | AC2 | 硬禁止 21 条 | 重跑 forbidden.test.mjs | 21 绿 | 测试输出 |
| V03 | AC5 | 硬禁止不可绕过 | 构造 `autonomy:"loose"` + 白名单 `sudo`，跑 judge("sudo ls") | confirm | 测试输出 |
| V04 | AC6 | 三档差异 | 重跑 judge.test.mjs | 全绿 | 测试输出 |
| V05 | AC7 | 审阅真调 | 自己起 3480 服务（或直连网关）跑三条命令审阅 | 三段合法 JSON | 脚本输出 |
| V06 | AC8 | 回显抗性 | 重跑 runner.test.mjs | 全绿 | 测试输出 |
| V07 | AC12 | stop/BUSY | 重跑 agent.test.mjs | 全绿 | 测试输出 |
| V08 | AC13 | 全量 | `node --test`（不带路径） | 0 fail | 测试输出 |
| V09 | AC14 | doctor | `DOCTOR_PORT=3481 node scripts/doctor.mjs` | 33/33 | doctor-report.json |
| V10 | AC15 | 范围 | `git diff --stat app/` | 空 | stdout |

# 12. 交付物

- 上述新增/修改的源码与测试（落盘在仓库内）
- `REPORT-V3D.md`：逐条 AC 的实际结果 + 命令原始输出片段 + 三条审阅实测的真实 JSON + 白话总结
- 核验原始结果（`node --test` 完整输出、doctor-report.json）
- 执行报告按 §11 JSON 格式返回（正文 ≤200 字摘要，大内容指路径）

# 13. 风险与回退

| 风险 | 影响 | 回退 |
|---|---|---|
| AI SDK 在本机装不上/版本冲突 | 卡死 | 如实报 blocked，不要降级自写循环 |
| `toolChoice` 强制工具模型不遵守 | 审阅拿不到结论 | 已实测三个模型都遵守；若真失败，审阅失败一律 confirm（fail-closed），不影响安全 |
| PTY 静默判定误判（命令中途停顿被当结束） | 输出不完整 | 已在协议里写明代价是多一轮；模型看到不完整输出会再跑一条确认 |
| Windows cmd.exe 不支持标记法 | 自动执行不可用 | 能力探测会返回 EXEC_UNSUPPORTED，模型改为给命令清单，属预期行为 |

# 14. 澄清记录

- 用户 m02763 回复「B」= 卡 C 与卡 D 一起做（Gate 2 批准）。
- 用户 m02629 已定：自动执行档位放设置页、默认平衡；多步执行选 A（边跑边确认）；白名单选 C（前缀 + 整条都支持，默认前缀）。
- 用户 m02632 已定：面向不懂命令行的用户，要真正的 agent（思考/调工具/总结）；设置页要能设基础提示词。
- 用户 m02636 已定：尽量用现成开源（本卡已落到 Vercel AI SDK，不自己写循环）。

# 15. 执行报告要求

按 §11 返回 JSON，另加：
- 三条审阅实测的真实 JSON（逐字，不要改写）
- `node --test` 的 pass/fail 数字
- doctor 的 assertions 数字
- 哪些 AC 是打折的（例如测试用了 mock 而不是真网关），如实写
