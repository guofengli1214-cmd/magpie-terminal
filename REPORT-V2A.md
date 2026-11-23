# REPORT-V2A（TASK-V2-A：布局重写（方案 A）+ 模型选择器）

工作单：`TASK-V2-A.md`（唯一工作单）。
机器：Windows / MINGW64 bash 5.2.37 / node v24.16.0（`node --version`）与 `D:/nodejs/install/node.exe`（同为 v24.16.0，两个二进制都跑了 D1/D2/D3）。
网关：真实 `http://127.0.0.1:3425`（`/v1/models` 实测 6 个模型）。

未做的事先声明（详见第 4 节）：

- 没有 `git add` / `git commit`；没有改 `docs/`、`.trellis/spec/`、`TASK.md`、`TASK-V2-A.md`、`LICENSE`、`.gitignore`；没有引入任何 npm 依赖（`package.json` 零改动）。
- `node --test` 偶发 1 例失败（node-pty 原生断言崩溃 / 或 pty 用例超时），**基线 HEAD（未改任何代码）同样会偶发**，见第 4.4 节。
- 宿主 magpie 已占用 3480（`magpie-bun.exe`），因此 D4 的 doctor 用 `DOCTOR_PORT=3481` 跑。

---

## 1. 改了什么（按文件）

### 1.1 骨架与样式

| 文件 | 改动 |
|---|---|
| `app/index.html` | 重写成方案 A 三层骨架：`#root[data-role=app]` 里 `nav.rail`（48px）+ `section.main`（tabbar / terminal-host / aibar）+ `div#ai-layer`（与 main 同格、绝对浮层）+ `div.statusbar`。保留 `<meta name="magpie-term-token">` 注入点注释、vendor 引用、data URI favicon。`data-role=rail-hosts` 带 `hidden`。 |
| `app/styles/layout.css` | 整份重写：`#root` 两列（`--term-rail-width` + 1fr）两行（主行 + 状态栏）；`.main` 纵向 flex（tabbar auto / terminal-host 1fr / aibar 44px）；`#ai-layer` 与 main 同格、`max-height: calc(100% - 88px)`、`margin` 让出 rail 与 aibar；`html,body{overflow-x:hidden}`。删掉了旧的 `grid-template-columns: minmax(...) var(--term-ai-width)` 与 `@media (max-width: 900px)` 折叠块；新增 `@media (max-width: 720px)` 让 aibar 折成两行。 |
| `app/styles/tokens.css` | 只加变量：`--term-rail-width:48px`、`--term-aibar-height:44px`、`--term-model-width:190px`、`--term-ai-layer-inset:88px`、`--term-rail-icon-size:34px`、`--term-shadow`、`--term-rail-active-bg`（明暗两套值）。颜色仍只出现在本文件。 |
| `app/styles/components.css` | 删掉 `.ai-header/.ai-body/.ai-input/.ai-log`（右栏形态）里的右栏专用部分，改为：rail 按钮/active/未读圆点、aibar 的 `select[data-role=model-select]`（190px, min-width:0）/ `input[data-role=ai-question]` / 「问」按钮、`[data-role=model-note]`、`#ai-layer` 内部 `.ai-header`（sticky）/`.ai-body`/`.ai-log`、`.ai-message-model`。确认卡样式原样保留。 |

### 1.2 前端模块

| 文件 | 改动 |
|---|---|
| `app/ui/rail.js` | 新增。`rail-term`（默认 active、点击 no-op 只保 active）、`rail-hosts`（点击 no-op，永不抛错）、`rail-ai`（调 `onToggleAi`，并镜像 `aria-pressed` / `data-unread`，未读时显示小圆点）、`rail-settings`（点击无副作用）。只订阅 store。 |
| `app/ui/ai-bar.js` | 新增。模型下拉 + 单行输入 + 「问」。启动 `Promise.all([GET /api/models, GET /api/config])`；默认选 `config.model`，配置里没有/不在清单里 → `default`；`available===false` 的项尾注「（上次失败）」并在 `.aibar` 下方一行小字显示 `note`；切换即 `PUT /api/config`（**串行化**，见 4.2）；网关不可达时下拉只有一个「网关不可用，点重试」项（选中即重拉）。`Enter` 提交、`Shift+Enter` 吞掉不提交、空输入拦截（提示走状态栏）。 |
| `app/ui/ai-panel.js` | 改为浮层结果列表：`host` 现在是 `#ai-layer`，只有 `ai-header`（含「收起」）+ `ai-body` + `ai-log`；回答头在 `frame.model` 存在时显示「模型：…」；确认卡全部逻辑（Esc / 焦点陷阱 / 关闭后焦点回触发点 / 不点不执行 / `decision==="auto"` 才自动写 PTY）一字未改地保留。`appendQuestion()` 供输入条回显。 |
| `app/ui/status-bar.js` | 新增「模型」一栏（显示 id 尾段，`title` 是完整 id；未选时标 warn）+ `setNotice(text,tone)` 一次性闪现（4 秒后自动消失，用于「模型偏好没存住」）。原「AI 栏」按钮保留。 |
| `app/core/api.js` | 加 `models()` / `config()` / `saveConfig(patch)`；新增 `sendJson()`（PUT 用），非 2xx 统一成 `{ok:false,code,userText}`，把服务端的 `code`（如 `INVALID_MODEL`）透出来。 |
| `app/core/session-store.js` | 只加字段，不改现有语义：`model`（null）、`aiOpen`（true）、`aiUnread`（false）；对应 `setModel/setAiOpen/setAiUnread`。`snapshotOf()` 里一并输出。 |
| `app/app.js` | 接新骨架：`rail`/`aiBar`/`aiPanel` 三个新视图；`toggleAi()` 改成控制 `#root[data-ai-open]` + `#ai-layer` 可见性（不再动 `aside.ai-panel`）；`applyAiOpen()` 是唯一同步点；`ai.ask` 帧带 `model`；`ai.reply/ai.error` 走后 `arriveAiResult()`（浮层可见就置已读，不可见就点未读圆点，不抢焦点）；banner 从 `#root` 改挂到 `main` 顶部（否则会多占一个网格格）；`sendResize()` 顺手 `patchSession({cols,rows})` 让 store 里的 cols/rows 是 PTY 真值。 |
| `app/ui/tab-bar.js` | 新增中键关闭（`auxclick` + `button===1`，并 `preventDefault` 掉中键 mousedown 的自动滚动）。**注意：这张卡把「中键关闭」列为回归锁，但基线里从未实现过**，本次补上（见 4.5）。 |

### 1.3 服务端

| 文件 | 改动 |
|---|---|
| `src/config/store.mjs` | 新增。`configPath()`（`MAGPIE_TERMINAL_CONFIG_PATH` 可覆盖，只给测试用；默认 `~/.config/magpie-terminal/config.json`）、`readConfig()`（不存在/损坏/非对象 → 返回默认值 + `ok:false` + `reason`，永不抛）、`writeConfig()`（`mkdir 700` → 临时文件 `mode 600` → `rename`）、`updateConfig(patch)`（读-改-写，只合并 `KNOWN_FIELDS`，**未知字段原样保留**）。导出：`CONFIG_PATH_ENV`、`KNOWN_FIELDS`、`DEFAULT_CONFIG`、`configPath`、`readConfig`、`writeConfig`、`updateConfig`。 |
| `src/ai/gateway.mjs` | ① `probeGateway()` 现在返回 `{count, durationMs, baseUrl, models:[{id,label,contextLength,available,note}]}`（`count`/`durationMs` 保留，现有调用方不受影响）；`label` 取 `magpie_label` 缺省回落 `id`；`contextLength` 取 `context_length`。② 新增失败记忆表：`MODEL_FAILURE_TTL_MS`（10 分钟）、`REMEMBERED_FAILURE_CODES`（`GATEWAY_HTTP_404`/`GATEWAY_HTTP_502`/`GATEWAY_BAD_JSON`）、`rememberModelFailure`/`clearModelFailure`/`modelFailuresSnapshot`/`resetModelFailures`。③ `askGateway` 在这三种错误码上记一笔、成功时 `clearModelFailure`。`AI_BAD_JSON`（模型回话了但没给可解析命令）**不记**，避免问错一句就把模型标灰 10 分钟。 |
| `src/server/http.mjs` | 新增三条路由，全部在 `isApi` 分支内（= 先过 token 门）：`GET /api/models`（网关不可达时 **仍 200**，`gateway.reachable:false`、`models:[]`、`default` 照常给出）、`GET /api/config`（只回 `{model}`，文件缺失/损坏时回默认值）、`PUT /api/config`（未知字段 → 400 `UNKNOWN_FIELD`；model 非字符串/空 → 400 `INVALID_MODEL`；model 不在 `/v1/models` 清单 → 400 `INVALID_MODEL`；写盘失败 → 500 `CONFIG_WRITE_FAILED`；网关不可达 → 502 `GATEWAY_UNAVAILABLE`，不假装存住了）。`access-control-allow-methods` 加 `PUT`。 |
| `src/server/ws.mjs` | `ai.ask` 帧加可选 `model: z.string().max(200).optional()`；`handleAsk` 把 `model` **透传**给 `askGateway`（这就是卡片说的「当前是丢弃的」那个 bug）；`ai.reply` 回显 `result.model`（网关实际用的那个）。 |

### 1.4 测试

| 文件 | 内容 |
|---|---|
| `test/server/models.test.mjs` | 新增 11 例：`/api/models` 无 token→403、有 token→200 且 label/contextLength/available/note/default 正确、网关 502→200+reachable:false+models:[]、网关端口关闭→同上、失败记忆记/清、非三种错误码不记、TTL 常量锁、`GET /api/config` 缺失→默认值、`PUT` 无 token→403、`PUT` 未知 model→400 `INVALID_MODEL`、`PUT` 未知字段→400 `UNKNOWN_FIELD`。全部用本地 stub 网关，不打真实 3425。 |
| `test/config/store.test.mjs` | 新增 10 例：默认路径、`KNOWN_FIELDS`、缺失/损坏/数组→默认值、落盘+读回+mode（POSIX 下断言 700/600）、未知字段原样保留、未知 patch 字段被忽略、原子替换不留临时文件、空 model 归 null。 |

---

## 2. 第 5 节每条命令的真实输出（原样贴）

> 说明：D4 用 `DOCTOR_PORT=3481`（3480 被宿主 `magpie-bun.exe` 占用，见 4.1）。

### D1. `"D:/nodejs/install/node.exe" --test` → 必须 0 fail

