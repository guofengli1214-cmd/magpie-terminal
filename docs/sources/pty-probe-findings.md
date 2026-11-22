# magpie 页面插件跑真终端（PTY）可行性实测

**结论先说：可行，且已在本机最严苛的条件下跑通。** magpie 自带的 Bun（1.4.4 / 1.4.5）能加载并驱动 N-API 原生 PTY 模块——真 TTY（`stty size` 返回真实行列）、Ctrl-C 中断、并发多会话隔离、vim 全屏 TUI、HTTP+WS 端到端桥接全部 PASS；且在 `DETACHED_PROCESS`（完全无控制台）下同样 PASS，比真实宿主条件更严。无 PTY 的哨兵法作为降级路径也实测可用，但没有 TTY 能力。

三件必须在开工前知道的事：
1. **ConPTY 有真实缺陷**：调用 `resize()` 后紧接的第一个输入字节会被吞掉（两个库都复现，属 Windows ConPTY 而非 JS 库）。修法已验证：`resize()` → 发一个垃圾 `'\r'` → 等 250–500ms → 再输入，10/10 干净。
2. **不 `kill()` 就泄漏进程**：shell 自己退出（用户敲 `exit`、崩溃）时若不在 `onExit` 里补 `kill()`，进程**永不退出**（两个库实测 15s 仍存活）。必须在 `onExit` 里无条件 `kill()`。另：`kill()` 后进程还要约 1.07s 才消失（node-pty 的 1000ms 排空定时器），但 `kill()` 本身不阻塞。
3. **Bun 会静默装错版本**：本地没有 `node_modules` 时，`import 'node-pty'` 会自动从全局缓存装 **1.1.0**。必须锁本地 `node_modules` 并断言解析到的版本；推荐 `node-pty@1.2.0-beta.15` 或 `@lydell/node-pty@1.2.0-beta.18`（1.1.0 会刷 `AttachConsole failed` stderr 噪声）。

另外：**网关本地不鉴权**——`127.0.0.1:<port>/v1/models` 不带任何 Authorization 也返回 200。所以插件不必为"调网关"去读 key；`caller-keys.json` 实测可读（仅 `id`/`name`/`lan`/`secret` 四个字段）。

- 主机：Windows 11 (10.0.22631.6199)，git-bash (MSYS) 下执行
- 全部证据：`C:/Users/41807/AppData/Local/hermes/cache/scratch/pty-probe/log/`
- 未修改 `C:/Users/41807/.config/magpie/` 下任何文件；未重启/重装 magpie；所有写入均在 scratch 内
- 任何输出中均未出现完整 API key（仅出现 `sk-` 前缀与长度）

---

## Q1. 本机可用的 JS 运行时

**结论**：node v24.16.0 + npm 11.13.0 可用；`bun` 不在 PATH 上；magpie 自带的两个 Bun 可执行文件**不叫 `bun.exe`，而是 `magpie-bun.exe`**，实测版本 1.4.4 与 1.4.5。

原始命令与输出（`log/Q1-runtimes.log`）：

```
$ node -v
v24.16.0
$ npm -v
11.13.0
$ bun -v
/usr/bin/bash: line 7: bun: command not found
$ ls C:/Users/41807/.cache/magpie/bun/1.4.4/
magpie-bun.exe
$ ls C:/Users/41807/.cache/magpie/bun/1.4.5/
magpie-bun.exe
$ ...1.4.4/magpie-bun.exe -v
1.4.4
$ ...1.4.5/magpie-bun.exe -v
1.4.5
$ cat C:/Users/41807/.cache/magpie/bun/state.json
{ "current": "1.4.5", "previous": "1.4.4", "checked": "2026-11-21T19:17:54Z" }
```

> 坑：任务里给的路径是 `1.4.4*/bun.exe`。实际文件名是 `magpie-bun.exe`，直接用 `bun.exe` 会 ENOENT。插件里定位 Bun 必须用 `magpie-bun.exe`。

---

## Q2. node-pty 在 node 下：**PASS**

**结论**：npm 安装成功（1.1.0，自带 win32-x64 预编译，**没有触发 node-gyp 编译**），spawn `cmd.exe` 回读到 `PROBE_OK_123`，退出码 0。

命令（`log/npm-init.log`、`log/npm-install-node-pty.log`）：

