---
id: TASK-FIX-RECONNECT
title: 状态栏显示当前会话的 shell + 宿主重启后旧页面自动恢复（O1/O2）
status: approved
plan_version: ACCEPT-FINAL.md §5（用户 m02953「1A」批准）
approval_ref: m02953「1A 2B」
priority: P1
executor: sub-agent
model_tier: commandcode/deepseek/deepseek-v4.1-flash --thinking max
attempt: 1
retry_budget: 2
escalation_policy: ask_human
session_policy: new_session_required
session_id: fix-reconnect-1
inputs:
  - app/ui/status-bar.js
  - app/core/ws-client.js
  - app/core/session-store.js
  - app/core/token.js
  - app/app.js
verification: node --test --test-force-exit + 真浏览器探针（重启宿主模拟 token 失效）
verifier: independent_new_session
depends_on: []
---

# 1. 背景（大白话）
插件服务每次启动都会重新生成一个 64 位 hex 口令（`src/server/auth.mjs` 的 `generateToken()`），页面通过首页 `<meta name="magpie-term-token">` 拿到它。现在有两个真实缺陷：

- **O1**：状态栏的「shell：」显示的是 `/api/health` 里「探测到的默认 shell」（本机 bash 5.2.37），而用户配置 `defaultShell=pwsh`，新会话实际跑 PowerShell 7。用户看到 bash 却在 PowerShell 里打字。
- **O2**：宿主重启后，已经打开的插件页面还拿着旧口令，WebSocket 每 10 秒被拒一次（宿主日志 `AUTH_TOKEN_MISMATCH`），永远连不回去，只能手动刷新。

# 2. 目标
- O1：状态栏优先显示**当前活动会话**的 shell；没有会话时才用 health 的探测值。
- O2：连续 3 次连不上时，用旧口令探一次 `/api/health`；确认 403（口令作废）就自动刷新一次页面；刷新过一次仍不行就在状态栏明确提示用户手动刷新，绝不无限刷新。

# 3. 非目标
- 不改服务端任何代码（`src/**` 一行不动），不新增接口，不改 WS 协议，不改 token 生成规则。
- 不动 AI 抽屉、文件面板、主机面板。
- 不引入新依赖；不用 localStorage/sessionStorage（沙箱 opaque origin 里会抛 SecurityError，见 `app/core/token.js` 注释）。

# 4. 涉及范围
- `app/ui/status-bar.js`（O1）
- `app/core/ws-client.js`（O2）
- `app/core/session-store.js`（只加一个 `staleToken` 字段 + `setStaleToken()`）
- `app/app.js`（把 `status.staleToken` 接到 store）
- 新增测试 `test/app/status-bar-shell.test.mjs`、`test/app/ws-client-stale-token.test.mjs`

# 5. 现有实现（别推翻）
- `app/ui/status-bar.js:72-77`：`shell.textContent = \`shell：${healthInfo.shell.name} ${healthInfo.shell.version}${fallback}\``。
- `app/core/ws-client.js:25-38 scheduleReconnect()`：指数退避，`attempt` 自增，`constants.RECONNECT_BASE_MS/MAX_MS`；`open` 时 `attempt = 0`。
- `app/core/session-store.js` snapshot 里已有 `sessions`（每项含 `shell` 字符串，例如 `bash`、`PowerShell 7`、`ssh devuser@192.168.10.24`）与 `activeId`。
- `app/app.js:424 handleWsStatus(status)`：`open` → `setConnection("open")`；`connecting` → `setConnection("connecting")`；其它 → `setConnection("closed")`。
- 实测（2026-11-24，真宿主 3480）：
  - `OPTIONS /api/health` 带 `Origin: null` + `Access-Control-Request-Headers: x-magpie-term-token` → **204**，`access-control-allow-origin: null`；
  - 有效口令 `GET /api/health` → **200**；错误口令 → **403** `{"code":"FORBIDDEN"}`。
  所以浏览器里可以用旧口令 fetch `/api/health` 来判断口令是否作废。

# 6. 需求细节
## 6.1 O1：状态栏 shell 文案
在 `app/ui/status-bar.js` 里导出**纯函数**：

```js
export function shellLabel(snapshot, healthInfo)
```

规则（按顺序）：
1. `snapshot.sessions` 里找到 `id === snapshot.activeId` 的项，且 `typeof active.shell === "string" && active.shell.length > 0` → 返回 `shell：${active.shell}`。
2. 否则 `healthInfo && healthInfo.shell` → 返回 `shell：${name} ${version}${fallback ? "（回退）" : ""}`（与现在一字不差，`version` 为空时不留尾空格）。
3. 都没有 → `shell：未知`。

