# PTY 实测笔记

> 状态：设计已定，代码未开始。最后更新：2026-11-22
> 本文所有数字与命令输出来自本仓库 `docs/sources/pty-probe-findings.md`（489 行，下称 F）及其引用的 `pty-probe/log/*.log`。引用格式为 `F:行号` + 原始日志名，便于逐条复核。原始日志 `log/*.log` 未入库（体积与隐私），需要追溯时在写文档的机器上按 `F` 里记录的路径复跑。
> 术语按 BRIEF 第 6 节：终端内核 = pty bridge、会话 = session、哨兵法 = sentinel。

---

## 1. 为什么必须是 PTY，不能用 `child_process`

`child_process.spawn` 给子进程的是**管道**，不是终端。管道没有 `isatty`、没有窗口尺寸、没有 `SIGWINCH` 语义，因此：

| 能力 | `child_process`（管道） | PTY | 证据 |
|---|---|---|---|
| `isatty()` | false | true | F:101 `TTY_STDIN=yes`；F:105 `process.stdout.isTTY` → `true`（`log/Q3e-pty-semantics-bun.log`） |
| 窗口尺寸 | 无此概念 | 可读可改 | F:102-108：`stty size` → `30 100`；`resize(132,40)` 后 → `40 132`（`log/Q3e-pty-semantics-bun.log`） |
| 全屏 TUI（vim） | 不可用（拿不到光标定位/清屏能力） | 可用 | F:415-423：`full_screen_clear: true`、`cursor_positioning: true`、`vim_quit_ok: true`、`tui_took_over: true`（`log/Q19-tui-vim.log`） |
| Ctrl-C 中断前台任务 | 只能杀进程，不能只中断前台作业 | 可用 | F:449：`ctrl_c_interrupts_sleep: true`，`M-2` 打印、`N-2` 永不出现、之后 shell 仍响应 `F-2`（`log/Q14b-pty-only-bun.log`） |
| 颜色 / 光标 | 无 | 有 | F:191 反向说明：哨兵法「无颜色/光标控制」 |
| 多会话隔离 | 可以，但每个都是独立管道 | 可以 | F:450：3 个并发会话分别得到 `Q-11` / `Q-22` / `Q-33`，互不串扰 |

**结论**：产品的定位是「在 magpie 窗口里放一个**真终端**」（BRIEF 1 节）。一旦用管道，`vim`、`top`、`less` 的分页、Ctrl-C、进度条全部失效，退化成「命令执行器」。所以 PTY 是主路径，`child_process` 只作为降级（第 6 节）。

**最严苛条件的验证**：真实插件宿主是 GUI 进程的子进程，理论上可能没有控制台。实测用 `DETACHED_PROCESS` 造出完全无控制台的进程（`stdout_isTTY=undefined`、`console=NONE (EBADF ... open 'CONOUT$')`，F:347-348），PTY 仍返回 `stty size = 30 100`（F:351-352），`[RESULT] PASS`。即 **ConPTY 不依赖宿主自己的控制台**。

---

## 2. 本机实测环境

