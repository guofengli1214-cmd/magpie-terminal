# ACCEPT-FUNC：magpie-terminal 功能验收 F01–F18

- 执行时间：2026-11-24（本地时区）
- 被测版本：`master`，`0.1.0`
- 服务：`startServer` 真服务，端口 **3681**（临时配置目录；未触碰 3480/3477/3488/3496）
- 浏览器：真 headless Chrome（`.dispatch/accept-f1/cdp.mjs`，同 `.dispatch/cdp.mjs`，仅调试端口 9421）
- 原始证据：`.dispatch/accept-f1/`；截图：`.dispatch/accept-f1/shots/`
- 结论：**14 PASS / 4 FAIL / 0 未验证**

> 说明：本报告按卡片字面验收；与卡片字面不同的取证口径逐条写在每项「说明」和末尾「口径说明」里。
> 产品代码、`app/`、`src/`、`test/`、`scripts/`、`index.mjs`、`docs/`、`package.json` 均未修改。

## 结论表

| 项 | 判定 | 证据路径 | 一句话说明 |
| --- | --- | --- | --- |
| F01 | **PASS** | `.dispatch/accept-f1/F01-F05-F09-F16.txt`；`shots/F01-sessions.png` | 2 组 / 3 项；分组、组头、当前项、普通项 `border-left=0`、`::before/::after=none`、无 inset 阴影；当前项底色 `rgba(120,160,220,0.18)` + `✓`，普通项透明 + `·`。 |
| F02 | **PASS** | `F02-F03-F06-F10-F11.txt`；`shots/F02-four-states.png`、`shots/F02-tooltip.png` | 四态 `ok/caution/danger/none` 颜色组合 4 种互异；右下角 gap 10/10；hover 后 tooltip 可见，两段标题逐字「执行后会发生什么」「为什么需要你确认」，两段正文均非空。 |
| F03 | **PASS** | `F02-F03-F06-F10-F11.txt`；`shots/F03-effect-on.png`、`shots/F03-after-reload.png` | 默认 `false` 且无 `.approval-effect`；打开开关后不保存即显示；保存后 `/api/config` 与磁盘均 `true`；刷新后仍开，确认卡不 hover 也显示效果行。 |
| F04 | **FAIL** | `F01-F05-F09-F16.txt`；`shots/F04-model-menu.png` | 无边框、菜单 6 项、`/api/config` 真变、下一次 `agent.run`/`agent.start` 都用新模型——这些都过；但模型选择实际在输入框**下方**（top 691 > textarea bottom 659），不在卡片要求的「输入框左侧」。 |
| F05 | **PASS** | `F01-F05-F09-F16.txt`；`shots/F05-composer.png` | 提示实际为 `Enter 发送 · Shift+Enter 换行`（卡片用 `/` 表并列，归一后一致）；发送按钮文本 `↑`、34×34、`border-radius:50%`，不是文字「发送」。 |
| F06 | **PASS** | `F02-F03-F06-F10-F11.txt`；`shots/F06-grow.png` | 拖 `[data-role=agent-grow]` 后 textarea 19.375px → 99px；持久化键 `magpie.term.composerHeight` 写入 `"99"`；刷新后仍 99px。附：向上拖会缩到 59px（方向反转，见 D6）。 |
| F07 | **PASS** | `F07-F08-F14-F15.txt`；`shots/F07-badges.png` | 本机徽标 `bash 5.2.37`（66×17）；实际连上远程终端后建会话，徽标两行 `局域网linux / 192.168.10.24`（83×26，`flex-direction:column`，scrollWidth=clientWidth，无截断），class 为 `k-ssh`。 |
| F08 | **PASS** | `F08-real.txt`（主）；`F07-F08-F14-F15.txt`（补充）；`shots/F08-real-*.png` | 在 A 真发「只回答两个字：收到」→ done；开 B 切过去 → `draft:B` + `agent-empty`，A 的回答不出现；切回 A → 原会话 `s-afbca5e2` 与「收到」仍在。 |
| F09 | **FAIL** | `F01-F05-F09-F16.txt`；`shots/F09-collapsed.png`、`shots/F09-open.png`、`shots/F09-expanded-audit.png` | 默认 `data-ai-open=false`；把手 22×78 贴主区右缘；点开/再点收起都正常；全页无其它 AI 展开/收起入口。但把手中心 y=363.5，视口中心 y=380，差 **16.5px**（它对齐的是 `.main` 中心），不满足卡片「与视口中心」垂直居中。 |
| F10 | **PASS** | `F02-F03-F06-F10-F11.txt`；`shots/F10-toast.png`、`shots/F10-jump.png` | 抽屉展开且有确认卡时 toast 容器 0 个子节点；收起后 1 条 toast、把手 badge `hidden=false` 文本 `1`、红色 `rgb(255,138,128)`；点「去确认」后抽屉打开、卡片 `data-highlight=true`、toast 移除。 |
| F11 | **PASS** | `F02-F03-F06-F10-F11.txt`；`shots/F11-terminal-buffer.png` | 初始 buffer 38 行、非空 2 行、`user@host` 1 条、`$` 1 条（1 个提示符）；展开/收起 AI 3 次后 38 行、内容逐字相同，无追加空行。 |
| F12 | **PASS** | `F12-live.txt`；`shots/F12-conversation.png`、`shots/F12-tool-cards.png`、`shots/F12-sessions.png` | 真模型 17.58s 跑完：3 步工具卡（`pwd && ls -la`、`du`、`ls -lS + awk`）、reasoning 999 字、最终总结含 3MB/2MB/1MB 三个文件名；服务端 messages=3、steps=3；新建/改名（服务端标题变）/删除（404）均通过。 |
| F13 | **PASS** | `F13-policy.txt` | `/api/config` 三档 PUT/GET 均 200 且回读一致；真审阅返回 caution/reversible=true；同一结论 strict=confirm、balanced=confirm、loose=auto；白名单 `mkdir -p` 三档 auto 且 reviewCalls=0；`rm -rf` 三档 confirm；网关不可用 6026ms 后 confirm + risk=null + `REVIEW_FAILED`。 |
| F14 | **FAIL** | `F07-F08-F14-F15.txt`；`F14-delete-defect.txt`；`shots/F14-*.png` | 跟随 cwd 411ms；新建文件夹/文件、查看、修改、上传（201）、下载（SHA-256 一致）、远程 `/tmp`（面板与接口均 9931 项）都过。**删除失败**：磁盘文件/目录真的删了，但 `api/core/api.js` 的 `del()` 把 200 当错误，面板提示「本地服务返回 HTTP 200，请重试。」且 DOM 仍保留旧条目，只有手动刷新才消失。 |
| F15 | **PASS** | `F07-F08-F14-F15.txt`；`shots/F15-hosts-panel.png`、`shots/F15-plus-menu.png` | `/api/shells` 三条齐全（bash/PowerShell 7/PowerShell 5，均 available）；面板列出本机 + 2 台已配置主机；点面板外后 `hidden=true`/`data-open=false`；顶部加号菜单同时有 3 个本机 shell 与 2 台主机。 |
| F16 | **PASS** | `F01-F05-F09-F16.txt`；`shots/F16-settings.png` | 点齿轮能打开 `settings-modal`；三档按钮可切换；基础提示词写入后保存，`/api/config` 与磁盘逐字一致（含换行）。 |
| F17 | **FAIL** | `F17-security.txt` | `Origin:null` 无 token 403、跨站首页 403、外部 Origin 403、合法导航 200 且有 token、相对/NUL/敏感路径 400/400/403/403 都过。但无 token 的 `/api/*` 实际是 **403** 不是卡片要求的 401；且 `C:/Windows` 可列（200）、`C:/Windows/win.ini` 可读（200），系统目录只靠 `System32/config` 的 Windows ACL 偶然 403。 |
| F18 | **PASS** | `F18-node-test.txt`、`F18-doctor.txt`、`doctor-report.after.json` | `node --test`：**tests 674 / pass 674 / fail 0**；`DOCTOR_PORT=3683 node scripts/doctor.mjs`：**33/33 assertions passed**。 |