```
$ cd .../pty-probe/np-node && npm init -y && npm i node-pty
added 2 packages, and audited 3 packages in 7s
node-pty@1.1.0
```

预编译产物（无需 VS Build Tools 的关键证据）：

```
node_modules/node-pty/prebuilds/win32-x64/
  conpty.dll  conpty.node  conpty_console_list.node  pty.node  winpty-agent.exe  conpty/OpenConsole.exe
node_modules/ 只含 node-pty + node-addon-api（无 node-gyp 编译痕迹）
```

探针 `np-node/probe.js`（CJS `require('node-pty')`）原始输出（`log/Q2-node-pty-probe.log`）：

```
[PTY] node=v24.16.0 node-pty=1.1.0 shell=C:\Windows\system32\cmd.exe pid=10368
[DATA] "...\u001b[?25lecho PROBE_OK_123\r\nPROBE_OK_123..."
[EXIT] code=0 signal=undefined
[RESULT] FOUND PROBE_OK_123 + clean exit
[RESULT] PASS
```

证据：`log/Q2-node-pty-probe.log`、`log/npm-install-node-pty.log`

---

## Q3. node-pty 在 magpie 自带 bun 下：**PASS**

**结论**：magpie-bun 1.4.5 与 1.4.4 **都能** `require`/`import` node-pty 并成功 spawn、读写。不需要 node，不需要重新编译。

原始输出（`log/Q3-bun145-node-pty.log`）：

```
[ENV] bun=1.4.5 node-compat=v26.3.0 node-pty=1.1.0
[DATA] "echo PROBE_OK_123\r\nPROBE_OK_123"
[EXIT] code=0 signal=undefined
[RESULT] PASS
```

1.4.4 同样 PASS（`log/Q3-bun144-node-pty.log`）。

**真 TTY 语义验证**（`pty-semantics.mjs`，插件布局的嵌套 node_modules 下，`log/Q3e-pty-semantics-bun.log`）：

```
[LOAD] nested-layout import ok, node-pty=1.2.0-beta.15
TTY_STDIN=yes
$ stty size
30 100
$ node -p "process.stdout.isTTY"
true
# child.resize(132,40) 之后
$ stty size
40 132
[EXIT] code=0
[RESULT] PASS
```

即：`isatty` 为真、`stty size` 可读、**resize 真实生效**（100x30 → 132x40）。

**bun 自带安装器也可用**（现场无 npm 时的安装路径，`log/Q3f-buninstall-spawn.log`）：

```
$ magpie-bun add node-pty@1.2.0-beta.15
bun add v1.4.5 (a7733435c)
installed node-pty@1.2.0-beta.15
2 packages installed [3.01s]
→ probe: [MARKER] true exited=true / [RESULT] PASS（1.4.5 与 node 均 PASS）
```

> 关键坑 1：magpie 的插件安装走 `bun add` 且**不执行依赖的 install 脚本**，所以 `node scripts/prebuild.js || node-gyp rebuild` 永远不会跑。必须依赖**预编译 N-API** 的包版本。
> 关键坑 2：在**没有本地 node_modules** 的目录里 `require('node-pty')`，Bun 会静默从全局缓存自动装一个 **1.1.0**（`C:/Users/41807/.bun/install/cache/node-pty@1.1.0@@@1`）。做版本判断前一定要先打印解析到的真实版本，并锁本地 node_modules。

证据：`log/Q3-bun145-node-pty.log`、`log/Q3-bun144-node-pty.log`、`log/Q3e-pty-semantics-bun.log`、`log/Q3f-buninstall-spawn.log`

---

## Q4. 备选 `@lydell/node-pty` 在 bun 下：**PASS**

**结论**：`@lydell/node-pty@1.2.0-beta.18`（官方预编译二进制，拆成 `node-pty` + `node-pty-win32-x64` 两个包）在 magpie-bun 下 import、spawn、读写、resize 全部正常。

```
$ magpie-bun add @lydell/node-pty
installed @lydell/node-pty@1.2.0-beta.18
2 packages installed [3.36s]
```

```
[LOAD] @lydell/node-pty version=1.2.0-beta.18 in 20ms
[LOAD] keys=native,spawn,fork,createTerminal,open
TTY_STDIN=yes
$ stty size
30 120
PROBE_OK_123
[EXIT] 0
```

证据：`log/Q4-lydell-bun.log`、`log/Q4-bun-lydell-node-pty.log`