| 项 | 实测值 | 证据位置 | 备注 |
|---|---|---|---|
| 操作系统 | Windows 11 (10.0.22631.6199)，git-bash (MSYS) | F:12 | 所有探针在此环境跑 |
| node | `v24.16.0` | F:26-27（`log/Q1-runtimes.log`） | 仅用于探针，插件运行时不用 node |
| npm | `11.13.0` | F:28-29 | 同上 |
| `bun` 在 PATH | 不存在（`bun: command not found`） | F:30-31 | 所以必须用 magpie 自带二进制 |
| magpie Bun 可执行名 | `magpie-bun.exe`（**不是** `bun.exe`） | F:32-38、F:44 | 路径 `C:/Users/41807/.cache/magpie/bun/{1.4.4,1.4.5}/`；用 `bun.exe` 会 ENOENT |
| magpie Bun 版本 | 1.4.4 与 1.4.5，`state.json` 当前 `1.4.5` | F:36-41 | 两版都实测可加载 node-pty（F:84-95） |
| 主选 node-pty | `1.2.0-beta.15`，含 `prebuilds/win32-x64` | F:100（`[LOAD] ... node-pty=1.2.0-beta.15`）、F:62 | 已在 `C:/Users/41807/.config/magpie/plugins/node_modules/` 里存在（BRIEF 3） |
| 备选 @lydell/node-pty | `1.2.0-beta.18`，import/spawn/读写/resize 全通 | F:134-152（`log/Q4-lydell-bun.log`） | 拆成 `node-pty` + `node-pty-win32-x64` 两个包 |
| 是否需要 VS Build Tools | **不需要** | F:60-66：`prebuilds/win32-x64/` 下有 `conpty.dll`、`conpty.node`、`pty.node`、`winpty-agent.exe`、`conpty/OpenConsole.exe`，`node_modules/` 只含 `node-pty` + `node-addon-api`，无 node-gyp 编译痕迹 | 关键：magpie 用 `bun add` 装插件且**不执行依赖的 install 脚本**（F:125），所以只能用带预编译产物的版本 |
| 必须避开的版本 | `1.1.0` | F:410：关闭时打印 `error: AttachConsole failed`（`conpty_console_list_agent.js:13`），`log/Q7-e2e-host.log` 中出现 2 次；beta.15 与 @lydell 均 0 次 | 功能不受影响（有 5000ms 超时兜底），但污染 stderr |

**为什么主选 beta.15 而不是 1.1.0**：三条叠加 —— ① 1.1.0 在真实宿主（**有**控制台，见 F:309）下更易触发 `AttachConsole failed` 噪声；② 1.1.0 无 Linux 预编译（F:459）；③ beta.15 体积 27MB、无 winpty 依赖（F:459）。

---

## 3. 坑 1：`resize()` 之后第一个输入字节被吞

### 现象

`echo PROBE_OK_123` 到达 shell 时变成 `cho PROBE_OK_123` → `bash: cho: command not found`，退出码 127（F:158）。

### 复现条件

- shell **空闲**时调用 `child.resize()`；
- 之后写入的**第一个字节**被吞（首字符丢失，不是整行丢失）；
- Windows ConPTY 缺陷，与 JS 库无关：`node-pty@1.2.0-beta.15`、`@lydell/node-pty@1.2.0-beta.18`、`node-pty@1.1.0` 三者均复现（F:160）。

### 定量证据

交替 A/B 各 5 轮（`log/Q12-interleave-beta15.log`，F:159）：

| 组 | 干净率 |
|---|---|
| resize 组 | **4/10** 干净（6 次掉字节） |
| 不 resize 组 | **10/10** 干净 |

即这不是偶发噪声，而是 resize 的必然副作用：只要改窗口大小，下一次输入必掉首字符。

### 修复流程

```
resize(cols, rows)
  → 立即写入一个丢弃的 '\r'
  → 等 250–500ms（暖场窗口）
  → 再接受/写入真实输入
```

实测结果（`log/Q13-fix-beta15.log`，F:163）：**10/10 全干净**，且 `[RESIZE_APPLIED] true`（45x140）、`[CMD_INTACT] true` —— 证明修法不是「不 resize」，resize 真的生效了。

### 实现约束

| 约束 | 为什么 |
|---|---|
| 暖场窗口内到达的用户输入必须**排队**，不能直接写 | 直接写就还是「第一个字节」，修法失效 |
| 连续 resize（拖拽窗口）要**合并**，只在最后一次 resize 后做一次暖场 | 每次 resize 都暖场会让输入延迟累积到不可用 |
| 暖场写 `'\r'` 而不是可见字符 | `'\r'` 在空命令行上只产生一个空提示符，不改变 shell 状态 |
| 打开新标签页时也要走同一路径（初始 cols/rows 也算一次 resize） | 否则「新开标签第一条命令掉首字符」，这是用户第一眼就会遇到的 bug |

### 回归测试的陷阱（必须写进测试）

终端会**回显**输入整行，所以 `/MARKER/` 断言在命令根本没执行时也会通过（F:165）。正确写法：

