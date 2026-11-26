# REPORT-V4-S — 安全返工卡（3 个 P0 + 4 个 P1 + 2 个焦点 P0）

- 状态：**待验收**（不是成品，不是已验收）
- 执行对象：HEAD `843352e`（工作区未提交改动）
- 执行时间：2026-11-24
- 执行者：子 agent（按 `TASK-V4-S.md` 逐条实现）
- 依据：`TASK-V4-S.md`（唯一权威）、`VERIFY-V4-G.md §4`、`docs/PROTOCOL-AGENT.md §5`

---

## 0. 一句话结论

9 项缺口全部按卡面修完，每项都有**改之前红、改之后绿**的测试锁住（HEAD 上跑新测试的红色结果见 `.dispatch/v4s-probe/red-on-head.txt`）。全量 `tests 610 / pass 610 / fail 0`，doctor `33/33`。**有 10 条打折项与 1 处需要人类拍板的偏差**，逐条列在第 5 节，请验收者先看那一节。

---

## 1. 逐项：改了什么文件哪几行 + 哪个测试证明了它

行号均为改动后的实际行号（`git diff` 可核对）。

### P0-1 口令外泄：根 HTML 只服务导航请求（AC1 / AC2）

| 改动 | 文件与行号 |
|---|---|
| 新增 `isNavigationRequest(req)` | `src/server/auth.mjs:72-95` |
| `checkOrigin` 上方补「放行 null 是为了 /api 与静态资源」的说明 | `src/server/auth.mjs:96-107`（注释） |
| 根路径分支加导航门（403 + 无 ACAO，日志码 `AUTH_NOT_NAVIGATION`） | `src/server/http.mjs:702-718`（门在 706，拒绝体在 716） |
| import 补 `isNavigationRequest` | `src/server/http.mjs:10` |

证明它的测试（`test/server/auth.test.mjs`，原有 32 条全部保留）：

- `N1` Origin:null + sec-fetch-mode:cors → 403、无 ACAO、body 不含口令
- `N2` 导航请求（无 Origin + navigate）→ 200 且 body 含 `<meta name="magpie-term-token" content="[0-9a-f]{64}">`
- `N3` 无任何 Sec-Fetch / Origin（curl 形态）→ 200 含口令
- `N3b` 无 Origin 但带 `sec-fetch-mode: cors`（Node fetch / doctor 形态）→ 200
- `N4` `GET /index.html` 同攻击 → 403
- `N5` 伪造 Origin → 403；`N5b` Origin:null 但无 sec-fetch-mode → 403；`N5c` no-cors + Origin:null → 403
- `N6` `/app.js` + Origin:null → 200 + `access-control-allow-origin: null`（不回归）
- `N6b` `/api/health` + Origin:null → 200 + ACAO null（不回归）
- `N7` 即使带真 token 也不给根 HTML（这道门不看 token）

真浏览器证据（`.dispatch/v4s-probe/ac2-iframe.mjs`，4/4 通过）：另起 3492 端口做「假 magpie 宿主页」，
里面用 `<iframe sandbox="allow-scripts" src="http://127.0.0.1:3491/">` 嵌我们。服务端请求日志显示：

```
GET / origin=(无) mode=navigate dest=iframe  → 200     ← 合法页面照常打开
GET / origin=http://127.0.0.1:3492 mode=cors dest=empty → 403，acao=null  ← 攻击面被堵
```

**单测输出摘要**：`test/server/auth.test.mjs` → `tests 43 / pass 43 / fail 0`（原有 32 + 新增 11）。

---

### P0-2 用户白名单必须逐段命中（AC3）

| 改动 | 文件与行号 |
|---|---|
| 新增 `splitSegments`（从 classify 原样搬出并 export，函数体逐字未改） | `src/policy/segments.mjs:1-163`（`splitSegments` 在 27） |
| `classify.mjs` 改为 import，删掉本地实现（2637 字符） | `src/policy/classify.mjs:13-15` |
| `matchAllowlist` 改成「切段 → 逐段命中同一条」 | `src/ai/allowlist.mjs:60-86` |
| 新增单段匹配 `segmentMatches` | `src/ai/allowlist.mjs:89-98` |
| import 同一份 `splitSegments` | `src/ai/allowlist.mjs:20` |

证明它的测试（`test/ai/allowlist.test.mjs`，原有 17 条全部保留）：

- `A1` `mkdir -p /tmp/x && rm -rf /tmp/victim` + `prefix("mkdir")` → `null`（**这就是 P0-2 本体**）
- `A2` `;` 变体 → `null`；`A3` `| tee` 变体 → `null`
- `A4` `mkdir a && mkdir b` → `hit === "mkdir"`（逐段都命中才放行）
- `A5` `mkdir a b` → 仍命中（不误伤）；`A6` `mkdirx` / `mkdirx a` → 仍不命中（词边界不回退）
- `A7` `npm run build && npm run test` + `exact("npm run build")` → `null`
- `A8` `ls && ls -la` → `hit === "ls"`
- `A9` 切不开（换行 / 重定向 / 命令替换 / 引号不闭合）→ 一律 `null`（fail-closed）

**单测输出摘要**：`test/ai/allowlist.test.mjs` → `tests 26 / pass 26 / fail 0`（17 + 9）。

---

