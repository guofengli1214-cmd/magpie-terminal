# VERIFY-V4-H — AI 会话模型重写 独立验收（主 agent 亲跑）

**被验对象**：工作区 uncommitted 改动（相对 HEAD `8295595`）—— 20 M + 5 未跟踪，`git diff --stat` = **+3838/−544**。
**执行者自述**：`REPORT-V4H.md`（标「待验收」，声称 673/673、doctor 33/33、AC1–AC13 全 PASS）。
**验收人**：主 agent。下表每个数字都是亲自复跑或亲自读原始产物得出，原始日志在 `.dispatch/`。

## 1. 结论

**通过。** AC1–AC13 全部有可追溯的主 agent 实测证据，无必过项失败；执行者 §3 列的 11 条打折项逐条复核后均不构成阻断（详见 §4）。

## 2. AC 逐条结果

| AC | 结果 | 主 agent 实测证据 |
|---|---|---|
| AC1 同一会话连续两问，第二问用指代并引用上一轮真实输出 | **PASS** | `.dispatch/my-v4h-e2e.txt`（复跑执行者探针，真实网关）：`DONE pass=14 fail=0`。会话 `s-0e2aa6aa` 两轮同 ID；第二问回答「三个文件中最大的是 REPORT.md，它精确大小是 89,402 字节」，逐字引用第一轮 `ls -lS` 的真实输出。反向核对：`REPORT.md` 实际 89402 字节、`REPORT-V2A.md` 80218、`TASK.md` 43426 —— 数字非编造 |
| AC2 重启后仍能列出会话并还原 steps | **PASS** | 同上探针：服务 3514 → kill → 3515 重启，`GET /api/ai/sessions` listed=1，`GET /api/ai/sessions/:id` → `steps=4 messages=6` |
| AC3 会话跟随终端标签，切回来历史还在 | **PASS** | `.dispatch/my-v4h-ui.txt`：切标签会话跟着切；历史 176 个时间线节点还原；新标签空态 + 可新建 |
| AC4 按终端分组、当前项只有底色无竖线、徽标 | **PASS** | 同上：三组 `["bash: 41807","prod-web-01","bash: 41807"]`；当前项 computed `{"boxShadow":"none","borderLeftWidth":"0px","background":"rgba(120,160,220,0.18)"}`；本机徽标 `bash 5.2.37`；远程徽标 `{w:68,h:26,dir:"column"}`（≤120px）。源码侧 `app/styles/components.css:2825` 当前项规则只有 `background: var(--term-accent-soft)`，无 `border-left`／`::before`；全仓 `border-left` 7 处均不在会话列表 |
| AC5 工具卡（命令/状态/耗时/输出可展开）+ 折叠思考过程 | **PASS** | 同上：输出默认折叠露 3 行、展开后折叠标记消失；思考块 DOM「▸思考过程 · 1479 字」hidden=true；真模型两轮 reasoning 1479 字（`.dispatch/v4h-probe/v4h-live.txt`） |
| AC6 角标四态可辨 + tooltip 两段标题逐字 | **PASS** | 同上：四态 `["ok","caution","danger","none"]`；tooltip 两段逐字「执行后会发生什么」「为什么需要你确认」；悬停可见；`cardOverflow: visible`；1440 下 `rightGap:10 bottomGap:10`。样式侧 `app/styles/components.css:635-680`（20×20 / absolute right9 bottom9 / 四态各自 color+border+soft 背景） |
| AC7 设置开关默认关→开→PUT/GET 一致→关消失 | **PASS** | 同上：默认 off；开后确认卡常显 effect；`PUT`/`GET` 一致；关掉后消失 |
| AC8 strict 档审阅确实被调用且 safe 仍 confirm | **PASS** | `.dispatch/my-v4h-e2e.txt`：strict 档 `reviewLines=2`、日志有 `[REVIEW]`；`risk=safe` 的命令仍返回 confirm（不自动执行）。源码 `src/ai/judge.mjs:13-15` 注释「三档都必须调审阅」，无 strict 跳过分支（用户 2026-11-24「就算选了宽松挡位，也需要审核 AI 评审」已落实）。注：`failed=1` 是网关随机失败（`REVIEW_FAILED` → 按需确认），执行者自测那次 0，属外部抖动 |
| AC9 审阅模型换成不存在的 id → none + confirm + 指定 reason | **PASS** | 同上：17ms 返回 `risk=null`、`reason:"审阅服务不可用，按需要确认处理"`、日志 `REVIEW_FAILED`、任务不崩（`src/ai/judge.mjs:31` 为该常量） |
| AC10 `rg reviewWhy` 0 命中 | **PASS** | 亲跑 `rg -n "reviewWhy" src app test scripts` → 无输出，`RG_EXIT=1` |
| AC11 `node --test` 0 fail；doctor 33/33 | **PASS** | 全量 `.dispatch/my-v4h-full-1.txt`：`tests 673 / pass 673 / fail 0`，18.77s，RC=0（ssh registry flaky 本轮未复现）；doctor `.dispatch/my-v4h-doctor.txt`（DOCTOR_PORT=3521）：`33/33 assertions passed` RC=0 |
| AC12 喊停后不再执行、已跑输出保留、标「已停止」 | **PASS** | `.dispatch/my-v4h-e2e.txt`：`{"stopped":true,"status":"stopped","steps":1}`，已跑完输出保留 |
| AC13 加分：流式逐字 | **PASS** | 同上：55 帧流式增量 |

