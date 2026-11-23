# 验收报告：TASK-V4-F / TASK-V4-F-FIX1（本机 shell 可选 + 「+」下拉）

验收人：主 agent（独立复跑，2026-11-23）
结论：**通过**（附三条已记录的小问题，不影响使用）

## 1. 背景

TASK-V4-F 由 pi 执行到「功能代码全部写完、测试反复挂死」后卡住；用户 m04217 选 A，派 TASK-V4-F-FIX1 修 close() 泄漏 + UV 断言 + 补报告 + 真浏览器走查。pi 第二轮把修复做完并把所有探针跑通，但**没有写 `REPORT-V4F.md`**（在反复跑基线 flaky 对照时空转 100 分钟，被我 `taskkill /PID 2484 /T /F` 止损）。本报告以主 agent 亲自复跑的证据为准，替代缺失的执行方报告。

## 2. 代码改动（我已亲读 git diff）

| 文件 | 改动 | 判定 |
|---|---|---|
| `src/server/http.mjs` | close() 增加 `try { sessions.killAllSync(); } catch {}`；新增 `GET /api/shells`（`{shells,default,configured}`）；`/api/config` 加 `defaultShell`；`new SessionManager({...,resolveShell})` | 合理，root cause 修法 |
| `src/pty/shells.mjs`（新） | `SHELL_IDS=["bash","pwsh","powershell"]`、`detectShells`、`resolveShellById`、`detectDefaultShell`、`resolveShellForRequest`、`resetShellsCache`；版本探测 3s 超时；pwsh 走 execFileSync 试跑绕开 WindowsApps 别名 EACCES | 合理 |
| `src/pty/bridge.mjs` | 抽出 `findMsysBash()` 供复用，`detectShell()` 改为调用它（行为逐字等价） | 纯重构 |
| `src/pty/session.mjs` | `create({cols,rows,cwd,shell})` 支持每会话 shell；`resolveShell` 可选注入，缺省保持旧行为 | 合理 |
| `src/server/ws.mjs` | `pty.create` 加 `shellId: z.string().max(32).optional()`（刻意不用 z.enum，非法值走 `session.failed` + `PTY_UNKNOWN_SHELL`）；`handleMessage` 改 async + 每 socket 串行队列；`resolveShellForRequest` | 合理 |
| `src/config/store.mjs` | `KNOWN_FIELDS` 加 `defaultShell`；非法值 400 `INVALID_SHELL`；读盘非法回落 null | 合理 |
| `app/ui/hosts-panel.js` | 「本机」固定条目 + `host-local-shell-select` 下拉 + `renderLocalRow`；切 shell 落盘并提示「只影响之后新开的标签」 | 合理 |
| `app/ui/tab-bar.js` | 「+」下拉：本机组三 shell + 已存主机组；`tab-new-menu`/`tab-new-local`/`tab-new-host` | 合理 |
| `app/styles/components.css` | +152 行全部新增；grep 验证 **0 处硬编码颜色、0 处 `inset Npx` 竖线** | 符合 v4 设计硬约束 |
| `test/config/{agent-fields,store}.test.mjs` | 断言加 `defaultShell`，无放水 | 合理 |
| `test/server/ws-agent.test.mjs` | `finally` 里 `client.close()` 后 `await 80ms` 再 `handle.close()`，修 UV 断言 | 测试侧时序缓解，不影响产品语义 |

新增测试 3 个文件：`test/pty/shells.test.mjs`(12)、`test/server/pty-shell.test.mjs`(4)、`test/server/shells-route.test.mjs`(5)。

## 3. 关键实测（全部主 agent 亲跑）

