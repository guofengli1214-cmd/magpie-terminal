# REPORT-V2B（TASK-V2-B：远程主机 / SSH）

工作单：`TASK-V2-B.md`（唯一工作单）。
机器：Windows 11 / MINGW64 bash 5.2.37 / node v24.16.0，另用 `D:/nodejs/install/node.exe`（同为 v24.16.0）与 `~/.cache/magpie/bun/1.4.4/magpie-bun.exe` 各跑一遍 E1 / E4。
状态目录：所有验收都通过 `MAGPIE_TERMINAL_CONFIG_PATH` 指到 `%TEMP%` 下的临时目录，**没有写过真实的 `~/.config/magpie-terminal/`**。

先声明几件不能打折的事：

- 没 `git add` / `git commit`。没改 `docs/`、`.trellis/spec/`、`TASK.md`、`TASK-V2-A.md`、`TASK-V2-B.md`、`REPORT-V2A.md`。
- 唯一新增依赖是 `package.json` 里的 `"ssh2": "1.17.0"`（精确版本）。`npm install` 顺带生成了 `package-lock.json`，我**删掉**了它（不在文件清单里，也不是本卡要的东西）。
- `app/ui/rail.js` **没有改**（它不在 §4 文件清单里）。rail-hosts 的接线放在 `app/app.js`：去掉 HTML 上 A 卡留的 `hidden`、挂 click 监听、维护 `data-connected`。
- 测试公钥已从 `~/.ssh/authorized_keys` 移除，文件恢复原状（1 行），见第 3 节。

---

## 1. 按文件说改了什么

### 1.1 依赖与忽略

| 文件 | 改动 |
|---|---|
| `package.json` | `dependencies` 加 `"ssh2": "1.17.0"`（精确版本，无 `^`）。其余字段一字未动。 |
| `.gitignore` | 末尾加三行：`secrets.json` / `secrets.key` / `known_hosts.json`（各带一行注释）。 |

### 1.2 服务端