```
输入 echo M-$((1+1))     → 回显是 "M-$((1+1))"，只有真输出才是 "M-2"
断言 /tty size/ 会误匹配 "stty size" 命令行本身 → 必须用 /\btty size\b/
```

---

## 4. 坑 2：shell 自己退出时不补 `kill()`，进程永不退出

### 现象

三个臂对照（`log/Q16f-close-matrix.log`、`log/Q16g-lydell-close-matrix.log`，每臂 15s 守卫，F:379-385）：

| 臂 | 场景 | 结果 |
|---|---|---|
| `kill` | 用户直接关标签 → `c.kill()` | EXITED，净延迟 1067ms（node-pty）/ 1059ms（@lydell） |
| `exit-kill` | shell 自己 `exit`，`onExit` 里补 `c.kill()` | EXITED，净延迟 2573ms / 2337ms |
| `exit-nokill` | shell 自己 `exit`，`onExit` 里什么都不做 | **STILL_ALIVE at 15s → 泄漏**（两个库均复现） |

`exit-nokill` 臂的原始输出（F:390-391）：

```
[KILL-AT-MS] 1795293489151 | [KILL-RETURNED] | [RESULT] {"arm":"exit-nokill","onExit_after_trigger_ms":1054,"exitCode":0,...}
[[noconsole/close-matrix.mjs] STILL_ALIVE at guard=15000ms (ms since kill=14042) -> LEAK]
```

注意 `onExit` **正常触发了**（`onExit_after_trigger_ms: 1054`）、`exitCode: 0` 也正常 —— 探针逻辑跑完了，只是进程不退出。所以「监听 onExit 并更新 UI 状态」是必要的，但**不够**。

### 机制

- `onExit` 只说明 shell 进程死了；node-pty 的 conout socket worker 仍握着句柄。
- 只有走 `kill()` 才会 `_conoutSocketWorker.dispose()`（`node-pty/lib/windowsPtyAgent.js:204`，F:394）。
- `kill()` 之后进程还要多活约 **1.07 秒**，因为排空定时器（F:370-375）：

```js
// node-pty/lib/windowsPtyAgent.js:23
var FLUSH_DATA_INTERVAL = 1000;
// node-pty/lib/windowsPtyAgent.js:262
this._closeTimeout = setTimeout(function () { return _this._cleanUpProcess(); }, FLUSH_DATA_INTERVAL);
```

`_flushDataAndCleanUp()` 每次调用都用 1000ms 重置这个定时器，定时器不烧完句柄不释放，事件循环因此多转 1 秒。三臂计时实测（F:363-365）：

```
noconsole/no-pty-baseline.mjs    n=5 nets=[4,4,5,5,6]                 median=5ms
noconsole/exit-lag2.mjs          n=5 nets=[1077,1077,1079,1080,1086]  median=1079ms
lydell/exit-lag2.mjs             n=5 nets=[1077,1084,1087,1097,1624]  median=1087ms
```

即「无 PTY 基线 5ms」→「PTY kill 后 1079ms」，**多出来的 1 秒是排空定时器，不是进程没死**。

### 正确写法

```js
child.onExit(({ exitCode, signal }) => {
  // 1) 立刻把会话标成已结束（UI 不等进程消失）
  session.markExited(exitCode, signal);
  // 2) 无条件 kill()，幂等；这是唯一会 dispose conout worker 的路径
  try { child.kill(); } catch { /* 已死则忽略 */ }
  // 3) 不要在这里同步等待进程消失
});
```

| 约束 | 为什么 |
|---|---|
| `onExit` 里**无条件** `kill()`，不要判断「是不是用户主动关的」 | 用户敲 `exit`、shell 崩溃、程序自杀都走这条路径；漏掉任一条就漏一个常驻进程（F:396） |
| 别在 1 秒内断言「已清理」 | `kill()` 后约 1.07s 才消失；`exit-kill` 路径约 2.1–2.8s（`onExit` 自身先等约 1.05s，再走 1s 排空，F:408） |
| 5/5 验证过的修法：`noconsole/fix-onExit-kill.mjs` | F:398-407：守卫 20s 与 40s 两种，净延迟 2103–2809ms，全部 `EXITED code=0` |
| `kill()` 本身非阻塞 | F:396：`[KILL_BLOCKED_MS] 39–63`；不要在 UI 线程上等它 |
| 标签页关闭的体感按 `onExit` 计时 | 用户点 × 到进程消失约 1.07s（直接 kill）或 2.1–2.8s（shell 自己退出） |

