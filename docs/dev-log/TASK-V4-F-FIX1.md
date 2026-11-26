---
id: TASK-V4-F-FIX1
title: 卡 F 返工 1：修服务关闭不杀本地 PTY（测试挂死根因）+ 补报告与真窗口走查
status: approved
plan_version: 用户 m04217 选 A
approval_ref: 用户 m04217「A」
priority: P0
executor: pi
model_tier: 人类指定 commandcode/deepseek/deepseek-v4.1-flash（provider magpie）
attempt: 2
retry_budget: 1
escalation_policy: ask_human
session_policy: new_session_required
session_id: null
inputs:
  - C:/Users/41807/magpie-terminal/src/server/http.mjs（close() 在 1042-1050 行）
  - C:/Users/41807/magpie-terminal/src/server/ws.mjs（close() 在 640-672 行）
  - C:/Users/41807/magpie-terminal/src/pty/session.mjs（killAllSync 在 370 行）
  - C:/Users/41807/magpie-terminal/test/server/ws-agent.test.mjs
  - C:/Users/41807/magpie-terminal/TASK-V4-F.md（原始卡，AC 不变）
quality_benchmark: 以 `node --test`（不带 --test-force-exit）能自己跑完并退出为准 —— 这是「服务能正常关闭」的可执行证据，不靠报告宣称。
verification: 主 agent 独立跑不带 force-exit 的全量测试 + 三 shell 实连 + CDP 真浏览器走查
verifier: independent_new_session
depends_on: [TASK-V4-F]
---

# 0. 你现在接手的状态（先读这段，别重复挖）

卡 F 的功能代码**已经写在当前工作区里、没有提交**。上一轮 pi 在跑测试时被一个永不退出的测试进程挂死 54 分钟，被主 agent 杀掉，所以**没有写 REPORT-V4F.md，也没做真窗口走查**。你的任务是补这两件事 + 修一个真实缺陷。不要回退已有改动，不要重写已完成的代码。

当前 `git status --porcelain`（相对 HEAD 259817a）：
```
 M app/app.js
 M app/core/api.js
 M app/styles/components.css
 M app/ui/hosts-panel.js
 M app/ui/tab-bar.js
 M src/config/store.mjs
 M src/pty/bridge.mjs
 M src/pty/session.mjs
 M src/server/http.mjs
 M src/server/ws.mjs
 M test/config/agent-fields.test.mjs
 M test/config/store.test.mjs
 M TASK-V4-H.md
?? src/pty/shells.mjs
?? test/pty/shells.test.mjs
?? test/server/pty-shell.test.mjs
?? test/server/shells-route.test.mjs
```

# 1. 主 agent 已测出的根因（已用探针三组对照锁定，不要再猜）

**缺陷**：`src/server/http.mjs:1042-1050` 的 `close()` 只杀远程会话，不杀本地 PTY：

```js
close: async () => {
  wsHandle.close();
  try { remote.killAllSync(); } catch {}
  await new Promise((resolve) => server.close(resolve));
},
```

本地 `sessions`（SessionManager）一个都没杀，node-pty 的原生 handle 还活着 → Node 进程退不出去。

主 agent 的对照实验（`node v24.16.0`，复刻 `test/server/pty-shell.test.mjs` 的行为）：
- 只 start/close，不建会话 → 0.9s 正常退出，rc 0。
- 建一个真 bash 会话再 close → 8 秒后进程仍存活（`STILL_ALIVE_AFTER_8S`）。
- 上一条 + 手动 `handle.sessions.killAllSync()` → 2.0s 正常退出，rc 0。

主 agent 已把「在 close() 里补 `sessions.killAllSync()`」单独打进一份源码副本验证：`test/server/pty-shell.test.mjs` 用**不带 --test-force-exit** 的裸 `node --test` 跑，4/4 pass 且进程自己退出（rc 0）。不带这个修复时同一命令挂住 60s 以上被 timeout 杀掉。

# 2. 目标

