# E2 失效口令页面：停止轮询 + 服务端告警限流

## Goal

服务重启（插件更新、magpie 重启、开发热重载）后，**已经打开的旧页面**仍持有失效 token：
主题每秒轮询 `GET /api/theme`、ws 每 ≤10s 重连，服务端每次都写一条 `warn`。
实测：628KB 日志里 5136 条 `AUTH_TOKEN_MISMATCH`，约 1.3KB/s，2MB 轮转约 24 分钟就把真实排障日志滚掉。
E 批交付的「日志导出」因此基本失去价值。

修两处：**客户端在确认口令失效后停止轮询/重连**（页面本来就必须刷新才能恢复），
**服务端对重复的同类告警做限流**（第一发照常终归要留住，之后计数、窗口结束时报 suppressed）。

## 现状（行号可查，E 批已合入 9ee519f）

- `app/app.js:122` `const THEME_POLL_MS = 1000;`
- `app/app.js:907` `createThemeSync()`：`tick()` 拿到 `response.ok === false` 只跳过不降频，`schedule()` 永远每秒一拍。
- `app/core/api.js:10` `getJson()`：非 2xx 时透传 body 的 `code`；403 走 `writeForbidden` 返回 `{code:"FORBIDDEN"}`（http.mjs:207-219，故意不区分原因）。
- `app/core/ws-client.js:129` `scheduleReconnect()`：`action === "mark-and-report"` 时 `onStatus({staleToken:true})` 之后**仍然**继续 setTimeout 重连；`probeStaleToken()` 在 :104-110 同样只上报。
- `src/server/http.mjs:109` `makeLogger(sink, options)`：`log(entry)` → `formatLogLine` → stdout + writer.write，无任何去重。
- `src/server/ws.mjs:247` ws upgrade rejected 也走同一个 `log`。
- 现有测试：`test/app/theme-sync.test.mjs`、`test/app/ws-client-stale-token.test.mjs` 已覆盖旧行为（无限重连是该测试的现状断言），**必须同步更新**，不许为了过测试删断言。

## Requirements

### R1 客户端：连续 403 后停止主题轮询（app/app.js）

- `createThemeSync` 内新增连续鉴权失败计数：`response && response.ok === false && (response.code === "FORBIDDEN" || response.code === "HTTP_403")` 视为鉴权失败；连续 **2** 次 → 调用内部 `stop()`，不再 schedule，并（如 deps 提供）调用 `deps.onAuthLost()` 通知调用方。
- 任何一次成功（`ok === true`）都把计数清零——不能因为一次网络抖动就永久停掉主题跟随。
- 网络错误（`code === "NETWORK"`）不计入鉴权失败计数。
- `stop()` 之后行为：不再 fetch、移除 visibilitychange / focus 监听（现有 stop 逻辑已如此）。
- 调用方（`app/app.js:983` 附近 `themeSync = createThemeSync()`）：`onAuthLost` 时把 `themeSync` 置空并调用状态栏已有的「口令失效」提示路径（`app/ui/status-bar.js:68` 的文案是 ws 侧用的；主题侧只需 console.info 一行，不新增 UI）。**不许**自动 location.reload。

### R2 客户端：staleToken 上报后停止 ws 重连（app/core/ws-client.js）

- `scheduleReconnect()` 中当 `action === "mark-and-report"`（即已带刷新标记、确认口令失效）：`onStatus({state:"closed", staleToken:true, attempt})` 之后**不再 setTimeout 重连**。
- `probeStaleToken()` 的 `marked` 分支同理：只上报，不再排队重连（现在 probe 返回后 close handler 还会再 schedule 一次，必须切断）。
- `retryNow()` 语义保留：手动调用仍能重新 connect（防将来做「重试」按钮）。
- `close()` 仍然彻底停止。
- 更新 `test/app/ws-client-stale-token.test.mjs`：把「已带标记仍会继续重连」的旧断言改成「不再重连、onStatus 收到 staleToken:true」；新增「retryNow 后能重新连接」用例。

### R3 服务端：重复告警限流（src/server/http.mjs）

- `makeLogger` 的 `log(entry)` 增加限流层，只作用于 `entry.level === "warn" || entry.level === "error"` **且** `typeof entry.code === "string"` 的行。
- 限流键：`level + "|" + code + "|" + (entry.route || "")`。
- 窗口：同一键 **60 秒**内最多落一条；被压掉的行计数。
- 窗口结束后该键下一次落盘时，条目里追加 `"suppressed": <上次窗口被压掉的条数>`（无压掉则不加该字段）。
- 实现要求：可注入 `now` 与 `windowMs`（`makeLogger(sink, { dedupeWindowMs, now })`），默认 60000 / Date.now，单测不真等 60s。
- `dedupeWindowMs <= 0` 表示**关闭限流**（给探针数原始 403 次数用），必须在注释里写明这个语义。
- stdout 与文件必须保持一致（被限流的行两条路都不落）。
- `level === "info"` 的行（含 SERVER_STARTED）**绝不许**被限流。
- 新增 `test/server/log-dedupe.test.mjs`：①同键 5 连发只落 1 条；②不同 route 各自落 1 条；③窗口过后再发带 `suppressed` 计数且计数正确；④info 不被限流；⑤限流后重启计数从头开始。
- 更新 `.trellis/spec/backend/logging-guidelines.md`：加一节「重复告警限流」，写清键、窗口、suppressed 语义，并注明「任何依赖逐条 warn 的排障方式都要改看 suppressed 计数」。