---

## 5. 坑 3：Bun 静默装错版本

### 现象

在没有本地 `node_modules` 的目录里 `require('node-pty')`，Bun 会**静默**从全局缓存自动装 `1.1.0`（路径 `C:/Users/41807/.bun/install/cache/node-pty@1.1.0@@@1`，F:126），随后刷一屏 `AttachConsole failed` 噪声（F:410）。没有报错、没有提示，代码照跑，只是版本不对。

### 为什么会这样

- magpie 的插件安装走 `bun add`，且**不执行依赖的 install 脚本**（F:125）—— 所以 `node scripts/prebuild.js || node-gyp rebuild` 永远不会跑，只能依赖预编译 N-API。
- Bun 的模块解析在找不到本地包时会去全局缓存并「自动安装」，这个行为对开发方便，对可复现部署是陷阱。

### 对策

| 对策 | 具体做法 | 为什么 |
|---|---|---|
| 锁本地依赖 | 把 `node-pty` 写进插件自己的 `dependencies`，确保 `C:/Users/41807/.config/magpie/plugins/node_modules/node-pty` 存在且版本固定 | 本地命中就不会走全局缓存 |
| **启动时断言实际版本** | 启动第一行打印/校验解析到的 `node-pty` 版本，不等于 `1.2.0-beta.15` 就拒绝启动并报错 | 这是唯一能在生产里发现「静默装错」的手段；探针里 `[LOAD] ... node-pty=1.2.0-beta.15` 就是这么打出来的（F:100） |
| 断言同时打印解析路径 | `require.resolve('node-pty')` 的绝对路径一并打进日志 | 版本对但来自全局缓存时，路径能暴露问题 |
| 不用 `1.1.0` | 主选 beta.15 或 @lydell beta.18 | 见第 2 节三条理由 |

---

## 6. 无 PTY 降级方案：哨兵法

### 机制

用 `child_process.spawn` 起**一个常驻** `bash.exe`（不是每条命令起一个），每条命令后追加一条哨兵打印：

```bash
<用户命令>
printf '__DONE_<seq>__%s__\n' "$?"
```

读到 `__DONE_<seq>__<code>__` 就判定该条命令结束，`<code>` 即真实退出码。

### 实测输出（`log/Q5-fallback-bun.log`，F:177-187）

```
[STREAM] "/c/Users/41807\n"
[STREAM] "__DONE_1__0__\n"
[CMD 1] "cd /c/Users/41807 && pwd"      exit=0    output="/c/Users/41807"
[STREAM] "「开始」菜单\rai_completion\nansel\n"
[STREAM] "__DONE_2__0__\n"
[CMD 2] "ls | head -3"                   exit=0    output="「开始」菜单 / ai_completion / ansel"
[STDERR] "/usr/bin/bash: line 5: nosuchcmd_xyz: command not found"
[STREAM] "__DONE_3__127__\n"
[CMD 3] "nosuchcmd_xyz"                  exit=127
```

- 3 条命令总耗时 **157ms**（node）/ **114ms**（bun），F:189。
- `nosuchcmd_xyz` → **127**：证明退出码是真实透传的，不是硬编码的成功。
- 流式读回、精确判结束、真实退出码，三项都成立。

### 它做不到什么（必须在 UI 上明示）

F:191：哨兵法拿不到 TTY，因此

| 缺失 | 后果 |
|---|---|
| `isatty()` 为假 | 程序会走「非交互」分支（无颜色、无进度条、不同提示语） |
| `stty size` 无输出 | 无法感知窗口尺寸 |
| Ctrl-C 无效 | 不能中断前台任务，只能杀整个 bash |
| 无颜色 / 光标控制 | 不能渲染 ANSI 全屏 |
| vim / top 等全屏程序不可用 | 这是「终端」与「命令执行器」的分界线 |