```
$ "D:/nodejs/install/node.exe" --test
✔ 提示词不得包含自我审查句「不要执行破坏性操作」 (1.5771ms)
✔ 提示词必须包含「删掉这个文件 → rm <文件名>」的反例/正例 (0.3257ms)
✔ 提示词必须说明：模型自己不执行、由应用/确认卡把关 (0.1452ms)
✔ 提示词仍然禁止 sudo（提权是硬性禁止，不是普通确认） (0.305ms)
✔ 提示词仍然禁止 find，并给出 rg/ls 替代（D8 的配套） (0.1663ms)
✔ 提示词仍然限定 curl 为 -I（D8 的配套） (0.1003ms)
✔ 提示词首行仍是「单条命令 + JSON 输出」的契约 (0.2194ms)
✔ configPath 默认落在 ~/.config/magpie-terminal/config.json (2.7705ms)
✔ KNOWN_FIELDS 本卡只有 model（下一张卡加 hosts） (0.8199ms)
✔ 文件不存在 → 默认值，不抛错（ok:false reason:missing） (6.5509ms)
✔ 文件损坏（不是 JSON）→ 默认值，不抛错 (7.5713ms)
✔ 文件是数组 → 视为损坏 (5.2142ms)
✔ updateConfig 落盘 + 读回；目录 700、文件 600 (5.0554ms)
✔ 未知字段原样保留（读-改-写） (6.2549ms)
✔ updateConfig 忽略不认识的 patch 字段（不报错、不落盘） (7.6349ms)
✔ writeConfig 是原子替换：目录里不留下临时文件 (9.5539ms)
✔ model 为空串 → 归一为 null，仍然落盘 (6.9735ms)
✔ test\fixtures\fake-gateway-500.mjs (429.5289ms)
✔ test\fixtures\fake-pty-noop.mjs (378.2223ms)
✔ test\fixtures\policy-empty-allowlist.mjs (325.0185ms)
✔ test\fixtures\slow-gateway.mjs (269.5053ms)
✔ #1 "ls -la" → auto（白名单基线） (3.8978ms)
✔ #2 "rm -rf /" → confirm（黑名单基线，最不能错） (0.305ms)
✔ #3 "ls > out.txt" → confirm（输出重定向会截断文件） (0.1007ms)
✔ #4 "ls -la && rm x" → confirm（多段任一段危险即整体危险） (0.1123ms)
✔ #5 "ls | grep foo" → auto（管道两侧都是只读） (0.1175ms)
✔ #6 "cat a.txt | xargs rm" → confirm（管道后段是黑名单） (0.1108ms)
✔ #7 "echo \"unclosed" → confirm（引号不闭合 = 切不开） (0.1121ms)
✔ #8 "find . -delete" → confirm（命令头只读但参数危险） (0.1748ms)
✔ #9 "find . -exec rm {} \\;" → confirm（同上） (0.1375ms)
✔ #10 "echo $(rm -rf x)" → confirm（命令替换里的危险命令） (0.1396ms)
✔ #11 "FOO=1 rm x" → confirm（环境变量前缀包装） (0.085ms)
✔ #12 "sudo ls" → confirm（提权包装） (0.0754ms)
✔ #13 "git status" → auto（白名单子命令） (0.093ms)
✔ #14 "git push" → confirm（黑名单 git 写操作） (0.0511ms)
✔ #15 "" → confirm（空命令不是成功执行） (0.0356ms)
✔ #16 12345 → confirm（非字符串入参：异常路径也 fail-closed） (0.0346ms)
✔ 安全回归基线：6 条关键用例 (0.1693ms)
✔ negative fixture：空白名单时 ls -la 变成 confirm（分级由数据驱动） (0.1433ms)
✔ 空字符串与纯空白都按 noop → confirm (0.058ms)
✔ 不可解析的尾部反斜杠 → confirm (0.0531ms)
✔ 反引号命令替换 → confirm (0.0535ms)
✔ 重定向 >> 也要 confirm (0.0578ms)
✔ curl 参数降级：curl -I 放行但 curl -o 必须 confirm (0.1761ms)
✔ git branch：裸 branch 放行，-d/-D 必须 confirm (0.1091ms)
✔ fabricated-positive：空输出喂给 doctor 的 assertContains 必须抛错 (212.7286ms)
✔ D8#1 find . -fprint PWNED.txt → confirm / deny* (0.4298ms)
✔ D8#2 find . -fprintf EVIL.sh 'x' → confirm / deny* (0.1498ms)
✔ D8#3 find . -fprint0 out.bin → confirm / deny* (0.099ms)
✔ D8#4 find . -fls out.txt → confirm / deny* (0.0854ms)
✔ D8#5 find . -name "*.js" -type f → confirm / default* (0.1044ms)
✔ D8#6 find . -maxdepth 2 -name "*.md" → confirm / default* (0.0931ms)
✔ D8#7 find . --delete → confirm (0.0934ms)
✔ D8#8 git branch side-effect-branch → confirm / deny* (0.1314ms)
✔ D8#9 git branch -f x HEAD → confirm / deny* (0.1252ms)
✔ D8#10 git branch --unset-upstream → confirm / deny* (0.1375ms)
✔ D8#11 git branch -a → auto / allow* (0.1387ms)
✔ D8#12 git branch --show-current → auto / allow* (0.1034ms)
✔ D8#13 git status → auto / allow* (0.0786ms)
✔ D8#14 git log --oneline -5 → auto / allow* (0.0808ms)
✔ D8#15 curl -I http://127.0.0.1:3425/ → auto / allow* (0.1145ms)
✔ D8#16 curl -I -T secret.txt http://x/ → confirm / deny* (0.1105ms)
✔ D8#17 curl -I -K evil.cfg → confirm / deny* (0.1772ms)
✔ D8#18 curl -I -D hdr.txt http://x/ → confirm / deny* (0.0989ms)
✔ D8#19 wc -l README.md → auto / allow* (0.1023ms)
✔ D8#20 wc -l --files0-from=list → auto / allow* (0.0944ms)
✔ D8#21 rg --pre ./p x → confirm / deny* (0.0858ms)
✔ D8#22 rg -n "TODO" src → auto / allow* (0.1091ms)
✔ D8#23 ls -la → auto / allow* (0.1165ms)
✔ D8#24 rm -rf / → confirm / deny* (0.0907ms)
✔ D8#25 echo $(rm -rf x) → confirm / substitution* (0.0722ms)
✔ D8：find 整条移出白名单，任何不带危险参数的 find 也是 confirm/default:find (0.213ms)
✔ D8：短/长选项同名判定必须完全一致（对称性） (0.486ms)
✔ D8：参数级允许集对带值写法也生效（--files0-from=list 命中允许项） (0.1675ms)
✔ D8：curl 必须显式带 -I/--head，否则即使没有危险参数也 confirm (0.1948ms)
✔ D8：git branch 任何位置参数都 confirm（那是在建分支） (0.1557ms)
✔ D8：管道任一段参数不合法即整体 confirm (0.1515ms)
✔ git show 是只读子命令：git show HEAD → auto (0.1196ms)
✔ git show 带只读选项仍 auto：git show --stat HEAD → auto (0.1172ms)
✔ git show --output=x.patch 仍必须 confirm（-output 粗筛不能被 show 放行绕过） (0.1243ms)
✔ git show 不能顺带放行 git 的写操作或未知子命令 (0.159ms)
▶ pty 集成组
  ✔ #1 真 TTY：stty size 有输出 (867.5209ms)
  ✔ #2 基础输出：echo hi 含 hi (551.2866ms)
  ✔ #4 resize：30 100 → 40 132 生效 (1145.0258ms)
  ✔ #5 resize 后连敲 10 次不丢字符 (1904.96ms)
  ✔ #6/#7 退出清理：kill 后 >1.1s pid 消失 (4009.7629ms)
✔ pty 集成组 (8481.1261ms)
✔ 哨兵法降级：强制 sentinel 时 ls 仍有输出，健康报 pty=sentinel (273.5437ms)
▶ AI 链路：extract / context 纯函数
  ✔ extract 剥 json 围栏 (0.5473ms)
  ✔ extract 从解释文字中取第一个 {...} (0.2774ms)
  ✔ extract 解析失败不抛 (0.2436ms)
  ✔ context 只带三个字段并截断 (0.5802ms)
  ✔ ai.reply 的 command 必须过 classify（不信任模型） (1.4595ms)
✔ AI 链路：extract / context 纯函数 (3.9853ms)
✔ AI 网关负向：fake 500 → GATEWAY_HTTP_500 (16.9314ms)
✔ AI 网关负向：慢网关 → GATEWAY_TIMEOUT (610.7475ms)
✔ AI 网关正探活（真实 3425，失败则 skip） (16.3753ms)
✔ #1 无 cookie 无 token 的 /api/health → 403 (190.4386ms)
✔ #2 错 token（64 位 hex 但不匹配）→ 403 (4.9396ms)
✔ #3 长度不对的 token（32 位）→ 403，且不是 500 (3.1408ms)
✔ #4 Origin: http://evil.com + 正确 token → 403 (3.742ms)
✔ #5 Host: evil.com:<port>（原始 socket）→ 403 (5.4254ms)
✔ #5b Host: 127.0.0.1:3477（端口不匹配）→ 403 (4.2987ms)
✔ #6 Origin: null 字面量 + 正确 token → 200 (4.2136ms)
✔ #7 正确 token + 自身 Origin → 200 (3.1421ms)
✔ #7b 正确 token + 无 Origin（脚本调用方）→ 200；query 也 200 (4.8651ms)
✔ #8 WS 无 token → 握手失败（非 101），且没有 HTTP body (4.8191ms)
✔ #8b WS 错 token → 同样不是 101，且无 body (3.1879ms)
✔ #8c WS 正确 token → 101 (4015.4781ms)
✔ #8d WS 伪造 Origin + 正确 token → 不是 101 (3.773ms)
✔ #9 未知 /api/nope 无 token → 403（鉴权先于路由），不是 404 (8.3467ms)
✔ #4b Origin: http://wails.localhost + 正确 token → 403（不放行宿主 origin） (2.1665ms)
✔ 403 响应体不区分失败原因 (5.343ms)
✔ 请求体超过 64KB → 413 (7.6034ms)
✔ POST /api/ai 已鉴权 → 501（存在且鉴权） (5.247ms)
✔ GET /api/policy 已鉴权 → 200 且含白名单 / 黑名单 (4.0751ms)
✔ 根路径 / 注入 meta 口令、不再下发 set-cookie、CSP 无 frame-ancestors (3.704ms)
✔ buildCsp() 不含 frame-ancestors（防止有人顺手加回去） (0.2766ms)
✔ Origin: null 取静态 JS 时带 ACAO: null 与 vary: Origin (19.9529ms)
✔ Origin: null 取 CSS / vendor 也带 ACAO: null (12.4787ms)
✔ OPTIONS /api/health 带 Origin: null → 204 + CORS，且不需要 token (2.7131ms)
✔ cookie 通道已关闭：只带 cookie: mt=<正确 token> → 403 (1.6085ms)
✔ 403 的 /api/* 也带 CORS 头（否则沙箱里分不清没权限还是网络错） (1.4988ms)
✔ Origin 不合法时不回 ACAO（不向恶意页面确认「你能读」） (1.6335ms)
✔ WS 连上但什么都不发 → 500ms 后 sessions 不变（服务端不自动建会话） (517.7061ms)
✔ WS 只发 pty.create 才建会话；重连只发 pty.attach 不重复建 (805.868ms)
✔ pty.attach 不存在的 id → pty.error / SESSION_GONE (30.6721ms)
✔ CSP 的 style-src 带 'unsafe-inline'，script-src 仍严格 'self' (4.3726ms)
✔ 注入的 tokens 用 html:root 选择器（否则被 tokens.css 兜底值盖掉） (2.4786ms)
✔ /api/models 未带 token → 403（与 /api/health 同一道门） (188.2093ms)
✔ /api/models 带 token → 200，label 取 magpie_label，缺省回落 id (25.0707ms)
✔ /api/models 网关 502 → 仍返回 200 + reachable:false + models:[] + default (18.9785ms)
✔ /api/models 网关连不上（端口关闭）→ 同样 200 + reachable:false (15.2604ms)
✔ 失败记忆：GATEWAY_HTTP_502 记一笔 → available:false + note；成功一次即清除 (13.9318ms)
✔ 失败记忆：不在三种错误码内的错误不记（例如 GATEWAY_TIMEOUT） (0.2881ms)
✔ 失败记忆 TTL 是 10 分钟（常量锁） (0.1478ms)
✔ GET /api/config 文件不存在 → 返回默认值（不抛错） (8.1171ms)
✔ PUT /api/config 未带 token → 403 (9.8193ms)
✔ PUT /api/config 不在清单里的 model → 400 INVALID_MODEL (11.9592ms)
✔ PUT /api/config 未知字段 → 400 UNKNOWN_FIELD (10.7205ms)
ℹ tests 140
ℹ suites 0
ℹ pass 140
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9981.1237

$ echo $?
0
```

### D2. `node --test` → 必须 0 fail

