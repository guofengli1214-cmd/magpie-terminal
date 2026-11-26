# VERIFY-ACCEPT：返工后独立复验

- 仓库：`C:/Users/41807/magpie-terminal`
- 复验日期：2026-11-24
- Node：`D:/nodejs/install/node.exe`（v24.16.0）
- 基线：`HEAD = fefbc2f`（执行者的改动仍在**未提交工作区**；`git diff fefbc2f..HEAD` 为空）
- 真服务端口：3695（UI）、3697（HTTP/失败路径）、3698（命中区定向）、3699（远程删除）、3700（杂项）；未触碰 3480/3477/3488/3496
- 浏览器：真 headless Chrome（`.dispatch/cdp.mjs` 的 `withPage`，`prefers-color-scheme: dark`），视口 1440×900 / 1280×760
- 证据目录：`.dispatch/verify-accept/`（探针、原始 JSON、日志、截图）

## 结论

**有条件通过（partial）**：13 项中 **11 PASS / 2 FAIL**。

- **V04 FAIL**：把手命中宽度 48px、最外侧 5px 点击可展开都达标；但收起态热区在终端右侧覆盖 26–30px × 78px 的 xterm 屏幕区域，从该条带内的文字上按下拖动时 **xterm selection rects = 0**。跨过热区、从外侧起拖仍能选中到屏幕最右，但“起点被把手截走”构成残余遮挡。
- **V10 FAIL**：审核角标的透明命中区实际是 **26×26**（`::before { inset:-4px }` 在 20×20 border-box 上得到 26px），不是验收要求的 ≥28×28。其余尺寸/热区（drawer-head、ai-ctx、file-panel、file-panel-toolbar、toast 关闭、会话操作、文件图标、文件「⋯」）通过。

A/B/D/E/F/G/H 的其余子项、V01/V05/V06/V07/V08/V09/V11/V12/V13 均通过。执行者报告中“审核角标命中 28×28”“终端文字无遮挡”的结论与实测不符，见下方差异表。

## 复跑命令

```bash
"D:/nodejs/install/node.exe" --test
DOCTOR_PORT=3696 "D:/nodejs/install/node.exe" scripts/doctor.mjs
"D:/nodejs/install/node.exe" .dispatch/verify-accept/probe-ui.mjs
"D:/nodejs/install/node.exe" .dispatch/verify-accept/probe-remote-verify.mjs
"D:/nodejs/install/node.exe" .dispatch/verify-accept/probe-http.mjs
"D:/nodejs/install/node.exe" .dispatch/verify-accept/probe-hits.mjs
"D:/nodejs/install/node.exe" .dispatch/verify-accept/probe-misc.mjs
```

## V01–V13 实测表