### ⚠️ 两个库共有的真实缺陷：ConPTY resize 吃掉下一个输入字节

这是本次最值得写进设计的发现，**与 JS 库无关，是 Windows ConPTY 的行为**。

- 症状：`echo PROBE_OK_123` 到达 shell 时变成 `cho PROBE_OK_123` → `bash: cho: command not found`，退出码 127。
- 交替 A/B（各 5 轮，`log/Q12-interleave-beta15.log`）：**resize 组 4/10 干净（6 次掉字节），不 resize 组 10/10 干净**。
- 两个库都复现（node-pty 1.2.0-beta.15、@lydell 1.2.0-beta.18、node-pty 1.1.0）。
- 触发条件：shell 空闲时调用 `child.resize()`，之后写入的第一个字节被吞。

**已验证的解法**：`resize()` 之后先发一个丢弃的 `'\r'` 暖场，等 250–500ms 再输入真实命令 → **10/10 全干净**（`log/Q13-fix-beta15.log`），且 resize 确实生效（`[RESIZE_APPLIED] true`，45x140）且命令完整（`[CMD_INTACT] true`）。

> 回归测试陷阱（我踩过，务必记住）：终端会**回显**你输入的整行，所以 `/MARKER/` 断言在命令根本没执行时也会通过。正确做法是输入 `echo M-$((1+1))`——回显文本是 `M-$((1+1))`，只有真输出才是 `M-2`。同理 `/tty size/` 会误匹配 `stty size` 命令行本身，必须用 `/\btty size\b/`。

证据：`log/Q10-matrix-beta15.log`、`log/Q11-ab-beta15.log`、`log/Q12-interleave-beta15.log`、`log/Q13-fix-beta15.log`

---

## Q5. 无 PTY 降级方案（哨兵法）：**PASS（够用，但不具备 TTY 能力）**

**结论**：用 `child_process.spawn` 起**一个常驻** `bash.exe`，每条命令后 `printf '__DONE_<seq>__%s__\n' "$?"` 打哨兵，可以做到：流式读回、精确判定命令结束、拿到真实退出码。node 与 magpie-bun 结果一致。

原始输出（`log/Q5-fallback-bun.log`，node 见 `Q5-fallback-node.log`）：

```
[STREAM] "/c/Users/41807\n"
[STREAM] "__DONE_1__0__\n"
[CMD 1] "cd /c/Users/41807 && pwd"      exit=0    output="/c/Users/41807"
[STREAM] "「开始」菜单\nai_completion\nansel\n"
[STREAM] "__DONE_2__0__\n"
[CMD 2] "ls | head -3"                   exit=0    output="「开始」菜单 / ai_completion / ansel"
[STDERR] "/usr/bin/bash: line 5: nosuchcmd_xyz: command not found"
[STREAM] "__DONE_3__127__\n"
[CMD 3] "nosuchcmd_xyz"                  exit=127
```

3 条命令总耗时 157ms (node) / 114ms (bun)。

**能力边界（设计时必须知道）**：哨兵法拿不到 TTY，因此 `isatty()` 为假、`stty size` 无输出、Ctrl-C 无效、vim/top 等全屏程序不可用、无颜色/光标控制。它把"终端"降级成"能流式看输出的命令执行器"——与 page-agent-console README 里描述的 fallback 定位一致。

证据：`log/Q5-fallback-bun.log`、`log/Q5-fallback-node.log`、`log/Q5-marker-bun.log`、`log/Q5-marker-node.log`

---

## Q6. magpie 网关凭据（**全程未输出任何 key 内容**）

**结论**：`caller-keys.json` 存在且**插件进程可读**（`fs.accessSync(..., R_OK)` → true）；`settings.json` **根本没有 `port` 字段**，真实端口来自 `gateway.json`；带 Bearer 打 `/v1/models` 返回 **HTTP 200**（模型数量动态：取证时 7 个，复查 6 个），前三个 id 是 `shuaiapi/gpt-6-luna`、`shuaiapihermes/gpt-6.2-sol`、`commandcode/deepseek/deepseek-v4.1-flash`。

### 6a. `caller-keys.json` 结构（`log/Q6-credentials-structure.log`）