```
$ node --test
✔ 提示词不得包含自我审查句「不要执行破坏性操作」 (0.7988ms)
✔ 提示词必须包含「删掉这个文件 → rm <文件名>」的反例/正例 (0.3753ms)
✔ 提示词必须说明：模型自己不执行、由应用/确认卡把关 (0.1501ms)
✔ 提示词仍然禁止 sudo（提权是硬性禁止，不是普通确认） (0.1865ms)
✔ 提示词仍然禁止 find，并给出 rg/ls 替代（D8 的配套） (0.1809ms)
✔ 提示词仍然限定 curl 为 -I（D8 的配套） (0.0928ms)
✔ 提示词首行仍是「单条命令 + JSON 输出」的契约 (0.1042ms)
✔ configPath 默认落在 ~/.config/magpie-terminal/config.json (2.2762ms)
✔ KNOWN_FIELDS 本卡只有 model（下一张卡加 hosts） (1.247ms)
✔ 文件不存在 → 默认值，不抛错（ok:false reason:missing） (9.1664ms)
✔ 文件损坏（不是 JSON）→ 默认值，不抛错 (5.4982ms)
✔ 文件是数组 → 视为损坏 (3.0742ms)
✔ updateConfig 落盘 + 读回；目录 700、文件 600 (4.192ms)
✔ 未知字段原样保留（读-改-写） (7.2712ms)
✔ updateConfig 忽略不认识的 patch 字段（不报错、不落盘） (10.2301ms)
✔ writeConfig 是原子替换：目录里不留下临时文件 (11.0885ms)
✔ model 为空串 → 归一为 null，仍然落盘 (7.0197ms)
✔ test\fixtures\fake-gateway-500.mjs (434.3163ms)
✔ test\fixtures\fake-pty-noop.mjs (382.9413ms)
✔ test\fixtures\policy-empty-allowlist.mjs (333.0491ms)
✔ test\fixtures\slow-gateway.mjs (272.4028ms)
✔ #1 "ls -la" → auto（白名单基线） (4.5254ms)
✔ #2 "rm -rf /" → confirm（黑名单基线，最不能错） (1.0909ms)
✔ #3 "ls > out.txt" → confirm（输出重定向会截断文件） (0.2754ms)
✔ #4 "ls -la && rm x" → confirm（多段任一段危险即整体危险） (0.3022ms)
✔ #5 "ls | grep foo" → auto（管道两侧都是只读） (0.3076ms)
✔ #6 "cat a.txt | xargs rm" → confirm（管道后段是黑名单） (0.25ms)
✔ #7 "echo \"unclosed" → confirm（引号不闭合 = 切不开） (0.2451ms)
✔ #8 "find . -delete" → confirm（命令头只读但参数危险） (0.4866ms)
✔ #9 "find . -exec rm {} \\;" → confirm（同上） (0.1787ms)
✔ #10 "echo $(rm -rf x)" → confirm（命令替换里的危险命令） (0.2058ms)
✔ #11 "FOO=1 rm x" → confirm（环境变量前缀包装） (0.123ms)
✔ #12 "sudo ls" → confirm（提权包装） (0.1052ms)
✔ #13 "git status" → auto（白名单子命令） (0.1065ms)
✔ #14 "git push" → confirm（黑名单 git 写操作） (0.0622ms)
✔ #15 "" → confirm（空命令不是成功执行） (0.0441ms)
✔ #16 12345 → confirm（非字符串入参：异常路径也 fail-closed） (0.0456ms)
✔ 安全回归基线：6 条关键用例 (0.272ms)
✔ negative fixture：空白名单时 ls -la 变成 confirm（分级由数据驱动） (0.2829ms)
✔ 空字符串与纯空白都按 noop → confirm (0.0849ms)
✔ 不可解析的尾部反斜杠 → confirm (0.0735ms)
✔ 反引号命令替换 → confirm (0.0806ms)
✔ 重定向 >> 也要 confirm (0.0866ms)
✔ curl 参数降级：curl -I 放行但 curl -o 必须 confirm (0.3164ms)
✔ git branch：裸 branch 放行，-d/-D 必须 confirm (0.1961ms)
✔ fabricated-positive：空输出喂给 doctor 的 assertContains 必须抛错 (218.4563ms)
✔ D8#1 find . -fprint PWNED.txt → confirm / deny* (0.2705ms)
✔ D8#2 find . -fprintf EVIL.sh 'x' → confirm / deny* (0.0874ms)
✔ D8#3 find . -fprint0 out.bin → confirm / deny* (0.0548ms)
✔ D8#4 find . -fls out.txt → confirm / deny* (0.0474ms)
✔ D8#5 find . -name "*.js" -type f → confirm / default* (0.0762ms)
✔ D8#6 find . -maxdepth 2 -name "*.md" → confirm / default* (0.0726ms)
✔ D8#7 find . --delete → confirm (0.0631ms)
✔ D8#8 git branch side-effect-branch → confirm / deny* (0.099ms)
✔ D8#9 git branch -f x HEAD → confirm / deny* (0.1211ms)
✔ D8#10 git branch --unset-upstream → confirm / deny* (0.1255ms)
✔ D8#11 git branch -a → auto / allow* (0.1405ms)
✔ D8#12 git branch --show-current → auto / allow* (0.09ms)
✔ D8#13 git status → auto / allow* (0.065ms)
✔ D8#14 git log --oneline -5 → auto / allow* (0.0731ms)
✔ D8#15 curl -I http://127.0.0.1:3425/ → auto / allow* (0.1171ms)
✔ D8#16 curl -I -T secret.txt http://x/ → confirm / deny* (0.0834ms)
✔ D8#17 curl -I -K evil.cfg → confirm / deny* (0.1375ms)
✔ D8#18 curl -I -D hdr.txt http://x/ → confirm / deny* (0.0934ms)
✔ D8#19 wc -l README.md → auto / allow* (0.0896ms)
✔ D8#20 wc -l --files0-from=list → auto / allow* (0.0859ms)
✔ D8#21 rg --pre ./p x → confirm / deny* (0.0748ms)
✔ D8#22 rg -n "TODO" src → auto / allow* (0.0751ms)
✔ D8#23 ls -la → auto / allow* (0.1561ms)
✔ D8#24 rm -rf / → confirm / deny* (0.1435ms)
✔ D8#25 echo $(rm -rf x) → confirm / substitution* (0.0715ms)
✔ D8：find 整条移出白名单，任何不带危险参数的 find 也是 confirm/default:find (0.1918ms)
✔ D8：短/长选项同名判定必须完全一致（对称性） (0.4904ms)
✔ D8：参数级允许集对带值写法也生效（--files0-from=list 命中允许项） (0.1741ms)
✔ D8：curl 必须显式带 -I/--head，否则即使没有危险参数也 confirm (0.1875ms)
✔ D8：git branch 任何位置参数都 confirm（那是在建分支） (0.1514ms)
✔ D8：管道任一段参数不合法即整体 confirm (0.1378ms)
✔ git show 是只读子命令：git show HEAD → auto (0.1102ms)
✔ git show 带只读选项仍 auto：git show --stat HEAD → auto (0.1201ms)
✔ git show --output=x.patch 仍必须 confirm（-output 粗筛不能被 show 放行绕过） (0.1141ms)
✔ git show 不能顺带放行 git 的写操作或未知子命令 (0.1327ms)
▶ pty 集成组
  ✔ #1 真 TTY：stty size 有输出 (783.99ms)
  ✔ #2 基础输出：echo hi 含 hi (572.0068ms)
  ✔ #4 resize：30 100 → 40 132 生效 (1089.3145ms)
  ✔ #5 resize 后连敲 10 次不丢字符 (1973.2524ms)
  ✔ #6/#7 退出清理：kill 后 >1.1s pid 消失 (3987.6585ms)
✔ pty 集成组 (8408.7461ms)
✔ 哨兵法降级：强制 sentinel 时 ls 仍有输出，健康报 pty=sentinel (213.2067ms)
▶ AI 链路：extract / context 纯函数
  ✔ extract 剥 json 围栏 (0.79ms)
  ✔ extract 从解释文字中取第一个 {...} (0.2257ms)
  ✔ extract 解析失败不抛 (0.1686ms)
  ✔ context 只带三个字段并截断 (0.3535ms)
  ✔ ai.reply 的 command 必须过 classify（不信任模型） (0.786ms)
✔ AI 链路：extract / context 纯函数 (3.3031ms)
✔ AI 网关负向：fake 500 → GATEWAY_HTTP_500 (14.302ms)
✔ AI 网关负向：慢网关 → GATEWAY_TIMEOUT (614.0544ms)
✔ AI 网关正探活（真实 3425，失败则 skip） (18.5627ms)
✔ #1 无 cookie 无 token 的 /api/health → 403 (140.3704ms)
✔ #2 错 token（64 位 hex 但不匹配）→ 403 (4.1563ms)
✔ #3 长度不对的 token（32 位）→ 403，且不是 500 (2.4005ms)
✔ #4 Origin: http://evil.com + 正确 token → 403 (3.7194ms)
✔ #5 Host: evil.com:<port>（原始 socket）→ 403 (5.2074ms)
✔ #5b Host: 127.0.0.1:3477（端口不匹配）→ 403 (3.9976ms)
✔ #6 Origin: null 字面量 + 正确 token → 200 (3.894ms)
✔ #7 正确 token + 自身 Origin → 200 (3.5536ms)
✔ #7b 正确 token + 无 Origin（脚本调用方）→ 200；query 也 200 (5.1243ms)
✔ #8 WS 无 token → 握手失败（非 101），且没有 HTTP body (4.5592ms)
✔ #8b WS 错 token → 同样不是 101，且无 body (2.8175ms)
✔ #8c WS 正确 token → 101 (4019.0227ms)
✔ #8d WS 伪造 Origin + 正确 token → 不是 101 (2.7237ms)
✔ #9 未知 /api/nope 无 token → 403（鉴权先于路由），不是 404 (6.5618ms)
✔ #4b Origin: http://wails.localhost + 正确 token → 403（不放行宿主 origin） (2.1881ms)
✔ 403 响应体不区分失败原因 (7.1712ms)
✔ 请求体超过 64KB → 413 (6.3497ms)
✔ POST /api/ai 已鉴权 → 501（存在且鉴权） (4.4005ms)
✔ GET /api/policy 已鉴权 → 200 且含白名单 / 黑名单 (7.5479ms)
✔ 根路径 / 注入 meta 口令、不再下发 set-cookie、CSP 无 frame-ancestors (4.8747ms)
✔ buildCsp() 不含 frame-ancestors（防止有人顺手加回去） (0.2585ms)
✔ Origin: null 取静态 JS 时带 ACAO: null 与 vary: Origin (4.7997ms)
✔ Origin: null 取 CSS / vendor 也带 ACAO: null (11.2882ms)
✔ OPTIONS /api/health 带 Origin: null → 204 + CORS，且不需要 token (2.948ms)
✔ cookie 通道已关闭：只带 cookie: mt=<正确 token> → 403 (2.3472ms)
✔ 403 的 /api/* 也带 CORS 头（否则沙箱里分不清没权限还是网络错） (1.6552ms)
✔ Origin 不合法时不回 ACAO（不向恶意页面确认「你能读」） (2.2186ms)
✔ WS 连上但什么都不发 → 500ms 后 sessions 不变（服务端不自动建会话） (519.1916ms)
✔ WS 只发 pty.create 才建会话；重连只发 pty.attach 不重复建 (816.061ms)
✔ pty.attach 不存在的 id → pty.error / SESSION_GONE (31.2544ms)
✔ CSP 的 style-src 带 'unsafe-inline'，script-src 仍严格 'self' (3.8021ms)
✔ 注入的 tokens 用 html:root 选择器（否则被 tokens.css 兜底值盖掉） (2.4865ms)
✔ /api/models 未带 token → 403（与 /api/health 同一道门） (153.0862ms)
✔ /api/models 带 token → 200，label 取 magpie_label，缺省回落 id (28.2082ms)
✔ /api/models 网关 502 → 仍返回 200 + reachable:false + models:[] + default (18.2224ms)
✔ /api/models 网关连不上（端口关闭）→ 同样 200 + reachable:false (15.4231ms)
✔ 失败记忆：GATEWAY_HTTP_502 记一笔 → available:false + note；成功一次即清除 (12.8378ms)
✔ 失败记忆：不在三种错误码内的错误不记（例如 GATEWAY_TIMEOUT） (0.4023ms)
✔ 失败记忆 TTL 是 10 分钟（常量锁） (0.1364ms)
✔ GET /api/config 文件不存在 → 返回默认值（不抛错） (10.4493ms)
✔ PUT /api/config 未带 token → 403 (9.6051ms)
✔ PUT /api/config 不在清单里的 model → 400 INVALID_MODEL (10.3021ms)
✔ PUT /api/config 未知字段 → 400 UNKNOWN_FIELD (8.6678ms)
ℹ tests 140
ℹ suites 0
ℹ pass 140
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9884.0651

$ echo $?
0
```

### D3. `"D:/nodejs/install/npm.cmd" test` → exit 0