## 3. 真浏览器走查（主 agent 复跑执行者探针）

`.dispatch/v4h-probe/v4h-ui.mjs` → `.dispatch/my-v4h-ui.txt`：**`DONE pass=47 fail=0`** RC=0。覆盖 AC3/AC4/AC5/AC6/AC7/AC13 + 两处遗留小修：
- model-select：`{"ratio":62,"text":"DeepSeek V4.1 Flash (latest) · Command Code▾"}`，与发送按钮间隙 8px（1280）；1440 下 61px。
- `shellShortName()`：`bash→bash`、`PowerShell 5*→PS5`、`PowerShell 7*→PS7`（`app/ui/tab-bar.js:16`），单测 5 条。
- 重命名/删除：行内输入框 + 行内二次确认（因 `window.prompt` 在 headless/沙箱 WebView 直接阻塞不返回），操作后服务端 404 确认删除生效。

## 4. 打折项复核（11 条）

| # | 内容 | 我的判断 |
|---|---|---|
| 1 | 流式是「服务端增量追加 + `agent.text` 帧」，非 token 级 SSE | AC13 为加分项，卡片 §3 允许工具/审批走原帧；前端逐字可见 → 接受 |
| 2 | `prune()` 只在 `createSession` 触发 | 卡片只要求「超了删」，未要求每次写都扫目录；每次写扫 100 文件会抬高追问延迟 → 接受 |
| 3 | 单条消息正文截到 `MESSAGE_TEXT_MAX=4000` | 不截则 40 条大日志塞不进卡片 512KB 上限（实测曾 1.84MB）；只放宽「怎么裁」未放宽上限 → 接受 |
| 4 | `reviewModel === ""` 全局关闭保留 | 属 PROTOCOL §1 用户显式开关，非「档位跳过」；且一律 confirm、设置页已移除「关闭审阅」选项、遗留 `""` 读成 null → 接受 |
| 5 | 远程徽标实测 68px（上限 120px 只用 CSS 锁住，无超长主机名用例） | 上限有 CSS 保障；实测值远低于上限 → 记录为未覆盖用例，不阻断 |
| 6 | model-select 实测 62% 而非 66% | 66% 是上限，整行可见即达标 → 接受 |
| 7 | `titleFor` 改成 `shellShortName()` | 正是卡面 §8 要求的小修 → 接受 |
| 8 | 一次环境事故（139 个孤儿 shell 导致 PTY console 耗尽） | 与本卡代码无关，已清孤儿；未杀宿主 3480/3470 → 记录 |
| 9 | `test/ssh/registry.test.mjs` 并行 flaky | 与卡 S 同一条既有 flaky，单跑 17/17 绿，本轮全量未复现 → 记录 |
| 10（缺号） | — | 无第 10 条，执行者编号跳号 → 仅记录 |
| 11 | 重命名/删除不用 `window.prompt` | 执行中自查发现（prompt 在沙箱 WebView 阻塞），不改则功能在真实环境是死的 → 属必要修正 |

