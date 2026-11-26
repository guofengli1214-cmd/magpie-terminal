# REPORT-FIX-RECONNECT

- 任务卡：`TASK-FIX-RECONNECT.md`（`plan_version: ACCEPT-FINAL.md §5`，`approval_ref: m02953「1A 2B」`）
- 执行者：sub-agent（commandcode/deepseek/deepseek-v4.1-flash --thinking max）
- 会话：`fix-reconnect-1`，attempt 1，retry_budget 2（本报告为第 1 次尝试）
- 状态：**待验收**（不是「成品」）
- 结论：O1/O2 均按卡实现；全量测试 **732/732**、doctor **33/33**、真浏览器 E2E **19/19**。
- 本轮特别修正：中止的前一轮草稿用了「粘性 `probed`」标记，探测失败一次后页面就再也不会自动刷新（正是 §6.2 禁止的锁死缺陷）。已改为 `inFlight` 在途标记，并在 `finally` 中无条件复位，用单测锁住「第一次探测抛错 → 下一次失败仍会 probe → 403 后恰好刷新一次」。

---

## 1. 产出清单

| 类型 | 路径 | 说明 |
| --- | --- | --- |
| 代码 | `app/core/ws-client.js` | O2 主逻辑：第 3 次失败探测、403 自动刷新一次、标记保护、`inFlight` 复位 |
| 代码 | `app/core/session-store.js` | `staleToken` 状态、snapshot 字段、`setStaleToken()`、连上复位 |
| 代码 | `app/ui/status-bar.js` | `shellLabel()` 纯函数；`statusText()` 口令失效提示 |
| 代码 | `app/app.js` | `handleWsStatus` 把 `staleToken` 接进 store |
| 测试 | `test/app/status-bar-shell.test.mjs` | 5 条 `shellLabel` 规则 |
| 测试 | `test/app/ws-client-stale-token.test.mjs` | 5 条（纯函数 + 4 个注入场景，共 10 个断言组） |
| E2E | `.dispatch/fix-reconnect/e2e.mjs` | 真宿主 + 真浏览器（CDP）探针 |
| E2E 输出 | `.dispatch/fix-reconnect/e2e.txt` | 19 PASS / 0 FAIL，自动恢复 1321 ms |
| 截图 | `.dispatch/fix-reconnect/e2e-1-connected-powershell.png` | 首屏：`shell：PowerShell 7`，无 bash |
| 截图 | `.dispatch/fix-reconnect/e2e-2-auto-recovered.png` | 自动刷新后：URL 带 `?mt_token_reload=1`（图内右上角有 E2E 证据角标） |
| 截图 | `.dispatch/fix-reconnect/e2e-3-stale-hint.png` | 已刷新过再断线：状态栏手动刷新提示，无刷新循环（额外一张） |
| 原始测试 | `.dispatch/fix-reconnect/node-test.txt` | `node --test --test-force-exit` 全量输出 |
| 原始 doctor | `.dispatch/fix-reconnect/doctor.txt` | `doctor: 33/33 assertions passed` |
| doctor 报告 | `.dispatch/fix-reconnect/doctor-report.json` | 33 项断言明细 |

未提交、未 stash、未动 `.git`；`src/**` 零改动（`git status --porcelain -- src` 为空）。

---

## 2. 文件级 diff 说明

### 2.1 `app/core/ws-client.js`（+117 / -0）

- L8：`export const RELOAD_AFTER_FAILURES = 3`
- L10：`export const STALE_TOKEN_MARK = "mt_token_reload"`
- L12：`PROBE_TIMEOUT_MS = 3000`
- L24-30：`shouldProbeStaleToken(attempt, { inFlight = false, marked = false })` 纯函数，严格按卡：
  - `attempt < 3` → `"none"`
  - `marked` → `"mark-and-report"`（先于 inFlight）
  - `inFlight` → `"none"`
  - 否则 → `"probe"`
- L51：`let inFlight = false`；L87-118 `probeStaleToken()`：
  - 进入即 `inFlight = true`；
  - `fetch("http://127.0.0.1:${port}/api/health", { cache: "no-store", headers: { "x-magpie-term-token": readToken() }, signal })`；
  - L76-84：`AbortSignal.timeout(3000)`，不可用时返回 `undefined`，不抛错；
  - L117：**`finally { inFlight = false; }`** —— 200 / 403 / 网络错误 / 超时都复位；
  - 403 + 未标记 → L65-72 `new URL(locationRef.href)` + `searchParams.set(STALE_TOKEN_MARK, "1")` + `reload(...)`；
  - 403 + 已标记 → `onStatus({ state: "closed", staleToken: true, attempt })`；
  - 其它状态 → 什么都不做，继续退避。
