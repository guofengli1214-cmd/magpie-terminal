# VERIFY-V4-S — 安全返工卡独立验收（主 agent 亲跑）

**被验对象**：工作区 uncommitted 改动（相对 HEAD `843352e`）—— 16 M + 5 未跟踪，`git diff --stat` = +1203/−150。
**执行者自述**：`REPORT-V4-S.md`（标「待验收」，声称 9 项缺口全修、610/610、doctor 33/33）。
**验收人**：主 agent（本报告全部数字均为亲自复跑，原始日志在 `.dispatch/`）。

## 1. 结论

**有条件通过（安全必过项全部成立；AC10「全量 fail 0」未复现，失败单条为既有 flaky 且与卡 S 零关联）。**
- 3 个 P0 + 4 个 P1 + 2 个焦点穿透 P0 均已真实堵住，且每项都有「改前红/改后绿」的实测证据。
- 唯一未守住的缺口在测试基础设施（`test/ssh/registry.test.mjs`），不是产品缺陷；解除条件见 §6。
- 待人类拍板 1 项：`isNavigationRequest` 判据比卡面示例宽（§5 #1），实测证明逐字照搬会把合法请求全 403。

## 2. AC 逐条结果

| AC | 结果 | 主 agent 实测证据 |
|---|---|---|
| AC1 Origin:null + cors → 403 且无 ACAO、body 不含口令 | **PASS** | 真宿主 3480：`curl -H "Origin: null" -H "Sec-Fetch-Mode: cors" /` → **403**，body 仅 20 字节 `{"code":"FORBIDDEN"}`，无 `access-control-allow-origin`。探针 `ac1-token-leak.mjs` **10/10 PASS**（含 64 位 token 不再出现在无 Origin 响应里） |
| AC2 导航/curl 200，现有 auth 全绿 | **PASS** | 真宿主 3480：`curl -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Dest: iframe" /` → **200** / `content-length: 4317` / body 含 `<meta name="magpie-term-token" content="7d70dfad…08d6">`（64 位）。`ac2-iframe.mjs` **4/4 PASS**（跨站 sandbox iframe 导航 200；宿主页脚本 cors fetch `TypeError: Failed to fetch`）。`test/server/auth.test.mjs` 全绿 |
| AC3 `&&`/`;`/`\| tee` 不命中白名单，`mkdir a b`、`mkdir a && mkdir b` 仍命中 | **PASS** | `my-s-ac3.mjs` **7/7 PASS**；`mkdirx` 不命中 |
| AC4 `cat secrets.key` / `head -c 100 id_rsa` / `cat .env` → confirm | **PASS** | `my-s-classify.mjs`：`cat ~/.ssh/id_rsa`、`cat .env`、`head -c 100 /home/u/.ssh/id_rsa`、`cat ~/.config/magpie-terminal/secrets.key` 全 **confirm** `deny:sensitive-path` |
| AC5 `cat README.md` / `grep` / `ls -la` 仍 auto | **PASS** | 同上探针：`cat README.md`、`grep foo src/index.mjs`、`ls -la`、`where node` 全 **auto** |
| AC6 11 条危险删除全 forbiddenReason≠null；12 条正常全 null；`rm -rf ~/` 宽松档+假审阅 caution 仍 confirm | **PASS** | `my-s-ac6b.mjs` **11/11 PASS**（`rm -rf ~/`、`$HOME/`、`~/.`、`//`、`/**`、`/./`、`/tmp/../..`、`chmod 777 /`、`rd /s /q C:\`、`Remove-Item -Recurse -Force C:\`、`del /f /s /q C:\Users`）；正常 12 条全 null；宽松档 + 假审阅 caution 仍 confirm |
| AC7 `echo hi\nrm -rf /x` / `ls > out.txt` / `echo $(rm -rf x)` 在 balanced+假审阅 safe 下仍 confirm | **PASS** | `my-judge-real2.mjs`（真实配置、balanced）：多行 → confirm `hit:unparsable`；`ls > out.txt` → confirm `hit:redirect`；`echo $(rm -rf x)` → confirm |
| AC8 设置页键盘焦点不穿透（带对照组） | **PASS** | `ac8-ac9-focus.mjs` **14/14 PASS**：AC8.0 对照组文件真生成、AC8.a 焦点在 `autonomy-option`、AC8.b rail/main/statusbar 三容器 inert、AC8.c 敲 `echo ok > ~/SETTINGS_LEAK_*.txt` 不再生成文件、AC8.d 关闭后 inert 全移除 |
| AC9 抽屉收起 inert + aria-hidden + visibility:hidden 且打字 value 为空 | **PASS** | 同上：AC9.a/b/c/d 全 PASS（收起后打字 value 保持空；展开后能聚焦能打字；再收起焦点被挪出） |
| AC10 全量 fail 0 | **部分达标** | 4 轮 `node --test`：`my-v4s-full-1.txt` **610/610**、`my-v4s-full-2.txt` **608/610**、`my-v4s-final-test.txt` **608/610**、`my-v4s-final-test2.txt` **608/610**。失败恒为同一条 `test/ssh/registry.test.mjs:297`「建连后立刻 close」（断言 `:318` `AssertionError: false !== true`，测试体用固定 `setTimeout 30/50` 造时序）。单跑该文件 3 次 **17/17 全绿**（`my-reg-1..3.txt`），`git status` 无任何 ssh/ 改动，该文件最后改动 `aad9ea3`。→ 并行负载下时序 flaky，非卡 S 引入 |
| AC11 doctor 33/33 | **PASS（需先修本机配置）** | 连跑三次 `doctor: 7/9`，根因双向复证见 §4；把配置里 `defaultShell` 置 null 后 `DOCTOR_PORT=3506` → **33/33 RC=0**（`my-doctor8-null.txt`） |
| AC12 终端/远程 SSH/文件面板/AI 抽屉无回归 | **PASS（远程项打折）** | 同一探针内：终端回显正常、文件面板 142 条、新建标签、`/api/hosts` 200。远程 SSH 文件面板**未真连**（见 §5 #8） |
| AC13 加分 | 不适用 | — |

## 3. 干净子集（排除并行噪声）

7 个直接相关测试文件单独跑：**tests 329 / pass 329 / fail 0**
（`test/server/auth.test.mjs`、`test/ai/allowlist.test.mjs`、`test/ai/judge.test.mjs`、`test/policy/classify.test.mjs`、`test/policy/forbidden.test.mjs`、`test/policy/sensitive.test.mjs`、`test/fs/local.test.mjs`）

## 4. doctor 红灯根因（非卡 S 回归）

- 现象：`STEP_TIMEOUT "3 echo M-2 timed out after 8000ms"` + `8.orphans skippedBecause STEP_TIMEOUT` → 7/9。
- 机理：`~/.config/magpie-terminal/config.json` 里 `defaultShell: "pwsh"`（疑由 `.dispatch/v4f-verify-own.mjs:131` 真实 PUT 留下）。`scripts/doctor.mjs:215` 发 `pty.input` data = `"echo M-$((1+1))\n"`（只有 LF），pwsh 7.7.0 不把裸 `\n` 当行结束 → 步骤超时。
- 直接证据：`.dispatch/my-doctor-mirror.mjs` 镜像 doctor 的 WS 帧（帧类型 `pty.output`），LF 发 12.3s 无 M-2、缓冲区停在 `PS C:\Users\41807>` 与 `>>` 续行提示；改发 `\r` 后 60ms 收到。
- 双向对照：隔离配置 `{"defaultShell":null}` → 33/33（`my-doctor6-iso.txt`）；隔离配置 `{"defaultShell":"pwsh"}` → 7/9（`my-doctor7-pwsh.txt`）。
- 处置：真实配置已备份到 `.dispatch/config-backup-0959.json`，`defaultShell` 已改回 `null`。**当前配置文件是被主 agent 改过的状态，需告知用户。**
- 另注：`scripts/doctor.mjs` 只发 LF 是一个独立的 doctor 缺陷（换 pwsh 默认 shell 就必然误报），不在卡 S 范围。

## 5. 打折项（10 条，逐条复核）

| # | 内容 | 我的判断 |
|---|---|---|
| 1 | `isNavigationRequest` 比卡面 §6.1 示例宽（`src/server/auth.mjs:59-95`） | **成立且必要**。实测 `.dispatch/my-nodefetch.mjs`：Node 24 全局 fetch 到本地 server，服务端收到的头是 `{"sec-fetch-mode":"cors"}`、**无 Origin**。逐字照搬卡面「有 sec-fetch-mode 就只认 navigate」会让所有 fetch 型合法请求 403（`.dispatch/v4s-probe/verbatim-gate-breaks.txt` 4 条测试红）。**需人类拍板** |
| 2 | 只给 rail/main/statusbar 设 inert，`[data-role="toast-stack"]` 未设 | 属实（`app/ui/settings-panel.js:476` `INERT_SELECTORS` 三元素）。toast 的「去确认」在设置页打开时仍可点 → P2 |
| 3 | 抽屉收起后打字落到当前真实焦点 | 属实。语义从「不可见」变「可见」，混淆未彻底消除 → P2 |
| 4 | `READ_HEADS` 保留 `where`/`which` | 偏保守但安全（`where C:/x/.ssh/id_rsa` 现要确认）→ 接受 |
| 5 | `/api/fs` 写只查 `path.dirname(target)` 的真实路径 | 我亲验补上了读侧：`my-p14.mjs` 对 junction→`~/.ssh` 的 list/read/write/remove **全 BLOCKED**（VERIFY-V4-G P1-4「139 条」洞已堵）。「中间层是链接」仍无用例 → P2 |
| 6 | `forbidden.mjs` 保留私有 `splitSegments` | 有意取舍（输入是 token 数组 vs 字符串）→ 接受 |
| 7 | `del /s C:\Users` 靠运行时 `os.homedir()` 父级 | 接受（不写死路径更正确） |
| 8 | AC12 远程 SSH 只验 `/api/hosts` 200 + hasSecret | 属实。`src/ssh/fs.mjs` 一行未改，P1-4 只修本地 `src/fs/local.mjs`。远端路径在远端，无 realpath 检查 → 记录为已知边界 |
| 9 | doctor 浏览器断言跑在临时服务，不覆盖新前端行为 | 新前端行为由 `ac8-ac9-focus.mjs`（headless Chrome）覆盖，非 WebView2 宿主 → 已用其它探针补足 |
| 10 | N2「真导航」用原始 socket 伪造请求头 | 我用真宿主 3480 + curl 复现（200/4317 字节/带 token），并 `ac2-iframe.mjs` 在真浏览器跑跨站 iframe → 已补足 |

## 6. 解除条件与遗留

**人类拍板记录**：
- **人类已批准 §5 #1（`isNavigationRequest` 放宽）** —— 用户消息 `m00970`「2A」，2026-11-24 13:20。即：接受执行者按 Node 24 实测放宽（navigate 放行 / 其它 mode 带 Origin 拒 / 无 mode 看 Origin），不按卡面 §6.1 逐字照搬。此项从「打折待拍板」转为**已批准**。
- 宿主已由用户重启（`magpie-bun` pid 31404，StartTime 2026-11-24 13:18:01），`/api/ai/sessions` 返 200、`/api/config` 含 `showApprovalEffect` → 卡 H 新代码已生效。

**解除「有条件」的唯一条件（二选一，仍待人类确认）**：
- (a) 用 `waitUntil` 替掉 `test/ssh/registry.test.mjs:297` 附近固定 `setTimeout`，使全量稳定 610/610；
- (b) 人类确认 AC10 以「干净子集 329/329 + 单文件 17/17 + 历史 610/610」为准放行。

**→ 已于 2026-11-24 结案：走 (a)，条件已满足。**

- 人类选 (a)：用户消息 `m01027`「A」，2026-11-24 13:46。
- 修法：新增 `waitUntil(fn, timeoutMs, label)` 轮询原语（形状照抄 `test/ai/agent.test.mjs:527-536`），把 `test/ssh/registry.test.mjs:317` 的 `setTimeout(30)` 换成 `waitUntil(() => entered === true, 2000, "openShell 进入")`、`:321` 的 `setTimeout(50)` 换成 `waitUntil(() => fake.client.ended === true && registry.size === 0, 2000, "close 生效并关掉连接")`。断言语义未改，产品代码未动，唯一改动文件 `test/ssh/registry.test.mjs`（+14/−2）。
- 主 agent 亲跑复核（不信执行者自述）：单文件 3 次 **17/17 / 17/17 / 17/17**（`.dispatch/my-sshflaky-single-1..3.txt`），全量 5 轮 **673/673、662/661、673/673、673/673、673/673**（`.dispatch/my-sshflaky-full-1..5.txt`）。目标用例 5 轮全绿，耗时 55.9 / 88.8 / 110.3 / 190.5 / 85.1 ms，2000ms 上限余量充足。
- 全量第 2 轮那 1 个 fail **不是**本用例，是 `test/pty/session.test.mjs` 的 Node 原生崩溃（`v8::HandleScope::CreateHandle() Cannot create a handle without a HandleScope`，伴随 `BaseObject::decrease_refcount` 断言失败）。经查为**历史已有的环境级 flaky**，`pi-v2a.jsonl`（2026-11-23 04:52）记录过完全相同的原生栈（当时执行者亦实测 baseline 同样可复现）。与 ssh registry 无关，属 ConPTY 资源竞争，另立卡处理。

**遗留 P2（不阻塞，进后续卡）**：
1. `[data-role="toast-stack"]` 未纳入 `INERT_SELECTORS`（设置页打开时 toast 按钮可点）。
2. 抽屉收起后打字落到真实焦点，语义混淆。
3. `/api/fs` 写路径「中间层是符号链接」无测试用例。
4. `scripts/doctor.mjs` 只发 `\n`，默认 shell 为 pwsh 时必然误报。
5. 远程 SSH 文件面板未做 sensitive 路径检查（远端路径语义不同）。

## 7. 安全合规

- `git diff | grep -iE "secret|token|apikey"` 命中项全部是测试假数据（`TOP-SECRET-CONTENT`、`cat secrets.key`、`~/.config/magpie-terminal/secrets.key`）与既有 token 门断言文本，**无真实凭据**。
- `.dispatch/` 整个目录未入库（`.gitignore:46-47` `*.dispatch/`），所有探针与日志安全。
- 本次验收未修改任何产品代码；只改了 `~/.config/magpie-terminal/config.json` 的 `defaultShell`（已备份）。

## 8. 证据索引

| 主题 | 路径 |
|---|---|
| 全量测试 ×4 | `.dispatch/my-v4s-full-1.txt`、`-2.txt`、`my-v4s-final-test.txt`、`my-v4s-final-test2.txt` |
| ssh registry 单跑 ×3 | `.dispatch/my-reg-1..3.txt` |
| 干净子集 329 | 主 agent 终端输出（7 文件） |
| doctor ×4 | `.dispatch/my-v4s-doctor{,2,3}.txt`、`my-doctor6-iso.txt`、`my-doctor7-pwsh.txt`、`my-doctor8-null.txt` |
| 焦点穿透 | `.dispatch/ac8-ac9-focus.mjs`（14/14） |
| token 泄漏 / iframe | `.dispatch/ac1-token-leak.mjs`（10/10）、`ac2-iframe.mjs`（4/4） |
| 白名单 / 危险删除 / 链式 | `.dispatch/my-s-ac3.mjs`、`my-s-ac6b.mjs`、`my-s-chain.mjs`、`my-judge-real2.mjs` |
| junction 穿透 | `.dispatch/my-p14.mjs`、`my-p14b.mjs` |
| Node fetch 头 | `.dispatch/my-nodefetch.mjs`、`v4s-probe/verbatim-gate-breaks.txt` |
| 备份 | `.dispatch/v4s-safety.patch`（1774 行）、`.dispatch/v4s-untracked.txt`、`.dispatch/config-backup-0959.json` |