## Files（白名单，只许动这些）

- `app/app.js`（只动 `createThemeSync` 与 `themeSync = createThemeSync()` 接线）
- `app/core/ws-client.js`
- `src/server/http.mjs`（只动 `makeLogger` 与其导出/注释）
- `test/app/theme-sync.test.mjs`、`test/app/ws-client-stale-token.test.mjs`、新增 `test/server/log-dedupe.test.mjs`
- `.trellis/spec/backend/logging-guidelines.md`
- 新增 `scripts/probe-stale-page.mjs`（见 AC4）
- `.dispatch/fix17-e2/**`

**禁改**：`app/vendor/**`、`app/tokens.css`、`app/styles/**`、`app/ui/**`（status-bar 也不动）、`app/core/{api,session-store,agent-store,token,constants}.js`、`src/pty/**`、`src/ai/**`、`src/fs/**`、`src/server/{ws,logger,log-redact,auth,magpie-settings}.mjs`、`src/config/**`、`package.json`、`scripts/doctor.mjs`、`page/**`。

## AC（每条都要有原始证据落盘）

- **AC1** 单测：主题轮询连续 2 次 403 后停止 fetch（注入计数 fetch，断言第 3 拍不再调用）；一次成功把计数清零；NETWORK 不算鉴权失败。
- **AC2** 单测：ws-client 已带标记时不再重连（假定时器推进 60s，connect 次数不再增长）；retryNow 可恢复。
- **AC3** 单测：log-dedupe 五条用例全过（见 R3）。
- **AC4** 真浏览器探针 `scripts/probe-stale-page.mjs`（自写，仿 `scripts/browser-probe.mjs` 的 CDP 写法）：
  1. 用 `makeLogger(collector, { file: false, dedupeWindowMs: 0 })` 包一个收集器（关掉限流，才能数**原始** 403 次数），再 `startServer({port:P1, token:T1, log})`，真 Chrome 打开 `http://127.0.0.1:P1/`；
  2. 关闭第一个服务，用 **新 token T2** 在**同一端口** P1 起重启（模拟插件重启），换新的同一个收集器；
  3. 观察 12 秒，数第二个服务收集到的原始告警行：
     - `AUTH_TOKEN_MISMATCH` 且 `route` 含 `/api/theme` 的条数 **≤ 3**（旧行为约 12 条）；
     - `route` 含 `ws` 的条数 **≤ 3**（旧行为持续重连）；
     - 页面无 JS 崩溃（`Page.javascriptDialogOpening` 不出现，Runtime 异常计数 0）。
  4. 另起一次 15 秒的运行，用默认 `dedupeWindowMs`（60000）验证：同一键只落 1 条，且行 JSON 合法。
  5. 探针输出单行 JSON 断言结果，退出码 0/1。
- **AC5** 无回归：`node --test` 全绿（目标 ≥ 985，只增不减）；`DOCTOR_PORT=3492 MAGPIE_TERMINAL_CONFIG_PATH=$PWD/tmp/doctor-e2/config.json node scripts/doctor.mjs` 33/33；`node scripts/probe-terminal-edges.mjs` 10/10。
- **AC6** `git status --porcelain` 里除白名单外无改动；`grep -rn "suppressed" src/server/http.mjs` 有实现，日志行 JSON 合法。

## 交付

- REPORT.md（末尾 `verdict: PASS|FAIL`）+ 证据落 `.dispatch/fix17-e2/evidence/`
- 提交前自查：新代码无颜色字面量（无关本批）、无 console.log 调试残留、无 `setTimeout` 未清理。

## 本机坑

- doctor 必须隔离配置：`MAGPIE_TERMINAL_CONFIG_PATH=$PWD/tmp/doctor-e2/config.json` + `DOCTOR_PORT=3492`（3450 以外、避开 3480/3490）。
- node 在 `D:/nodejs/install`；pi 在 `/c/Users/41807/AppData/Roaming/npm`。
- 临时脚本放仓库 `tmp/`（已 gitignore）。
- 子进程 / Chrome 收尾要 kill；headless Chrome 用临时 profile，结束删掉。