```
$ "D:/nodejs/install/npm.cmd" test

> magpie-terminal@0.1.0 test
> node --test

✔ 提示词不得包含自我审查句「不要执行破坏性操作」 (1.2645ms)
✔ 提示词必须包含「删掉这个文件 → rm <文件名>」的反例/正例 (0.8623ms)
✔ 提示词必须说明：模型自己不执行、由应用/确认卡把关 (0.2996ms)
✔ 提示词仍然禁止 sudo（提权是硬性禁止，不是普通确认） (0.431ms)
✔ 提示词仍然禁止 find，并给出 rg/ls 替代（D8 的配套） (0.3285ms)
✔ 提示词仍然限定 curl 为 -I（D8 的配套） (0.2247ms)
✔ 提示词首行仍是「单条命令 + JSON 输出」的契约 (0.2352ms)
✔ configPath 默认落在 ~/.config/magpie-terminal/config.json (4.5355ms)
✔ KNOWN_FIELDS 本卡只有 model（下一张卡加 hosts） (0.8194ms)
✔ 文件不存在 → 默认值，不抛错（ok:false reason:missing） (7.0229ms)
✔ 文件损坏（不是 JSON）→ 默认值，不抛错 (4.2569ms)
✔ 文件是数组 → 视为损坏 (2.7286ms)
✔ updateConfig 落盘 + 读回；目录 700、文件 600 (7.7976ms)
✔ 未知字段原样保留（读-改-写） (6.3026ms)
✔ updateConfig 忽略不认识的 patch 字段（不报错、不落盘） (7.0881ms)
✔ writeConfig 是原子替换：目录里不留下临时文件 (6.7232ms)
✔ model 为空串 → 归一为 null，仍然落盘 (7.1078ms)
✔ test\fixtures\fake-gateway-500.mjs (441.4615ms)
✔ test\fixtures\fake-pty-noop.mjs (387.8197ms)
✔ test\fixtures\policy-empty-allowlist.mjs (333.2904ms)
✔ test\fixtures\slow-gateway.mjs (277.9969ms)
✔ #1 "ls -la" → auto（白名单基线） (3.4717ms)
✔ #2 "rm -rf /" → confirm（黑名单基线，最不能错） (0.3966ms)
✔ #3 "ls > out.txt" → confirm（输出重定向会截断文件） (0.1049ms)
✔ #4 "ls -la && rm x" → confirm（多段任一段危险即整体危险） (0.1181ms)
✔ #5 "ls | grep foo" → auto（管道两侧都是只读） (0.1374ms)
✔ #6 "cat a.txt | xargs rm" → confirm（管道后段是黑名单） (0.1056ms)
✔ #7 "echo \"unclosed" → confirm（引号不闭合 = 切不开） (0.125ms)
✔ #8 "find . -delete" → confirm（命令头只读但参数危险） (0.2267ms)
✔ #9 "find . -exec rm {} \\;" → confirm（同上） (0.1496ms)
✔ #10 "echo $(rm -rf x)" → confirm（命令替换里的危险命令） (0.1501ms)
✔ #11 "FOO=1 rm x" → confirm（环境变量前缀包装） (0.0909ms)
✔ #12 "sudo ls" → confirm（提权包装） (0.0671ms)
✔ #13 "git status" → auto（白名单子命令） (0.1041ms)
✔ #14 "git push" → confirm（黑名单 git 写操作） (0.0669ms)
✔ #15 "" → confirm（空命令不是成功执行） (0.036ms)
✔ #16 12345 → confirm（非字符串入参：异常路径也 fail-closed） (0.0355ms)
✔ 安全回归基线：6 条关键用例 (0.3303ms)
✔ negative fixture：空白名单时 ls -la 变成 confirm（分级由数据驱动） (0.4638ms)
✔ 空字符串与纯空白都按 noop → confirm (0.2358ms)
✔ 不可解析的尾部反斜杠 → confirm (0.1284ms)
✔ 反引号命令替换 → confirm (0.1253ms)
✔ 重定向 >> 也要 confirm (0.1683ms)
✔ curl 参数降级：curl -I 放行但 curl -o 必须 confirm (0.6968ms)
✔ git branch：裸 branch 放行，-d/-D 必须 confirm (0.369ms)
✔ fabricated-positive：空输出喂给 doctor 的 assertContains 必须抛错 (234.9438ms)
✔ D8#1 find . -fprint PWNED.txt → confirm / deny* (0.3401ms)
✔ D8#2 find . -fprintf EVIL.sh 'x' → confirm / deny* (0.0859ms)
✔ D8#3 find . -fprint0 out.bin → confirm / deny* (0.0754ms)
✔ D8#4 find . -fls out.txt → confirm / deny* (0.1192ms)
✔ D8#5 find . -name "*.js" -type f → confirm / default* (0.1183ms)
✔ D8#6 find . -maxdepth 2 -name "*.md" → confirm / default* (0.0934ms)
✔ D8#7 find . --delete → confirm (0.0824ms)
✔ D8#8 git branch side-effect-branch → confirm / deny* (0.1514ms)
✔ D8#9 git branch -f x HEAD → confirm / deny* (0.1253ms)
✔ D8#10 git branch --unset-upstream → confirm / deny* (0.1264ms)
✔ D8#11 git branch -a → auto / allow* (0.1352ms)
✔ D8#12 git branch --show-current → auto / allow* (0.1025ms)
✔ D8#13 git status → auto / allow* (0.0669ms)
✔ D8#14 git log --oneline -5 → auto / allow* (0.0788ms)
✔ D8#15 curl -I http://127.0.0.1:3425/ → auto / allow* (0.1083ms)
✔ D8#16 curl -I -T secret.txt http://x/ → confirm / deny* (0.1036ms)
✔ D8#17 curl -I -K evil.cfg → confirm / deny* (0.1764ms)
✔ D8#18 curl -I -D hdr.txt http://x/ → confirm / deny* (0.0924ms)
✔ D8#19 wc -l README.md → auto / allow* (0.0979ms)
✔ D8#20 wc -l --files0-from=list → auto / allow* (0.0902ms)
✔ D8#21 rg --pre ./p x → confirm / deny* (0.0828ms)
✔ D8#22 rg -n "TODO" src → auto / allow* (0.0765ms)
✔ D8#23 ls -la → auto / allow* (0.1501ms)
✔ D8#24 rm -rf / → confirm / deny* (0.057ms)
✔ D8#25 echo $(rm -rf x) → confirm / substitution* (0.0445ms)
✔ D8：find 整条移出白名单，任何不带危险参数的 find 也是 confirm/default:find (0.1649ms)
✔ D8：短/长选项同名判定必须完全一致（对称性） (0.2733ms)
✔ D8：参数级允许集对带值写法也生效（--files0-from=list 命中允许项） (0.0936ms)
✔ D8：curl 必须显式带 -I/--head，否则即使没有危险参数也 confirm (0.1039ms)
✔ D8：git branch 任何位置参数都 confirm（那是在建分支） (0.0874ms)
✔ D8：管道任一段参数不合法即整体 confirm (0.0924ms)
✔ git show 是只读子命令：git show HEAD → auto (0.0711ms)
✔ git show 带只读选项仍 auto：git show --stat HEAD → auto (0.0711ms)
✔ git show --output=x.patch 仍必须 confirm（-output 粗筛不能被 show 放行绕过） (0.0701ms)
✔ git show 不能顺带放行 git 的写操作或未知子命令 (0.0822ms)
▶ pty 集成组
  ✔ #1 真 TTY：stty size 有输出 (783.8994ms)
  ✔ #2 基础输出：echo hi 含 hi (570.755ms)
  ✔ #4 resize：30 100 → 40 132 生效 (1122.4585ms)
  ✔ #5 resize 后连敲 10 次不丢字符 (1990.4695ms)
  ✔ #6/#7 退出清理：kill 后 >1.1s pid 消失 (3973.7956ms)
✔ pty 集成组 (8443.4447ms)
✔ 哨兵法降级：强制 sentinel 时 ls 仍有输出，健康报 pty=sentinel (267.4246ms)
▶ AI 链路：extract / context 纯函数
  ✔ extract 剥 json 围栏 (0.58ms)
  ✔ extract 从解释文字中取第一个 {...} (0.2696ms)
  ✔ extract 解析失败不抛 (0.134ms)
  ✔ context 只带三个字段并截断 (0.33ms)
  ✔ ai.reply 的 command 必须过 classify（不信任模型） (0.7304ms)
✔ AI 链路：extract / context 纯函数 (2.7212ms)
✔ AI 网关负向：fake 500 → GATEWAY_HTTP_500 (17.6338ms)
✔ AI 网关负向：慢网关 → GATEWAY_TIMEOUT (609.4755ms)
✔ AI 网关正探活（真实 3425，失败则 skip） (14.729ms)
✔ #1 无 cookie 无 token 的 /api/health → 403 (141.2114ms)
✔ #2 错 token（64 位 hex 但不匹配）→ 403 (3.7985ms)
✔ #3 长度不对的 token（32 位）→ 403，且不是 500 (2.3178ms)
✔ #4 Origin: http://evil.com + 正确 token → 403 (3.9214ms)
✔ #5 Host: evil.com:<port>（原始 socket）→ 403 (4.5605ms)
✔ #5b Host: 127.0.0.1:3477（端口不匹配）→ 403 (3.5656ms)
✔ #6 Origin: null 字面量 + 正确 token → 200 (4.275ms)
✔ #7 正确 token + 自身 Origin → 200 (2.5731ms)
✔ #7b 正确 token + 无 Origin（脚本调用方）→ 200；query 也 200 (4.6264ms)
✔ #8 WS 无 token → 握手失败（非 101），且没有 HTTP body (2.8774ms)
✔ #8b WS 错 token → 同样不是 101，且无 body (2.2607ms)
✔ #8c WS 正确 token → 101 (4006.9233ms)
✔ #8d WS 伪造 Origin + 正确 token → 不是 101 (2.207ms)
✔ #9 未知 /api/nope 无 token → 403（鉴权先于路由），不是 404 (4.9737ms)
✔ #4b Origin: http://wails.localhost + 正确 token → 403（不放行宿主 origin） (1.7883ms)
✔ 403 响应体不区分失败原因 (5.6821ms)
✔ 请求体超过 64KB → 413 (5.8209ms)
✔ POST /api/ai 已鉴权 → 501（存在且鉴权） (3.0026ms)
✔ GET /api/policy 已鉴权 → 200 且含白名单 / 黑名单 (3.3194ms)
✔ 根路径 / 注入 meta 口令、不再下发 set-cookie、CSP 无 frame-ancestors (3.6293ms)
✔ buildCsp() 不含 frame-ancestors（防止有人顺手加回去） (0.2953ms)
✔ Origin: null 取静态 JS 时带 ACAO: null 与 vary: Origin (4.2886ms)
✔ Origin: null 取 CSS / vendor 也带 ACAO: null (21.7027ms)
✔ OPTIONS /api/health 带 Origin: null → 204 + CORS，且不需要 token (2.5217ms)
✔ cookie 通道已关闭：只带 cookie: mt=<正确 token> → 403 (1.8929ms)
✔ 403 的 /api/* 也带 CORS 头（否则沙箱里分不清没权限还是网络错） (3.0391ms)
✔ Origin 不合法时不回 ACAO（不向恶意页面确认「你能读」） (4.9403ms)
✔ WS 连上但什么都不发 → 500ms 后 sessions 不变（服务端不自动建会话） (518.293ms)
✔ WS 只发 pty.create 才建会话；重连只发 pty.attach 不重复建 (787.5476ms)
✔ pty.attach 不存在的 id → pty.error / SESSION_GONE (31.16ms)
✔ CSP 的 style-src 带 'unsafe-inline'，script-src 仍严格 'self' (4.0373ms)
✔ 注入的 tokens 用 html:root 选择器（否则被 tokens.css 兜底值盖掉） (2.4625ms)
✔ /api/models 未带 token → 403（与 /api/health 同一道门） (156.5673ms)
✔ /api/models 带 token → 200，label 取 magpie_label，缺省回落 id (25.8727ms)
✔ /api/models 网关 502 → 仍返回 200 + reachable:false + models:[] + default (19.2202ms)
✔ /api/models 网关连不上（端口关闭）→ 同样 200 + reachable:false (18.1569ms)
✔ 失败记忆：GATEWAY_HTTP_502 记一笔 → available:false + note；成功一次即清除 (15.1982ms)
✔ 失败记忆：不在三种错误码内的错误不记（例如 GATEWAY_TIMEOUT） (0.4862ms)
✔ 失败记忆 TTL 是 10 分钟（常量锁） (0.1518ms)
✔ GET /api/config 文件不存在 → 返回默认值（不抛错） (10.5166ms)
✔ PUT /api/config 未带 token → 403 (9.859ms)
✔ PUT /api/config 不在清单里的 model → 400 INVALID_MODEL (10.5568ms)
✔ PUT /api/config 未知字段 → 400 UNKNOWN_FIELD (7.7204ms)
ℹ tests 140
ℹ suites 0
ℹ pass 140
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9960.7976

$ echo $?
0
```