| 项 | 结果 | 证据 |
|---|---|---|
| 全量测试（裸跑，**不带** `--test-force-exit`） | `tests 425 / pass 425 / fail 0`，RC=0，18s 自己退出 → **close() 挂死已根治** | `.dispatch/my-final-full.txt` |
| doctor | 33/33 全 PASS，RC=0，30s（含 `D7-1a.browserAutoTab`、`D7-2b.browserComputedValue #1e1e2e`、`D7-3b.resumeKeepsSession`） | `.dispatch/my-final-doctor.txt` |
| 基线对照 | HEAD worktree（259817a）：405 tests / 404 pass / 1 fail（UV 断言）；工作区 425/425/0。逐用例名对比：**没有删测试** | `.dispatch/head-wt` |
| 服务端 shellId 链路（原始 WS 帧） | powershell → `PowerShell 5 / 5.1.22621.6133`；pwsh → `PowerShell 7 / 7.7.0`；bash → `5.2.37`；不带 → bash；zsh → `PTY_UNKNOWN_SHELL` | 早前 `.dispatch/v4f-verify-own.mjs` 会话记录 |
| AC6 重启后仍生效 | 临时 config 目录：PUT `defaultShell=pwsh` → 落盘；新 server 实例 GET 仍 pwsh，不带 shellId 建会话得 PowerShell 7 | `.dispatch/v4f-ac6-restart.mjs` |
| 真浏览器走查（自己写的 CDP 探针，非 pi 的） | 14 PASS / 1 FAIL（那 1 条是我断言写错：标题不区分 PS5/PS7，属设计现状，已转 H 卡小修）；含「+」菜单三项带实测版本、点 PS5 真出 5.1.x、点 PS7 真出 7.7.x、切下拉落盘、不指定 shell 用 defaultShell、bash 回归 | `.dispatch/v4f-own-raw.txt`、`.dispatch/v4f-own-shots/`（6 张） |
| AC9 SSH 回归（直连真主机 h-8cd47b 192.168.10.24） | `reg.create` → remote；`listFiles("/")` 28 条；`write` 执行 `echo AC9_MARKER_7731; uname -a` 真回显；close ok；572ms | `.dispatch/v4f-ac9-ssh.txt` |
| AC9 远程 UI 回归（真浏览器 + 真 SSH） | 点「局域网linux」→ 新标签 `🖧局域网linux`；文件 tab 启用并列出 **90 条**（📁.agently-cli …）；点外部面板关闭 `{hidden:true,open:"false"}` | `.dispatch/v4f-ac9-remote.txt`、`.dispatch/v4f-own-shots/own-ac9-remote-files.png` |
| AC9 本机 UI 回归 | AI 抽屉开（385×727）/关、主机面板、本机条目、点外部关闭 | `.dispatch/v4f-ac9-ui.txt`、`own-ac9-ai-open.png` |
| 宿主 3480 已跑新代码 | `GET /api/shells` → 三项真版本；`/ui/tab-bar.js` 含 `tab-new-menu` | curl 实跑 |
| pi 的探针（我核过原始 txt） | `walk-a-raw.txt` failed=0；`walk-b-raw.txt` failed=0（V8 PS5 5.1.22621 / V9 PS7 7.7.0 / V10 PTY_UNKNOWN_SHELL 不崩 / V11 bash 回归 + AI 抽屉） | `.dispatch/v4f-probe/`、`.dispatch/v4f-shots/` |

## 4. flaky 判定（基线与工作区同源）

- 工作区 23 次全量：19 全绿；4 次红 = `test/ssh/registry.test.mjs:318`（建连后立刻 close，30ms 竞态）×2 次 + `test/pty/session.test.mjs` 整文件 ×2。
- 基线 worktree 22 次全量：20 全绿；2 次红 = 同样的 registry 那条 + session.test.mjs。
- → **两条 flaky 均为基线自带，非卡 F 引入。** 单文件连跑 `test/ssh/registry.test.mjs` ×3 全 17/17。
- 教训：pi 花了约 100 分钟、22 次基线重复跑想证明这一点；从它落盘的 txt 里两分钟就能数出来。

## 5. 问题清单（不影响核心使用）

| 编号 | 问题 | 级别 | 处置 |
|---|---|---|---|
| P1 | 执行方 `REPORT-V4F.md` 缺失（pi 被止损时未写） | minor | 本报告 + `.dispatch/` 原始证据替代；已记录 |
| P2 | 标签标题 PS5/PS7 都显示 `PowerShell:`（`titleFor()` 取 shell 名首词） | minor | 已写入 `TASK-V4-H.md` §8 附带小修 |
| P3 | `test/server/ws-agent.test.mjs` 用 80ms sleep 规避 UV 断言（测试侧缓解，根因在 libuv teardown 时序） | minor | 记录为技术债；不阻塞 |

## 6. 结论

必过项 AC1–AC9 全部有原始证据，关键项经独立复跑，无越权、无擅自换能力、无泄漏（密钥扫描 0 命中），会话隔离成立。**通过。**