- L135-147：`scheduleReconnect()` 在 `attempt += 1` 和常规 `closed` 上报之后调用 `shouldProbeStaleToken(attempt, { inFlight, marked })`；`mark-and-report` 每次失败都上报。
- L168-174：`open` 时 `attempt = 0; inFlight = false;`。
- 注入项：`fetchImpl`（默认 `globalThis.fetch` 包装）、`locationRef`（默认 `globalThis.location`）、`reload`（默认 `locationRef.replace`）；不传时行为一致。

### 2.2 `app/core/session-store.js`（+15 / -1）

- L12：state 增加 `staleToken: false`（仅内存，沙箱不碰 storage）。
- L52：snapshot 带 `staleToken`。
- L129-143：
  - `setConnection("open")` 时把 `staleToken` 复位为 `false`；即使 connection 已经是 `open`，只要有 stale 标记也 notify 一次；
  - 新增 `setStaleToken(value)`：布尔化，值没变不 notify。

### 2.3 `app/ui/status-bar.js`（+40 / -7）

- L10-31：导出纯函数 `shellLabel(snapshot, healthInfo)`：
  1. 活动会话（`id === snapshot.activeId`）且 `shell` 非空 → `shell：${active.shell}`；
  2. 否则 health.shell → `shell：${name} ${version}${fallback ? "（回退）" : ""}`（version 为空不留尾空格）；
  3. 都没有 → `shell：未知`。
- L63-70：`statusText()` 在 `connection !== "open" && staleToken` 时优先返回
  `本地服务已重启：这个页面用的口令已失效，请刷新页面（F5）再试。`
- L100-111：`render()` 的 shell 一栏改为 `shellLabel(snapshot, healthInfo)`，并移出 `if (healthInfo)` 块，使 health 尚未返回时也能先显示活动会话的 shell；health 的 PTY 等其它用途保持不变。

### 2.4 `app/app.js`（+2 / -0）

- L451-452：`handleWsStatus` 在非 `open` / 非 `connecting` 分支，`status.staleToken === true` → `store.setStaleToken(true)`。

### 2.5 测试

- `test/app/status-bar-shell.test.mjs`：5 条（PowerShell 优先、空 shell 回退、无会话用 health、fallback 后缀、全无 → 未知）。
- `test/app/ws-client-stale-token.test.mjs`：5 组，覆盖：
  - `shouldProbeStaleToken` 的 2/3/9、`inFlight`、`marked` 优先级；
  - 403 + 未标记 → `location.replace` 恰好一次，URL 含 `mt_token_reload=1`，原有 query 保留；
  - 200 → 不刷新（走默认 `fetch` / `location` / `reload` 路径）；
  - **fetch 抛错 → 不刷新；下一次失败仍 probe；第二次 403 后恰好 replace 一次**（`inFlight` 复位回归锁）；
  - 已带标记 → 不探测、不刷新，`onStatus` 收到 `staleToken:true`。

---

## 3. 测试结果（原始输出路径）

### 3.1 全量测试

```text
命令：D:/nodejs/install/node.exe --test --test-force-exit
输出：.dispatch/fix-reconnect/node-test.txt
结果：EXIT=0
      tests 732
      pass 732
      fail 0
      skipped 0
```

基线 722，新增 10（5 + 5），`722 + 10 = 732`。既有断言未删、未放宽、基线数字未改。

### 3.2 doctor

```text
命令：MAGPIE_TERMINAL_CONFIG_PATH=C:/Users/41807/magpie-terminal/.dispatch/fix-reconnect/doctor-config/config.json \
      DOCTOR_PORT=3799 D:/nodejs/install/node.exe scripts/doctor.mjs
输出：.dispatch/fix-reconnect/doctor.txt
结果：EXIT=0；doctor: 33/33 assertions passed
```