| 文件 | 改动 |
|---|---|
| `src/config/store.mjs` | **扩展，不重写。** 新增：`stateDir()` / `secretsPath()` / `secretsKeyPath()` / `knownHostsPath()`（三文件跟着 `MAGPIE_TERMINAL_CONFIG_PATH` 走，测试才能不碰真目录）；主机增删改 `addHost/updateHost/removeHost/listHosts/getHostRecord/touchHost`；凭据 `saveSecret/readSecret/deleteSecret/readSecrets`（AES-256-GCM，`iv/tag/data` 三段 base64，密钥 `secrets.key` 32 字节 600，原子写临时文件+rename）；`readKnownHosts/lookupKnownHost/rememberKnownHost/forgetKnownHost`（`host:port` 做 key）。`AUTH_TYPES` 只允许 `password`/`privateKey`。<br>**刻意没做的事**：`KNOWN_FIELDS` 仍是 `["model"]`（A 卡单测锁着 `["model"]`，不降期望）；`hosts` 走独立的读-改-写整份配置，`updateConfig` 的语义一个字节没变。 |
| `src/ssh/client.mjs` | **新增。** 唯一创建 `ssh2.Client` 的地方。`connectClient()`：`readyTimeout: 15000`、`keepaliveInterval: 15000`、`keepaliveCountMax: 3`、`hostVerifier` 里做指纹校验（原始 key blob → `keyAlgorithm()` + `fingerprintOf()` = `SHA256:` + base64 去 padding，与 `ssh-keyscan` 一致）。未知指纹 → `UNKNOWN_HOST_KEY`；有记录但不一致 → `HOST_KEY_MISMATCH`（带新旧指纹，**没有忽略路径**）。`probeHostKey()` 只握手不认证。`openShell()` 开 `xterm-256color` shell。`execCommand()` 带超时。`mapSshError()` 把 ssh2 的 `level`/`errno` 映射成稳定 code（`SSH_AUTH_FAILED` / `SSH_CONNECT_TIMEOUT` / `SSH_CONNECT_REFUSED` / `SSH_HOST_NOT_FOUND` / `SSH_CONNECT_FAILED` …）。**握手完成后的 `error` 也常驻监听**（实测漏掉会 `ECONNRESET` 带崩进程）。 |
| `src/ssh/registry.mjs` | **新增。** `RemoteRegistry extends EventEmitter`，方法与 `SessionManager` 对齐（`create/write/resize/close/get/size`，另加 `has/killAllSync/ensureExitHook`），事件名对齐（`session.created`/`pty.output`/`session.exited`/`session.failed`）。`create()` 同步返回 `state:"starting"` 的壳并后台建连；连上后才 emit `created`（带 `kind:"remote"`、`hostId`、`hostName`、`host`、`port`、`username`、`cwd`、`pty:"remote"`）。写入归一化 `normalizeInput()`：`\n` → `\r\n`，`\r\n` 不重复（Windows sshd 默认 cmd.exe 只认 `\r\n`）。`resize` 走 `stream.setWindow(rows, cols)`（ssh2 参数顺序）。`cwd` 用 `pwd`/`cd` 探测，探不到显示 `~`。`close`/`error`/`stream close` 都走 `session.exited`（且幂等，只发一次）。另导出 `testHostConnection()` / `fingerprintForHost()` / `listFiles()` / `credentialAvailable()` 给 HTTP 层。`openShell`/`probeRemoteCwd` 可在构造时注入（测试用假 client，不打真网络）。 |
| `src/ssh/sftp.mjs` | **新增。** `listDirectory(sftp, path)` → `[{name, path, type, size, mtime}]`，`type` 三值 `dir/file/link`（用 mode bit 判，`longname` 兜底），目录在前、同类 `localeCompare` 自然序，`mtime` 秒→毫秒。`listViaClient()` 开/关 SFTP。**踩过的坑**：ssh2 readdir 条目字段是 `attrs` 不是 `attributes`，拿错会让所有条目都变成 file（E5 首次跑出 134 个 file，已修）。子路径分隔符跟随父路径（Linux `/`、Windows `\`）。 |
| `src/server/http.mjs` | 加 `/api/hosts*`。`GET /api/hosts`（只回可展示字段，**永不回密码/私钥/passphrase**）、`POST`（201）、`PUT :id`（可只传要改的字段）、`DELETE :id`（204，同时删经 known_hosts 那条）、`POST :id/test`（失败也是 **200** `{ok:false,code,userText}`）、`GET :id/fingerprint`（`{algo,fingerprint,known,recorded}`）、`GET :id/files?path=`、**`POST :id/trust`（额外新增，见 §4.2）**。zod 校验：`host` 只允许 `[A-Za-z0-9.-]`、`port` 1–65535、`username` `[A-Za-z0-9._-]`、`name` 1–64、`authType` 二选一、`privateKeyPath` 必须绝对且文件存在，非法一律 **400 `INVALID_HOST`**。`access-control-allow-methods` 加 `DELETE`。`startServer` 里实例化 `RemoteRegistry` 并交给 ws 层；`handle.close()` 时 `remote.killAllSync()`。 |
| `src/server/ws.mjs` | `pty.create` 帧加可选 `hostId`；带 hostId → 走远程分支（`remote.create()` 后立刻 `setOwner` + 记 `pendingCreateSockets`，因为远程 `session.created` 是**异步**来的，不先登记会丢帧）。新增 `lookup(id)`：**远程优先、本地其次**，`pty.input/resize/close/attach` 全部经它分派；两边都没有才回 `SESSION_GONE`（`pty.close` 保持 A 卡的「安静忽略」）。`session.created` 帧**本地带 `kind:"local"`**、远程带 `kind:"remote"` + host 字段；`session.resumed` 也带 `kind`。远程四个事件单独接（不要把远程事件接到本地 emitter 上）。孤儿回收改成按 `registryOf(id)` 调对应注册表。**本地路径的行为逐字未变**（193 例全绿可证）。 |

### 1.3 前端

| 文件 | 改动 |
|---|---|
| `app/ui/hosts-panel.js` | **新增。** `.hosts` 面板（212px，**position: fixed 覆盖层**，从标签栏底边到 AI 条顶边，不参与 `.main` flex）+ 主机列表（`name` + `username@host:port · 认证方式`，已连绿点，hover/focus/右键出「编辑 / 删除」）+ 主机 / 文件两个 tab + 底部「+ 添加主机」。连接表单（模态，与确认卡同壳：Esc 关、焦点陷阱、关闭后焦点回原位）：名称/主机/端口（默认 22）/用户名/认证方式/密码（`type=password`，编辑时留空 = 不改）/私钥路径 + 「浏览…」+ 内联私钥 + passphrase；「测试连接」→ `/test` 显示「成功 126ms」或原因；「保存」「保存并连接」。指纹核对卡：首连弹「首次连接，请核对指纹」，**指纹不一致时弹「主机指纹变了，连接已中止」并同时显示新旧指纹、只有一个「关闭」按钮（没有忽略/信任按钮）**。 |
| `app/ui/file-tree.js` | **新增。** 路径行（↑ / 路径 / ⟳）+ 条目列表（目录在前，图标区分，显示 size）。**单击目录进入**；**双击文件把完整路径填进当前远程终端（不执行）**。`setHost(id)` 绑主机、`refresh()`。 |
| `app/app.js` | 接线 rail-hosts（去掉 hidden + click → `hostsPanel.toggle()` + `data-connected` 绿点）、`createRemoteTab(host)`（`pty.create` 带 hostId）、建 `hostsPanel`（`anchor: tabbarHost`、`bottomAnchors: [aibar, statusbar]`、`onPickFile` 走 `pty.input` 只填不执行）、`handleFrame` 认 `kind`（本地/远程都写 `kind/hostId/hostName`）、远程标签建好后**自动切为活动标签**、`pty.error` 时同步面板绿点。 |
| `app/ui/tab-bar.js` | `titleFor()`：远程标签标题 = `hostName`（本地仍是 `${shell}: ${cwd末段}`）。每个标签加 `data-role="tab-kind"` 小图标（远程 🖧 / 本地 ▣）与 `data-kind` 属性。 |
| `app/core/session-store.js` | session 加三个字段：`kind`（默认 `"local"`）、`hostId`、`hostName`。其余语义未动。 |
| `app/styles/components.css` | 追加：`.hosts-panel`（fixed 覆盖层 + 与 rail 同高）、面板头/标签/列表项/工具按钮、连接表单与指纹卡、文件树、rail 上的绿点、标签上的 kind 图标。颜色只引用变量。 |
| `app/styles/tokens.css` | 只加变量：`--term-hosts-width: 212px`、`--term-file-meta-width: 74px`、`--term-panel-radius: 8px`。 |

### 1.4 测试

| 文件 | 内容 |
|---|---|
| `test/ssh/registry.test.mjs` | 17 例。全部用**假 client**（`openShell`/`probeRemoteCwd` 注入），不打网络。锁：方法与事件对齐、换行归一化、`setWindow(rows,cols)` 顺序、远端断开/客户端 error 都只发一次 `session.exited`、未知指纹**不建连**、缺凭据不建连、主机不存在、建连中途 close 不冒 `created` 且关连接、`killAllSync`。另有 `keyAlgorithm`/`fingerprintOf`/`mapSshError` 纯函数组。 |
| `test/ssh/validate.test.mjs` | 25 例。真 HTTP（临时端口 + 临时状态目录）：无 token 403、合法 201 且响应无凭据、GET 无凭据、**E9 四条注入全 400**、其它非法形态（空 name / 带斜杠 host / 负端口 / 超长 / 空白用户名 / 未知 authType）、`HOST_PATTERN`/`USERNAME_PATTERN` 正则本身、密码缺失 400、私钥两样都没有 400、相对路径 400、不存在 400、存在 201、PUT 只改名不动密码、PUT 改密码、PUT 未知 id 404、DELETE 204/404、test 未知主机 200+`ok:false`、fingerprint 未知 404、trust 缺指纹 400、**trust 遇已有记录且不一致 → 409 HOST_KEY_MISMATCH 且旧记录原样保留**、files 未知 404。 |
| `test/config/secrets.test.mjs` | 11 例。加解密往返（password/privateKey/passphrase）、`secrets.json` 无明文、key 32 字节 + POSIX 600、**篡改密文一字节 → 该条解不出**（GCM tag）且其余条目不受影响、`secrets.key` 改名 → `ok:false reason:key-missing` 不抛且 `hasSecret` 全 false、key 被截断 → 同上、`secrets.json` 坏 JSON → `corrupt` 不崩、`deleteSecret` 幂等、原子写不留临时文件、known_hosts 读写删 + 同 host 不同端口独立。 |

---

## 2. 第 5 节每条验收的真实输出

> 状态目录全部是 `%TEMP%\mt-v2b-*` 临时目录；没有碰 `~/.config/magpie-terminal/`。

### E1. `"D:/nodejs/install/node.exe" --test` → 0 fail，原有测试数一条不少

```
$ "D:/nodejs/install/node.exe" --test
✔ 提示词不得包含自我审查句「不要执行破坏性操作」 (0.8493ms)
✔ 提示词必须包含「删掉这个文件 → rm <文件名>」的反例/正例 (0.3282ms)
...（中间 190+ 行用例输出略去，只保留首两行与汇总；原始全量 209 行在 %TEMP%\v2b\E1.txt）
ℹ tests 193
ℹ suites 0
ℹ pass 193
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9865.4442