### D4. `node scripts/doctor.mjs` → 原断言数不减，全过

```
$ DOCTOR_PORT=3481 node scripts/doctor.mjs
doctor: 33/33 assertions passed
  PASS 1.health.status actual=200 expected=200
  PASS 1.health.pty actual="native" expected="native"
  PASS 1.health.nodePtyVersion actual="1.2.0-beta.15" expected="1.2.0-beta.15"
  PASS 1.health.shell actual="bash" expected="name contains bash"
  PASS 2.session.created actual="9853419e-cdf2-4684-ab75-ec70ac2bbccf" expected="uuid"
  PASS 2.session.pty actual="native" expected="native"
  PASS 2.session.cwd actual="C:\\Users\\41807" expected="string"
  PASS 3.echo.M-2 actual="M-2 present" expected="M-2 present"
  PASS 4.stty.initial actual="28 90" expected="28 90"
  PASS 4.stty.resized actual="40 132" expected="40 132"
  PASS 5.warmup.10of10 actual="10/10" expected="10/10"
  PASS 6.two.sessions actual=2 expected=2
  PASS 6.pids.collected actual=[28372,7856] expected="2 pids"
  PASS 6.pids.alive actual=2 expected=2
  PASS 6.first.closed actual=true expected=true
  PASS 6.second.works actual="SECOND-2 present" expected="SECOND-2 present"
  PASS 7.pty.exit actual="pty.exit" expected="pty.exit"
  PASS 8.orphans actual={"skippedBecause":null,"checked":2,"aliveBeforeWait":2,"orphans":[]} expected={"skippedBecause":null,"checked":2,"aliveBeforeWait":2,"orphans":[]}
  PASS D7-1.before.sessions actual=0 expected=0
  PASS D7-1c.silentSocketDoesNotCreate actual={"before":0,"after500ms":0,"createdFrames":0} expected={"before":0,"after500ms":0,"createdFrames":0}
  PASS D7-1a.clientCreateProducesOneSession actual={"sessions":1,"gotSessionCreated":true} expected={"sessions":1,"gotSessionCreated":true}
  PASS D7-1b.noDuplicateOnReconnect actual={"createdFrames":0,"sessionsBefore":1,"sessionsAfter":1} expected={"createdFrames":0,"sessionsBefore":1,"sessionsAfter":1}
  PASS D7-1.cleanup.sessions actual=0 expected=0
  PASS D7-2a.cspStyleUnsafeInline actual=true expected=true
  PASS D7-2a.cspScriptStillSelf actual=true expected=true
  PASS D7-2a.buildCspMatches actual=true expected=true
  PASS D7-2b.browserComputedValue actual={"value":"#1e1e2e","skipped":false,"reason":null} expected={"value":"#1e1e2e"}
  PASS D7-1a.browserAutoTab actual={"debugAvailable":true,"sessionCount":1,"xtermCount":1} expected={"debugAvailable":true,"sessionCount":1}
  PASS D7-3a.sessionsBuild actual={"beforeDestroy":1,"afterDestroy":1,"afterGrace":0} expected={"beforeDestroy":1,"afterDestroy":1,"afterGrace":0}
  PASS D7-3a.orphanKeptDuringGrace actual=1 expected=1
  PASS D7-3a.reclaimedAfterGrace actual=0 expected=0
  PASS D7-3b.resumeKeepsSession actual={"resumedType":"session.resumed","pty":"native","recentOutputLen":111,"before":1,"after":1} expected={"resumedType":"session.resumed","pty":"native","before":1,"after":1}
  PASS D7-3c.sessionGone actual="SESSION_GONE" expected="SESSION_GONE"
report: C:\Users\41807\magpie-terminal\doctor-report.json

$ echo $?
0
```

（断言数 **33**，与基线 HEAD 在 3482 上跑的 33 一致，没有减少。用 3481 的原因见 4.1。）

### D5. 布局量测（真浏览器 headless Chrome + CDP）

量测脚本是临时文件（不在仓库里），复用 `scripts/browser-probe.mjs` 的 `--remote-debugging-port` + `Page.navigate` + `Runtime.evaluate` 手法，额外做两件事：
1. `Emulation.setDeviceMetricsOverride` 把视口钉成 829×721 / 1024×768（CSS 视口，不是窗口尺寸）；
2. 等 `window.__termDebug().sessions[0].cols > 0` 后再等 800ms，一次 `Runtime.evaluate` 读回全部数字（rail 宽、aibar 高、terminal `clientWidth`、`scrollWidth/clientWidth`、`__termDebug()` 的 cols/rows），最后 `Page.captureScreenshot` 存 PNG。

```javascript
// 量测表达式（页面内执行，returnByValue）
(() => {
  const rail = document.querySelector('[data-role="rail"]');
  const aibar = document.querySelector('[data-role="aibar"]');
  const term = document.querySelector('[data-role="terminal-host"]');
  const xterm = document.querySelector('.terminal-pane:not([hidden]) .xterm');
  const screen = xterm && xterm.querySelector('.xterm-screen');
  const snaps = window.__termDebug ? window.__termDebug() : null;
  const doc = document.documentElement;
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    railWidth: rail ? rail.getBoundingClientRect().width : null,
    aibarHeight: aibar ? aibar.getBoundingClientRect().height : null,
    termClientWidth: term ? term.clientWidth : null,
    xtermScreenWidth: screen ? screen.getBoundingClientRect().width : null,
    aiLayerHidden: document.querySelector('[data-role="ai-layer"]').hidden,
    overflowX: doc.scrollWidth - doc.clientWidth,
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    sessions: snaps ? snaps.sessions.map(s => ({ id: s.id, cols: s.cols, rows: s.rows })) : null,
  };
})()
```

**命令与原始输出（829×721 与 1024×768 各一次）：**

```
$ node <tmp>/d5.mjs
[
  {
    "at": "829x721",
    "viewport": {
      "w": 829,
      "h": 721
    },
    "railWidth": 48,
    "aibarHeight": 44,
    "termClientWidth": 781,
    "termClientHeight": 610,
    "xtermScreenWidth": 758,
    "aiLayerHidden": true,
    "overflowX": 0,
    "scrollWidth": 829,
    "clientWidth": 829,
    "sessions": [
      {
        "id": "63c097b0-8c9a-4a4b-9bc0-6d07bab5c6c3",
        "cols": 106,
        "rows": 33
      }
    ],
    "screenshot": "C:/Users/41807/AppData/Local/Temp/v2a/d5-829x721.png"
  },
  {
    "at": "1024x768",
    "viewport": {
      "w": 1024,
      "h": 768
    },
    "railWidth": 48,
    "aibarHeight": 44,
    "termClientWidth": 976,
    "termClientHeight": 657,
    "xtermScreenWidth": 951,
    "aiLayerHidden": true,
    "overflowX": 0,
    "scrollWidth": 1024,
    "clientWidth": 1024,
    "sessions": [
      {
        "id": "0d543439-d027-4e0d-9d9b-087216e28570",
        "cols": 133,
        "rows": 35
      }
    ],
    "screenshot": "C:/Users/41807/AppData/Local/Temp/v2a/d5-1024x768.png"
  }
]

$ echo $?
0
```

**两组关键数字（照卡要求单列）：**

| 视口 | `.rail` 宽 | `.aibar` 高 | 终端 `clientWidth` | xterm `cols` × `rows` | `scrollWidth - clientWidth` |
|---|---|---|---|---|---|
| 829×721  | 48 | 44 | 781 | **106** × 33 | 0 |
| 1024×768 | 48 | 44 | 976 | **133** × 35 | 0 |

- 终端可视宽 781px ≥ 779px（卡的下限）→ 106 列 ≥ 100 列 ✅
- xterm 的 `.xterm-screen` 实测宽 758px（829 视口）：106 列 × 约 7.15px/列 = 758px，两者自洽。

**溢出扫描（卡要求 800×600 ~ 1600×900；我额外加了 380/500/600/719/720 几个窄点）：**

```
$ node <tmp>/d5b.mjs
{"vw":380,"vh":600,"overflowX":0,"scrollWidth":380,"clientWidth":380,"railWidth":48,"aibarHeight":69,"aibarBottom":513,"selectWidth":190,"inputRight":323,"termClientWidth":332}
{"vw":500,"vh":600,"overflowX":0,"scrollWidth":500,"clientWidth":500,"railWidth":48,"aibarHeight":44,"aibarBottom":549,"selectWidth":190,"inputRight":443,"termClientWidth":452}
{"vw":600,"vh":600,"overflowX":0,"scrollWidth":600,"clientWidth":600,"railWidth":48,"aibarHeight":44,"aibarBottom":549,"selectWidth":190,"inputRight":543,"termClientWidth":552}
{"vw":719,"vh":700,"overflowX":0,"scrollWidth":719,"clientWidth":719,"railWidth":48,"aibarHeight":44,"aibarBottom":649,"selectWidth":190,"inputRight":662,"termClientWidth":671}
{"vw":720,"vh":700,"overflowX":0,"scrollWidth":720,"clientWidth":720,"railWidth":48,"aibarHeight":44,"aibarBottom":649,"selectWidth":190,"inputRight":663,"termClientWidth":672}
{"vw":800,"vh":600,"overflowX":0,"scrollWidth":800,"clientWidth":800,"railWidth":48,"aibarHeight":44,"aibarBottom":549,"selectWidth":190,"inputRight":743,"termClientWidth":752}
{"vw":1024,"vh":768,"overflowX":0,"scrollWidth":1024,"clientWidth":1024,"railWidth":48,"aibarHeight":44,"aibarBottom":735,"selectWidth":190,"inputRight":967,"termClientWidth":976}
{"vw":1280,"vh":800,"overflowX":0,"scrollWidth":1280,"clientWidth":1280,"railWidth":48,"aibarHeight":44,"aibarBottom":767,"selectWidth":190,"inputRight":1223,"termClientWidth":1232}
{"vw":1600,"vh":900,"overflowX":0,"scrollWidth":1600,"clientWidth":1600,"railWidth":48,"aibarHeight":44,"aibarBottom":867,"selectWidth":190,"inputRight":1543,"termClientWidth":1552}
[all overflowX zero] true

$ echo $?
0
```

- `< 720px` 时 `.aibar` 折成两行：实测 380px 视口下 `.aibar` 高 **69px**（不是 44），44px 是最小高度（`min-height: var(--term-aibar-height)` + `flex-wrap: wrap`）。符合卡里「视口 < 720px 宽时 `.aibar` 允许折行成两行」。
- 所有视口 `overflowX === 0`。

**AI 浮层不遮 rail / aibar（真浏览器量 + 截图）：**

```
$ node <tmp>/d5c.mjs
[geo] {"rail":{"x":0,"y":0,"w":48,"h":688},"aibar":{"x":48,"y":644,"w":781,"h":44},"layer":{"x":56,"y":8,"w":765,"h":602},"card":{"x":117,"y":241,"w":596,"h":239}}
[layer 不遮 rail] true
[layer 不遮 aibar] true
[png] C:/Users/41807/AppData/Local/Temp/v2a/d5-ai-layer-829x721.png

$ echo $?
0
```

- 浮层左边界 56 = rail(48) + 8px margin；右 56+765=821 ≤ 829；上 8；下 8+602=610 ≤ 644（aibar 顶）。

### D6. 模型下拉（真浏览器 + 真网关 3425）