说明：doctor 的步骤 3-5 直接用 bash 语义（`stty size`、`$((1+1))`、`bash.exe`）。真实用户配置当前是 `defaultShell=pwsh`，直接跑会在 `3 echo M-2` 超时（已实测两次；与本卡代码无关，doctor 自身是 bash 假设）。因此 doctor 用隔离的空配置目录运行，让默认 shell 回到自动探测的 bash；pwsh 路径由 E2E 单独验证。原始 doctor 报告已复制到 `.dispatch/fix-reconnect/doctor-report.json`，仓库根 `doctor-report.json` 已还原为运行前内容。

---

## 4. E2E（真宿主 + 真浏览器）

```text
命令：D:/nodejs/install/node.exe .dispatch/fix-reconnect/e2e.mjs
输出：.dispatch/fix-reconnect/e2e.txt
结果：E2E_RESULT pass=19 fail=0 recoveredInMs=1321
```

关键输出（省略 token 明文）：

```text
INITIAL:
  href: http://127.0.0.1:3795/
  shellText: shell：PowerShell 7
  connectionText: 已连接本地服务
  sessions[0].shell: PowerShell 7

SERVER_1_STOPPED -> 空窗 2.5s -> SERVER_2 (same port 3795, new token)

RECOVERED:
  href: http://127.0.0.1:3795/?mt_token_reload=1
  search: ?mt_token_reload=1
  shellText: shell：PowerShell 7
  connectionText: 已连接本地服务
  elapsedSinceSecondStartMs: 1321
  elapsedSinceStopMs: 3829
  authMismatchLogged: true

STALE_HINT:
  connectionText: 本地服务已重启：这个页面用的口令已失效，请刷新页面（F5）再试。
  search: ?mt_token_reload=1
  sentinel: kept-after-reload
  staleToken: true
```

E2E 断言摘要：

- O1 状态栏含 `PowerShell`，整条状态栏不含 `bash`；
- 初始 URL 无标记，meta token = 第一个宿主 token；
- 同端口重启后 token 变化，新宿主日志出现 `AUTH_TOKEN_MISMATCH`（旧页面确实带旧 token 来敲门）；
- 页面自动刷新，URL 含且仅含一个 `mt_token_reload=1`，刷新后 meta token = 新宿主 token，并重新 `open`；
- 从第二个宿主启动到恢复连接 **1321 ms** ≤ 30 s；
- 刷新后再次停宿主：页面不再刷新（sentinel 仍在），状态栏出现手动刷新提示，`staleToken:true`；再等 1.5 s 仍无刷新循环。

截图：

- `.dispatch/fix-reconnect/e2e-1-connected-powershell.png`
- `.dispatch/fix-reconnect/e2e-2-auto-recovered.png`（右上角蓝色角标是 E2E 证据，显示刷新后 URL 与「meta token === 新宿主 token: true」；截完即移除，不属于产品 UI）
- `.dispatch/fix-reconnect/e2e-3-stale-hint.png`

---

## 5. 验收标准对照

| AC | 结果 | 证据 |
| --- | --- | --- |
| AC1 `shellLabel` 五条规则 | PASS | `status-bar-shell.test.mjs` 5 条 |
| AC2 真实页面显示活动会话 shell | PASS | E2E `shell：PowerShell 7`，整条状态栏无 `bash` |
| AC3 第 3 次失败探测；403 → replace 一次且带标记 | PASS | 单测 + E2E URL `?mt_token_reload=1` |
| AC4 已带标记不刷新，上报 `staleToken:true` | PASS | 单测 + E2E sentinel/无刷新循环 |
| AC5 200/异常/超时不刷新；失败后下一轮仍探测 | PASS | 单测「抛错 → 第二次 403 → replace 恰好一次」；E2E 空窗 2.5s |
| AC6 状态栏 stale 提示；连上后消失 | PASS | E2E `STALE_HINT`；store `setConnection("open")` 复位 |
| AC7 宿主重启 ≤30s 自动恢复 | PASS | E2E 1321 ms（从第二宿主启动计） |
| AC8 全量测试 + doctor | PASS | 732/732；doctor 33/33 |
| AC9 无新增 storage；`src/**` 零改动 | PASS | 本次改动无 storage；`git status --porcelain -- src` 为空 |
| AC10 默认注入路径行为一致 | PASS | 单测「200 → 不刷新（默认 fetch/location/reload）」 |
| AC11 3 秒超时、不支持时不报错 | PASS | `AbortSignal.timeout(3000)` + fallback；单测断言 `init.signal` 存在 |