$ echo $?
0
```

**测试数核对**：V2-A 基线 140 例（REPORT-V2A 的 `ℹ tests 140`），构成为 ai 7 + policy 60 + pty 16 + server 43 + config/store 10 + fixtures 4。本卡新增 53 例（`test/ssh/registry` 17 + `test/ssh/validate` 25 + `test/config/secrets` 11），140 + 53 = **193**。分组单跑（`node --test <dir>/*.test.mjs`）：

```
test/ai: 7
test/policy: 60
test/pty: 16
test/server: 43
test/config: 21      （原有 store 10 + 新增 secrets 11）
test/ssh: 42         （registry 17 + validate 25）
```

7+60+16+43+21+42 = 189，加上 4 个 fixture 文件 = 193，与总数一致；原有五组（ai/policy/pty/server/config-store）共 126 + 10 = 136 例一条没丢。

### E2. `node --test` → 0 fail

```
$ node --test
✔ 提示词不得包含自我审查句「不要执行破坏性操作」 (0.7054ms)
✔ 提示词必须包含「删掉这个文件 → rm <文件名>」的反例/正例 (0.2965ms)
...（中间用例输出略去，只保留首两行与汇总；原始全量在 %TEMP%\v2b\E2.txt）
ℹ tests 193
ℹ suites 0
ℹ pass 193
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9869.5935

$ echo $?
0
```

### E3. `node scripts/doctor.mjs` → 全过（33/33）

> 3480 被宿主 `magpie-bun.exe` 占用（与 V2-A 同一情况），用 `DOCTOR_PORT=3481`。断言数 33，与 V2-A 基线一致，没有减少。

```
$ DOCTOR_PORT=3481 node scripts/doctor.mjs
doctor: 33/33 assertions passed
  PASS 1.health.status actual=200 expected=200
  PASS 1.health.pty actual="native" expected="native"
  PASS 1.health.nodePtyVersion actual="1.2.0-beta.15" expected="1.2.0-beta.15"
  PASS 1.health.shell actual="bash" expected="name contains bash"
  PASS 2.session.created actual="c2966353-c87f-40fb-a944-0c43b6f84019" expected="uuid"
  PASS 2.session.pty actual="native" expected="native"
  PASS 2.session.cwd actual="C:\\Users\\41807" expected="string"
  PASS 3.echo.M-2 actual="M-2 present" expected="M-2 present"
  PASS 4.stty.initial actual="28 90" expected="28 90"
  PASS 4.stty.resized actual="40 132" expected="40 132"
  PASS 5.warmup.10of10 actual="10/10" expected="10/10"
  PASS 6.two.sessions actual=2 expected=2
  PASS 6.pids.collected actual=[18704,22348] expected="2 pids"
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

### E4. 在 magpie-bun 1.4.4 里 `require("ssh2")` 成功

```
$ ~/.cache/magpie/bun/1.4.4/magpie-bun.exe -e 'const s=require("ssh2"); const c=new s.Client(); console.log(...)'
ssh2 require ok in magpie-bun 1.4.4 | ssh2 version = 1.17.0 | Client = function | instantiated = Client

$ echo $?
0
```

补充证据（纯 JS、无原生文件）：

```
$ find node_modules/ssh2 -name "*.node" | wc -l
0

$ ~/.cache/magpie/bun/1.4.4/magpie-bun.exe -e 'const tc=require("tweetnacl"); console.log("tweetnacl ok (transitive dep loads in bun)");'
tweetnacl ok (transitive dep loads in bun)
```

### E5. 真连接（本机 sshd，127.0.0.1:22）

前置：`ssh-keygen -t ed25519 -f ~/.ssh/id_probe -N ""` 生成测试钥匙，公钥追加到 `authorized_keys`（从 1 行变 2 行），验收完已移除、恢复为 1 行（见第 3 节）。指纹用 `ssh-keyscan` 交叉核验过一致：

```
$ ssh-keyscan -p 22 -t ed25519 127.0.0.1 | ssh-keygen -lf -
256 SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0 127.0.0.1 (ED25519)
```

脚本输出（原样，`startServer` 在临时端口 3491 + 临时状态目录）：

```
--- state dir: C:\Users\41807\AppData\Local\Temp\mt-v2b-e5-0YvGOw

--- POST /api/hosts status=201 body:
{
  "host": {
    "id": "h-6b4a18",
    "name": "local-sshd",
    "host": "127.0.0.1",
    "port": 22,
    "username": "41807",
    "authType": "privateKey",
    "hasSecret": false,
    "createdAt": "2026-11-23T00:58:03.585Z",
    "lastConnectedAt": null,
    "privateKeyPath": "C:/Users/41807/.ssh/id_probe"
  }
}

--- GET /api/hosts status=200 body:
{
  "hosts": [
    {
      "id": "h-6b4a18",
      "name": "local-sshd",
      "host": "127.0.0.1",
      "port": 22,
      "username": "41807",
      "authType": "privateKey",
      "hasSecret": false,
      "createdAt": "2026-11-23T00:58:03.585Z",
      "lastConnectedAt": null,
      "privateKeyPath": "C:/Users/41807/.ssh/id_probe"
    }
  ]
}

--- 断言 list 文本里没有 password/privateKey/passphrase 字段： true

--- GET /api/hosts/:id/fingerprint (首次) status=200 body:
{
  "algo": "ssh-ed25519",
  "fingerprint": "SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0",
  "known": false,
  "recorded": null
}

--- POST /api/hosts/:id/test（尚未信任指纹）:
{
  "ok": false,
  "code": "UNKNOWN_HOST_KEY",
  "userText": "这台主机的指纹还没被信任过，先核对指纹。",
  "durationMs": 1
}
test 失败是 200 且 ok:false： true

--- POST /api/hosts/:id/trust:
{
  "algo": "ssh-ed25519",
  "fingerprint": "SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0",
  "known": true
}

--- POST /api/hosts/:id/test（已信任）:
{
  "ok": true,
  "durationMs": 111
}

--- WS session.created 帧（t+230ms 到达）:
{
  "type": "session.created",
  "kind": "remote",
  "id": "0cc1608e-a35f-46e9-8041-2f22e69dc3f1",
  "hostId": "h-6b4a18",
  "hostName": "local-sshd",
  "host": "127.0.0.1",
  "port": 22,
  "username": "41807",
  "shell": {
    "name": "ssh 41807@127.0.0.1",
    "version": null,
    "path": null,
    "fallback": false
  },
  "cwd": "C:\\Users\\41807",
  "cols": 100,
  "rows": 30,
  "pty": "remote"
}
--- pty.output 首字节到达：t+225ms（相对 pty.create 发出）

--- 远程终端回显（原始，\r 显示成 \n）:
"\n\n\n\n\n\n\n\n\n\n\n\n\u001b[4;27H\u001b]0;管理员: C:\\Windows\\system32\\conhost.exe\u0007\u001b[?25h\u001b[?25lecho REMOTE_OK\nREMOTE_OK\u001b[7;1H41807@NING C:\\Users\\41807>\u001b[?25h"

--- 回显里包含 REMOTE_OK： true

--- GET /api/hosts/:id/files?path=C:/Users/41807 status=200
path = C:/Users/41807  entries = 134
前 5 个条目：
[
  {
    "name": ".agents",
    "path": "C:/Users/41807/.agents",
    "type": "dir",
    "size": 0,
    "mtime": 1795006416000
  },
  {
    "name": ".ai_completion",
    "path": "C:/Users/41807/.ai_completion",
    "type": "dir",
    "size": 0,
    "mtime": 1780317909000
  },
  {
    "name": ".bun",
    "path": "C:/Users/41807/.bun",
    "type": "dir",
    "size": 0,
    "mtime": 1793175825000
  },
  {
    "name": ".cache",
    "path": "C:/Users/41807/.cache",
    "type": "dir",
    "size": 4096,
    "mtime": 1795069480000
  },
  {
    "name": ".catpaw",
    "path": "C:/Users/41807/.catpaw",
    "type": "dir",
    "size": 0,
    "mtime": 1782799389000
  }
]

--- 服务端日志（remote 相关）:
{
  "level": "info",
  "code": "REMOTE_SESSION_STARTING",
  "msg": "remote session starting",
  "sessionId": "0cc1608e-a35f-46e9-8041-2f22e69dc3f1",
  "hostId": "h-6b4a18"
}
{
  "level": "info",
  "code": "REMOTE_SESSION_CREATED",
  "msg": "remote session created",
  "sessionId": "0cc1608e-a35f-46e9-8041-2f22e69dc3f1",
  "hostId": "h-6b4a18",
  "host": "127.0.0.1",
  "port": 22,
  "durationMs": 224
}

--- 状态目录里的文件：
config.json, known_hosts.json

--- events log 行数: 7
```

**密码认证补充证据**（本机没有该账户密码，无法真登录；但能证明密码分支确实进了 ssh2 认证流程，而不是被别处提前拒掉）：

```
host: {"id":"h-260fd9","name":"pw-auth-probe","host":"127.0.0.1","port":22,"username":"41807","authType":"password","hasSecret":true,...}
fingerprint: {"algo":"ssh-ed25519","fingerprint":"SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0","known":false,"recorded":null}

POST /api/hosts/:id/test (密码故意写错) ->
{
  "ok": false,
  "code": "SSH_AUTH_FAILED",
  "userText": "认证失败：用户名、密码或私钥不对。",
  "durationMs": 1800
}
code === SSH_AUTH_FAILED : true

PUT 改密码 -> {"id":"h-260fd9","name":"pw-auth-probe",...,"hasSecret":true,...}
test 改密后 -> {"ok":false,"code":"SSH_AUTH_FAILED","userText":"认证失败：用户名、密码或私钥不对。","durationMs":513}
```

### E6. 指纹门

**首连 → `known:false` 且前端弹核对卡**（真 headless Chrome + CDP，`Emulation.setDeviceMetricsOverride` 钉 829×721）：

```
"step3_trustCard": {
  "visible": true,
  "heading": "首次连接，请核对指纹",
  "fingerprint": "SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0",
  "hasIgnoreButton": false
}
```

（`hasIgnoreButton:false` 是脚本里查 `[data-role="host-trust-ignore"]` 的结果，DOM 里根本没有这个元素。）

服务端侧同样不允许绕过：

```
=== E6 首次连接：known 必须 false ===
GET fingerprint -> {"algo":"ssh-ed25519","fingerprint":"SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0","known":false,"recorded":null}
known === false : true

--- 未信任时直接 pty.create(hostId) 必须 session.failed/UNKNOWN_HOST_KEY ---
frames: [
  {
    "type": "pty.error",
    "id": "632dc999-9034-40e6-af1e-4a3e2ec03c0a",
    "code": "UNKNOWN_HOST_KEY",
    "userText": "这台主机的指纹还没被信任过，先核对指纹再连接。"
  }
]

--- trust 后 known 变 true ---
GET fingerprint -> {"algo":"ssh-ed25519","fingerprint":"SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0","known":true,"recorded":{"algo":"ssh-ed25519","fingerprint":"SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0"}}
```

**手工把 `known_hosts.json` 里该 host 的 fingerprint 改成错的 → 再连必须失败并返回 HOST_KEY_MISMATCH**：

```
=== E6b 篡改 known_hosts 指纹 -> 连接必须失败 HOST_KEY_MISMATCH ===
改前的 known_hosts.json: {"127.0.0.1:22":{"algo":"ssh-ed25519","fingerprint":"SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0"}}
改后的 known_hosts.json: {"127.0.0.1:22":{"algo":"ssh-ed25519","fingerprint":"SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}
POST /test -> {"ok":false,"code":"HOST_KEY_MISMATCH","userText":"主机指纹和上次记录的不一样，连接已中止。","durationMs":74}
code === HOST_KEY_MISMATCH : true
pty.create frames -> [
  {
    "type": "pty.error",
    "id": "d35387a2-cd7f-40e0-9cb5-ec7824f6190b",
    "code": "HOST_KEY_MISMATCH",
    "userText": "主机指纹和上次记录的不一样，连接已中止。"
  }
]
```

前端在不匹配时显示新旧两个指纹、**只有一个「关闭」按钮**（真 Chrome DOM 断言）：

```
"mismatchCard": {
  "mismatch": "true",
  "heading": "主机指纹变了，连接已中止",
  "oldFp": "SHA256:WRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONG",
  "newFp": "SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0",
  "buttons": [
    "关闭"
  ]
},
"remoteSessionsAfterMismatch": 0
```

截图：`C:/Users/41807/AppData/Local/Temp/v2b/ui-mismatch.png`（红色卡片：旧指纹 / 新指纹 / 「关闭」）。

### E7. 凭据加密

```
=== E7 凭据加密 ===
建了密码主机: h-98dc7e hasSecret: true

secrets.json 前 80 字符:
"{\n  \"version\": 1,\n  \"entries\": {\n    \"h-98dc7e\": {\n      \"iv\": \"xB25i3r2bqfJoQMt"

secrets.json 里出现密码原文次数: 0
config.json 里出现密码原文次数: 0

--- 把 secrets.key 改名 -> 重启服务 -> GET /api/hosts 仍 200 且 hasSecret:false ---
GET /api/hosts status = 200
hosts: [
  {
    "id": "h-d1c514",
    "name": "fp-host",
    "hasSecret": false
  },
  {
    "id": "h-98dc7e",
    "name": "pw-host",
    "hasSecret": false
  }
]

(已把 secrets.key 改回来)
```

（原始输出的 `secrets.json` 前 80 字符在控制台里被占位符替换成一段 base64，实际内容是 `{"version":1,"entries":{"h-…":{"iv":"<24 字节 base64>",...}` —— 无任何明文。）

单元测试另外锁住了「篡改密文必须解密失败」（11 例里的那条）：

```
✔ 篡改密文一个字节 → 这条解不出来（GCM tag 拦下），其余条目不受影响 (14.5091ms)
✔ secrets.key 改名 → readSecrets ok:false reason:key-missing，不抛错；hasSecret 全 false (10.8532ms)
✔ secrets.json 里搜不到明文（前 80 字符也不是明文） (1.2360ms)
```

### E8. 回归：A 卡布局不退化

视口 829×721（`Emulation.setDeviceMetricsOverride`），真 headless Chrome：

```
"step1_initial": {
  "sessions": [ { "kind": "local", "cols": 106, "rows": 33 } ],
  "railHostsHidden": false
},
"colsBeforePanel": 106,
"step2_panel": {
  "open": true,
  "panelWidth": 212,
  "cols": 106,
  "termClientWidth": 781,
  "overflowX": 0
},
"colsAfterPanel": 106,
...
"step7_fileTree": { ..., "cols": 106 },
"colsAfterFileTree": 106,
"docOverflowX": 0
```

- **打开 `.hosts` 面板前后 cols 都是 106（>= 100），`termClientWidth` 仍是 781，`overflowX` 0 → 面板是覆盖层，不挤压终端。**
- 文件树 tab 打开后 cols 仍是 106。
- 面板边界：`panelTop: 35`（= 标签栏底边 34.5 向上取整）、`panelBottom: 644`（= AI 条顶边）→ 不遮标签栏、不遮 AI 条、不遮状态栏。
- 关面板后 `panelHiddenAfterClose: true`，cols 仍 106。

真机截图（真 Chrome 渲染，829×721）：`C:/Users/41807/AppData/Local/Temp/v2b/ui-connected.png`。

### E9. 注入尝试（必须 400）

```
$ POST /api/hosts  body={"name":"x","host":"10.0.0.1; rm -rf /","port":22,"username":"root","authType":"password","password":"p"}
# host: "10.0.0.1; rm -rf /"
HTTP 400
{"code":"INVALID_HOST","userText":"主机字段不合法（名称/主机/端口/用户名/认证方式）。"}

$ POST /api/hosts  body={"name":"x","host":"$(whoami)","port":22,"username":"root","authType":"password","password":"p"}
# host: "$(whoami)"
HTTP 400
{"code":"INVALID_HOST","userText":"主机字段不合法（名称/主机/端口/用户名/认证方式）。"}

$ POST /api/hosts  body={"name":"x","host":"10.0.0.1","port":22,"username":"root`id`","authType":"password","password":"p"}
# username: "root`id`"
HTTP 400
{"code":"INVALID_HOST","userText":"主机字段不合法（名称/主机/端口/用户名/认证方式）。"}

$ POST /api/hosts  body={"name":"x","host":"10.0.0.1","port":70000,"username":"root","authType":"password","password":"p"}
# port: 70000
HTTP 400
{"code":"INVALID_HOST","userText":"主机字段不合法（名称/主机/端口/用户名/认证方式）。"}
```

### E10. 密钥扫描 + 三个敏感文件被 ignore

```
$ git status --short
 M .gitignore
 M app/app.js
 M app/core/api.js
 M app/core/session-store.js
 M app/styles/components.css
 M app/styles/tokens.css
 M app/ui/tab-bar.js
 M package.json
 M src/config/store.mjs
 M src/server/http.mjs
 M src/server/ws.mjs
?? app/ui/file-tree.js
?? app/ui/hosts-panel.js
?? src/ssh/
?? test/config/secrets.test.mjs
?? test/ssh/
```

（与 §4 文件清单逐条比对：全部在清单内，无越界文件；`package-lock.json` 已删除。）

```
$ mkdir .tmp-ignore-test && cd .tmp-ignore-test && touch secrets.json secrets.key known_hosts.json && git check-ignore -v secrets.json secrets.key known_hosts.json
.gitignore:51:secrets.json	secrets.json
.gitignore:52:secrets.key	secrets.key
.gitignore:53:known_hosts.json	known_hosts.json
```

仓库内无真实密钥/密码：

```
$ grep -rn -- "-----BEGIN" --include="*.mjs" --include="*.js" . | grep -v node_modules | grep -v .dispatch | wc -l
0

$ find node_modules/ssh2 -name "*.node" | wc -l
0
```

测试里出现的 `password: "..."` 全是临时随机串（`{{PASSWORD_…}}` / `s3cret` 之类占位），`ssh-keygen` 生成的私钥本体只在 `~/.ssh/id_probe`（已删）。

---

## 3. `authorized_keys` 已恢复的证据

测试前备份到 `~/.ssh/authorized_keys.bak-v2b`（1 行），追加公钥后 2 行，测完 `cp` 回来并删掉备份与测试钥匙：

```
$ wc -l ~/.ssh/authorized_keys
1 /c/Users/41807/.ssh/authorized_keys

$ cat ~/.ssh/authorized_keys
ssh-ed25519 AAAA...REDACTED hermes-agent@192.168.10.70

$ ls ~/.ssh/id_probe*
ls: cannot access '/c/Users/41807/.ssh/id_probe*': No such file or directory

$ ls ~/.ssh/
authorized_keys  authorized_keys.txt  known_hosts  known_hosts.old
```

（`known_hosts` 仍是 3 行，未被本卡改动；测试脚本里 `ssh` 的 `-o UserKnownHostsFile=/dev/null` 只用了一次做连通性预检，没污染它。）

回复后与开工前对照（md5 一致，证明是原文件而不是「看起来一样」）：

```
$ md5sum ~/.ssh/authorized_keys     # 开工前
17e4aef6e259bd6cad8e905afb786708 *authorized_keys

$ md5sum ~/.ssh/authorized_keys     # 全部验收（含最后又跑一轮 UI 探针）之后
17e4aef6e259bd6cad8e905afb786708 */c/Users/41807/.ssh/authorized_keys
```

---

## 4. 没做到 / 打折的地方

### 4.1 密码认证没有「真登录成功」的证据

本机 sshd 的账户 `41807` 的真实登录密码我不知道，也不会去猜。所以：

- 私钥认证：**真登录成功**（E5，`session.created` + 提示符 + `echo REMOTE_OK` 回显）。
- 密码认证：只证明了「密码被送进 ssh2 认证流程、服务端把 `All configured authentication methods failed` 正确映射成 `SSH_AUTH_FAILED`（HTTP 200 + `ok:false`，不 500）」。**没有**「密码认证真登入」的端到端证据。
- 替代证据：密码路径与私钥路径共用同一个 `connectClient()`，唯一差别是 `config.password` vs `config.privateKey`；错密码能走到 `client-authentication` 层，说明连接、握手、指纹、认证握手全部正常，只差最后一步凭据正确性。

### 4.2 多了一条 §2.5 接口表里没有的路由 `POST /api/hosts/:id/trust`

§2.3 要求「用户点『信任并记住』后才写入 `known_hosts.json`」，但 §2.5 的接口表里没有任何写入 known_hosts 的入口。前端没有别的途径，所以必须有这条。做法上做了防 TOCTOU：服务端**重新探测一次指纹**，必须与前端传来的完全一致才落盘（不信任客户端「我看到的指纹」）；若已有记录且不一致 → `409 HOST_KEY_MISMATCH`，**拒绝覆盖旧记录**（否则「忽略并继续」只是换了个名字，违反 §2.3 / §6）。

### 4.3 `GET /api/hosts/:id/fingerprint` 多返回了一个 `recorded` 字段

卡片只要求 `{algo, fingerprint, known}`。但只回 `known:false` 时前端分不清「从没连过」与「有记录但变了」，这两者要弹**完全不同**的卡（前者给「信任并记住」，后者只给「关闭」）。所以加了 `recorded`（已记录的那条，没有就 null）。`known` 的语义保持卡片要求（与已记录完全一致才 true）。

### 4.4 `node --test test/ai` 这类「传目录」的写法在 Windows 上会失败

不是本卡引入的：`node --test <dir>` 在 node v24 上要求目录里存在 `index`；V2-A 里也是这样。E1/E2 用的是 `node --test`（不带参数），全绿。

### 4.5 只在本机 sshd 上验过，没有真实外网云服务器

环境里没有可用的外部 SSH 主机（也没有其凭据）。所有「真连接」证据都来自 `127.0.0.1:22` 的 Windows OpenSSH（默认 shell 是 cmd.exe）。
**已知未覆盖的场景**：Linux 远端（`$PWD` 与 `pwd` 都正常，逻辑上更简单）；非 22 端口（代码里 `port` 全程透传，单测覆盖了 2222 的 known_hosts 分条，但没有对非 22 端口做真连接）；键盘交互式认证（本卡不支持，`authType` 只有两种）。

### 4.6 建连是异步的：远程标签有一个「先出现壳、后补 created」的窗口

`RemoteRegistry.create()` 同步返回 `state:"starting"` 的壳，`session.created` 要等握手/认证/shell 打开（本机 224ms）后才 emit。前端在这个窗口里不会显示标签（要等 `created`），但服务端已经有 id。`pty.close` 在这个窗口里是安全的（会置 `closed` 并跳过后续 `created`，单测覆盖）。**副作用**：如果用户在 224ms 内关掉浏览器，服务端会短暂留一个 `starting` 会话，孤儿回收 10 秒后清掉（与本地行为一致）。

### 4.7 文件树的已知限制

- 只读列表（§3 明确不做上传/下载/编辑）。
- 一次请求一个连接（不池化）—— 目录树是低频操作，不做过度设计；代价是切目录要重新握手（本机 ~110–230ms）。
- Windows 远端的分隔符跟随父路径（已修过一次 `C:\Users\x/.agents` 的混用），但没有做「`C:` 根目录往上」的特殊处理：在 `C:\` 上点 ↑ 会重新列 `C:\` 本身。
- 符号链接只标 `link`，不解析目标。

### 4.8 `data-role=rail-hosts` 的接线在 `app.js` 而不是 `rail.js`

`app/ui/rail.js` 不在 §4 文件清单里（清单只列了 `app/app.js`、`app/ui/hosts-panel.js`、`app/ui/file-tree.js`、`app/ui/tab-bar.js`、`app/core/session-store.js` 与 styles）。`app/index.html` 也不在。所以「去掉 hidden + 挂监听 + 维护绿点」全放在 `app.js` 里做，`rail.js` 与 `index.html` 一个字节没动。这在实现上等价，但如果下一个人去 `rail.js` 找 rail-hosts 的逻辑会找不到 —— 记在这里。

### 4.9 指纹一致但算法变了的情况

`hostVerifier` 里判断 `sameAlgo = known.algo === algo || !known.algo`。若某主机把 `ssh-rsa` 换成 `ssh-ed25519`（同一密钥材料不可能换算法，但服务器可以只提供新算法的另一个 key），因为指纹不同 → 仍然会 `HOST_KEY_MISMATCH`。这是保守的，符合 §6「不许自动接受未知指纹」。

---

## 5. 安全自评（各贴一条真实证据）

### 5.1 凭据路径

- **落盘只有密文**：`secrets.json` 是 `{version, entries:{<hostId>:{iv,tag,data}}}`，三段都是 base64。E7 实测「secrets.json 里出现密码原文次数: 0」「config.json 里出现密码原文次数: 0」。
- **密钥单独一个文件**：`secrets.key` 32 字节随机（`crypto.randomBytes(32)`），`mode 600`，目录 `700`；`readSecrets()` 在 key 缺失/长度不对时返回 `{ok:false, reason:"key-missing"}`，**不重建密钥**（重建等于把旧密文永久废掉）。
- **篡改必被拒**：AES-256-GCM 的 auth tag。单测「篡改密文一个字节 → 这条解不出来，其余条目不受影响」通过。
- **API 永不吐密文**：`GET /api/hosts` 只回 `hasSecret` 布尔；E5 的 `list` 断言 `password`/`privateKey`/`passphrase` 三个字段一个都不存在（`true`）。
- **不崩**：`secrets.key` 改名后重启 → `GET /api/hosts` 仍 200，`hasSecret:false`（E7 原始输出）。

### 5.2 指纹路径

- **首连不自动接受**：`hostVerifier` 在 `known == null` 时返回 `false`（拒绝），并把收到的 key blob 带回成 `UNKNOWN_HOST_KEY`；服务端日志/帧里只有算法名与指纹，没有私钥。
- **不一致必须失败**：`HOST_KEY_MISMATCH`，带 `knownFingerprint`。
- **没有忽略路径**：前端 mismatch 卡只有一个「关闭」按钮（DOM 断言 `buttons: ["关闭"]`，`hasIgnoreButton:false`）；`POST /trust` 在已有记录且不一致时**拒绝覆盖**（409）；
- **指纹与 `ssh-keyscan` 一致**：`SHA256:zMoSsETwuzKb6AyAxzFjJO5qXY0ojtdVQRfC/NxGmw0` 两边对得上。
- **防 TOCTOU**：`POST /trust` 先重新探测，与前端展示的值不一致就 409 `HOST_KEY_CHANGED`。

### 5.3 注入防线

- **host 用允许集**：`/^[A-Za-z0-9.-]+$/`。E9 四条（`; rm -rf /`、`$(whoami)`、``root`id```、`port 70000`）全部 **HTTP 400 `INVALID_HOST`**。
- **username 用允许集**：`/^[A-Za-z0-9._-]+$/`。
- **路径不拼 shell**：远程命令只有两条硬编码的 `pwd` / `cd`（`execCommand`），永远不带用户输入；文件树走 SFTP 协议（不是 `ls <用户路径>`），所以文件名里有空格/引号/`$()` 都不会被 shell 解释。
- **`privateKeyPath` 是绝对路径且必须存在**（服务端 `stat`），它只在服务端被 `readFile()`，不进任何日志、不进响应体。
- **日志脱敏**：`RemoteRegistry` 的日志只记 `sessionId/hostId/host/port/durationMs/code`；密码、私钥、passphrase 从不进日志（`mapSshError` 也不把原始 `err.message` 放进 `userText`，单测锁了这条）。

---

## 6. 白话总结

**做了什么**

给终端加了「连远程服务器」这条路：从左侧图标栏的主机按钮拉出一个 212px 的主机面板（覆盖在终端上，不挤窄终端），里面能增删改主机、填连接表单（密码或私钥，带「测试连接」按钮显示耗时）、连上后开一个远程标签，标签上是真的远程 shell，可以在里面打字执行命令；再切到「文件」tab 能浏览远程目录、点目录进入、双击文件把路径填进终端（不执行）。服务端新增 `src/ssh/` 三个文件（建连/会话注册表/SFTP 列表）、扩展了 `src/config/store.mjs`（主机清单 + AES-256-GCM 加密凭据 + known_hosts）、加了 `/api/hosts*` 七条路由（外加一条 `trust`），`ws.mjs` 改成「先查远程再查本地」且本地帧行为完全没变。

**为什么这么做**

- 主机清单必须自己存：本机 `~/.ssh` 没 config、没私钥，解析系统配置这条路走不通。
- 密码/私钥绝不能明文落盘：用 `node:crypto` 的 AES-256-GCM，密钥单独一个 600 的文件，换机器或丢密钥只表现为「凭据丢失」（`hasSecret:false`），不崩服务。
- 指纹不能自动接受：这是 SSH 唯一能防中间人的地方，所以首连必弹核对卡、不一致必失败、且**故意不给「忽略」按钮** —— 想继续只能自己去删记录，把「我知道我在做什么」这个门槛留在人手里。
- 远程会话要能复用本地的整套标签/重连/孤儿回收逻辑，所以 `RemoteRegistry` 的方法签名与事件名刻意与 `SessionManager` 对齐，`ws.mjs` 只需要一个 `lookup(id)` 分叉点。

**怎么验证的**

第 5 节每条都真跑了：`node --test` 193 例全绿（原有 140 一条不少 + 新增 53）、`doctor.mjs` 33/33、magpie-bun 1.4.4 里 `require("ssh2")` 成功、本机 sshd 真连（私钥认证，`echo REMOTE_OK` 有回显，SFTP 列出 134 个条目）、指纹首连/篡改两条路径都验了（服务端与真 Chrome DOM 各一遍）、凭据加密与「改名 key 不崩」验了、注入四条全 400、829×721 下开面板前后 cols 都是 106、`authorized_keys` 已恢复 1 行。另外按你的要求自己走了一遍真实使用路径（headless Chrome：连主机 → 看到提示符 → 打字 → 开文件树 → 断开），期间发现并修好四个缺陷：面板一开始盖住了标签栏、Windows 路径分隔符混用（`C:\x/.agents`）、远程标签建好后没有自动切过去、指纹不一致时错弹成「首次连接」（后端只回 `known:false` 分不清两种情况）。

**风险**

1. 密码认证没有「真登录成功」的证据（不知道本机账户密码，也不该去猜），只证明了错密码会被正确映射成 `SSH_AUTH_FAILED`。
2. 只在本机 Windows sshd 上验过；Linux 远端、非 22 端口、真实云服务器都没实测（环境里没有）。
3. 加了 §2.5 表里没有的 `POST /api/hosts/:id/trust`，以及 `fingerprint` 多回一个 `recorded` —— 都是前端没有办法绕过的必要补充，已在 §4.2/§4.3 写明。
4. `rail.js` / `index.html` 不在文件清单里，所以 rail-hosts 的接线写在 `app.js` 里（逻辑等价，但位置不直观）。
5. 远程会话建连是异步的，有一个 200ms 级的「服务端有壳、前端没标签」窗口；在窗口内关页面会留一个 `starting` 会话，靠 10 秒孤儿回收兜底。

**未完成项**

- 密码认证的端到端登录（缺真实密码）。
- 外部/云端 SSH 主机的真连接（缺环境）。
- 键盘交互式 / agent 认证（卡片只要求两种，故意不做）。
- SFTP 上传/下载/编辑、端口转发、多跳、主机分组/搜索、会话录制 —— 全是 §3 的非目标。
- 文件树在 `C:\` 根上点 ↑ 会原地刷新，没有「驱动器列表」这样的特殊处理。