| # | 实测值 | 证据路径 | 判定 |
|---|---|---|---|
| **V01** 删除 | **本地文件** `verify-del-file.txt`：确认“永久删除”后，不手动刷新，条目 `entryStillInDom=false`，磁盘 `diskExistsAfter=false`，状态栏「已删除 verify-del-file.txt」。**空目录** `verify-del-empty-dir`：`entryStillInDom=false`，磁盘不存在，状态栏「已删除 verify-del-empty-dir」。**非空目录** `verify-del-nonempty` 不勾递归：条目仍在、磁盘仍在，状态栏逐字「这个目录不是空的（1 项）。要连内容一起删就先勾选「递归删除」。」（HTTP 409）。**远程** `h-8cd47b` `/tmp/verify-remote-*.txt`：`connected=true`、`pathOk=true`、删除后 `entryStillInDom=false`、远端 `stat` 为 `NOT_FOUND`、状态栏「已删除 …」。两档视口一致。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v01file/v01emptyDir/v01nonEmpty`）；`.dispatch/verify-accept/remote/measure.json`；截图 `shots/1440x900-V01-delete-file.png`、`shots/1440x900-V01-delete-nonempty.png`、`shots/1440x900-V01-remote-delete.png` 及 1280 对应图 | **PASS** |
| **V02** 对比度 | 独立按 sRGB 相对亮度公式重算（Node 侧，不复用页面 helper）：<br>确认卡「跳过」：前景 `rgb(154,164,176)`（#9aa4b0）/ 合成背景 `rgb(34,34,31)` → **6.31:1**；确认卡 why：同色/同背景 → **6.31:1**（正文阈值 4.5）。<br>主机地址 hover：`rgb(154,164,176)` / `rgb(55,71,95)` → **3.73:1**；不 hover → **7.11:1**。<br>设置页选中档位说明：`rgb(154,164,176)` / `rgb(55,71,95)` → **3.73:1**（次要阈值 3.0）。两档视口同值。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v02`，含 `rawBgStack`）；`shots/1440x900-V03-approval-card.png`、`shots/1440x900-V05-host-panel.png`、`shots/1440x900-V02-settings.png` 及 1280 对应图 | **PASS** |
| **V03** 确认卡配色 | 两档视口 computed style 完全一致：`border-top-color = rgba(227, 179, 65, 0.38)`；`background-color = rgba(227, 179, 65, 0.07)`；卡片 `padding = 10px`；按钮组 `padding = 2px 40px 2px 0px`。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v03`）；`shots/1440x900-V03-approval-card.png`、`shots/1280x760-V03-approval-card.png` | **PASS** |
| **V04** 把手热区 | 1440：视觉 22×78；命中扫描 `hitMinX=1392..hitMaxX=1439`，**hitWidth=48px**；最外侧 5px 真实点击 → `data-ai-open=true`。1280：`1232..1279`，**48px**，同样能展开。<br>终端文字：在把手顶边 +24px 的文字行（buffer row 21/17，行长 192/169）起拖：热区外起拖 **2 个 selection rect**；**热区内起拖 0 个 rect**；从外侧跨过热区拖到屏幕右缘仍能选中到 `maxRight=1422/1258`。<br>热区覆盖 xterm screen 右侧 **30px（1440）/ 26px（1280）**；`elementFromPoint` 在该条带返回 `data-role=ai-handle`。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v04`，含 `selectionRow/selectionOutsideHotzone/selectionStartedInsideHotzone/selectionCrossingHotzone`）；`shots/1440x900-V04-handle-collapsed.png`、`shots/1280x760-V04-handle-collapsed.png` | **FAIL**（命中宽度/外侧点击通过；终端文字“无被遮挡”不通过） |
| **V05** 可见性 | 不 hover、鼠标移到 (4,4) 后：会话 `.sess-actions` `display=flex`、`opacity=0.55`；主机会话工具 `display=flex`、`opacity=0.55`，hover 后 `opacity=1`；文件「⋯」`display=grid`、`opacity=0.7`、28×28。可用性：点会话“改名”出现 `agent-session-rename-input=true`；点主机“编辑”出现 `host-form-card=true`；点文件「⋯」后 `data-more-open=true`、`aria-expanded=true`、动作条 `display=flex`、动作数 3。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v05sessions/v05hosts/v05files`）；`shots/1440x900-V05-expanded-sessions.png`、`shots/1440x900-V05-host-panel.png`、`shots/1440x900-V10-file-panel.png` 及 1280 对应图 | **PASS** |
| **V06** toast | 1440：toast rect `left 1092 / top 802.81 / right 1432 / bottom 859`；状态栏 rect `top 867`；相交面积 **0**；toast 栈 `bottom=41px`；状态栏「立即重连」rect 中心命中 `data-role=status-retry`，与 toast 相交面积 **0**。1280：toast bottom `719`，状态栏 top `727`；相交面积 **0**，`status-retry` 仍为命中顶层。只显示 1 条待确认 toast。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v06`）；`shots/1440x900-V06-toast-collapsed.png`、`shots/1280x760-V06-toast-collapsed.png` | **PASS** |
| **V07** 模型菜单 | 1440：输入框 111px → composer-box 132px，菜单 rect `top 453.5 / bottom 687`（= box 顶边），与 box 相交 **0**，`fullyVisible=true`，菜单 6 项，`max-height:240px`。输入框 132px → box 153px，菜单 bottom 666 = box 顶边，相交 **0**。1280：box 132/153px 时菜单 bottom 547/526 = box 顶边，相交 **0**，均完整可见（top 313.5/292.5 > drawer top 0）。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v07a/v07b`）；`shots/1440x900-V07-model-menu.png`、`shots/1280x760-V07-model-menu.png` | **PASS** |
| **V08** 拖拽方向 | 两档视口真实鼠标拖拽 grip：起点 99px；向上 40px → **139px**，`localStorage['magpie.term.composerHeight']="139"`；向下 40px → **59px**，持久化 `"59"`。拖到上限：1440 → 347px（持久化 `"347"`），1280 → 291px（`"291"`）；拖到下限：**19.38px**（持久化 `"19"`，键值取整）。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v08`）；`shots/1440x900-V08-composer-drag.png`、`shots/1280x760-V08-composer-drag.png` | **PASS** |
| **V09** 文本 | 会话长标题：`title` = 全文，`-webkit-line-clamp=2`，`white-space=normal`，高度 **33px**（2 × 16.5px 行高）；普通标题 16.5px。主机地址：`title` 与 `.host-addr` 文本一致（完整 `user@host:port · 认证方式`）。工具命令：142 字符，`white-space=pre-wrap`、`overflow-wrap=anywhere`、`text-overflow=clip`，`scrollWidth=clientWidth=362`、`scrollHeight=clientHeight=82`，`fullyVisible=true`。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v05sessions`、`checks.v09tool`、`checks.v05hosts`）；`shots/1440x900-V05-expanded-sessions.png`、`shots/1440x900-V05-host-panel.png` 及 1280 对应图 | **PASS** |
| **V10** 尺寸/热区 | 高度：`drawer-head=48px`（声明 48）、`ai-ctx=30px`（30）、`file-panel=224px`（224）、`file-panel-toolbar=34px`（34），全部 `box-sizing=border-box`，无 1px 漂移。文件面板左内边距：toolbar/grid/status 均 **9px**。热区：toast 关闭 **28×28**；会话改名/删除 **31×28**；文件图标 **28×28**；文件「⋯」**28×28**；主机编辑 **32×28**。<br>**审核角标**：视觉 20×20，`::before` computed **26×26**（`inset:-4px` 在 border-box 20px 上 +8px）；逐像素命中 bbox **26×27**，右侧 +3px、下侧 +4px 已落到卡片而非角标。 | `.dispatch/verify-accept/ui/measure.json`（`checks.v10files/v03/v05sessions`）；`.dispatch/verify-accept/misc/measure.json`；`.dispatch/verify-accept/hits/measure.json`；`shots/1440x900-V10-file-panel.png`、`shots/1440x900-V03-approval-card.png` 及 1280 对应图 | **FAIL**（仅审核角标 26×26 < 28×28；其余子项通过） |
| **V11** 未改项 | F04：模型选择仍在输入框下方提示行——1440 模型 top 831 / 输入 bottom 799；1280 模型 top 691 / 输入 bottom 659；`modelBelowInput=true`、`modelInPromptLine=true`、`modelLeftOfInput=false`，与改动前定位一致（32px 间距）。F09：把手中心 y=433.5 / 363.5，`.main` 中心同值，**deltaMain=0**；视口中心差 **-16.5px**（保持原状）。F17：`src/` 无 diff；无 token `/api/health` **403**、`/api/fs/list` **403**、`Origin:null` **403**、敏感 `.ssh/id_rsa` **403**、`C:/Windows` list 仍 **200**（原 D5 现象未改）。L1-07：tabbar **34px** / statusbar **33px**；L1-12：rail 无 SVG，仍是字符 glyph；L1-15：无虚拟列表改动。 | `.dispatch/verify-accept/ui/measure.json`（`checks.f09/drawer/v11`）；`.dispatch/verify-accept/http/measure.json`；`git diff --name-only`/`git diff -U0` | **PASS** |
| **V12** 回归 | `node --test`：**tests 679 / pass 679 / fail 0 / skipped 0**，exit 0。`DOCTOR_PORT=3696 node scripts/doctor.mjs`：**33/33 assertions passed**，exit 0。基线 674 + 新增 5（`test/app/api-delete.test.mjs` 3 条 + `fs-route` 的 DELETE 组/子测试 2 条）。`git diff -U0 -- test` 只有新增行，没有 `-` 行；既有断言未删/未放宽。 | `.dispatch/verify-accept/logs/node-test.txt`、`.dispatch/verify-accept/logs/doctor.txt`；`git diff -U0 -- test` | **PASS** |
| **V13** 失败路径 | 无 token `/api/health` **403**、`/api/fs/list` **403**（401/403 口径允许）；错误 token **403**；`Origin:null` **403**。`Z:\` 盘根删除 **403 FORBIDDEN_PATH**；`.ssh/id_rsa` 读取 **403 FORBIDDEN_PATH**。非空目录不递归 **409 DIR_NOT_EMPTY**，文案逐字保留、目录仍在。2.5MB 文本读取 **413 FILE_TOO_LARGE**；二进制读取 **415 NOT_TEXT**。上传缺 `x-filename` **400 MISSING_FILENAME**；文件名带分隔符 **400 INVALID_PATH**；上传目标是文件 **409 NOT_A_DIRECTORY**。删除成功契约仍为 **200 + JSON `{path,type}`** 且磁盘消失。审阅网关指向死端口：`decision=confirm`、`risk=null`、reason=「审阅服务不可用，按需要确认处理」，日志 `REVIEW_FAILED`（约 6031ms）；注入无效 risk 同样 confirm + `REVIEW_FAILED`。 | `.dispatch/verify-accept/http/measure.json`；`.dispatch/verify-accept/logs/probe-http.log` | **PASS** |

## 与执行者报告 `REPORT-FIX-ACCEPT.md` 的差异

| 项 | 执行者报告 | 本次实测 | 影响 |
|---|---|---|---|
| V10 / H5 审核角标 | “视觉 20×20，**命中 28×28**（左外 3px 命中）” | 视觉 20×20；`::before` computed **26×26**；逐像素命中 bbox **26×27**（右侧 +3px 已不命中） | **V10 FAIL**；报告数值不成立 |
| V04 / C 终端文字选择 | “终端文字选择（xterm selection rects） **2**（把手热区外开始拖动）”，据此判过 | 外侧起拖确为 2 个 rect；**从热区内起拖为 0**；热区覆盖 xterm 屏幕右侧 **30/26px × 78px**。跨区拖能选中，但起点会被把手截走 | **V04 FAIL**；报告只测了“热区外起拖”，覆盖了“无被遮挡”条件 |
| V10 其余热区 | toast 关闭 28×28、会话 31×28、文件图标 28×28、文件「⋯」28×28 | 实测一致（另测得主机工具 32×28） | 报告正确 |
| V02 对比度 | 跳过/why 6.31、主机地址 3.73、设置档位 3.73 | 独立重算完全一致（主机不 hover 7.11） | 报告正确 |
| V03 确认卡 | 边框 `rgba(227,179,65,0.38)`、背景 `rgba(227,179,65,0.07)`、padding 10、按钮组右 40 | computed style 逐项一致 | 报告正确 |
| V01 删除 / 远程 | 本地文件/空目录成功、非空 409、远程成功 | 复跑一致；远程 `/tmp` 真删除，`stat=NOT_FOUND` | 报告正确 |
| V06 / V07 / V08 | toast 相交 0、菜单相交 0、上拖变高下拖变矮 | 复跑一致；另记录持久化键值 139/59、上限 347/291、下限 19.38 | 报告正确 |
| V09 / H4 / H6 / H7 | 标题 title+两行、命令换行、高度 48/30/224/34、左内边距 9、sess-title 12/600 + sess-sub 10.5/dim | 全部一致 | 报告正确 |
| V12 / V13 | 679/679、doctor 33/33、失败路径网格 | 复跑一致；另测 2.5MB 413、`.ssh` 403、REVIEW_FAILED 真网关 | 报告正确 |
| 提交状态 | 报告称“代码改动 + 测试”已完成，未说明是否提交 | `HEAD` 仍是 **fefbc2f**，`git diff fefbc2f..HEAD` 为空；改动全部是**未提交工作区**改动，新增测试 `test/app/api-delete.test.mjs` 也未跟踪 | 功能可用，但若按 `fefbc2f..HEAD` 做 CI/交付检查，会看不到这次修复；属流程风险 |
| 改动范围 | 报告称只动预期文件、未改 docs/依赖 | 工作区 diff：`app/core/api.js`、`app/styles/{components,layout,tokens}.css`、`app/ui/{ai-drawer,file-panel,hosts-panel}.js`、`test/server/fs-route.test.mjs`；新增 `test/app/api-delete.test.mjs`。`docs/`、`package.json`、`package-lock.json`、`src/` 无改动 | 与报告一致（范围正确） |

## 回归风险

1. **V04 的 26–30px 透明热区**：收起态把手贴视口右缘，为凑 48px 把整个热区放到把手左侧；终端最右侧一条 78px 高的文字无法作为选区起点（点击会命中把手）。跨区拖仍可选中，但“无被遮挡”未满足。若产品要求严格无覆盖，需要移动把手/调整视觉宽（属于设计决策）。
2. **V10 审核角标少 2px**：`inset:-4px` 在 20×20 border-box（含 1px 边框）上得到 26×26。改为 `inset:-5px`（或显式 28×28 命中层）即可；当前会漏掉角标右/下各约 3px。
3. **未提交工作区**：所有修复和新增测试都在工作区，`HEAD` 未前进；任何基于 commit 的流水线/交付物都会看不到本次修复。
4. **文件条目嵌套按钮**：文件卡片本身是 `<button>`，内部已有动作按钮，本次又新增「⋯」按钮；HTML 语义上仍是嵌套 button（既有问题加重新入口），可能影响部分辅助技术与键盘焦点顺序，现有测试未覆盖。
5. **常显操作压缩文本**：主机/会话操作默认可见后，地址和长标题的可用宽度减少；已用 `title`、两行截断补偿，但视觉密度与可用宽度仍是产品取舍。
6. **模型菜单高度只在打开时计算**：窗口在菜单打开期间改变尺寸不会重算 `maxHeight`；两档目标视口实测完整可见，但非响应式。
7. **`del()` 对任意 2xx 的 JSON 解析**：非 JSON 的 2xx 会成功且 `data:null`；当前 DELETE 端点只有 204 与 200+JSON，暂不触发。
8. **明色主题**：B 项新增的明色 `--term-warn-border/bg` 和 `--term-muted` 未做明色视觉/对比度验收（验收卡以暗色设计稿为基准）。

## 未验证项（原因）

- **明色主题对比度/配色**：验收卡 B 项的基准是暗色设计稿；本次只按卡片要求跑暗色（`prefers-color-scheme: dark`）。明色 token 是执行者自述，未做视觉验收。
- **第二台远程主机 `h-75a46c`**：本次只测可连的 `h-8cd47b`（真 SSH）；`h-75a46c`（127.0.0.1:2222）未建立会话，未测其远程删除。
- **200MB 上传上限**：未发送 200MB 级 payload；上传失败路径测了缺文件名、路径分隔符、目标非目录。读取侧的 2.5MB → 413 已实测。
- **基线 674 条的独立复跑**：没有回退到 `fefbc2f` 跑旧测试（避免改动工作区）；用“当前 679 条 + `git diff -U0 -- test` 仅新增、无删除行”证明没有删/放宽既有断言。历史基线 674 来自 `ACCEPT-FUNC.md` F18。
- **与 `docs/mockups-v4` 的像素级对比**：未做逐像素 diff；本次用 computed style 数值 + 截图复核，符合验收卡的“量或截图”口径。
- **审阅成功路径**：本次只复跑失败兜底（死网关/无效 risk）；成功路径不属于本次 A–H 改动，且 `src/` 无 diff。

## 证据索引

- 探针：`.dispatch/verify-accept/probe-ui.mjs`、`probe-remote-verify.mjs`、`probe-http.mjs`、`probe-hits.mjs`、`probe-misc.mjs`
- 原始数据：`.dispatch/verify-accept/ui/measure.json`、`remote/measure.json`、`http/measure.json`、`hits/measure.json`、`misc/measure.json`
- 日志：`.dispatch/verify-accept/logs/node-test.txt`、`logs/doctor.txt`、`logs/probe-ui.log`、`logs/probe-remote.log`、`logs/probe-http.log`、`logs/probe-hits.log`、`logs/probe-misc.log`
- 截图：`.dispatch/verify-accept/shots/`（两档视口 × 收起+待确认、展开+会话列表、确认卡、文件面板、主机面板、设置页；另含删除、远程删除、把手、拖拽、模型菜单等）

```json
{"status":"done","verdict":"partial","v_fail":["V04","V10"],"tests":"679/679","doctor":"33/33","report":"VERIFY-ACCEPT.md","evidence":".dispatch/verify-accept"}
```