### UI 要求

- 降级时必须在标签栏或状态栏**明示**「降级模式：无 TTY」，不能静默降级 —— 否则用户会以为 `vim` 打不开是 bug。
- 降级判据：`node-pty` 加载失败 / 版本断言失败 / spawn 抛错。三者任一即切降级，并把原因写进状态栏（可点击查看详情）。
- 哨兵序号必须单调递增且做转义：用户输出里若出现 `__DONE_`，未匹配当前 seq 的忽略。

---

## 7. spawn 参数建议与 resize 校验

### spawn

| 参数 | 建议值 | 为什么 |
|---|---|---|
| `name` | `'xterm-256color'` | xterm.js 支持 256 色；`TERM` 不对会导致 `less`/`vim` 退化成单色或报 `unknown terminal` |
| `cols` / `rows` | 初始 `100` / `30`，下限 `20` / `5` | `30 100` 是实测默认值（F:102、F:351），与 xterm.js 首次 `fit()` 前的占位一致；下限防 0 或负数导致 ConPTY 异常 |
| `cwd` | 新标签继承当前标签的 cwd；首个标签用 `os.homedir()` | 多标签「独立 cwd」是 BRIEF 4 的产品要求；继承当前 cwd 符合「开新标签继续在同一目录干活」的直觉 |
| `env` | 继承 `process.env`，覆盖 `TERM`，**不注入 token** | 继承保证 PATH / 代理 / 语言环境可用；不注入 token 见 `docs/security.md` 5.2 |
| `useConpty` | 不显式设置（用库默认） | 1.2.0-beta.15 默认走 ConPTY，全部实测都是在默认值下跑的。FINDINGS 标注该版本「无 winpty」（F:459），但预编译目录里同时存在 `winpty-agent.exe`（F:64），因此显式设 `useConpty: false` 会得到什么**未实测**，不要去试 |
| shell 选择 | `bash.exe`（msys）优先，全部候选失败才回退 `powershell.exe` | 本机 msys bash 在 PATH 上，且 FINDINGS 全部 PTY 证据都是 bash；探测顺序见 `docs/architecture.md` 第 7 节 |
| 编码 | 读回按 UTF-8 解码 | 实测中文路径 `「开始」菜单` 正常显示（F:181） |

### resize 参数校验

```
resize(cols, rows):
  1) 取整：Math.floor，非有限数直接丢弃
  2) 夹紧：cols = clamp(cols, 20, 500)，rows = clamp(rows, 5, 200)
  3) 与上次相同则直接 return（不触发暖场，避免拖拽时空转）
  4) 调用 child.resize(cols, rows)
  5) 写 '\r' 暖场 → 250–500ms 内排队输入 → 放行
```

| 校验 | 为什么 |
|---|---|
| 取整 + 非有限数丢弃 | xterm.js 的 `fit()` 在容器尺寸为 0（标签隐藏、窗口最小化）时会算出 0 或负数；直接传给 ConPTY 会得到未定义行为 |
| 上限 500x200 | 防异常放大值把 ConPTY 缓冲区撑爆；正常 4K 屏 `fit()` 远低于此 |
| 同值 return | 拖拽窗口会连发几十次 resize，每次都暖场会让输入延迟累积（见第 3 节实现约束） |
| 不把 resize 放在 `requestAnimationFrame` 之前算尺寸 | 容器还没布局完，`fit()` 读到的是旧尺寸 |

---

## 8. 孤儿进程排查（Windows）

### 判定标准

「关标签、退 magpie 后无孤儿 shell」= 不存在「父进程已死或父 pid 不属于插件宿主」的 `bash.exe`。

### 命令

**列所有 bash.exe 及其父进程**（PowerShell，本机实测可用）：

```
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | Format-Table -AutoSize"
```

本机实跑样例（pid 每次不同，这里只示范「一个 bash 的父 pid 是另一个 bash」这种嵌套关系）：

```
ProcessId ParentProcessId Name
    27944           23716 bash.exe
    32228           27944 bash.exe
```