## 关键取证细节

### F01 / F02 / F03 / F10 / F11（数据与样式）

- F01 选择器：`[data-role="agent-session-item"]`、`.sess-group`、`.sess-group-head`；
  对每个节点取 `borderLeftWidth/Style`、`boxShadow`、`::before/::after` 的 `content` 与 `borderLeftWidth`。
  结果全部 `0px/none`；当前项背景 `rgba(120,160,220,0.18)`，普通项 `rgba(0,0,0,0)`；`si-mark` 为 `✓` / `·`。
- F02 用 `window.__termDebugFrame` 注入 4 条 `agent.approval`（`stepId/approvalId` 唯一，risk 分别为
  `safe/caution/danger/null`），hover `[data-role="approval-review"]` 后读 tooltip 的 `b` 与 `p`。
  四态色值：ok `rgb(165,214,167)`、caution `rgb(255,204,128)`、danger `rgb(255,138,128)`、
  none `rgb(143,153,164)`；tooltip 宽 276px、显示 block。
- F03 操作序列：点 `[data-role="rail-settings"]` → 点 `[data-role="setting-show-effect"]`
  → 点 `[data-role="settings-save"]` → 读 `GET /api/config` 与磁盘 `config.json`
  → 关所有标签后 `Page.reload` → 再注入确认卡；`.approval-effect` 文本逐字
  `执行后会发生什么：刷新后仍应常显：不会改变任何东西，只是查看目录。`，且 `:hover` 数为 0。