```
-rw-r--r-- 1 41807 197609 168 ... caller-keys.json
[TOP] JSON array, length=1
[ENTRY 0] fields:
   - id      string len=24   (prefix "0e4")
   - name    string len=6    ("Magpie")
   - lan     boolean true
   - secret  string len=62   (prefix "sk-")   <VALUE REDACTED>
[SAFE] no secret value printed; total distinct fields=4
```

字段仅 4 个：`id` / `name` / `lan` / `secret`。没有 scope、过期时间、provider 绑定等任何附加信息。

### 6b. `settings.json` 里的 `port`：**不存在**

```
settings.json top-level keys (24):
accent, autoRestart, chinaMirror, currency, dockNever, dockSettled, lan, lanKey,
lanKeyId, lang, modelNames, otel, redact, redactModelAuto, redactModelName,
sessionReads, textSize, theme, tray, trayUsageEvery, updateChannel, updateEvery,
window, windowAt
has "port" key: False
keys matching /port|addr|listen/i: NONE
```

**这与任务描述不符，必须纠正**：端口不在 `settings.json`，在 `gateway.json`：

```json
{"addr": "[::]:3425", "pid": 18560, "serves": "tray", "version": "0.1.4015", "started": "2026-11-21T19:15:52Z"}
```

netstat 确认 pid 18560 监听 `0.0.0.0:3425` 与 `[::]:3425`。

> 顺带发现：`settings.json` 里另有 `lan: true`、`lanKey`(len 62)、`lanKeyId`(len 24)——LAN key 也存在这里，插件若读 settings 会顺带拿到它。另外 `sessionReads: {"asked":true,"all":true}`。

### 6c. `/v1/models` 实测（`log/Q6-gateway-curl.log`）

```
$ curl -sS -H @log/hdr.txt -o log/models-curl.json -w "HTTP_STATUS=%{http_code}\n" \
       http://127.0.0.1:3425/v1/models
HTTP_STATUS=200
bytes=5464
model_count=7
first3_ids=['shuaiapi/gpt-6-luna', 'shuaiapihermes/gpt-6.2-sol', 'commandcode/deepseek/deepseek-v4.1-flash']
```

（bearer 写入临时 header 文件后 `curl -H @file` 传入，用完立即 shred 删除；从未回显。）

> 模型数量会**动态变化**：首次/取证时为 7 个，复查时为 6 个（当前 4754 bytes）。别把数量写死成断言，只断言 `HTTP 200` + `data[]` 非空。

> 环境坑：本机 curl 是 8.18.0 (x86_64-w64-mingw32, Schannel)，**不支持 `--config` 也不支持 `-K`**（`curl: option -K: is unknown`，exit 2）。只能用 `-H @file` 或 `-H "..."`。另：`-o /dev/null` 在本机 MSYS 下会报 `curl: (23) client returned ERROR on write`，写临时文件再删即可。

### 6d. ⚠️ 安全隐患：网关**不校验本地调用方**

| 请求 | 结果 |
|---|---|
| 正确 Bearer | HTTP 200 / 5451 bytes |
| `Authorization: Bearer bogus` | HTTP 200 / 5451 bytes |
| **完全不带 Authorization** | HTTP 200 / 5451 bytes |
| `POST /v1/chat/completions`（max_tokens=5） | HTTP 200 / 458 bytes |

桌面模式下 127.0.0.1 的调用方**无需任何凭据**即可用 `/v1/models` 与 `/v1/chat/completions`。这意味着插件"读取 key"在功能上并非必需（读网关不需要它），但这也意味着**本机任何进程都能白嫖该网关**——属于既有配置风险，非本次改动引入，仅记录。

Bun 侧读取能力实测：`[READ] ok entries=1 picked.name=Magpie` / `[KEY] len=62 prefix=sk- usable=true` / `[GW] status=200 bytes=5451`。

证据：`log/Q6-credentials-structure.log`、`log/Q6-gateway-curl.log`、`log/models-curl.json`

---

## Q7. 决定性验证：在**无控制台**条件下（最严苛的宿主条件）

这一节是本次最关键的补充。前面 Q2–Q4 都是在**有控制台**的 git-bash 里跑的，而真实插件宿主是 GUI 进程的子进程——条件可能不同，必须单独验证。为了让结论不被环境假设绑住，这里直接测**最坏情况**：用 `DETACHED_PROCESS` 造一个完全无控制台的进程再跑 PTY。真实宿主只要比这宽松，就必然可行。

### 7a. 控制台状态：**实测**真实的在线插件宿主