读法：`32228` 是 `27944` 的子 shell，`27944` 的父进程 `23716` 不在列表里 —— 说明它是由非 bash 进程拉起的（本例是 Hermes 的终端宿主）。本项目要断言的是「没有父 pid 属于 `magpie-bun.exe` 的残留 bash」，不是「没有 bash」。

**递归判断某个 pid 的祖先是否还活着**：

```
powershell -NoProfile -Command "$p=<pid>; while($p -and $p -ne 0){ $x=Get-CimInstance Win32_Process -Filter \"ProcessId=$p\"; if(-not $x){ 'MISSING ' + $p; break }; '{0} <- {1} ({2})' -f $x.ProcessId,$x.ParentProcessId,$x.Name; $p=$x.ParentProcessId }"
```

**按命令行特征筛本项目拉起的 shell**（比筛 `bash.exe` 更准，因为用户自己开的 git-bash 也是 `bash.exe`）：

```
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Where-Object { $_.CommandLine -match 'magpie-terminal|plugin-host' } | Select-Object ProcessId,ParentProcessId,CommandLine | Format-List"
```

| 要点 | 为什么 |
|---|---|
| 必须看 `ParentProcessId`，不能只看进程数量 | 用户自己可能开着 git-bash；按数量断言会假失败 |
| 父进程是 `magpie-bun.exe` 才算本项目拉起 | 插件宿主是 `magpie-bun.exe run C:/Users/41807/.cache/magpie/plugin-host/host-*.js`（F:290-293 实测命令行） |
| 窗口 `cmd.exe` / `conhost.exe` 也要查 | ConPTY 会额外拉 `conhost.exe`；只查 bash 会漏掉控制台宿主残留（F:299 实测宿主有 `conhost.exe` 子进程） |
| 等待窗口至少 5 秒再断言 | `kill()` 后约 1.07s 才消失，`exit` 路径约 2.1–2.8s（第 4 节）；1 秒内断言会假失败 |
| `wmic` 在本机可用但已被微软弃用 | 上面统一用 `Get-CimInstance`，避免未来版本移除 `wmic` 后脚本失效 |

---

## 9. 端到端可行性（为什么这套架构能成立）

F:428-443 用**完全符合目标架构**的形态验证过：一个无控制台的 Bun 进程在 `127.0.0.1:18881` 起 HTTP+WS，WS 后接真 PTY；另一个 Node 进程作为客户端连接并输入命令。

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

这条证据的意义：**HTTP+WS → PTY → 独立客户端** 这条链路在无控制台条件下已经跑通，T1 的风险不在「能不能跑」，而在「插件包装 + UI」是否写对。

> 与平台契约的一处冲突需注意：插件宿主协议本身是**逐行 JSON + 流式 chunk**，FINDINGS 建议本地服务把流式事件翻成 **SSE**（F:339）。但终端数据是双向的（用户输入要回传），SSE 单向不够，因此本项目 WS 只承载 PTY 的 stdin/stdout，AI 栏的流式回复走 SSE。这一点在 `docs/architecture.md`（他人编写）里定稿，此处只记录约束来源。

---

## 10. 待定

| 项 | 现状 | 选项 |
|---|---|---|
| `top` 是否可用 | **未单独实测**（vim 已 PASS，F:412-426）；`top` 在 msys 下是否存在取决于 git-bash 安装的包 | A 用 vim 作为全屏 TUI 的验收代表（BRIEF 5.1 第 2 条即如此）；B 额外实测 `top`/`less`。推荐 A |
| 暖场窗口的精确值 | 实测区间 250–500ms 均有效（F:163） | 取 300ms 固定值；拖拽场景用 250ms |
| 降级模式是否允许用户手动切回 | 未定 | A 自动重试 PTY / B 只在重启时重试。推荐 A（带退避） |

---

## 11. 已定

| 项 | 结论 | 依据 |
|---|---|---|
| 默认 shell | **bash（msys）优先，PowerShell 回退** | 探测顺序、WindowsApps 陷阱、msys 校验与回退路径见 `docs/architecture.md` 第 7 节 |

已定项不再留在第 10 节的「待定」表里：那一节只收纳真正未决的问题。
