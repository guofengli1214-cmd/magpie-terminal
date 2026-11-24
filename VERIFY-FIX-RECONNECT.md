# VERIFY-FIX-RECONNECT：主 agent 独立验收

- 任务卡：`TASK-FIX-RECONNECT.md`（用户 m02953「1A」批准修 O1/O2）
- 执行报告：`REPORT-FIX-RECONNECT.md`（执行者自述，**待验收**）
- 验收者：主 agent（不采信执行者自述，关键项全部亲跑）
- 结论：**通过**（AC1–AC11 全部有可追溯证据）

## 1. 结论（大白话）
状态栏现在显示「当前这个终端实际用的 shell」（`shell：PowerShell 7`），不再是探测到的默认 bash；宿主重启换了口令后，旧页面会在约 7 秒内自己刷新并连回来；如果已经自动刷过一次还是连不上，状态栏会明说「请刷新页面（F5）」，不会再无限刷新。

## 2. 验收标准逐条

| AC | 结果 | 主 agent 亲跑证据 |
| --- | --- | --- |
| AC1 shellLabel 五条规则 | PASS | `node --test test/app/status-bar-shell.test.mjs` → 5/5 |
| AC2 真实页面显示活动会话 shell | PASS | `.dispatch/my-verify-reconnect.txt`：`A_shell {"shell":"shell：PowerShell 7","conn":"已连接本地服务",...}`；截图 `.dispatch/my-verify-reconnect/O1-statusbar.png`，视觉复核逐字读到 `shell: PowerShell 7` |
| AC3 403 未标记 → 刷新一次带 `mt_token_reload=1` | PASS | 同上：`B_after_restart {... "search":"?mt_token_reload=1"}`；服务端日志同步出现 `AUTH_TOKEN_MISMATCH`（ws upgrade + GET /api/health 403）后 `PAGE_SERVED`→`WS_CONNECTED`→`SESSION_CREATED` |
| AC4 已标记不再刷新、只提示 | PASS | `.dispatch/my-verify-reconnect2.txt` 6/6：第二次重启后 `conn=本地服务已重启：这个页面用的口令已失效，请刷新页面（F5）再试。`，URL 12s/3s 后均不变，`mt_token_reload` 只出现 1 次 |
| AC5 200/异常/超时不刷新，且失败后仍会再探 | PASS | `node --test test/app/ws-client-stale-token.test.mjs` → `探测抛错：不刷新，且下一次失败仍会 probe → 第二次 403 只 replace 一次`；E2E 里宿主停机 9s（第 3 次探测必然打空）后仍能自动恢复，证明失败探测没有锁死后续探测 |
| AC6 staleToken 时状态栏提示、连上后消失 | PASS | `my-verify-reconnect2.txt` 出现提示；首轮 `my-verify-reconnect.txt` 连上时状态栏是「已连接本地服务」，无提示 |
| AC7 宿主重启后 ≤30s 自动恢复 | PASS | 7095 ms 恢复（`B_after_restart ... ms 7095`），远小于 30s |
| AC8 全量测试 + doctor | PASS | `D:/nodejs/install/node.exe --test --test-force-exit` → `tests 732 / pass 732 / fail 0`，EXIT=0（`.dispatch/my-reconnect-full.txt`，23:14:37，晚于全部代码改动 23:03:33）；doctor `33/33`（`.dispatch/my-doctor-reconnect.txt`，独立配置 `defaultShell:null` + `DOCTOR_PORT=3531`，EXIT=0） |
| AC9 不用 storage、`src/**` 零改动 | PASS | `git status --porcelain -- src` 空；新代码只用 `location.search` 标记（`app/core/ws-client.js`），无新增 localStorage/sessionStorage 调用 |
| AC10 默认注入路径行为一致 | PASS | 单测「探测返回 200：不刷新，继续退避（默认 fetch / location 路径）」走默认注入 |
| AC11 3 秒超时、AbortSignal 不可用不影响启动 | PASS | 代码 `probeSignal()`：`AbortSignal.timeout(3000)`，异常/缺 API 返回 `undefined` |

## 3. 代码核对（主 agent 亲自读 diff）
- `app/core/ws-client.js`：`RELOAD_AFTER_FAILURES=3`、`STALE_TOKEN_MARK="mt_token_reload"`、`shouldProbeStaleToken(attempt,{inFlight,marked})`（`marked` 优先于 `inFlight`）、`probeStaleToken()` 的 `finally { inFlight = false }`、`open` 时 `attempt=0; inFlight=false`。
- `app/core/session-store.js`：`staleToken` 字段 + snapshot + `setStaleToken()`，`setConnection("open")` 时复位。
- `app/ui/status-bar.js`：纯函数 `shellLabel()`；`statusText()` 在未连上且 `staleToken` 时返回刷新提示（优先于「正在重连…」）。
- `app/app.js:451`：`if (status.staleToken === true) store.setStaleToken(true);`。
- `src/**` 无 diff。

## 4. 派发与成本审计
- 档位：`commandcode/deepseek/deepseek-v4.1-flash --thinking max`（用户既定要求）。
- attempt 1：session `fix-reconnect-1`。执行到约 80% 时，主 agent 发现卡里「探测只做一次」的设计会在宿主停机期间打空探测后永久锁死自动刷新，**主动中止**并在卡里改成「inFlight 在途标记 + finally 复位」，同时补 AC5 后半句与 AC11。
- attempt 2：session `fix-reconnect-2`，模型只回了一句说明就结束（EXIT=0，无任何工具调用），判定为执行器空转；按「原卡不得无改动重跑」，改写了派发提示（要求先读卡、首步必须是工具调用、点明 inFlight 语义）后重派。
- attempt 3：session `fix-reconnect-3`，EXIT=0，产出代码 + 2 个测试文件 + E2E + 报告。
- 已知文档瑕疵：`REPORT-FIX-RECONNECT.md` 头部写「会话：`fix-reconnect-1`，attempt 1」，与实际第 3 次尝试（`fix-reconnect-3`）不一致；该字段是执行者照抄卡里 `session_id`，不影响产物。以本文件记录为准。

## 5. 风险与边界（随交付读）
- 页面确实被宿主重启时，自动刷新会把终端里的滚动内容丢掉（一次性）；这是换来「不用手动 F5」的代价。
- 如果宿主关机、长时间不再启动，页面只会退避重连，不刷新（探不到 403 就不刷新）——符合设计。
- 刷新标记会长期留在 URL（`?mt_token_reload=1`），无功能影响。

## 6. 未完成项
- 未提交（由主 agent 本轮统一提交）。
- 未推送 GitHub（用户 m02953「2B」暂缓；本地无 remote）。