- F10 先展开抽屉注入 `agent.approval`：`toast-stack.children.length=0`；点把手收起后为 1，
  `handle-badge.hidden=false`、`textContent="1"`、`data-badge="1"`、背景 `rgb(255,138,128)`。
  点 `[data-role="toast-action"]` 后 `data-ai-open=true` 且确认卡 `data-highlight=true`。
  点开抽屉后 badge 仍为 1 是正确的：该待确认尚未处理。
- F11 读 `window.__termDebugBuffer(activeId)`：行数 38 → 3 次开合后仍 38；`lines.join("\n")` 逐字相等。

### F04（模型选择）

- 模型按钮 rect：`{left:988.75, top:691, right:1227, bottom:713}`；
  输入框 rect：`{left:917, top:639.625, right:1259, bottom:659}`。
  因此 `leftOfInput=false`、`belowInput=true`（卡片要求左侧 → FAIL）。
- 菜单 6 项；选 `shuaiapi/gpt-6-luna` 后 `GET /api/config.model=shuaiapi/gpt-6-luna`；
  页面注入的 WS 记录器抓到下一次 `agent.run.model` 与下行 `agent.start.model` 均为该值。
- 边框 `0px none`、文本为模型 label + 装饰三角 `▾`，不含「发送」等按钮文案。

### F08（真实一问）

`probe-g-f08-real.mjs`：A 真发问 → `agent.done`；开 B → `current=draft:B…`、`agent-empty=true`、
时间线不含 A 的 summary；切回 A → `current=s-afbca5e2`、summary「收到」仍在。
`probe-c` 额外用落盘会话验证了标题/消息数快照与 B 空态，二者一致。

### F12（真对话）

- 操作：先把真 PTY cwd 切到 `.dispatch/accept-f1/f12-work/run-*`（3MB/2MB/1MB 三个文件），
  再点 `[data-role="agent-new"]`，输入「统计当前目录下最大的三个文件并说明。请真的运行命令…」。
- 结果：17.58s done；3 个工具卡；reasoning 999 字；总结列出
  `largest-3mb.bin` 3.00MB、`middle-2mb.bin` 2.00MB、`smallest-1mb.bin` 1.00MB。
- 服务端 `/api/ai/sessions/:id`：messages=3（user/assistant/...）、steps=3、reasoning 999。
- 改名：行内输入框 → PATCH，服务端 title=`F12 改名 1795508788094`。
- 新建：`draft:…` 空态；删除：客户端显示 404，服务端 404。
- **注意**：第一次在默认 home 目录直接问同一目标时，模型先跑 `du -a .` 扫 AppData，
  200s 仍未结束；后续步骤 `du`/`ls` 全部超时空转。会话文件保存在
  `F12-long-command-session.json`，作为 D7 证据。之后改为小目录复测，F12 本身通过。

### F13（审阅门控）

- 三档通过真 `PUT /api/config` 写入并 `GET` 回读：`strict/balanced/loose` 均 200。
- 真审阅对 `mkdir -p .dispatch/accept-f1/f13-demo` 返回 `risk=caution`、`reversible=true`、
  有 `effect/confirmWhy`。用同一结论注入 judge：
  `strict=confirm`、`balanced=confirm`、`loose=auto`。