### P0-3 敏感路径：内置白名单不能读密钥（AC4 / AC5 / AC13）

| 改动 | 文件与行号 |
|---|---|
| 新增敏感路径表 `SENSITIVE_DIRS` / `SENSITIVE_BASENAMES` / `SENSITIVE_SUFFIXES` / `SENSITIVE_SEQUENCES` | `src/policy/sensitive.mjs:16-72` |
| 新增 `isSensitivePath()` | `src/policy/sensitive.mjs:91-151` |
| 新增 `sensitiveReadTarget()`（judge 用的粗筛） | `src/policy/sensitive.mjs:156-175` |
| 新增 `READ_HEADS`（只含会吐文件内容的命令头） | `src/policy/classify.mjs:18-26` |
| `inspectSegment` 在命令头白名单通过后拦敏感路径 | `src/policy/classify.mjs:299-307`（拦截在 302-307） |
| judge 第 1.5 级（白名单之前） | `src/ai/judge.mjs:75-81` |

证明它的测试：

`test/policy/sensitive.test.mjs`（新增，10 条）：`S1` `.ssh/id_rsa`（含反斜杠写法）、`S2` 本插件 secrets、
`S3` `.env` / `.env.local` / `.env.production`（`.envrc` 不算）、`S4` Hermes 数据目录整棵拒、
`S5` 普通文件不误伤、`S6` 非字符串不抛、`S6b` 后缀与凭据文件名、`S6c` **AC13**（`%USERPROFILE%` / `.config/gcloud`）、
`S6d` 表冻结、`S6e` 粗筛函数。

`test/policy/classify.test.mjs`（新增 6 条）：`S7` `cat ~/.config/magpie-terminal/secrets.key` → `confirm` / `deny:sensitive-path`、
`S8` `head -c 100 /home/u/.ssh/id_rsa` → 同上、`S9` `cat .env` → 同上、`S9b` tail/grep/stat/type + `.pem` 全拦、
**`S10`（AC5 不误伤）** `cat README.md` / `grep foo src/index.mjs` / `ls -la` / `head -n 5 package.json` 仍 `auto`、
`S10b` `ls ~/.ssh` 仍 `auto`（ls 不吐文件内容，刻意不拦）。

`test/ai/judge.test.mjs`：`S11` `judge("cat secrets.key", {allowlist:[prefix("cat")], autonomy:"loose"}, 假审阅)` → `confirm` / `deny:sensitive-path` / **审阅未被调用**；
`S11b` 三个档位都 confirm 且审阅 0 次。

**单测输出摘要**：`sensitive.test.mjs` 10/10；`classify.test.mjs` 66/66（原 60 + 6）；`judge.test.mjs` 36/36。

---

### P1-1 危险目标归一化 + 补 cmd/PowerShell/chmod（AC6）

| 改动 | 文件与行号 |
|---|---|
| 新增 `normalizeDangerTarget()`（8 步归一，含 `$HOME`/`%USERPROFILE%`/`..`/`/**`） | `src/policy/forbidden.mjs:255-345`（导出在 277） |
| 危险集合按归一形态重写（`/` `/*` `~` `~/*` `*` + 盘符） | `src/policy/forbidden.mjs:247-252` |
| `isDangerousRmTarget` 改成先归一再比，并加 `..` 开头 / 纯盘符判据 | `src/policy/forbidden.mjs:347-362` |
| 新增 `isDangerousDeleteTarget`（额外把「家目录父级」算危险 → 覆盖 `del /s C:\Users`） | `src/policy/forbidden.mjs:364-380` |
| 新增 cmd 删除判定（`rd`/`rmdir`/`del`/`erase` 带 `/s`） | `src/policy/forbidden.mjs:438-448` |
| 新增 PowerShell 删除判定（`Remove-Item`/`ri`/`del`/`rmdir` 带 `-Recurse`/`-r`，大小写不敏感） | `src/policy/forbidden.mjs:450-467` |
| 新增 `chmod`/`chown` 目标为根时判危险（**不带 `-R` 也拦**） | `src/policy/forbidden.mjs:469-487` |
| `forbiddenReason` 接入三条新判定 | `src/policy/forbidden.mjs:518-521`、`522` |
| 新增 import `node:path` / `node:os` | `src/policy/forbidden.mjs:19-20` |

证明它的测试（`test/policy/forbidden.test.mjs`，原有 75 条全部保留）：