## 5. 视觉复核（`vision_analyze` 本模型不可用 → 网关 `shuaiapihermes/gpt-6.2-sol`，同 `.dispatch/look.py` 模式）

看 `.dispatch/v4h-shots/1280-sessions.png`、`1280-tool-card.png`、`1440-overview.png`：
- 会话下拉按终端分组 3 组正确；**当前项有底色 + 勾号、左侧无竖线**（视觉模型明确「没看到左侧竖线」）；徽标两行右缘对齐、无挤压重叠。
- 工具卡/总览层次正常，无重叠、截断、错位。
- 一致性 P2：次要文字（分组版本、消息数、耗时、路径、快捷键提示、模型名）偏小偏暗。**实测对比度合格**：`--term-dim #8f99a4` on `--term-panel-bg #14171c` = **6.21:1**（panel-2 5.85、raise 5.53），全过 WCAG AA 4.5:1；字号与 mockup 一致（`docs/mockups-v4/assets/v4.css:1845-1846` 同为 11px/9px），非实现方擅自缩小 → **不构成阻断，列为可选润色**。
- 另两处同源观感项（输入框上沿 grip 短横条、菜单底部留白）在 `docs/mockups-v4/assets/v4.css:1052-1068` 有同款定义，属设计稿自带 → 非缺陷。

## 6. 用户红框（`dashboard_20261123_185159` V4 反馈第 1 条）核对

红框 bbox `(26,150)-(66,405)`，放大 3 倍复核：框内是**一根浅蓝细竖线、上下两端向右弯成拉长左括号「[」、沿组标题下方几行会话条目左侧连续延伸**。
当前实现已确认无此装饰：`app/styles/components.css:2694-2710` 分组与条目规则只有 `background` / `color`，`app/styles/components.css:2825` 当前项只有 `background: var(--term-accent-soft)`；全仓 `border-left` 仅 7 处（`layout.css:73` 抽屉分隔、`components.css:319` 思考块、`:778/:787/:791` 确认卡状态条、`:1072` 横幅），均不在会话列表；会话菜单无 `::before`。→ **该项已满足**。

## 7. 安全与边界

- 会话文件落 `stateDir()`（`~/.config/magpie-terminal/`），不在仓库内，不进 git。
- `git diff` 敏感词扫描（9 组模式：sk-/ghp_/api_key/secret/token 字面量赋值等）：**0 命中**。
- 未改 `docs/mockups-v4/`、`app/vendor/`；无新增依赖。

## 8. 遗留（不影响放行）

1. **需要重启宿主 magpie 才能看到新 UI**：宿主 `magpie-bun` pid 31596 于 09:32 启动，而 `src/ai/sessions.mjs` mtime 11:59、`app/ui/ai-drawer.js` mtime 12:23 —— 当前 3480 跑的是旧代码，`/api/ai/sessions` 在 3480 返 404 属预期。
2. 卡 S §5 #1 `isNavigationRequest` 放宽需人类拍板（已在 `VERIFY-V4-S.md §5` 写明，随本次交付一并呈报）。
3. `test/ssh/registry.test.mjs` 并行 flaky 未修（既有）。
4. 可选润色：次要文字对比度（已过 AA，与 mockup 一致）。