脚本：`startServer()` 起临时端口 → `GET /api/models` 打真实 3425 → CDP 打开页面 → 读下拉 option → 先切到 `shuaiapi/gpt-6-luna`、等 1.2s 再读 `/api/config`（证明 PUT 真落盘）→ 再切回 `commandcode/deepseek/deepseek-v4.1-flash` → 提一个真问题 → 记录 `frame.model` → 关页面 → **重新开一个页面**读下拉值（证明刷新后仍停在刚选的模型）→ `GET /api/config`。

```
$ node <tmp>/d6.mjs
[1] GET /api/models status = 200
    gateway = {"reachable":true,"durationMs":15,"baseUrl":"http://127.0.0.1:3425"}
    default = commandcode/deepseek/deepseek-v4.1-flash
    models  = 6
      - shuaiapi/gpt-6-luna  available=true  note=null  contextLength=922000  label="GPT-6 Luna · shuaiApi"
      - shuaiapihermes/gpt-6.2-sol  available=true  note=null  contextLength=1000000  label="GPT-6.2 Sol · shuaiapihermes增强用"
      - commandcode/deepseek/deepseek-v4.1-flash  available=true  note=null  contextLength=1000000  label="DeepSeek V4.1 Flash (latest) · Command Code"
      - commandcode/recursive/flint-v1.0:free  available=true  note=null  contextLength=262144  label="Flint · Command Code"
      - commandcode/stealth/glyph-cluster:free  available=true  note=null  contextLength=256000  label="Glyph Cluster · Command Code"
      - anyrouter/claude-fable-5-2  available=true  note=null  contextLength=1000000  label="claude-fable-5-2[1m] · anyrouter"
[2] 下拉 option 数量 = 6  selected = commandcode/deepseek/deepseek-v4.1-flash
      [0] shuaiapi/gpt-6-luna  |  GPT-6 Luna · shuaiApi
      [1] shuaiapihermes/gpt-6.2-sol  |  GPT-6.2 Sol · shuaiapihermes增强用
      [2] commandcode/deepseek/deepseek-v4.1-flash  |  DeepSeek V4.1 Flash (latest) · Command Code
      [3] commandcode/recursive/flint-v1.0:free  |  Flint · Command Code
      [4] commandcode/stealth/glyph-cluster:free  |  Glyph Cluster · Command Code
      [5] anyrouter/claude-fable-5-2  |  claude-fable-5-2[1m] · anyrouter
[2b] 先切到另一个模型 -> {"before":"commandcode/deepseek/deepseek-v4.1-flash","after":"shuaiapi/gpt-6-luna"}
[2c] 切换后立刻 GET /api/config（PUT 可能还在飞）=  {"model":"commandcode/deepseek/deepseek-v4.1-flash"}
[2d] 等 1.2s 后 GET /api/config = {"model":"shuaiapi/gpt-6-luna"}
[assert] 切到 gpt-6-luna 后确实落盘 -> true
[3] 切换模型 -> {"ok":true,"before":"shuaiapi/gpt-6-luna","after":"commandcode/deepseek/deepseek-v4.1-flash"}
[4] 浮层 hidden = false
    modelLines = ["模型：commandcode/deepseek/deepseek-v4.1-flash"]
    log = "已发送：看看当前目录有多少个文件只读命令，已自动执行：ls -1A | wc -l理由：统计当前目录下的条目数量（含隐藏项，不含 . 和 ..）分级命中：allow:ls模型：commandcode/deepseek/deepseek-v4.1-flash执行复制已写入当前标签：ls -1A | wc -l"
[5] PUT 后下拉值 = commandcode/deepseek/deepseek-v4.1-flash
[6] 刷新页面后下拉值 = commandcode/deepseek/deepseek-v4.1-flash
[7] GET /api/config status = 200  body = {"model":"commandcode/deepseek/deepseek-v4.1-flash"}
[RESULT] {"first":"commandcode/deepseek/deepseek-v4.1-flash","reload":"commandcode/deepseek/deepseek-v4.1-flash","target":"commandcode/deepseek/deepseek-v4.1-flash"}

$ echo $?
0
```

**`~/.config/magpie-terminal/config.json` 的真实内容（D6 跑完之后）：**

```
$ cat ~/.config/magpie-terminal/config.json
{
  "model": "commandcode/deepseek/deepseek-v4.1-flash"
}
```

**补充：快速连切 5 次（验证 PUT 串行化，见 4.2）：**

```
$ node <tmp>/d6c.mjs
[switch order] {"order":["shuaiapi/gpt-6-luna","shuaiapihermes/gpt-6.2-sol","commandcode/deepseek/deepseek-v4.1-flash","commandcode/recursive/flint-v1.0:free","commandcode/deepseek/deepseek-v4.1-flash"],"final":"commandcode/deepseek/deepseek-v4.1-flash"}
[GET /api/config] {"model":"commandcode/deepseek/deepseek-v4.1-flash"}
[assert] 落盘值 === 最后一次选择 -> true

$ echo $?
0
```

- D6 五项逐条：`/api/models` 返回 **6 个模型**（真实 id 见上）；下拉渲染 **6 个 option** ✅；选 `commandcode/deepseek/deepseek-v4.1-flash` 提新问题拿到回答（`ls -1A | wc -l`，`decision=auto`，回答头 `模型：commandcode/deepseek/deepseek-v4.1-flash`）✅；刷新页面后下拉仍停在刚选的模型 ✅；`config.json` 内容如上 ✅。

### D7. 负向 fixture（真做：gatewayBaseUrl → 必然 502 的 stub）

用现成的 `test/fixtures/fake-gateway-500.mjs`（不是真网关），`process.env.MAGPIE_TERMINAL_GATEWAY_URL = http://127.0.0.1:<stub port>`，再起 app server，CDP 打开页面读下拉。

```
$ node <tmp>/d7.mjs
[env] MAGPIE_TERMINAL_GATEWAY_URL = http://127.0.0.1:56633
[1] GET /api/models status = 200
    body = {"gateway":{"reachable":false,"durationMs":13,"baseUrl":"http://127.0.0.1:56633"},"default":"commandcode/deepseek/deepseek-v4.1-flash","models":[]}
[assert] status===200                -> true
[assert] gateway.reachable===false   -> true
[assert] models is empty array       -> true
[2] 前端下拉 optionCount = 1
    optionTexts = ["网关不可用，点重试"]
    optionValues = ["__retry__"]
    noteHidden = false  noteText = "AI 网关不可用：模型清单拉不到。点下拉重试。"
[assert] 渲染「网关不可用」文案 -> true
[assert] 不是空白下拉(>=1 option) -> true
[done] closed server + stub
[end] finished

$ echo $?
0
```

### D8. 模型失败记忆（真做：真网关 3425 + 真提一次 `anyrouter/claude-fable-5-2`）

`anyrouter/claude-fable-5-2` 在真网关上要 **约 33 秒**才吐 502（网关自己回 `anyrouter: answered 200 OK with a web page (text/html)`）。默认 `MAGPIE_TERMINAL_GATEWAY_TIMEOUT_MS=20000` 会先在 20s 取消，得到 `GATEWAY_TIMEOUT`（不在失败记忆错误码里，不记）。为了让这次真实 502 抵达应用层，这一次跑把超时提到 60s（环境变量，不改代码）。**卡的「这一次真调会花 ~34s」是准确的。**

```
$ MAGPIE_TERMINAL_GATEWAY_TIMEOUT_MS=60000 node <tmp>/d8.mjs
[0] gateway base = http://127.0.0.1:3425（真实网关）
[1] 调用前 /api/models 里该模型 = {"id":"anyrouter/claude-fable-5-2","label":"claude-fable-5-2[1m] · anyrouter","contextLength":1000000,"available":true,"note":null}
[2] 建会话 cwd = C:\Users\41807
[3] 真实请求耗时 = 34344 ms
    真实帧 = {"type":"ai.error","requestId":"d8-1","code":"GATEWAY_HTTP_502","userText":"AI 网关返回错误（HTTP 502），命令仍可手动输入。"}
[4] 调用后 /api/models 里该模型 = {"id":"anyrouter/claude-fable-5-2","label":"claude-fable-5-2[1m] · anyrouter","contextLength":1000000,"available":false,"note":"AI 网关返回错误（HTTP 502），命令仍可手动输入。（GATEWAY_HTTP_502）"}
[assert] available === false          -> true
[assert] note 非空                    -> true
[5] 全部模型的 available 快照 = [
 {
  "id": "shuaiapi/gpt-6-luna",
  "available": true
 },
 {
  "id": "shuaiapihermes/gpt-6.2-sol",
  "available": true
 },
 {
  "id": "commandcode/deepseek/deepseek-v4.1-flash",
  "available": true
 },
 {
  "id": "commandcode/recursive/flint-v1.0:free",
  "available": true
 },
 {
  "id": "commandcode/stealth/glyph-cluster:free",
  "available": true
 },
 {
  "id": "anyrouter/claude-fable-5-2",
  "available": false
 }
]

$ echo $?
0
```

**对照：不设 60s 超时（默认 20s），同一个模型：**

```
[0] gateway base = http://127.0.0.1:3425（真实网关）
[1] 调用前 /api/models 里该模型 = {"id":"anyrouter/claude-fable-5-2","label":"claude-fable-5-2[1m] · anyrouter","contextLength":1000000,"available":true,"note":null}
[2] 建会话 cwd = C:\Users\41807
[3] 真实请求耗时 = 20019 ms
    真实帧 = {"type":"ai.error","requestId":"d8-1","code":"GATEWAY_TIMEOUT","userText":"AI 网关响应超时，请稍后重试。"}
[4] 调用后 /api/models 里该模型 = {"id":"anyrouter/claude-fable-5-2","label":"claude-fable-5-2[1m] · anyrouter","contextLength":1000000,"available":true,"note":null}
[assert] available === false          -> false
[assert] note 非空                    -> false
[5] 全部模型的 available 快照 = [
 {
  "id": "shuaiapi/gpt-6-luna",
  "available": true
 },
 {
  "id": "shuaiapihermes/gpt-6.2-sol",
  "available": true
 },
 {
  "id": "commandcode/deepseek/deepseek-v4.1-flash",
  "available": true
 },
 {
  "id": "commandcode/recursive/flint-v1.0:free",
  "available": true
 },
 {
  "id": "commandcode/stealth/glyph-cluster:free",
  "available": true
 },
 {
  "id": "anyrouter/claude-fable-5-2",
  "available": true
 }
]
```

- 结论：`GATEWAY_HTTP_502` 一到，`available` 就从 `true` 变 `false`、`note` 非空；其余 5 个模型仍 `available:true`。
- 文件权限：`~/.config/magpie-terminal` 在 Windows 上 `ls -la` 显示 `drwxr-xr-x`、`config.json` 是 `-rw-r--r--`。**700/600 在 Windows 上不成立**（Windows 没有 POSIX dir/file mode 位），见 4.3。

### D9. 回归走查（真浏览器 headless Chrome，页面由真服务托管）

`d9.mjs`（靶子目录用例）：临时目录放 `a.log`、`b.log`、`keep.txt`；CDP 打开页面；终端里用 `Input.insertText` + `Input.dispatchKeyEvent`（真键盘路径，不是伪造 DOM 事件）敲 `echo D9-$((1+1))`；然后走快捷键、AI 自动执行、确认卡、Esc。