先看二进制层面（`log/Q17-pe-subsystem.log`）：读 PE header 的 Subsystem 字段

```
magpie-windows-amd64 (1).exe  magic=0x20b  subsystem=2 (GUI/no-console)
magpie-bun.exe (1.4.4)        magic=0x20b  subsystem=3 (CONSOLE)
magpie-bun.exe (1.4.5)        magic=0x20b  subsystem=3 (CONSOLE)
```

但 PE 字段只是静态属性，**运行时到底有没有控制台要直接测**。本次探针期间机器上正跑着一个真实的插件宿主，于是直接对它取证（`log/Q21-attachconsole-host.log`）：

```
-- live host process --
CommandLine=C:\Users\41807\.cache\magpie\bun\1.4.5\magpie-bun.exe run C:\Users\41807\.cache\magpie\plugin-host\host-04ae8bb31b67.js
Name=magpie-bun.exe
ParentProcessId=18560
ProcessId=14216

-- parent check --
Name=magpie-windows-amd64 (1).exe

-- children of 14216 --
Name=conhost.exe
ProcessId=28524

-- AttachConsole(14216) --
ATTACH_PID=14216
ATTACH_OK=True
WIN32_ERROR=203
CONSOLE_HWND=0
```

**结论修正：真实插件宿主 14216 是有控制台的**（有一个 conhost.exe 子进程 28524，且 `AttachConsole` 成功返回 TRUE）。

这个探针本身的有效性用 3 组对照证明（同在 `log/Q21-attachconsole-host.log`），避免"永远返回 TRUE"的假信号：

```
-- CONTROL: AttachConsole(18560 = GUI magpie.exe, must be False) --
ATTACH_OK=False   WIN32_ERROR=6    (ERROR_INVALID_HANDLE)

-- CONTROL: AttachConsole(999999 = nonexistent, must be False/err87) --
ATTACH_OK=False   WIN32_ERROR=87   (ERROR_INVALID_PARAMETER)

-- CONTROL: AttachConsole(<real console app ping>, must be True) --
ATTACH_OK=True    WIN32_ERROR=203
```

三组对照全部符合预期 → 探针对"有无控制台"具备区分力，因此 14216 的 TRUE 是可信的。

对可行性判断的影响：**无。** 因为更严格的"完全无控制台"（`DETACHED_PROCESS`）条件下 PTY 已经 PASS（见 7b），真实宿主反而条件更宽松。这点只影响一件事：**1.1.0 的 `AttachConsole failed` stderr 噪声在生产里会不会出现**——宿主有控制台时该噪声更可能被触发，所以更应选 `node-pty@1.2.0-beta.15` 或 `@lydell/node-pty`（实测 0 次噪声）。

顺便确认了插件宿主的真实位置与契约（此前一度以为 `plugin-host/` 目录不存在，是错的）：

```
C:/Users/41807/.cache/magpie/plugin-host/  (注意在 .cache 下，不是 .config 下)
  host-04ae8bb31b67.js  164.9K   ← 当前在跑的那个
  host-57e4026712e7.js  120.1K
  host-a2d7578824f7.js  117.0K
  pi-2694d2cfa370.js     44.6K
  pi-f1950b483233.js     44.6K
```

宿主脚本头部自述的协议（`host-04ae8bb31b67.js` 前 25 行）：magpie→host `{id, method, params}`，host→magpie `{id, result}` / `{id, error}`；流式 fetch 先 `{id, event:"head", status, headers}`，再逐块 `{id, event:"chunk", data}`（base64），最后 `{id, result:null}`；`{method:"abort", params:{id}}` 取消；主动推送 `{event:"log"|"toast"|"auth"}`。所以 127.0.0.1 HTTP 服务应把这些流式事件翻成 SSE（与 page-chat 一致），而不是 WebSocket。

### 7b. 无控制台下的 PTY：**PASS**

用 `DETACHED_PROCESS` 启动（libuv 在 `detached:true` 时设置该 flag），进程**确实**没有控制台：

```
[ENV] bun=1.4.5 node-pty=1.2.0-beta.15
[ENV] stdout_isTTY=undefined stdin_isTTY=undefined
[ENV] console=NONE (EBADF: bad file descriptor, open 'CONOUT$')
$ echo NC_$((20+5))
NC_25
$ stty size
30 100
[RESULT] PASS
```