1. **修** `close()`：本地 PTY 会话必须被杀，`node --test`（不带 `--test-force-exit`）能自己跑完退出。
2. **顺带**把 `test/server/ws-agent.test.mjs` 在 Windows 上偶发的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` 处理掉（这是基线老问题，不是卡 F 引入；见 §4）。
3. **补** `REPORT-V4F.md`：逐条 AC1–AC9 的实际结果 + 证据路径。
4. **补**真浏览器走查（CDP，真服务）：主机面板的「本机」+ shell 下拉、「+」下拉菜单、真用 PowerShell 建一个标签并在里面执行命令、非法 shellId 的表现。截图落盘。
5. 不改 AC 定义、不放宽断言、不删测试。

# 3. 非目标

- 不加新依赖、不改 `docs/mockups-v4/`、不改 `app/vendor/`。
- 不重做卡 F 的功能（它已在工作区里，只做必要的配合性小改）。
- 不 commit。

# 4. UV 断言这条，先看主 agent 已经排除了什么（省你 40 分钟）

主 agent 在源码副本上试过 4 种服务端改法，**全部仍然撞断言**：
1. `close()` 里跳过 `readyState !== OPEN` 的 socket 再 terminate；
2. `close()` 改成 async，tereminate 后 `await` 每个 socket 的 `close` 事件再 `wss.close()`；
3. async + `wss.close(cb)` 等回调；
4. 先 `client.close(1001)` 优雅关，150ms 后才 terminate。

触发器是**测试序列**，不是单条测试：
- `ws-agent.test.mjs` 前 3 条测试单独跑或两两组合 → 全绿；
- 一次性跑前 4 条（含 4 个 server 实例，每条都 `client.close()` 后立刻 `handle.close()`）→ 稳定撞断言；
- 纯 `startServer`+`close` 连开 6 个 server 不开 WS → 全绿；
- 开 WS 连 6 个 → 全绿。

**唯一有效的处置**：客户端 `close()` 之后、`handle.close()` 之前给 socket 关闭留出时间。测试侧加 60ms 等待（`await new Promise(r => setTimeout(r, 60))`）后 5/5 全绿。

你的做法（按这个顺序，别自由发挥）：
1. 先只做 §2 第 1 条（`sessions.killAllSync()`），重跑全量确认 hang 消失。
2. 再把 `test/server/ws-agent.test.mjs` 的 `withServer()` 改成：`finally` 里先 `await handle.close()`，但在**调用 close 之前**给 60–100ms 的宽限（或在每个测试的 `finally` 里 `client.close()` 之后等一次 `close` 事件）。目标只有一个：`node --test --test-force-exit test/server/ws-agent.test.mjs` 连跑 5 次 0 fail。
3. 如果按第 2 步仍不稳，**停下来写进报告**（`REPORT-V4F.md` 里单列一节「UV 断言：基线老问题，未彻底修，当前缓解做法是 X，残留概率 Y/5」），不要为了绿去改 `ws.mjs` 的产品语义、不要删测试、不要加 `--test-force-exit` 到 `npm test` 里冒充修复。

# 5. 跑测试的硬规则（上一轮就是在这里挂死的）

- **永远不要**裸跑 `node --test`。一律加一层超时壳：
  ```bash
  timeout 120 node --test --test-force-exit 2>&1 | tail -20; echo RC=$?
  ```
  （`D:/nodejs/install/node.exe`，cwd = `C:/Users/41807/magpie-terminal`。）
- 单个测试文件同理：`timeout 90 node --test --test-force-exit test/server/xxx.test.mjs`。
- 任何探针脚本必须自带 `process.exit(0)` 与 60s 硬超时；不留后台 node 进程。
- 如果某条命令 90 秒没返回：先 `ps -W | grep node` 找出子进程、`taskkill /PID <pid> /T /F`，再继续。**不要**换 19 种写法重试同一条命令。

# 6. 修完要做的实测（写进报告，给证据路径）

| 编号 | 做什么 | 期望 |
|---|---|---|
| V1 | `timeout 180 node --test`（**不带** --test-force-exit） | 自己跑完并退出（RC=0），`fail 0` |
| V2 | `timeout 90 node --test test/server/pty-shell.test.mjs`（不带 force-exit） | 4/4 pass 且进程退出 RC=0 |
| V3 | `node --test --test-force-exit test/server/ws-agent.test.mjs` 连跑 5 次 | 5 次全 0 fail（若仍偶发，按 §4 第 3 步记）
| V4 | `DOCTOR_PORT=3485 node scripts/doctor.mjs` | 33/33 |
| V5 | CDP 真浏览器：打开页面 → 点 rail「主机」→ 截图（本机条目 + shell 下拉 + SSH 列表） | 截图 + 下拉选项文本（三个 shell + 版本） |
| V6 | 主机面板 shell 下拉选 PowerShell → `GET /api/config` | `defaultShell:"powershell"` 落盘 |
| V7 | 标签栏「+」→ 截图菜单 | 菜单含「本机」三 shell 分组 + 主机分组 |
| V8 | 从「+」菜单点 PowerShell 新建标签 → 在该终端输入 `$PSVersionTable.PSVersion.ToString()` | 输出以 `5.1.` 开头（真 shell，不是 bash） |
| V9 | 从「+」菜单点 pwsh 新建标签 → 同上 | 输出以 `7.` 开头 |
| V10 | 发 `pty.create{shellId:"zsh"}` | 收 `session.failed` + `code:"PTY_UNKNOWN_SHELL"`，页面不崩、已有标签还能用 |
| V11 | 回归：终端能建 bash 标签并执行 `echo OK`；AI 抽屉能开关；主机面板有 SSH 主机时能列出来 | 都正常 |

CDP 注意：CDP 客户端只有 `send/close`，没有 `Input` 快捷属性，必须 `client.send("Input.dispatchMouseEvent", …)` / `client.send("Input.insertText", …)`；xterm 输入要先 `document.querySelector('.xterm-helper-textarea').focus()`。参考 `.dispatch/final-e2e.mjs` 的做法（已存在，可读）。

# 7. 交付物

- 代码改动（`src/server/http.mjs` 必改；`test/server/ws-agent.test.mjs` 按 §4 处置）。
- `REPORT-V4F.md`：开头一行写 `状态：待验收`。逐条 AC1–AC9 + V1–V11 的实际输出（贴关键行，不要整段日志），每条给证据文件路径。单列一节写 UV 断言的处理结果（修好了 / 未彻底修 + 缓解做法 + 残留概率）。
- `.dispatch/v4f-probe/*.txt`（测试与探针输出）、`.dispatch/v4f-shots/*.png`（1280×760 与 1440×900 各一套，至少覆盖 V5/V7/V8）。

# 8. 执行约束

- 独立新会话；只改上面点名的文件 + 报告；不动 `app/vendor/`、`docs/mockups-v4/`、`package.json`。
- 不做卡外架构决策；遇到卡里没写的取舍 → 停下来在报告里写清楚，不要自己扩范围。
- 不直接问人类任何问题。
- 不 commit；产出标「待验收」，不得标「成品」「已验收」。
- 交付前按使用者视角自己走一遍 V5–V11，发现缺陷先修再交。