```
$ node <tmp>/d9.mjs
[0] 靶子目录 = C:\Users\41807\AppData\Local\Temp\v2a-d9-OPXYKz
[1] 自动建标签 -> {"sessions":1,"id":"a99fb28d-0a5f-4fe3-85bc-be996a90913c","cols":106}
[2] 终端回显含 D9-2 -> true
    回显行 = ["41807@devpc MINGW64 ~$41807@devpc MINGW64 ~$ echo D9-$((1+1))D9-241807@devpc MINGW64 ~$  "]
[3a] Ctrl+Shift+T 后标签数 -> 2
[3b] Ctrl+Shift+W 后标签数 -> 1
[3c] cd 后终端末段 = "41807@devpc MINGW64 ~$41807@devpc MINGW64 ~$ cd \"C:/Users/41807/AppData/Local/Temp/v2a-d9-OPXYKz\"41807@devpc MINGW64 /tmp/v2a-d9-OPXYKz$  "
[4a] 提问，使用模型 = commandcode/deepseek/deepseek-v4.1-flash
[4b] 回答 decision = auto
    回答文本 = "只读命令，已自动执行：ls -1A | wc -l理由：统计当前目录下的文件（含隐藏文件）数量分级命中：allow:ls模型：commandcode/deepseek/deepseek-v4.1-flash执行复制"
[4c] auto 执行后终端末段 = "41807@devpc MINGW64 ~$41807@devpc MINGW64 ~$ cd \"C:/Users/41807/AppData/Local/Temp/v2a-d9-OPXYKz\"41807@devpc MINGW64 /tmp/v2a-d9-OPXYKz$ ls -1A | wc -l341807@devpc MINGW64 /tmp/v2a-d9-OPXYKz$  "
[5a] 提问，使用模型 = commandcode/deepseek/deepseek-v4.1-flash
[5b] 确认卡 = {"exists":true,"command":"rm -f ./*.log","buttons":["执行","复制","取消（Esc）"],"activeIsInside":true}
[5c] Esc 前目录内容 = ["a.log","b.log","keep.txt"]
[5d] 焦点陷阱 = {"allInside":true,"seen":[true,true,true,true,true]}
[5e] Esc 后 = {"card":false,"backdrop":false,"focusRole":"TEXTAREA"}
     Esc 后目录内容 = ["a.log","b.log","keep.txt"]
[assert] Esc 关闭确认卡 -> true
[assert] 文件仍在（不点不执行） -> true
[RESULT] {
 "autoTab": {
  "sessions": 1,
  "id": "a99fb28d-0a5f-4fe3-85bc-be996a90913c",
  "cols": 106
 },
 "echo": true,
 "newTab": true,
 "closeTab": true,
 "autoDecision": "auto",
 "confirm": {
  "exists": true,
  "command": "rm -f ./*.log",
  "buttons": [
   "执行",
   "复制",
   "取消（Esc）"
  ],
  "activeIsInside": true
 },
 "focusTrap": true,
 "escClosed": true,
 "filesIntact": true
}

$ echo $?
0
```

`d9b.mjs`（标签条全量交互：`+` / `Ctrl+Shift+T` / `Ctrl+Shift+←→` / 中键关闭 / `×` / `Ctrl+Shift+W`）：

```
$ node <tmp>/d9b.mjs
[1] 初始标签数 = 1
[2] 点「+」后标签数 = 2 -> true
[3] Ctrl+Shift+T 后标签数 = 3
[4] Ctrl+Shift+→ 切换 -> true  | Ctrl+Shift+← 切回 -> true
[5] 中键关闭第二个标签 -> {"ok":true,"targetId":"142923f1-2920-4e0c-8d36-11d16cfeaeea"}  之后标签数 = 2
[6] 点 × 关闭 -> 标签数 = 1
[7] Ctrl+Shift+W 关掉最后一个 -> 标签数 = 0
[RESULT] {"arrowSwitch":true,"middleClickClose":true,"closeButton":true,"ctrlShiftW":true}

$ echo $?
0
```

`d5d.mjs`（rail 四键 + 未读圆点 + 状态栏 AI 按钮 + hosts/settings no-op）：

```
$ node <tmp>/d5d.mjs
[A] 初始 = {"aiOpen":"true","aibarDisplay":"flex","railAiPressed":"true","railAiUnread":"false","dotHidden":true,"hostsHidden":true,"settingsPresent":true}
[B] 点 rail-ai 后 = {"aiOpen":"false","aibarDisplay":"none","railAiPressed":"false","railAiUnread":"false","dotHidden":true,"hostsHidden":true,"settingsPresent":true}
[C] 再点一次 = {"aiOpen":"true","aibarDisplay":"flex","railAiPressed":"true","railAiUnread":"false","dotHidden":true,"hostsHidden":true,"settingsPresent":true}
[D] 有回复后层可见 = true
[E] 点「收起」后 = {"aiOpen":"true","aibarDisplay":"flex","railAiPressed":"true","railAiUnread":"false","dotHidden":true,"hostsHidden":true,"settingsPresent":true}
[F] 收起状态下收到回复 = {"aiOpen":"true","aibarDisplay":"flex","railAiPressed":"true","railAiUnread":"true","dotHidden":false,"hostsHidden":true,"settingsPresent":true}
[F2] 展开后圆点消失 -> true
[G] 状态栏 AI 按钮后 = {"aiOpen":"true","aibarDisplay":"flex","railAiPressed":"true","railAiUnread":"false","dotHidden":true,"hostsHidden":true,"settingsPresent":true}
[H] hosts 按钮点击 no-op 不报错 -> true
[I] settings 按钮点击 no-op -> true

$ echo $?
0
```

**D9 逐条对照（卡 §2.1「必须保留的行为」）：**

| 项 | 证据 |
|---|---|
| 打开页面自动建一个标签 | `[1] 自动建标签 -> {"sessions":1,...,"cols":106}` |
| 打字进终端，输出回显 | `[2] 终端回显含 D9-2 -> true`，回显行含 `echo D9-$((1+1))D9-2` |
| `Ctrl+Shift+T` 新建 | d9 `[3a] → 2`；d9b `[3] → 3` |
| `Ctrl+Shift+W` 关闭 | d9 `[3b] → 1`；d9b `[7] → 0` |
| 标签新建 / 关闭 | d9b `[2]` `+`→2，`[6]` `×`→1 |
| 中键关闭 | d9b `[5] 中键关闭第二个标签 -> 3→2` |
| `Ctrl+Shift+←/→` | d9b `[4] → true / 切回 true` |
| AI「看看当前目录有多少个文件」→ auto 执行 | `[4b] decision=auto`，`[4c]` 终端末段出现 `ls -1A | wc -l` 回显与结果 `3` |
| AI「删除当前目录所有 .log 文件」→ 确认卡 | `[5b] {"command":"rm -f ./*.log","buttons":["执行","复制","取消（Esc）"],"activeIsInside":true}` |
| 确认卡焦点困在内部 | `[5d] {"allInside":true,"seen":[true,true,true,true,true]}` |
| `Esc` 关闭、关闭后焦点回触发点 | `[5e] {"card":false,"backdrop":false,"focusRole":"TEXTAREA"}` |
| 不点不执行 | `[5c]` 前 `["a.log","b.log","keep.txt"]`、`[5e]` 后同 → `filesIntact: true` |
| `decision==="auto"` 才自动写 PTY | `[4b] auto` 走了「已写入当前标签」；`[5b] confirm` 只弹卡、未写 PTY（文件仍在） |
| rail 三键 | `[B]/[C]` rail-ai 来回切（`.aibar` display flex↔none）；`[H]` hosts 点击 no-op 不报错；`[I]` settings 点击 no-op |
| 未读圆点 | `[F] railAiUnread:"true", dotHidden:false`；`[F2]` 展开后圆点消失 |

> 说明：D9 原始输出里出现的 `{{SECRET_...}}` 占位符是**本工具的凭据过滤器**对 bash 提示符里用户名那一段的自动打码结果（原文是 `41807@devpc MINGW64`），不是仓库内容、也不是凭据。为保持「原样贴」，我没有改写这几行。

**没被真浏览器直接覆盖、只有协议层证据的两条（老实标注）：**

- **断线重连 `pty.attach` 认领 / `SESSION_GONE` 掉标签**：headless 下掐断真实 WS 要注入网络故障。但 `scripts/doctor.mjs` 的 `D7-1b.noDuplicateOnReconnect`、`D7-3b.resumeKeepsSession`、`D7-3c.sessionGone` 在真服务上全过（见 D4），覆盖的正是这两条协议路径；前端 `app.js` 对应分支本次未改逻辑（只把 banner 挂载点从 `#root` 改到 `main`）。
- **resize 去抖**：`app/ui/terminal-view.js` 一行未改，`constants.RESIZE_DEBOUNCE_MS` 仍 150ms；D5 里 `cols` 在 fit 后稳定 106，说明去抖管道仍通。

### D10. 密钥扫描

自写扫描器（不联网）：递归读 260 个文件（跳过 `node_modules` / `.git` / `.pi` / `.dispatch` / `vendor`），匹配 `sk-` 长串、64 位 hex 字面量、`Bearer <token>`、`password=`、`api_key=`、`"callerKeys": [`。**命中只打印 `文件:行号` + 掩码后的片段，绝不把原文写进本报告。**

```
$ node <tmp>/d10.mjs
[scan] 扫描文件数 = 260
[scan] 跳过目录 = node_modules, .git, .pi, .dispatch, vendor
[scan] 命中条数 = 147 （代码内 = 0 ，脚手架/文档 = 147 ）
  [非代码] 命中按文件统计（均为 .trellis 脚手架里的模板哈希，不是凭据）：
    .trellis/.template-hashes.json: 147
[auth.mjs] TOKEN_HEADER 行 = "export const TOKEN_HEADER = \"x-magpie-term-token\";"
[auth.mjs] TOKEN_QUERY  行 = "export const TOKEN_QUERY = \"token\";"
[auth.mjs] token 只来自 crypto.randomBytes(32) -> true | TOKEN_BYTES = 32
[VERDICT] clean（代码内 0 命中）

$ echo $?
0
```

- 代码内 **0** 命中。
- 147 条命中全部在 `.trellis/.template-hashes.json`（trellis 脚手架记录模板文件 SHA-256 的表，值不是凭据；`.trellis/` 是只读规范区，不在本卡可改范围）。
- `src/server/auth.mjs` 的凭据相关常量只有「名字」：`TOKEN_HEADER`（请求头名字）、`TOKEN_QUERY`（query 参数名）、`TOKEN_BYTES = 32`；口令本身由 `crypto.randomBytes(32)` 进程内生成、不落盘。

---

## 3. 布局量测的两组数字与截图路径

| 视口 | rail 宽 | aibar 高 | 终端 clientWidth | cols × rows | 横向溢出 |
|---|---|---|---|---|---|
| **829×721**  | 48 | 44 | 781 | **106** × 33 | 0 |
| **1024×768** | 48 | 44 | 976 | **133** × 35 | 0 |

截图（headless Chrome `Page.captureScreenshot`，PNG）：

- `C:/Users/41807/AppData/Local/Temp/v2a/d5-829x721.png` → 仓库内存档 `.dispatch/v2a-shots/d5-829x721.png`
- `C:/Users/41807/AppData/Local/Temp/v2a/d5-1024x768.png` → 仓库内存档 `.dispatch/v2a-shots/d5-1024x768.png`
- `C:/Users/41807/AppData/Local/Temp/v2a/d5-ai-layer-829x721.png`（AI 浮层 + 确认卡，证明不遮 rail / aibar）→ `.dispatch/v2a-shots/d5-ai-layer-829x721.png`

（`.dispatch/` 命中 `.gitignore` 的 `*.dispatch/`，不会入库。）

## 4. 没做到 / 打折的地方（老实写）

### 4.1 D4 用了 3481 而不是 3480

宿主 magpie 已经在 `127.0.0.1:3480` 上跑着 `magpie-bun.exe`（PID 18296，`netstat -ano` 可查），直接 `node scripts/doctor.mjs` 会 `PORT_IN_USE` 直接 fatal。所以 D4 用 `DOCTOR_PORT=3481`。doctor 的端口本来就是可配的（`DOCTOR_PORT` 环境变量是既有能力），断言内容与 3480 时完全一致；断言数 **33/33**，与基线 HEAD（在 3482 上跑）的 33/33 相同，没有减少。

### 4.2 我修掉了自己写出来的一个竞态（记录在案）

第一版 `ai-bar.js` 在 `change` 事件里直接 `void persist(value)`。实测发现：先切到 `shuaiapi/gpt-6-luna` 再立刻切回 `deepseek` 时，**两个 PUT 并发到达服务端，落盘值是「先选的那个」**（`config.json` 里留下了 `gpt-6-luna`，而 UI 停在 `deepseek`）。这不是卡里要求的行为（卡只要求「PUT 失败时保留本地选择」），但它会让「刷新后下拉停在哪」变得不可预测。修法：`ai-bar.js` 里维护一个写链 + 只写最新一次选择（`persistLatest`）。D6 的 `[2b]/[2c]/[2d]` 与 `d6c.mjs` 就是这条的回归证据。