PTY 在无控制台环境下照常工作，`stty size` 仍返回真实值 → ConPTY 不依赖宿主自己的控制台。

### 7c. 关闭 PTY 的延迟，以及一个**必须规避的进程泄漏**

先纠正一处我先前写错的结论。早前只跑了一次、且把"含固定 900ms 等待"的总耗时误当成净延迟，写成"约等于基线"。这次用 `noconsole/exitlag3.cjs` 从**进程外部**计时（`[KILL-AT-MS]` 由探针在 `kill()` 前打出，外层记录进程真正被 OS 回收的时刻），每臂 5 次，净延迟 = 退出时刻 − kill 调用时刻：

```
[LAG] noconsole/no-pty-baseline.mjs    n=5 nets=[4,4,5,5,6]                 median=5ms
[LAG] noconsole/exit-lag2.mjs          n=5 nets=[1077,1077,1079,1080,1086]  median=1079ms
[LAG] lydell/exit-lag2.mjs             n=5 nets=[1077,1084,1087,1097,1624]  median=1087ms
```

**结论：`kill()` 之后进程还要多活约 1.07 秒，不是 100ms。** 根因定位到 `node-pty/lib/windowsPtyAgent.js`：

```js
// windowsPtyAgent.js:23
var FLUSH_DATA_INTERVAL = 1000;
// windowsPtyAgent.js:262
this._closeTimeout = setTimeout(function () { return _this._cleanUpProcess(); }, FLUSH_DATA_INTERVAL);
```

`_flushDataAndCleanUp()` 每次被调用都用 `FLUSH_DATA_INTERVAL`（1000ms）重置这个定时器，定时器不烧完句柄就不释放，事件循环因此多转 1 秒。这不是 bug，但要计入"关标签页"的体感。

**更重要的发现：shell 自然退出而不 `kill()` 时，进程永不退出。** 三个臂的对照（`log/Q16f-close-matrix.log`、`log/Q16g-lydell-close-matrix.log`，每臂 15s 守卫）：

| 臂 | 场景 | 结果 |
|---|---|---|
| `kill` | 用户直接关标签 → `c.kill()` | EXITED，net_lag 1067ms（node-pty）/ 1059ms（@lydell） |
| `exit-kill` | shell 自己 `exit`，在 `onExit` 里补 `c.kill()` | EXITED，net_lag 2573ms / 2337ms |
| `exit-nokill` | shell 自己 `exit`，`onExit` 里什么都不做 | **STILL_ALIVE at 15s → 泄漏**（node-pty 与 @lydell 均复现） |

`exit-nokill` 臂的 stdout 证明探测逻辑本身跑完了、`onExit` 也正常触发，只是进程不退出：

```
[KILL-AT-MS] 1795293489151 | [KILL-RETURNED] | [RESULT] {"arm":"exit-nokill","onExit_after_trigger_ms":1054,"exitCode":0,"kill_blocked_ms":null,"kill_in_onexit_ms":null}
[[noconsole/close-matrix.mjs] STILL_ALIVE at guard=15000ms (ms since kill=14042) -> LEAK]
```

机制：`onExit` 只说明 shell 进程死了，node-pty 的 conout socket worker 仍握着句柄；只有走 `kill()` 才会 `_conoutSocketWorker.dispose()`（`windowsPtyAgent.js:204`）。

**因此产品硬性要求：`onExit` 里必须调用 `kill()`（幂等）。** 用户敲 `exit`、shell 崩溃、终端程序自杀，都必须走这条路径，否则每关一个标签页就漏一个常驻进程。`c.kill()` 本身是非阻塞的（实测 `[KILL_BLOCKED_MS] 39–63`）。

该修法已实测验证（`noconsole/fix-onExit-kill.mjs`，`log/Q16h-fix-onexit-kill.log`，5 次、守卫 20s 与 40s 两种）：

```
[noconsole/fix-onExit-kill.mjs] EXITED code=0 net_lag_ms=2200 total_ms=3215
[noconsole/fix-onExit-kill.mjs] EXITED code=0 net_lag_ms=2809 total_ms=3882
[noconsole/fix-onExit-kill.mjs] EXITED code=0 net_lag_ms=2103 total_ms=3168
[noconsole/fix-onExit-kill.mjs] EXITED code=0 net_lag_ms=2106 total_ms=3116   (guard 40s)
[noconsole/fix-onExit-kill.mjs] EXITED code=0 net_lag_ms=2734 total_ms=3785   (guard 40s)
```