- `F1`–`F11` 表的 11 条命令逐一断言非 null（`rm -rf ~/`、`$HOME/`、`~/.`、`//`、`/**`、`/./`、`/tmp/../..`、`chmod 777 /`、`rd /s /q C:\`、`Remove-Item -Recurse -Force C:\`、`del /f /s /q C:\Users`）
- `F1a` `${HOME}/` / `~` / `/*` / `*` / `~/*` / `C:\` 变体
- **`F12`（不误伤）** `rm -rf ./build`、`rm -rf /tmp/mydir`、`chmod 777 ./x`、`chmod 777 /tmp/mydir` → `null`
- **`F13`（不回退 V3-D-FIX1）** `git commit -m reboot`、`npm run format`、`rg shutdown src/`、`grep -rn "sudo" docs/`、`echo dd`、`ls | grep halt`、`cat format.log`、`npm run remove-item` → `null`
- `F14` 归一函数直测：`"~/./"→"~"`、`"/tmp/../.."→"/"`、`"$HOME//x/.."→"~"`、`"/**"→"/*"`、`"C:\"→"c:"`、引号剥离、`null→""`

**单测输出摘要**：`test/policy/forbidden.test.mjs` → `tests 90 / pass 90 / fail 0`（75 + 15）。

---

### P1-2 `rm -rf ~/` 不许被宽松档 + 审阅自动放行（AC6）

由 P1-1 覆盖（归一后进硬禁止第 1 级，judge 在 `forbiddenReason` 就返回，走不到审阅）。

证明它的测试（`test/ai/judge.test.mjs`）：

- `P1-2`：`judge("rm -rf ~/", {autonomy:"loose", reviewModel:"x"}, 假审阅 → {risk:"caution", reversible:true})`
  → `confirm`，`reason` 以「硬性禁止」开头，**审阅调用 0 次**（修前是 `auto` + 审阅理由）
- `P1-2b`：其余 10 条 P1-1 变体 × 三个档位 = 30 次断言，全部 confirm 且审阅 0 次

---

### P1-3 切不开的命令不许交给审阅（AC7）

| 改动 | 文件与行号 |
|---|---|
| 新增 `UNREVIEWABLE_HITS` 集合 | `src/ai/judge.mjs:25-33`（集合在 31） |
| 在「内置白名单」之后、「审阅关闭/严格档」之前插入 3.5 级 | `src/ai/judge.mjs:94-102` |
| 头部注释补 1.5 与 3.5 两级 | `src/ai/judge.mjs:1-13` |

证明它的测试（`test/ai/judge.test.mjs`）：

- `J1` `"echo hi\nrm -rf /x"` + balanced + 假审阅 safe → `confirm` / `hit === "unparsable"` / **审阅 0 次**
- `J2` `"ls > out.txt"` → `hit === "redirect"` / 审阅 0 次
- `J3` `"echo $(rm -rf x)"` → `hit === "substitution"` / 审阅 0 次
- `J3b` 引号不闭合 / `&` 后台 / 反斜杠结尾 → 都 confirm 且审阅 0 次
- `J4`（正路径不回退）`npm run build` → `auto` 且**审阅调用 1 次**

**单测输出摘要**：`test/ai/judge.test.mjs` → `tests 36 / pass 36 / fail 0`（原 27 + 9）。

---

### P1-4 文件 API 用真实路径判定（AC6 的 L 组 + 下方探针）

| 改动 | 文件与行号 |
|---|---|
| 新增 `realPathOf()`（ENOENT 时返回原路径） | `src/fs/local.mjs:79-94`（导出 88） |
| 新增 `sensitiveBlockedReason()` | `src/fs/local.mjs:96-110`（导出 106） |
| 新增 `assertNoLinkHop()`（写/删用：realpath 必须等于 resolve，且顺带判敏感） | `src/fs/local.mjs:112-134`（导出用内部函数，122） |
| `listDirectory` 加真实路径敏感判定 | `src/fs/local.mjs:198-201` |
| `readTextFile` / `openDownloadStream` / `statPath` 同上 | `:261-264` / `:533-536` / `:511-514` |
| `writeFileAtomic` / `makeDirectory` / `makeFile` / `writeStreamAtomic` / `writeTextFile` 加跨链接拒绝（目标 + 父目录） | `:314-316` / `:368-370` / `:385-387` / `:551-553` / `:596-597` |
| `renamePath` 两端 + 新路径父目录 | `:431-433` |
| `removePath` 加跨链接拒绝（删链接 = 删目标内容） | `:464-478` |
| 头部注释说明真实路径策略 | `src/fs/local.mjs:1-20` |
| `src/server/routes/fs.mjs` | **未改**：`statusOf` 早有 `FORBIDDEN_PATH → 403`（`src/server/routes/fs.mjs:56-60`），`sendError` 已原样回 `userText`（`:81-92`）。卡面要求「确认即可」，已用探针实测确认（P1-4.a 等 8 条） |

证明它的测试（`test/fs/local.test.mjs`，原有 51 条全部保留）：

- `L1` 真目录 `real-secret/secrets.key` → `readTextFile` / `statPath` / `openDownloadStream` 全抛 `FORBIDDEN_PATH`
- `L2` 造 `.ssh` 同名目录 + junction → `listDirectory` 抛 `FORBIDDEN_PATH`；`L3` 经 junction 读 `known_hosts` 同上
- **`L2-real`（卡面原文形态）** junction → **真 `~/.ssh`** → `listDirectory` 抛 `FORBIDDEN_PATH`（本机有 `.ssh`，未 skip）
- `L4` junction → 普通目录 → 正常列（不误伤）；`L5` `removePath(link,{recursive:true})` → `FORBIDDEN_PATH`，且目标文件仍存活
- `L6`（不误伤）普通 `removePath` / `writeTextFile` / `makeFile` / `writeFileAtomic` / `listDirectory` 全成功
- `L7` 经 junction 的 `writeTextFile` / `makeFile` / `makeDirectory` / `renamePath` 全拒，且目标目录里确实什么都没写进去

**junction 建不出来时用 `t.skip()` 并 `return`**（L2/L7 都有这条分支），**没有把 skip 写成 pass**。本机实测 junction 可建，三条 junction 用例都真跑到了（`skipped 0`）。

HTTP 层真路由探针（`.dispatch/v4s-probe/p1-4-fs.mjs`，8/8）：`/api/fs/read` 直接读 `secrets.key` → 403 `FORBIDDEN_PATH`；
**经 junction 列敏感目录 → 403**；**经 junction 读敏感文件 → 403**；普通 junction 照常列 200；
**经 junction 删除 → 403，目标内容仍存活**；普通写读正常 200；删盘根仍 403。

真 `~/.ssh` 探针（`.dispatch/v4s-probe/p1-4-real-ssh.mjs`，5/5）：junction → 真 `~/.ssh`，列目录 / 读 `authorized_keys` / 递归删 全部 `FORBIDDEN_PATH`，用户 `~/.ssh` 内容 4 条完好。

**单测输出摘要**：`test/fs/local.test.mjs` → `tests 58 / pass 58 / fail 0`（51 + 7）。

---

### 焦点 P0-a：设置页焦点时序（AC8）

| 改动 | 文件与行号 |
|---|---|
| 新增 `INERT_SELECTORS` + `setBackgroundInert()` | `app/ui/settings-panel.js:469-486` |
| `open()` 打开即 inert，焦点等 `load()` 完成后进模态 | `app/ui/settings-panel.js:488-513` |
| `closeModal()` 先解 inert 再还原焦点 | `app/ui/settings-panel.js:519-535`（解 inert 在 528） |

证明它的是真浏览器探针（前端行为，卡面 §6.8 明确「单测留空」）：
`.dispatch/v4s-probe/ac8-ac9-focus.mjs` 的 `AC8.0` / `AC8.a`–`AC8.d`，全部 PASS（见第 3 节原始输出）。

---

### 焦点 P0-b：收起抽屉必须真的不可交互（AC9）

| 改动 | 文件与行号 |
|---|---|
| 抽屉基础规则补 `visibility: visible` + 双属性 transition | `app/styles/layout.css:57-81`（visibility 在 76、transition 在 78） |
| 新增 `[data-ai-open="false"]` 规则：`visibility: hidden` + 延迟 0.18s | `app/styles/layout.css:83-87` |
| `[data-ai-open="true"]` 规则补 `visibility: visible` | `app/styles/layout.css:89-93` |
| `applyAiOpen()` 加 inert / aria-hidden / 焦点挪出抽屉 | `app/app.js:516-553` |
| 启动末尾调一次 `applyAiOpen(store.getSnapshot().aiOpen)` | `app/app.js:578`（原有调用，`init()` 第一行） |

> 卡面 §4 写的是 `app/styles/components.css`，但 §6.9 与实测行号都在 `app/styles/layout.css`（`:55-72` 与 `:77`）。
> **我按 §6.9 的实测行号改了 `layout.css`**，`components.css` 里没有任何 `ai-drawer` 规则（已 grep 确认）。

证明它的是真浏览器探针：`AC9.a`–`AC9.d`，全部 PASS。

---

## 2. 全量测试与 doctor 原始数字

### 全量测试（裸跑，cwd = 仓库根，不带任何路径参数）

```
命令：timeout 240 D:/nodejs/install/node.exe --test
输出：.dispatch/v4s-probe/full-test-final3.txt（连续三次 `fail 0`；final / final2 为同值）
```

```
ℹ tests 610
ℹ suites 0
ℹ pass 610
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 18384.547
RC=0
```

> 中途第一次全量跑出 `tests 609 / pass 607 / fail 2`，唯一失败是**已知基线 flaky**
> `test/ssh/registry.test.mjs` 的「建连后立刻 close」；重跑一次即 `pass 609 / fail 0`。
> 按卡面 §9.2「只跑两次、不追」处理，未做第三次。两份原始输出都在
> `.dispatch/v4s-probe/full-test-1.txt`（fail 2）与 `full-test-2.txt`（fail 0）。

单文件逐个数字（每项都是最终代码上重跑）：

| 文件 | tests | pass | fail |
|---|---|---|---|
| `test/policy/classify.test.mjs` | 66 | 66 | 0 |
| `test/policy/forbidden.test.mjs` | 90 | 90 | 0 |
| `test/policy/sensitive.test.mjs`（新增） | 10 | 10 | 0 |
| `test/ai/allowlist.test.mjs` | 26 | 26 | 0 |
| `test/ai/judge.test.mjs` | 36 | 36 | 0 |
| `test/server/auth.test.mjs` | 43 | 43 | 0 |
| `test/fs/local.test.mjs` | 58 | 58 | 0 |

### doctor

```
命令：DOCTOR_PORT=3485 timeout 200 D:/nodejs/install/node.exe scripts/doctor.mjs
输出：.dispatch/v4s-probe/doctor-final3.txt（四次均为 33/33）
首行：doctor: 33/33 assertions passed
PASS 行数：33    FAIL 行数：0
doctor-report.json: passed=true, assertions=33, fail=0
RC=0
```

### 改之前是红的（红→绿证据）

`git worktree` 在 HEAD `843352e` 上跑同一批**新**测试文件（输出 `.dispatch/v4s-probe/red-on-head.txt`）：

| 测试文件 | HEAD 上 | 现在 |
|---|---|---|
| `test/ai/allowlist.test.mjs` | 22 pass / **4 fail**（A1 A2 A3 A9） | 26 / 0 |
| `test/policy/forbidden.test.mjs` | **加载失败**（没有 `normalizeDangerTarget` 导出） | 90 / 0 |
| `test/policy/classify.test.mjs` | 62 pass / **4 fail**（S7 S8 S9 S9b） | 66 / 0 |
| `test/ai/judge.test.mjs` | 28 pass / **8 fail**（S11 S11b J1 J2 J3 J3b P1-2 P1-2b） | 36 / 0 |
| `test/server/auth.test.mjs` | 38 pass / **5 fail**（N1 N4 N5b N5c N7） | 43 / 0 |
| `test/fs/local.test.mjs` | **加载失败**（没有 `realPathOf` 导出） | 58 / 0 |
| `test/policy/sensitive.test.mjs` | **文件不存在**（模块缺失） | 10 / 0 |

---

## 3. 真浏览器探针结果（AC8 对照组 / AC9 / AC12）

环境：headless Chrome + CDP，`http://127.0.0.1:3491/`（**独立服务，从未碰 3480 宿主**，收尾已 kill）。
探针本体与原始输出全部在 `.dispatch/v4s-probe/`。

### `ac8-ac9-focus.mjs` → 14/14 PASS（`out-ac8-ac9-focus.txt`）

```
PASS AC12.a 终端已渲染 :: {"xterm":true,"textarea":true,"sessions":1}
PASS AC8.0 对照组：焦点在终端时命令真执行（文件生成） :: {"ctrlFocus":"xterm-helper-textarea","exists":true}
PASS AC8.a 设置页打开后焦点在模态内 :: {"activeTag":"BUTTON","activeClass":"autonomy-card","activeRole":"autonomy-option","activeInBackdrop":true,"activeInModal":true}
PASS AC8.b 三个后台容器都被 inert，且 settings-host 没有被 inert :: {"inert":{"rail":true,"main":true,"status":true},"settingsHostInert":false}
PASS AC8.c 设置页打开时敲命令**不生成文件**（焦点说明有效） :: {"cmd":"echo ok > \"C:/Users/41807/SETTINGS_LEAK_….txt\"","exists":false}
PASS AC8.d 关闭设置页后 inert 全部移除 :: {"railInert":false,"mainInert":false,"statusInert":false}
PASS AC9.a 收起态：inert + aria-hidden + computed visibility:hidden :: {"aiOpen":"false","drawerInert":true,"drawerAriaHidden":"true","drawerVisibility":"hidden"}
PASS AC9.b 收起态打字 20 字符后输入框 value 仍为空 :: {"focusAttempt":{"focused":false},"afterType":{"value":"","len":0}}
PASS AC9.c 对照组：展开后能看到、能聚焦、能打字 :: {"drawerOpen":{"aiOpen":"true","drawerInert":false,"ariaHidden":null,"visibility":"visible","focused":true},"openValue":"OPEN_OK"}
PASS AC9.d 再收起：又变 inert + hidden，且焦点被挪出抽屉 :: {"inert":true,"visibility":"hidden","activeInDrawer":false}
PASS AC12.b 文件面板能列出目录 :: {"path":"C:\\Users\\41807","entryCount":142,"panelVisible":true}
PASS AC12.c 新建标签（+ → 本地终端） :: {"tabsBefore":1,"tabsAfter":2,"menuOpen":"clicked","picked":"clicked-local"}
PASS AC12.e 终端有回显 :: {"echoed":true}
PASS AC12.d /api/hosts 可用（远程 SSH 面板的前提） :: {"status":200,...}
SUMMARY fail=0 total=14
```

**AC8 对照组是真的**：先在终端里敲 `echo ok > C:/Users/41807/CTRL_GROUP_<ts>.txt` → 文件**真生成**（`exists:true`）；
再打开设置页敲同一形态的命令 → 文件**没生成**（`exists:false`）。对照组文件收尾时已删除，没在你家目录留垃圾。

截图（1280×760）：`shot-ac8-settings.png`（设置页，焦点环在「平衡（默认）」卡片上）、
`shot-ac9-drawer-closed.png`、`shot-ac9-drawer-open.png`（抽屉展开、`OPEN_OK` 在输入框里）、
`shot-ac12-files.png`、`shot-ac12-terminal.png`。

### 其它探针（全部 PASS）

| 探针 | 结果 | 原始输出 |
|---|---|---|
| `ac1-token-leak.mjs` | 10/10 | `out-ac1-token-leak.txt` |
| `ac2-iframe.mjs` | 4/4 | `out-ac2-iframe.txt`（含完整请求头日志） |
| `policy-e2e.mjs`（P0-2/P0-3/P1-1/P1-2/P1-3/AC5，33 条） | 33/33 | `out-policy-e2e.txt` |
| `p1-4-fs.mjs`（HTTP 层真路由） | 8/8 | `out-p1-4-fs.txt` |
| `p1-4-real-ssh.mjs`（真 `~/.ssh`） | 5/5 | `out-p1-4-real-ssh.txt` |

---

## 4. 逐条 AC 判定（自查）

| AC | 判定 | 依据 |
|---|---|---|
| AC1 | **PASS** | N1/N4/N5/N5b/N5c/N7 + `ac1-token-leak.mjs` AC1.a–AC1.f + `ac2-iframe.mjs` AC2.iframe.d（真浏览器 Origin=3492 → 403 无 ACAO） |
| AC2 | **PASS** | N2/N3/N3b/N6/N6b + 原 32 条 auth 测试全绿 + `ac2-iframe.mjs` AC2.iframe.b（真跨站 sandbox iframe 导航 200、全部静态资源加载成功） |
| AC3 | **PASS** | A1–A9 |
| AC4 | **PASS** | S7–S11 |
| AC5 | **PASS** | S10 / S10b / AC5.a–e |
| AC6 | **PASS** | F1–F14 + P1-2 + P1-2b + P1-4 的 L1–L7 |
| AC7 | **PASS** | J1–J3b + J4（正路径不回退） |
| AC8 | **PASS** | AC8.0 / AC8.a–d（带真对照组） |
| AC9 | **PASS** | AC9.a–d（带「展开后仍能用」的对照组） |
| AC10 | **PASS** | `tests 610 / pass 610 / fail 0`（裸跑，RC=0） |
| AC11 | **PASS** | doctor 33/33，`passed=true` |
| AC12 | **PASS（有折扣）** | 终端回显 / 文件面板 142 条 / 新建标签 1→2 / `/api/hosts` 200。**折扣**：远程 SSH 只验证到「主机列表 API 可用」，没有真连一台主机做完整走查（见 §5-8） |
| AC13 | **PASS** | `S6c`（`%USERPROFILE%/.aws/credentials`、`.config/gcloud/...`） |
| 焦点 P0-a | **PASS** | AC8.a–c |
| 焦点 P0-b | **PASS** | AC9.a–d |

---

## 5. 打折项（做到了但打了折扣的地方，如实列）

1. **`isNavigationRequest` 的判据比卡面 §6.1 的示例代码宽一点。⚠️ 这是本卡唯一需要验收者拍板的偏差。**
   卡面写「有 `sec-fetch-mode` 就只看它是不是 navigate，否则 curl/Node fetch 两者都没有」。
   **实测 Node 24 的全局 `fetch` 会自带 `sec-fetch-mode: cors`**（无 `Origin`、无 `sec-fetch-dest`）。
   我**真的把卡面代码逐字贴上去跑了一遍**（脚本与输出：`.dispatch/v4s-probe/verbatim-gate-breaks.txt`）：

   ```
   逐字照搬卡面 §6.1 的 isNavigationRequest：
   ✖ 根路径 / 注入 meta 口令、不再下发 set-cookie、CSP 无 frame-ancestors
   ✖ CSP 的 style-src 带 'unsafe-inline'，script-src 仍严格 'self'
   ✖ 注入的 tokens 用 html:root 选择器（否则被 tokens.css 兜底值盖掉）
   ✖ N3b：无 Origin 但带 sec-fetch-mode: cors（Node fetch / doctor 形态）→ 200
   ℹ tests 43 / pass 39 / fail 4
   ```

   也就是说：**§6.1 的示例代码与 AC2「现有 32 条 auth 测试全绿」互相矛盾**，两者不能同时成立。
   我选择保 AC2，把实现改成：`navigate` → 放行；其它 mode **且带 Origin** → 拒；其它 mode 且**不带 Origin** → 放行；
   无 mode 时看 Origin。
   安全性**没有降低**：浏览器发跨源脚本请求**一定**带 `Origin`（实测沙箱 fetch 是 `Origin: null`），
   且真浏览器探针 `ac2-iframe.mjs` 实测「跨站 sandbox iframe 导航 200、宿主页脚本 cors fetch 403 无 ACAO」。
   实现与理由写在 `src/server/auth.mjs:59-95`，测试 `N3b` 专门锁这个行为。
   **如果验收者坚持逐字照搬卡面，则必须同时授权改那 3 条老测试（给它们补 `Sec-Fetch-Mode: navigate`），
   否则 AC2 必红。这一条请人类拍板。**

2. **后台容器用 `inert` 的是 `rail` / `main` / `statusbar` 三个容器，不是「`#root` 里除设置挂载点之外的全部」。**
   卡面 §6.8 说「给 `nav.rail`、`section.main`、`[data-role="statusbar"]` 三个容器各设 inert」——与卡面一致。
   **但 `[data-role="toast-stack"]` 没有设 inert**（它不在卡面清单里）：设置页打开时 toast 仍可被点。
   toast 里唯一的可交互元素是「去确认」（会打开抽屉），影响很小，但确实是个漏口，留给验收者定。

3. **抽屉收起时「打字打到别处」的行为变了，但没有被完全关死。**
   收起后 `agent-input` 拿不到焦点（AC9.b 通过、`value` 为空），但**这 20 个字符会落到当前真正持有焦点的元素上**——
   探针里焦点在终端，于是字符真的出现了终端里（`shot-ac9-drawer-closed.png` 能看到 `HIDDEN_TYPED_1234567`）。
   这是**正确方向**（用户在终端里看得见自己打的字，回车会执行一条看得见的命令，而不是发进看不见的抽屉），
   但严格说「用户以为在跟 AI 说话、实际写进了 shell」这一类**语义混淆**没有被消除，只是从「不可见」变成「可见」。
   要彻底解决需要 UI 层区分「抽屉收起时焦点应在哪」，超出本卡范围。

4. **`READ_HEADS` 里保留了 `where` / `which`（卡面原文如此），但它们本来不吐文件内容。**
   `where C:/x/.ssh/id_rsa` 现在会要求确认。偏保守，不会误伤日常（`where node` 照旧 auto），但严格说是多拦了一类。

5. **`/api/fs` 的写操作里，`snapshot` / `MKCOL` 这类「挂在父目录上」的检查是对 `path.dirname(target)` 做的。**
   理论上还有一个更深的泄漏面：路径里**间接**经过的中间目录是链接时（`a/link/b/c.txt` 里 `a/link` 是链接），
   `realpath` 会把整条链展开，所以只有**最末一级或父目录本身**是链接时比较才不等 —— 实测 `L7` 的四种写法都被拒了，
   但「多层嵌套、只有中间层是链接」这种我**没有**专门造用例验证。风险低（Windows 上 junction 嵌套不常见），但如实列出。

6. **`forbidden.mjs` 里现在有两个同名函数 `splitSegments`**（新加的是 `segments.mjs` 导出的那份，
   `forbidden.mjs` 里那个是它自己的、输入是 token 数组的私有版本）。卡面 §5 要求「切段逻辑只许有一份」，
   我理解它约束的是 `classify ↔ ai/allowlist` 这条链（已共用 `segments.mjs`）；`forbidden.mjs`
   那个私有版本输入形状不同（token 数组 → 段，且预置了 `2>&1` 例外），合并会让 forbidden 的用例受力面变大，
   **所以没有合并**。这是有意的取舍，不是漏了。

7. **`del /s C:\Users` 的危险性靠「家目录父级」判据兜住，用的是运行时的 `os.homedir()`。**
   也就是说：如果你把家目录挪到别处，`C:\Users` 这个**具体的**字面量就不在判定里了
   （`C:\Users` 只是恰好等于本机家目录的父级）。我没有把 `c:/users` 写死进危险集合 ——
   写死会在 Linux/macOS 上产生无意义条目，但也就意味着「在另一台机器上删别人的 `C:\Users`」不会被本卡拦住。
   卡面 F11 的语义是「删家目录父级」，我按语义实现。

8. **AC12 的「远程 SSH」只验证到 API 可用，没有真连主机做完整文件面板走查。**
   探针只确认 `/api/hosts` 返回 200 且 `hasSecret` 字段在（`shot` 里也能看到主机存在）。
   真正的 SSH 文件面板（列目录 / 上传 / 下载 / 删除）**本轮没有重跑**，因为 P1-4 的改动只碰本地
   `src/fs/local.mjs`，`src/ssh/fs.mjs` 一行未改，SSH 链路不受影响（`test/ssh/*` 在全量里 pass）。
   要 100% 确认，验收者需要自己连一台主机点一遍。

9. **doctor 的 `D7-2b.browserComputedValue` 等 5 条浏览器断言是在 3485 端口起的临时服务上跑的**，
   它们验证的是「CSS/JS 在真浏览器里的计算值」，**不覆盖**我改的两处前端行为（设置页 inert、抽屉 visibility）。
   那两处由 `ac8-ac9-focus.mjs` 覆盖，其证据强度介于「单测」与「主 agent 亲跑」之间 —— 我用的是 headless Chrome
   （`--headless=new`），不是 magpie 的 WebView2 宿主。

10. **N2 的「真导航」是用原始 socket 伪造请求头模拟的**，不是在真 magpie 窗口里点的。
    真宿主验证需要主 agent 按卡面 §13 风险 2 亲自做（开 magpie 窗口看插件页能不能打开）。
    我能给的最强旁证是 `ac2-iframe.mjs`：真 Chrome 发的跨站 sandbox iframe 导航（`mode=navigate dest=iframe`）→ 200。

---

## 6. 未执行清单

| 项 | 为什么没做 | 影响 |
|---|---|---|
| 真 magpie 宿主窗口里点开插件页 | 我起不了宿主（3480 是你在用的，禁止碰） | AC2 的「真宿主」那半只能由主 agent 复核；我用 `ac2-iframe.mjs` 的跨站 sandbox iframe 做替代证据 |
| 真远程 SSH 主机上走查文件面板 | 卡面 §10 AC12 要求「无回归」，而 P1-4 只动本地 `fs/local.mjs`；`src/ssh/fs.mjs` 未改，`test/ssh/*` 全量 pass | 低。但若验收者要 100%，需自连一台 |
| 多层嵌套链接（只有中间层是 junction）的用例 | 见 §5-5 | 低 |
| 在旧 WebView2 上验 `inert` 不支持时的降级 | 我没有旧内核可用 | CSS `visibility: hidden` 是兜底，但**未在旧内核上实测** |
| 全量测试跑第三次以「确认 flaky」 | 卡面 §9.2 禁止追 flaky、限两次 | 无 |

---

## 7. 改了哪些文件（与卡面 §4 的对照）

**新增 4 个**（全部按卡面）：`src/policy/segments.mjs`、`src/policy/sensitive.mjs`、
`test/policy/segments.test.mjs`**（没建，见下）**、`test/policy/sensitive.test.mjs`。

> **偏差**：卡面 §4 要求新增 `test/policy/segments.test.mjs`，**我没有单独建它**。
> 理由：`splitSegments` 的函数体逐字搬用、未改一行，它的行为已经被
> `test/policy/classify.test.mjs` 的 60 条原有用例（第 2 步跑过 60/60）与 `test/ai/allowlist.test.mjs` 的 A9 全覆盖。
> 单开一个文件只会重复断言。**这是缩小范围，如实列出，请验收者定是否需要补。**

**改动 11 个**：`src/policy/classify.mjs`、`src/ai/allowlist.mjs`、`src/ai/judge.mjs`、`src/policy/forbidden.mjs`、
`src/server/auth.mjs`、`src/server/http.mjs`、`src/fs/local.mjs`、`app/ui/settings-panel.js`、`app/app.js`、
`app/styles/layout.css`。

> 卡面 §4 还列了 `src/server/routes/fs.mjs` 与 `app/styles/components.css`：**两个都没改**。
> 前者 `statusOf` 早有 `FORBIDDEN_PATH → 403`、`sendError` 早已原样回 `userText`（卡面也写「确认即可」），
> 已用 `p1-4-fs.mjs` 8 条 HTTP 实测确认；后者没有 `ai-drawer` 规则，抽屉规则在 `layout.css`。

**改动测试 6 个**（与卡面一致）+ 新增 1 个：`test/server/auth.test.mjs`、`test/ai/allowlist.test.mjs`、
`test/ai/judge.test.mjs`、`test/policy/forbidden.test.mjs`、`test/policy/classify.test.mjs`、`test/fs/local.test.mjs`、
新增 `test/policy/sensitive.test.mjs`。

**没碰**：`docs/mockups-v4/`、`app/vendor/`、`package.json`、`package-lock.json`、`scripts/`、端口 3480 上的宿主。
`git status` 只有上面这些 + 卡面自己（`TASK-V4-S.md` 未跟踪）。**没有 commit，没有 push。**

---

## 8. 交付物清单

代码改动：见 §7。

`.dispatch/v4s-probe/`：

| 文件 | 内容 |
|---|---|
| `server-3491.mjs` | 独立探针服务（3491），带请求头日志 |
| `ac1-token-leak.mjs` / `out-ac1-token-leak.txt` / `ac1-token-leak.json` | AC1/AC2 的原始 socket 复现 |
| `ac2-iframe.mjs` / `out-ac2-iframe.txt` / `ac2-iframe.json` | 跨站 sandbox iframe 真浏览器验证 + 完整请求头日志 |
| `ac8-ac9-focus.mjs` / `out-ac8-ac9-focus.txt` / `ac8-ac9-focus.json` | AC8/AC9/AC12 真浏览器探针（带对照组） |
| `p1-4-fs.mjs` / `out-p1-4-fs.txt` / `p1-4-fs.json` | P1-4 的 HTTP 层真路由复现 |
| `p1-4-real-ssh.mjs` / `out-p1-4-real-ssh.txt` / `p1-4-real-ssh.json` | P1-4 对真 `~/.ssh` 的强验证 |
| `policy-e2e.mjs` / `out-policy-e2e.txt` / `policy-e2e.json` | P0-2/P0-3/P1-1/P1-2/P1-3/AC5 的 33 条生产形态复现 |
| `full-test-1.txt` / `full-test-2.txt` / `full-test-final.txt` / `full-test-final2.txt` / `full-test-final3.txt` | 五次全量原始输出（前两次含基线 flaky） |
| `doctor-1.txt` / `doctor-final.txt` / `doctor-final2.txt` / `doctor-final3.txt` | doctor 原始输出（全部 33/33） |
| `red-on-head.txt` | HEAD 上跑新测试的红色结果（红→绿证据） |
| `verbatim-gate-breaks.txt` | 把卡面 §6.1 代码逐字贴上去的实测红结果（§5-1 的证据） |
| `requests-3491.jsonl` | 探针服务收过的全部请求头 + 状态码 |
| `shot-*.png`（5 张） | 真浏览器截图 |

所有探针脚本都以 `process.exit(0)` 结尾（常驻服务 `server-3491.mjs` 除外，它由后台进程管理、收尾已 kill）。
探针服务全程只用 3491/3492/3485 端口，**3480 上的宿主一次都没连过**（收尾 `netstat` 确认它仍在 LISTENING）。

---

## 9. 白话总结（≤200 字）

有人能给你的终端使坏，这次把九个口子全堵上了。

第一个最要命：任何网页都能偷偷读到你家门的钥匙（口令），拿到就能在你电脑上执行任意命令。现在只有你亲手打开页面才给钥匙。

第二个：你写了"mkdir 免确认"，坏人就能写成"mkdir 删光你的文件"骗过去。现在必须整条命令每一段都白名单里才行。

第三个：查看文件的命令（cat 之类）能直接读走你的密钥、密码文件。现在碰到密钥目录一定先问你。

另外：删家目录的各种花式写法都拦住了；看不懂的命令不再交给 AI 猜；文件面板不能绕道链接偷看密钥目录。

还有两个烦人毛病：打开设置页打字会跑进终端，收起 AI 面板后打字会进看不见的框——都修好了。

全部 610 个自动检查通过，医生的 33 项体检也全过。**改动待验收，不是成品。**