`render()` 里那行改成用 `shellLabel(snapshot, healthInfo)`。不要删除 health 的其它用途。

## 6.2 O2：旧口令自动恢复
在 `app/core/ws-client.js` 里：

```js
export const RELOAD_AFTER_FAILURES = 3;
export const STALE_TOKEN_MARK = "mt_token_reload";
export function shouldProbeStaleToken(attempt, { probed = false, marked = false } = {})
```
- `shouldProbeStaleToken(attempt, { inFlight = false, marked = false } = {})` 纯函数：`attempt < RELOAD_AFTER_FAILURES` → `"none"`；`marked` → `"mark-and-report"`；`inFlight` → `"none"`；否则 `"probe"`。

行为（在 `scheduleReconnect()` 里，`attempt += 1` 之后调用）：
1. `marked` = 当前 URL（`location.search` 或 `location.href`）里是否已带 `mt_token_reload`。
2. `"mark-and-report"` → `onStatus({ state: "closed", staleToken: true, attempt })`，每次失败都报（状态栏提示手动刷新）。
3. `"probe"`：
   - `inFlight = true`；
   - `fetch(\`http://127.0.0.1:${port}/api/health\`, { cache: "no-store", headers: { "x-magpie-term-token": token }, signal })`，`token` 用现有的 `readToken()`，`signal` 用 `AbortSignal.timeout(3000)`（环境不支持时退回 `undefined`，不报错）；
   - **无论 200 / 403 / 网络错误 / 超时，都在 `finally` 里把 `inFlight` 复位为 `false`。** 这一步是硬要求：宿主重启期间服务可能还没起来，一次探测失败绝不能把页面锁死在「永不刷新」，下一次退避重试必须继续探测；
   - `res.status === 403` 且 `!marked` → 给当前 URL 加上 `mt_token_reload=1`（`new URL(location.href)` + `searchParams.set`）后 `location.replace(url)`；
   - `res.status === 403` 且 `marked` → `onStatus({ state: "closed", staleToken: true, attempt })`；
   - 其它 → 什么都不做，继续退避。
4. `open` 时把 `inFlight` 复位为 `false`。

要求（便于测试，不许写死全局）：
- `createWsClient(options)` 增加可选注入：`fetchImpl`（默认 `globalThis.fetch`）、`locationRef`（默认 `globalThis.location`）、`reload`（默认 `() => locationRef.replace(url)`）。没有这些注入时行为一致。
- 不许用 `sessionStorage`/`localStorage`（会抛 SecurityError）。刷新标记只能放在 URL 查询串里，靠 `location.replace` 保留。

## 6.3 O2：状态栏提示
`app/core/session-store.js`：
- state 增加 `staleToken: false`；
- snapshot 里带上 `staleToken`；
- 新增 `setStaleToken(value)`（布尔化，值没变不 notify）。
- `setConnection("open")` 时把 `staleToken` 复位为 `false`（连上了就不该再提示）。

`app/app.js` 的 `handleWsStatus`：当 `status.state !== "open" && status.state !== "connecting"` 且 `status.staleToken === true` → `store.setStaleToken(true)`。

`app/ui/status-bar.js` 的 `statusText(snapshot)`：若 `snapshot.connection !== "open" && snapshot.staleToken` → 返回
`"本地服务已重启：这个页面用的口令已失效，请刷新页面（F5）再试。"`
（优先于现有的「正在重连…」文案；`connection === "open"` 时不显示。）

# 7. 执行步骤
1. 写 `test/app/status-bar-shell.test.mjs`（纯函数，5 条）：
   - 有活动会话 `PowerShell 7` → `shell：PowerShell 7`；
   - 有活动会话但 shell 为空字符串 → 退回 health；
   - 没有会话、health `{name:"bash",version:"5.2.37"}` → `shell：bash 5.2.37`；
   - health `fallback:true` → 末尾「（回退）」；
   - 两者都没有 → `shell：未知`。
2. 写 `test/app/ws-client-stale-token.test.mjs`（纯函数 + 注入假 fetch/location，7 条）：
   - `shouldProbeStaleToken(2, {})` → `"none"`；`(3,{})` → `"probe"`；`(3,{inFlight:true})` → `"none"`；`(3,{marked:true})` → `"mark-and-report"`；`(9,{})` → `"probe"`。
   - 假 fetch 返回 `{status:403}` 且 `marked=false` → 调用 `location.replace` 一次，URL 含 `mt_token_reload=1`；
   - 返回 `{status:200}` → 不 replace；
   - fetch 抛错 → 不 replace，且**下一次 attempt 仍会 probe**（用序列假 fetch：第一次 reject、第二次 403 + `marked=false` → 断言 replace 恰好一次）；
   - `marked=true` 且 403 → `onStatus` 收到 `staleToken:true` 且不 replace。