5/5 全部正常退出，泄漏消失。注意"shell 自己退出"这条路径的净延迟约 **2.1–2.8s**（比直接 `kill()` 的 1.07s 更长），因为 `onExit` 自身先要等约 1.05s 才触发，之后 `kill()` 的排空定时器再走 1s。这属于**可接受但需知情**的量级：UI 应在收到 `onExit` 时就立刻把标签页标成已结束，不要等进程消失。

> 另注意 node-pty **1.1.0** 会在关闭时打印 `error: AttachConsole failed`（`conpty_console_list_agent.js:13`）。2 次出现于 `log/Q7-e2e-host.log`，beta.15 与 @lydell 均为 0 次。有 5000ms 超时兜底（`resolve([_this._innerPid])`），功能不受影响，但会污染 stderr → **选 beta.15 或 @lydell 可避免**。

### 7d. 全屏 TUI 程序（vim）在无控制台下可用：**PASS**

```
[CHECKS] {
  "full_screen_clear": true,        // \e[2J
  "cursor_positioning": true,       // \e[<row>;<col>H
  "vim_quit_ok": true,              // TUI_42 输出正常（:q! 被正确接收）
  "exit_code": 0,
  "raw_bytes": 4094,
  "tui_took_over": true
}
[RESULT] PASS
```

vim 能接管屏幕、接受 `:q!`、正常退出后 shell 继续可用。原始字节流：`log/Q19-tui-raw.bin`。

### 7e. 端到端产品形态（Bun HTTP+WS → PTY → 独立客户端）：**PASS**

完全按目标插件架构：一个**无控制台**的 Bun 进程在 `127.0.0.1:18881` 起 HTTP+WS，WS 后接真 PTY；另一个 Node 进程作为客户端连接并输入命令。

```
[HOST] listening http://127.0.0.1:18881 bun=1.4.5
[HOST] pty spawned, clients=1
[CLIENT] connected / prompt seen, typing now
$echo PROBE_OK_123
PROBE_OK_123
[CLIENT] exit code=0
[CHECKS] { "cmd_echoed_intact": true, "output_line": true, "got_exit": true }
[RESULT] PASS
```

证据：`log/Q20-e2e-noconsole.log`、`log/Q20-e2e-noconsole-host.log`

### 7f. PTY 独有能力（无 PTY 方案做不到）

| 能力 | 结果 | 证据 |
|---|---|---|
| Ctrl-C 中断前台任务（`sleep 30`） | `ctrl_c_interrupts_sleep: true`：`M-2` 打印、`N-2` 永不出现、之后 shell 仍响应 `F-2` | `log/Q14b-pty-only-bun.log` |
| 3 个并发会话互不串扰 | `three_concurrent_isolated: true`：分别得到 `Q-11` / `Q-22` / `Q-33` | 同上 |
| 真 TTY（`isatty`） | `TTY_STDIN=yes`、`process.stdout.isTTY=true` | `log/Q3e-pty-semantics-bun.log` |
| resize 生效 | `stty size` 100x30 → 132x40 | `log/Q3e-pty-semantics-bun.log` |
| 全屏 TUI | vim 正常（见 7d） | `log/Q19-tui-vim.log` |

---

## 落地建议（按风险排序）