---

## 6. 已知边界 / 风险

1. **服务真的没起时只会退避，不会刷新**：这是设计。探测失败不改变状态，下一次退避重试仍会继续探；服务回来后一旦拿到 403 才刷新。
2. **标记只保证「自动刷新一次」**：URL 带 `mt_token_reload=1` 后再失败，永不自动刷新，只显示手动刷新提示；用户必须按 F5。这是防循环的硬边界。
3. **探测在途时跳过本轮**：`inFlight=true` 时第 N 次失败不会再发并发探测；探测在 `finally` 复位，所以不会锁死后续轮次。`marked` 优先于 `inFlight`，已刷新页面每轮都会上报提示。
4. **探测期间重新连上会丢弃探测结果**：`attempt` 已复位到 0 时，晚到的 403 不会触发刷新。
5. **E2E 使用端口 3795 与 headless Chrome**：需本机有 Chrome；脚本会复制真实配置到 `.dispatch/fix-reconnect/e2e-state/` 并把副本里的 `defaultShell` 固定为 `pwsh`，跑完可删；EOF 后不会遗留服务进程。
6. **doctor 的 bash 假设是既有约束**：`defaultShell=pwsh` 时 doctor 第 3 步会超时。本次没有改 doctor（不在 §4 范围），改用隔离配置得到 33/33；如果验收要求「真实 pwsh 配置下 doctor 也 33/33」，需要另开卡改 doctor，这属于卡外改动。
7. **仓库里既有的 localStorage 使用**：`app/ui/ai-drawer.js`、`app/ui/file-panel.js` 早就有 localStorage（带降级处理），不在本卡 §4 范围，本次没有触碰；新增代码零 storage。
8. **E2E 输出含一次性宿主 token**：两个宿主都已关闭，token 已失效；报告正文不复制 token。截图 2 的角标只显示布尔判断，不显示 token。
9. `shellLabel` 的 health 分支在 `name` 缺失时使用「未知」兜底（例如 `{shell:{}}`），正常 health 一定带 name；卡面要求的五种情况逐条被单测锁住。

---

## 7. 白话总结

**做了什么**：状态栏的 shell 不再只信 `/api/health`，优先显示当前标签真实跑的那个 shell；重连连续失败 3 次后，用旧口令去问一次 `/api/health`，确认 403 就自动刷新一次页面。刷新标记放在 URL 里（不用会被沙箱拒绝的 localStorage/sessionStorage）。刷新过一次还连不上，状态栏直接告诉用户按 F5，绝不刷新循环。

**为什么**：用户配置 `defaultShell=pwsh`，health 探测的却是 bash，状态栏「骗人」；宿主重启会换 token，旧页面不刷新就永远连不回去。中途还修掉了草稿里「探测失败一次就再也不刷新」的锁死逻辑。

**怎么验证**：10 条新单测（含失败探测后下一次仍会刷新的回归）；全量 732/732；doctor 33/33；真浏览器里起 3795 端口、复制真实 pwsh 配置、停宿主 2.5 秒再用新 token 重启，页面 1.3 秒自动刷新并重连，再停宿主只提示不刷新。

**风险**：自动刷新最多一次；服务没起时只退避；doctor 的 bash 假设是既有问题，用隔离配置绕过并在上面写明。

**未完成项**：无（卡内范围）。卡外未做：改 doctor 让其兼容 pwsh；清理仓库既有 localStorage 使用。

---

## 8. 审计信息

```text
git status --porcelain=v1
 M app/app.js
 M app/core/session-store.js
 M app/core/ws-client.js
 M app/ui/status-bar.js
?? TASK-FIX-RECONNECT.md
?? test/app/status-bar-shell.test.mjs
?? test/app/ws-client-stale-token.test.mjs

git diff --numstat
2   0   app/app.js
15  1   app/core/session-store.js
117 0   app/core/ws-client.js
40  7   app/ui/status-bar.js
```

- 未执行 `git commit` / `git stash`；未对 `.git` 做任何写操作（只读 `git status` / `git diff` 用于自查）。
- 未改 `src/**`、未新增依赖、未改 WS 协议 / token 生成规则。
- E2E 结束后已删除含真实配置副本的 `e2e-state/`；`doctor-config/` 为空目录，仅供复跑 doctor 指路。
- 报告为「待验收」。