- 再跑三档真 `judge` + 真 `review`：strict/balanced `confirm`、loose `auto`，日志均有 `REVIEW`。
- 白名单 `pattern:"mkdir -p", mode:"prefix"`：三档都 `auto`、`hit:"mkdir -p"`，注入的
  review 一次都没被调用（reviewCalls=0）。
- `rm -rf .dispatch/accept-f1/f13-danger`：三档都 `confirm`（risk=danger）。
- 把 `MAGPIE_TERMINAL_GATEWAY_URL` 指向死端口 `http://127.0.0.1:9`：6026ms 后返回
  `decision=confirm, risk=null, reason="审阅服务不可用，按需要确认处理"`，日志
  `code=REVIEW_FAILED`。随后恢复环境变量。

### F14（文件面板）

- 跟随：打开面板后从页面 WS 发 `cd /c/Users/41807/magpie-terminal/docs`，
  面板 path 在 **411ms** 后变为 `C:\Users\41807\magpie-terminal\docs`。
- 在 `.dispatch/accept-f1/f14-work/run-*` 内：
  新建 `f14-dir`/`f14-note.txt` → 查看（空文件）→ 编辑保存（API 读回逐字一致）
  → 上传 14 字节（201）→ 刷新后面板出现 → 下载（200，SHA-256 一致）。
- 远程：切到远程终端后面板 `kind=remote`、`/home/devuser`；手动 `/tmp` 得到 9931 项，
  `GET /api/hosts/h-8cd47b/fs/list?path=/tmp` 同样 200/9931 项。
- 删除：点击删除 → 确认 → 磁盘文件/目录已消失，但面板仍显示旧条目，状态栏出现
  「本地服务返回 HTTP 200，请重试。」；手动点刷新后条目才消失。见 `F14-delete-defect.txt`。

### F15 / F16 / F17 / F18

- F15：`/api/shells` 返回 bash 5.2.37 / PowerShell 7 7.7.0 / PowerShell 5 5.1.22621.6133，
  均 `available:true`；若某条 `available:false`，面板与加号菜单都会标「未安装」并 disabled。
  两台主机 `h-75a46c`（127.0.0.1:2222，当前不可连）与 `h-8cd47b`（192.168.10.24:22，可连）。
  面板外点击后 `hidden=true`、`data-open=false`；加号菜单 3 个本机 + 2 个主机。
- F16：设置页打开；基础提示词 `F16 基础提示词验收 <ts>\n第二行：保持不变` 保存后
  `GET /api/config.basePrompt` 与磁盘逐字相同。
- F17：状态码原文见 `F17-security.txt`；关键值：无 token `/api/health` 403、
  `Origin:null` 无 token 403、`Origin:null` + `sec-fetch-mode:cors` 的 `/` 403、
  外部 Origin `/` 403 且无 ACAO、合法 navigate `/` 200 且有 token；
  `C:/Windows/System32/config` 403（`NO_PERMISSION`，Windows ACL）；
  `C:/Windows` 200、`C:/Windows/win.ini` 200；
  相对路径 400、NUL 400、`.ssh/id_rsa` 403、`.config/magpie-terminal/config.json` 403。
- F18：`node --test` 674/674/0，`doctor` 33/33。`doctor-report.json` 运行前后快照已保存，
  根文件已恢复原样（未被本次验收修改）。

## 缺陷清单