1. **直接用 node-pty，不要做无 PTY 降级为主路径**。选择 **`node-pty@1.2.0-beta.15`**（体积 27MB，win32-x64 预编译，bun 下零 AttachConsole 噪声，无 winpty）或 **`@lydell/node-pty@1.2.0-beta.18`**（拆包、预编译、同样干净）。避免 1.1.0（stderr 噪声 + 无 Linux 预编译）。两者都有官方 win32-x64 预编译产物，**不需要 VS Build Tools、不跑 install 脚本**——这点很关键，因为 magpie 用 `bun add` 装插件且不执行依赖的 install 脚本。
2. **必须锁本地 `node_modules` 并断言解析到的版本**，否则 Bun 会静默全局缓存装 1.1.0。
3. **resize 后必须暖场**：`resize()` → `'\r'` → 等 250–500ms → 再输入。这是硬性要求，否则新开标签页/改窗口大小时第一条命令必掉首字符。
4. **测试断言必须区分回显与输出**（`echo M-$((1+1))` 技巧），否则会得到假 PASS。PTY 会把输入行原样回显，所以断言 `/MARKER/` 会在命令根本没执行时也通过。
5. Bun 可执行文件名是 `magpie-bun.exe`，不是 `bun.exe`（在 `C:/Users/41807/.cache/magpie/bun/<ver>/`）。
6. 网关端口从 `C:/Users/41807/.config/magpie/gateway.json` 的 `addr` 解析（本次 `[::]:3425`），**不要**去 `settings.json` 找 `port`（该 key 不存在）。
7. 网关本地不鉴权 → 插件没必要为"调网关"去读 key；若产品要展示 key 状态，读 `caller-keys.json` 是可行的（实测可读），但要接受它把 key 暴露在插件进程内存里。
8. 插件宿主的真实位置是 `C:/Users/41807/.cache/magpie/plugin-host/`（在 `.cache` 下，不是 `.config` 下）；宿主协议是逐行 JSON，流式 fetch 以 `event:"chunk"` 分块下发 → 本地 HTTP 服务应转成 **SSE**（与 page-chat 一致），别用 WebSocket。
9. **`onExit` 里必须调 `kill()`**。shell 自然退出（用户敲 `exit` / 崩溃 / 程序自杀）而不再 `kill()` 时，进程**永不退出**（两个库实测 15s 仍存活）。这是最容易在真实使用里漏成"每关一个标签页漏一个进程"的坑。
10. 关闭标签页到进程真正消失约 **1.07s**（`FLUSH_DATA_INTERVAL = 1000` 的排空定时器），`kill()` 本身不阻塞（39–63ms）。UI 上别等进程退出才更新状态，以 `onExit` 为准。

---

## 证据文件索引

| 问题 | 文件 |
|---|---|
| Q1 运行时 | `log/Q1-runtimes.log` |
| Q2 node 下 node-pty | `log/npm-init.log`、`log/npm-install-node-pty.log`、`log/Q2-node-pty-probe.log`、`np-node/probe.js` |
| Q3 bun 下 node-pty | `log/Q3-bun145-node-pty.log`、`log/Q3-bun144-node-pty.log`、`log/Q3e-pty-semantics-bun.log`、`log/Q3f-buninstall-spawn.log`、`log/Q3b-bash-under-bun.log` |
| Q4 @lydell | `log/Q4-lydell-bun.log`、`log/Q4-bun-lydell-node-pty.log`、`log/npm-install-lydell.log` |
| Q4 resize 缺陷 | `log/Q10-matrix-beta15.log`、`log/Q11-ab-beta15.log`、`log/Q12-interleave-beta15.log`、`log/Q13-fix-beta15.log` |
| Q5 哨兵降级 | `log/Q5-fallback-node.log`、`log/Q5-fallback-bun.log`、`log/Q5-marker-node.log`、`log/Q5-marker-bun.log`、`q5-fallback.cjs` |
| Q6 凭据/网关 | `log/Q6-credentials-structure.log`、`log/Q6-gateway-curl.log`、`log/models-curl.json`、`log/models-body.json` |
| Q7a 控制台实测 | `log/Q21-attachconsole-host.log`、`attachtest/attach.ps1`（含 3 组对照） |
| Q7a PE subsystem | `log/Q17-pe-subsystem.log`、`pesub.cjs` |
| Q7b 无控制台 PTY | `log/Q15-noconsole-detached.log`、`noconsole/probe-noconsole.mjs` |
| Q7c 退出延迟/泄漏 | `log/Q16d-exitlag-multitrial.log`、`log/Q16f-close-matrix.log`、`log/Q16g-lydell-close-matrix.log`、`noconsole/exitlag3.cjs`、`noconsole/close-matrix.mjs`、`lydell/close-matrix.mjs`、`noconsole/exit-or-leak.cjs` |
| Q7d TUI | `log/Q19-tui-vim.log`、`log/Q19-tui-raw.bin`、`tui/probe-vim.mjs` |
| Q7e 端到端 | `log/Q20-e2e-noconsole.log`、`log/Q20-e2e-noconsole-host.log`、`e2e/e2e-host.mjs`、`e2e/e2e-client2.mjs`、`e2e/run-final.cjs` |
| Q7f PTY 独有能力 | `log/Q14b-pty-only-bun.log`、`pty-only2.mjs` |