### 4.3 文件权限 700/600 在 Windows 上只是尽力而为

`src/config/store.mjs` 确实传了 `mkdir(..., {mode: 0o700})` 与 `writeFile(..., {mode: 0o600})`，POSIX 上生效。但在 Windows 上（本次全部验收都在 Windows 上跑）`stat().mode & 0o777` **不等于** 700/600，`ls -la` 显示 `drwxr-xr-x` / `-rw-r--r--`。Windows 没有 POSIX 的 dir/file 权限位，Node 只能做近似映射。测试里因此只在非 win32 上断言 mode（`test/config/store.test.mjs`）。**这条要求在本环境下无法真实验证通过**，不假装通过。

### 4.4 `node --test` 偶发失败：基线同样偶发（不是本次引入）

在改动后的树上，`node --test` / `D:/nodejs/install/node.exe --test` 大约每 4~8 次会有 1 次以 `test/pty/session.test.mjs` 整组失败，两种形态：

- `node.exe: Assertion failed: (metadata->strong_ptr_count) > (0)` + `FATAL ERROR: v8::HandleScope::CreateHandle()` —— node-pty 原生模块在进程退出阶段崩溃；
- `#5 resize 后连敲 10 次不丢字符 timed out` —— ConPTY 满载时的偶发慢。

为了确认不是本次引入，我用 `git worktree add` 检出**未改动的基线 HEAD（8324d74）**，把 `node_modules` 用 junction 指过去，连跑 6 次 `node --test`：**6/6 全绿**；但单独连跑 `node --test test/pty/session.test.mjs` 10 次时，**bp7 那次以完全相同的 node-pty 原生断言崩溃失败**（日志在 `/tmp/v2a/bp7.out`，第 87 行的 `Assertion failed: (metadata->strong_ptr_count) > (0)`）。改动后的树同样连跑 `test/pty/session.test.mjs` 10 次挂 1 次（p3，形态是 pty 用例超时，不是崩溃）。所以这是**基线既有的偶发性不稳定**，与本卡改动无关，但确实会让「D1/D2/D3 必须 0 fail」这条变成「重跑到绿为止」。本报告贴的是最终通过那一次的真实输出；我没有改任何测试期望来让它变绿。

（临时 worktree 已删除：`git worktree prune` 后 `git worktree list` 只剩主树，`/c/tmp/v2a/baseline` 已 `rm -rf`。仓库里没有留下 `.tmp-*.mjs` 之类文件。）

### 4.5 「中键关闭」是本次补上的，不是「保留」

卡 §2.1 把「标签条：新建 / 关闭 / 切换 / **中键关闭** / 快捷键」列为「必须保留的行为（回归锁）」。但基线 HEAD 的 `app/ui/tab-bar.js` 里**根本没有中键处理**（`grep -rn 'auxclick\|button === 1\|中键' app/` 在基线上 0 命中）。所以这条不是「保留」，是「补上」——我在 `tab-bar.js` 里加了 `auxclick`（`button === 1`）关闭，并 `preventDefault` 掉中键 `mousedown` 的自动滚屏。d9b 的 `[5]` 是它的验证。**请下一张卡评审时确认：这是卡片描述与基线不符，我按卡片要求补齐了。**

### 4.6 `AI_BAD_JSON` 故意不进失败记忆

卡列出的三个错误码是 `GATEWAY_HTTP_404` / `GATEWAY_HTTP_502` / `GATEWAY_BAD_JSON`。网关返回 200 但内容无法解析时，`askGateway` 抛的是 `GATEWAY_BAD_JSON`（HTTP 体的 JSON 解析失败），这个**会**被记住。但「模型回话了、只是没给出可解析的命令」抛的是 `AI_BAD_JSON`——那是用户问得不好，不是模型不可用，记忆它会让用户问错一句就把模型标灰 10 分钟。`AI_BAD_JSON` 因此不在 `REMEMBERED_FAILURE_CODES` 里。`test/server/models.test.mjs` 的「不在三种错误码内的错误不记」锁住了这条。

### 4.7 模型可用性的真实状态（D6 当时 6 个都 available:true）

D6 那次跑出来 6 个模型全部 `available:true`，是因为可用性**不做启动探测**（卡明确要求），只靠「失败后记忆」。`anyrouter/claude-fable-5-2` 实际是坏的（D8 真调拿到 502），但它只有在**真的被调用失败之后**才会变灰。这正是卡要的语义（免得启动时 6 个模型逐个探、最坏 34 秒拖死页面），但也就意味着「第一次选到坏模型」时用户仍会等超时。

### 4.8 浮层的「关闭」语义

「收起」只藏浮层内容，不关掉 AI 输入条（`data-ai-open` 仍 `true`）——这样用户收起结果后还能直接再问一句，不用先点两次展开。要整体收起 AI（连输入条一起）点 rail 的 AI 按钮或状态栏「AI 栏」。卡里说「浮层内可滚动、可关闭」，两者都在：header 里 sticky 的「收起」按钮 + rail AI 按钮。

### 4.9 其他小打折

- `test/server/models.test.mjs` 里的 `GET /api/config` 缺失用例只断言「返回一个非空 model 字符串」，没有断言它等于 `DEFAULT_MODEL`。原因是默认值取决于真实网关的 `/v1/models` 首项或 `DEFAULT_MODEL`（`deepseek` 在清单里，所以实际是 `deepseek`），但那依赖网络。不做成硬断言是为了让单测不依赖真网关。
- `state.banner` 从 `#root` 的第一个子元素改挂到 `main` 顶部。原因：`#root` 现在是 2×2 网格，多塞一个子元素会占掉一个格。banner 的样式与文案完全没变。
- 卡要求 `.aibar`「高 44px」。在 < 720px 视口它折成两行（69px）——这是卡自己允许的例外，不是打折。

---

## 5. 下一张卡需要的接口（我留下了什么）

### 5.1 `GET /api/config` / `PUT /api/config` 的字段

```json
// GET /api/config  ->  200
{ "model": "commandcode/deepseek/deepseek-v4.1-flash" }

// PUT /api/config  <-
{ "model": "commandcode/deepseek/deepseek-v4.1-flash" }
// -> 200 { "model": "..." }
// -> 400 UNKNOWN_FIELD     （请求体里出现 KNOWN_FIELDS 之外的键）
// -> 400 INVALID_MODEL     （model 不是非空字符串，或不在 /v1/models 清单里）
// -> 502 GATEWAY_UNAVAILABLE（网关不可达，无法校验 model 是否在清单里）
// -> 500 CONFIG_WRITE_FAILED（写盘失败）
```

落盘形状（当前只有 `model`，下一张卡加 `hosts` 时**只需要**扩 `KNOWN_FIELDS`）：

```json
{ "model": "commandcode/deepseek/deepseek-v4.1-flash", "hosts": [ ... ] }
```

**加 `hosts` 的最小改法**：
1. `src/config/store.mjs`：`KNOWN_FIELDS` 加 `"hosts"`；在 `normalize()` 里给 `hosts` 做默认（`Array.isArray(next.hosts) ? next.hosts : []`）。读-改-写已经会**原样保留**未知字段，所以即使服务端还没升级、文件里已经有 `hosts`，也不会被抹掉（`test/config/store.test.mjs` 的「未知字段原样保留」锁住了这条）。
2. `src/server/http.mjs` 的 `PUT /api/config` 分支：`unknown` 过滤已经按 `KNOWN_FIELDS` 动态算，加完字段自动生效；`hosts` 自身的形状校验要新写。
3. 前端：`app/core/api.js` 的 `saveConfig()` 是通用的（传整块 patch），`ai-bar.js` 只传 `{model}`，互不影响。

### 5.2 `rail-hosts` 按钮的 id / 选择器

```html
<button type="button" data-role="rail-hosts" hidden title="主机（即将支持）">
  <span aria-hidden="true">🖧</span><span class="rail-label">主机</span>
</button>
```

- 选择器：`[data-role="rail-hosts"]`（仓库统一用 `data-role` 钩子，不用 class 当选择器）。
- 现在是 `hidden`，点击回调在 `app/ui/rail.js` 里是**空函数 + 注释**「下一张卡接管：主机面板从左侧滑出」。
- 下一张卡把 `hidden` 去掉、在 `rail.js` 的 `hosts` 点击分支里切滑出层即可；按钮已经在 DOM 里、已经在 rail 的纵向流里（位置在「终端」下面）。
- 同位置还有一个 `[data-role="rail-settings"]`（点击 no-op），主机面板的「设置」入口可以复用它。

### 5.3 `src/config/store.mjs` 的导出签名

```javascript
export const CONFIG_PATH_ENV = "MAGPIE_TERMINAL_CONFIG_PATH"; // 测试用路径覆盖
export const KNOWN_FIELDS = Object.freeze(["model"]);           // 下一张卡 += "hosts"
export const DEFAULT_CONFIG = Object.freeze({ model: null });   // 文件缺失/损坏时的值

export function configPath(): string

export async function readConfig(): Promise<{
  ok: boolean;            // false = 读不到（missing / corrupt / unreadable）
  reason: "missing" | "corrupt" | "unreadable" | null;
  config: object;         // 永远可用；未知字段原样保留
}>

export async function writeConfig(config: object): Promise<object>
// 原子写：mkdir 700 → 临时文件 mode 600 → rename；失败会清理临时文件后 rethrow

export async function updateConfig(patch: object): Promise<object>
// 读-改-写：只合并 KNOWN_FIELDS 里存在的键；未知 patch 键被忽略（不报错）
// 返回合并后的完整配置（已落盘）
```

### 5.4 模型清单 / 失败记忆的导出（下一张卡若要显示可用性会用到）

```javascript
export const MODEL_FAILURE_TTL_MS = 10 * 60 * 1000;
export const REMEMBERED_FAILURE_CODES = ["GATEWAY_HTTP_404", "GATEWAY_HTTP_502", "GATEWAY_BAD_JSON"];
export function rememberModelFailure(modelId, err)   // err: {code, userText}
export function clearModelFailure(modelId)
export function modelFailuresSnapshot(): Map<string, {note, at}>
export function resetModelFailures()                  // 仅测试
// probeGateway() 现在返回 { count, durationMs, baseUrl, models: [{id,label,contextLength,available,note}] }
```

### 5.5 前端留给下一张卡的钩子

| 钩子 | 位置 | 用途 |
|---|---|---|
| `store.setModel(id)` / `snapshot.model` | `app/core/session-store.js` | 状态栏「模型」一栏与任何新视图都能读当前模型 |
| `store.setAiOpen(bool)` / `snapshot.aiOpen` | 同上 | 主机面板若要「打开 AI 时也开着面板」之类联动 |
| `store.setAiUnread(bool)` / `snapshot.aiUnread` | 同上 | rail 小圆点的数据源；主机/其它待办也能复用同一颗圆点样式 |
| `aiLayerHasContent` + `applyAiOpen()` | `app/app.js` | 浮层可见性唯一同步点；新增浮层内容只需 `openAiLayer()` |
| `[data-role="ai-layer"]` 与 `[data-role="aibar"]` | `app/index.html` | 主机面板不要放进 `.main`（会挤终端），应做成与 `#ai-layer` 同级的覆盖层，用 `grid-column: 2; grid-row: 1` |
| `--term-rail-width` / `--term-aibar-height` / `--term-ai-layer-inset` | `app/styles/tokens.css` | 任何新滑出层的定位都从这三个变量算，不要写魔法数字 |

---

## 6. 一句话收尾

终端在 829×721 视口下现在是 **106 列 × 33 行**（终端可视宽 781px，比卡的下限 779px 多 2px，比改前的 ~64 列多 42 列）；1024×768 下是 133×35。模型下拉里**真实可用的是 6 个**——但这 6 个里有 1 个（`anyrouter/claude-fable-5-2`）一调就 502，只是在「失败后记忆」生效之前它仍显示 `available:true`，真正被调用失败一次后才会标灰并带尾注。还剩没做的：SSH / 远程主机 / 文件树与 `.hosts` 滑出层（卡明确划给下一张）、主题编辑器 / 字号 / 分屏 / 搜索框（非目标），以及 `node --test` 那条基线就有的偶发 node-pty 崩溃（需要单独一张卡处理，不在这张卡范围内）。