3. 改 `app/ui/status-bar.js`、`app/core/ws-client.js`、`app/core/session-store.js`、`app/app.js`（按 §6）。
4. 自测：`D:/nodejs/install/node.exe --test --test-force-exit` 全绿（基线 **722**，加新用例后应为 722 + 新增数）。
5. 真浏览器自证（写 `.dispatch/fix-reconnect/e2e.mjs`，参考 `.dispatch/my-walk-final3.mjs` 与 `.dispatch/cdp.mjs`）：
   - 起独立实例端口 3795，config 复制真实用户配置（`defaultShell=pwsh`），打开页面；
   - 等首个会话出现，读 `[data-role="statusbar"]` 文本，断言含 `PowerShell`，不含 `bash`；
   - **模拟宿主重启**：`server.stop()` 后在同一端口重新 `startServer`（新 token），等 ≤ 30 秒，断言页面自动重新加载（`location.search` 含 `mt_token_reload=1`）且重新连上（状态栏出现「已连接本地服务」）；
   - 截图两张落 `.dispatch/fix-reconnect/`。
6. 写 `REPORT-FIX-RECONNECT.md`（结论、改了哪些文件与行、两组测试数、E2E 输出、已知边界）。

# 8. 示例
状态栏（有活动会话）：`shell：PowerShell 7`
状态栏（无会话）：`shell：bash 5.2.37`
断线且口令已作废且已自动刷过：`本地服务已重启：这个页面用的口令已失效，请刷新页面（F5）再试。`

# 9. 执行约束
- 全新会话只按本卡执行；不得直接询问人类；卡外决策返回 `needs_clarification`。
- 只准改 §4 列出的文件；发现必须改别处，先停下写进报告，不自行扩大范围。
- 保持既有代码风格与中文注释口径；不重构无关函数。
- 交付前按使用者视角自查，发现缺陷先修再交；产物标「待验收」，不许标「成品」。
- 不许为了让测试过而删断言、放宽既有断言或改基线数字。

# 10. 验收标准
- **AC1** `shellLabel` 五条规则逐条正确（单测锁）。
- **AC2** 状态栏在真实页面里显示活动会话的 shell（E2E：含 `PowerShell`）。
- **AC3** 断开后第 3 次重试触发 `/api/health` 探测；403 且未带标记 → 一次 `location.replace`，URL 带 `mt_token_reload=1`。
- **AC4** 已带标记 → 不刷新，`onStatus` 上报 `staleToken:true`。
- **AC5** 200 / fetch 异常 / 超时 → 不刷新，继续退避；**探测失败后下一次重试仍会再探**（不得出现「探一次失败就永不刷新」）。
- **AC6** 状态栏在 `staleToken` 且未连上时显示刷新提示；连上后提示消失。
- **AC7** E2E：宿主重启后页面 ≤ 30 秒自动恢复连接。
- **AC8** 全量测试全绿（722 + 新增），doctor 33/33。
- **AC9** 未使用 localStorage/sessionStorage；`src/**` 零改动。
- **AC10** 不使用注入参数时行为与现在一致（默认值路径被测到）。
- **AC11** 探测使用 3 秒超时，`AbortSignal.timeout` 不可用时不影响启动。

# 11. 核验要求
见 `.dispatch/fix-reconnect/` 下脚本与报告；执行者自测 AC1/AC3/AC4/AC5/AC8/AC9；主 agent 独立复跑 AC2/AC7 与全量回归。

# 12. 交付物
- 代码改动（§4 文件）
- `test/app/status-bar-shell.test.mjs`、`test/app/ws-client-stale-token.test.mjs`
- `.dispatch/fix-reconnect/e2e.mjs` + 输出 `e2e.txt` + 截图
- `REPORT-FIX-RECONNECT.md`（含 `node --test` 与 doctor 原始输出路径）
- 白话总结（做了什么/为什么/怎么验证/风险/未完成项）

# 13. 风险与回退
- 自动刷新最坏情况：刷新后仍是旧口令 → 有标记保护，只刷一次，之后显示提示，不会循环。
- 状态栏文案改变会影响截图类断言：仓库现有测试没有对 `shell：` 文案的断言（已 grep 确认），只需保证 §6.1 兜底分支逐字不变。

# 14. 澄清记录
（无）

# 15. 执行报告要求
产出清单、文件级 diff 说明、测试原始输出路径、E2E 输出、已知边界（例如：服务真的没起时只会退避，不刷新）、模型档位与 attempt、会话与审计信息。