| 编号 | 级别 | 现象 | 复现步骤 | 影响面 |
| --- | --- | --- | --- | --- |
| **D1** | **P1** | 文件面板删除实际成功，但 UI 报「本地服务返回 HTTP 200，请重试。」且不刷新列表 | 打开文件面板 → 新建 `del.txt` → 悬停「删除」→ 点「永久删除」→ 观察：磁盘文件已消失，面板仍显示 `del.txt`；手动「刷新」后才消失 | `api/core/api.js` 的 `del()` 只接受 204，而 `/api/fs` DELETE 返回 200 JSON。文件面板本地/远程删除都受影响；用户会误以为删除失败并重复操作，旧条目还可被继续点击 |
| **D2** | P2 | 模型选择不在输入框左侧，而在输入框下方、发送按钮左侧 | 展开 AI 抽屉 → 取 `[data-role=model-select]` 与 `[data-role=agent-input]` rect：model top=691，input bottom=659 | F04 布局要求；功能本身正常 |
| **D3** | P2 | 收起态 AI 把手比视口中心高 16.5px（对齐 `.main` 中心，而非视口中心） | 1280×760 首屏取 `[data-role=ai-handle]` rect：中心 y=363.5，视口中心 380 | F09 视觉要求；视觉上略偏上 |
| **D4** | P2 | 无 token 的 `/api/*` 返回 403 `{code:"FORBIDDEN"}`，不是卡片要求的 401 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3681/api/health`（无 token） | 安全行为本身是拒绝；但与验收契约/自动化预期不一致 |
| **D5** | P2 | 系统目录未按策略统一拒绝：`C:/Windows` 可列、`C:/Windows/win.ini` 可读；只有 `C:/Windows/System32/config` 因 Windows ACL 返回 403 | `GET /api/fs/list?path=C:/Windows` → 200；`GET /api/fs/read?path=C:/Windows/win.ini` → 200；`GET /api/fs/list?path=C:/Windows/System32/config` → 403 | 拿到 token 的页面可浏览/读取系统文件；F17 要求「系统目录被拒」未满足 |
| **D6** | P2 | 输入框顶部 grip 拖动方向反转：向上拖缩小、向下拖放大 | 展开抽屉 → 从 `[data-role=agent-grow]` 向上拖 40px：高度 99→59；向下拖 80px：19.375→99 | F06 交互；用户按直觉向上拖会得到相反结果 |
| **D7** | P2 | 长耗时命令超时后仍占用 PTY，后续步骤排队空转、无输出 | 默认 cwd（home）问「统计当前目录下最大的三个文件并说明」→ 模型跑 `du -a .` → 200s 后 steps 仍 failed/running 且 output 为空；会话文件见 `F12-long-command-session.json` | AI 任务在大目录/慢命令上可能永远不结束；用户需手动 Ctrl+C。本次在小目录复测 F12 通过 |

## 口径说明（保守解释）

1. **F01 选择器**：卡片写 `.agent-session-item`，产品没有这个类；实际节点是
   `[data-role="agent-session-item"]`（同时有 `.sess-item`）。本报告按 data-role 验，属于同一节点。
2. **F05 分隔符**：卡片用「/」表并列，产品与 `docs/mockups-v4/ai-chat.html` 用「·」。
   探针把 `\s*·\s*` 归一成 ` / ` 后比对；原文 `Enter 发送 · Shift+Enter 换行` 已落盘。
   若要求逐字「/」，F05 应改判 FAIL（P2 文案差异）。
3. **F04 位置**：按「输入框左侧」字面量验，不放宽成「发送按钮左侧」。
4. **F09 居中**：按卡片证据要求与**视口中心**比较；若按 `.main` 内容区中心，产品是对齐的。
5. **F17 401**：按卡片字面量验；产品统一用 403。安全语义是「拒绝」，非「未认证」。
6. **F14 删除**：同时看磁盘、面板 DOM 与用户提示；只删掉磁盘、UI 报错并保留旧条目判 FAIL。
7. **F13 三档**：先用真审阅拿到同一份结论，再注入 judge 做三档映射（保证同一命令同一结论）；
   另跑三档真 judge + 真 review 作为旁证。不是只读设置页文案。
8. **F07 远程会话**：远程标签是通过「+」菜单真连 `h-8cd47b` 建立的；远程 AI 会话用服务端
   `createSession` 落盘（与 `agent.run` 首次落盘走同一函数），因为 F07 验的是徽标渲染，
   真模型对话由 F12 独立覆盖。
9. **F08**：主证据 `F08-real.txt` 是真实 `agent.run`；`F07-F08-F14-F15.txt` 额外用落盘会话
   验证标题/消息数快照。
10. **F12 第一次尝试**：默认 cwd 为 home，`du -a .` 扫 AppData 超时，导致后续步骤空转；
    这不是模型不工作，而是长命令超时后仍占用 PTY（D7）。改到 3 文件小目录后同一目标通过。

## 清理与回归

- 所有探针 `finally` 里 `handle.close()`；Chrome 由 `withPage` 的 finally `taskkill /T /F`。
- 结束后复查：3681/3683/9421 无 LISTENING 残留；3480/3477/3488/3496 未动。
- 产品代码 `git diff` 为空；`doctor-report.json` 已恢复为运行前内容。
- F18 原始输出：`F18-node-test.txt`（674/674/0）、`F18-doctor.txt`（33/33）。
