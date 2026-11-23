# TASK V2-B：远程主机（SSH）

你是编码 agent。本卡是唯一工作单。**TASK-V2-A 已经实现并通过验收，你必须先读它的产出再动手。**

---

## 0. 开工前必读

1. `TASK-V2-A.md` 与 `REPORT-V2A.md` —— A 卡的接口约定与已落地结果
2. `src/config/store.mjs`（A 卡新增）—— 本卡要在它上面加 `hosts`，**不许另写一套配置读写**
3. `.trellis/spec/backend/pty-lifecycle.md`、`security-model.md`、`magpie-plugin-contract.md`
4. `docs/security.md`、`docs/architecture.md`
5. `src/pty/session.mjs`、`src/server/ws.mjs`、`src/server/http.mjs`
6. `app/ui/rail.js`、`app/app.js`、`app/ui/tab-bar.js`、`app/core/session-store.js`
7. `C:/Users/41807/AppData/Local/hermes/skills/autonomous-ai-agents/magpie-plugin-development/references/pty-in-bun-host.md`

---

## 1. 为什么要做（已实测的事实，不用重新论证）

- 用户要连远程云服务器，形态选了「连接表单 + 密码框 + 文件树」，**接受新增 ssh2 依赖**。
- `ssh2@1.17.0` 已在本机实测：纯 JS、无 `.node` 原生文件，在 **magpie-bun 1.4.4** 与 node v24 上 `require` 成功，`Client` 可实例化。
- 真连本机 sshd 实测通过：handshake 93ms → ready 126ms → exec 208ms → **shell open 219ms，2021ms 收到 282 字节回显** → sftp open 2076ms → **sftp readdir 2096ms 拿到 134 个条目**。
- **Windows sshd 陷阱**：默认 shell 是 cmd.exe，不认 bash 语法；**PTY 写入必须用 `\r\n`，光 `\n` 不回显**。Linux 远端同样建议 `\r\n`（终端里就是回车）。
- 本机 `~/.ssh` **没有 config、没有私钥**；`known_hosts` 只有 3 条。所以主机清单必须由插件自己存，不能靠解析 `~/.ssh/config`。

---

## 2. 目标

### 2.1 依赖

`package.json` 加 `"ssh2": "1.17.0"`（精确版本，不加 `^`）。这是本卡唯一允许新增的依赖。

### 2.2 主机配置与凭据

配置文件沿用 `src/config/store.mjs`，`~/.config/magpie-terminal/config.json` 新增：

```json
{
  "model": "…",
  "hosts": [
    {
      "id": "h-1a2b3c",
      "name": "prod-web",
      "host": "10.0.0.12",
      "port": 22,
      "username": "root",
      "authType": "password",
      "hasSecret": true,
      "createdAt": "2026-11-23T01:00:00.000Z",
      "lastConnectedAt": "2026-11-23T01:02:00.000Z"
    }
  ]
}
```

- `authType` 只允许 `"password"` | `"privateKey"`。
- `privateKey` 认证额外存 `"privateKeyPath"`（本机路径字符串）或 `"hasInlineKey": true`（用户粘贴的 key 走加密存储）。二者至少一个。
- **`GET /api/hosts` 永不返回密码、私钥正文、passphrase**。只返回 `hasSecret` 布尔。

凭据单独落盘：`~/.config/magpie-terminal/secrets.json`，结构由你定，但必须：
- 用 `node:crypto` 的 AES-256-GCM 加密，密钥是 `~/.config/magpie-terminal/secrets.key`（32 字节随机，权限 600）
- 目录 700、文件 600
- 原子写（临时文件 + rename）
- 解密失败（换机器 / 文件损坏）→ 视为「凭据丢失」，在 `/api/hosts` 里 `hasSecret:false`，**不抛错、不崩服务**

这三个文件（config.json / secrets.json / secrets.key）都必须在 `.gitignore` 里。**`.gitignore` 允许本卡修改，仅限加这三行。**

### 2.3 主机指纹校验（不许跳过）

- 首次连某主机：**不自动接受**。服务端把收到的 host key 算法 + SHA256 指纹（`ssh-keyscan` 风格的 base64 摘要）回给前端，前端弹一张「首次连接，请核对指纹」卡，用户点「信任并记住」后才写入 `~/.config/magpie-terminal/known_hosts.json` 并完成连接。
- 之后每次连接比对已存指纹；**不匹配时连接必须失败**，错误码 `HOST_KEY_MISMATCH`，前端显示新旧两个指纹，且**不提供「忽略并继续」按钮**（只能用户自己去删掉那条记录）。
- `known_hosts.json` 用 `host:port` 做 key，值 `{algo, fingerprint}`。

### 2.4 服务端 SSH 层

新增 `src/ssh/` 目录：

| 文件 | 职责 |
|---|---|
| `client.mjs` | 建连（含指纹校验回调）、exec、开 shell、开 sftp、keepalive、超时、错误码映射 |
| `registry.mjs` | 远程会话注册表，**方法签名与 `SessionManager` 对齐**：`create/write/resize/close/get/size`，事件名对齐 `session.created`/`pty.output`/`session.exited`/`session.failed` |
| `sftp.mjs` | `list(path)` → `[{name, path, type:"dir"\|"file"\|"link", size, mtime}]`，按目录名排序、目录在前 |

`src/ssh/registry.mjs` 的 `create({ hostId, cols, rows })` 必须：
- 从 config 取 host、从 secrets 取凭据
- 建连超时 15s（`readyTimeout`），keepalive `interval: 15000, count: 3`
- 开 `shell({ term: "xterm-256color", cols, rows })`，把 stdout/stderr 都接到 `pty.output`
- 保存远程 `cwd`（`shell` 上来时的 `$PWD` 或首次 `pwd` 的输出，取不到就显示 `~`）
- 断线：`close`/`error` 事件都要走 `session.exited`，前端掉标签

**ws.mjs 路由改造**：现在 `pty.*` 帧直接调 `sessions.*`。改成先查远程注册表再查本地，两者都没有才回 `SESSION_GONE`。`session.created` 帧加 `kind: "local" | "remote"`，远程另带 `hostId`、`hostName`、`host`。**本地行为一个字都不许变。**

### 2.5 HTTP 接口

全部要求 token（与 `/api/health` 同一道门）：

```
GET    /api/hosts              -> { hosts: [...] }
POST   /api/hosts              -> body: {name, host, port, username, authType, password?|privateKey?|privateKeyPath?, passphrase?}
                                  -> 201 { host }（不含 secret）；字段非法 400 INVALID_HOST
PUT    /api/hosts/:id          -> 同上，可只传要改的字段；改密码需带 password
DELETE /api/hosts/:id          -> 204；同时删 known_hosts 里那条
POST   /api/hosts/:id/test     -> 只建连不开 shell，测通 -> { ok:true, durationMs }
                                  失败 -> 200 { ok:false, code, userText }（不 500，失败是正常结果）
GET    /api/hosts/:id/fingerprint -> { algo, fingerprint, known: bool }（用于首次连接的核对卡）
GET    /api/hosts/:id/files?path=/var/log -> { path, entries: [...] }
```

校验规则（`zod`）：
- `host` 只允许 `[A-Za-z0-9.-]`（**不许出现 `/`、`;`、`$()`**）；`port` 1–65535；`username` `[A-Za-z0-9._-]`；`name` 长度 1–64
- `privateKeyPath` 必须是绝对路径且文件存在，否则 400

### 2.6 前端

**rail 按钮 `data-role=rail-hosts`**（A 卡留的占位）变成真入口：点击滑出 `.hosts` 面板（212px，覆盖在终端之上，**不挤压终端宽度** —— 保持 A 卡的 103 列不被破坏）。

`.hosts` 面板内容：
- 顶部：「主机」标题 + 「+ 添加」按钮
- 列表：每项显示 `name` + `username@host:port`；已连接的主机左侧一个绿色圆点；右键或悬停出现「编辑 / 删除」
- 点击主机：若从未连接过 → 先弹「首次连接核对指纹」卡；否则直接建远程标签
- 底部：「+ 添加主机」打开连接表单

**连接表单**（浮层，与确认卡同层，`Esc` 可关）：
- 字段：名称、主机、端口（默认 22）、用户名、认证方式（密码 / 私钥）
- 密码方式：`input[type=password]`，**不得回显已存密码**（编辑时留空 = 不改）
- 私钥方式：路径输入 + 「浏览…」按钮（本卡不要求文件选择器，路径手填即可）+ 可选 passphrase
- 「测试连接」按钮 → 调 `/api/hosts/:id/test`，显示「成功 126ms」或错误原因
- 「保存」→ POST/PUT；「保存并连接」→ 保存后立即建标签

**远程标签**：
- 标签标题 = `hostName`（A 卡 `titleFor()` 现在是 `${shell}: ${cwd末段}`，远程改用它）
- 终端里就是远程 shell，键盘输入走 `pty.input`（**写 `\r\n` 的处理在服务端 shell.write，前端照旧发 `\r` 或 `\n` 都可以，但服务端要归一化**）
- 标签上有个小图标区分本地/远程（`data-kind="remote"`）

**文件树**（远程标签建立后可用）：
- 面板位置：`.hosts` 面板内切换成「主机 / 文件」两个 tab，或独立 240px 层 —— 你选一种，但**不许挤压终端宽度**
- 内容：当前目录路径 + 条目列表（目录在前，图标区分 dir/file/link，显示 size 与 mtime）
- 点目录 → 进入；点 `..` → 上一级
- 双击文件 → 把文件名（带路径）插入到当前远程终端输入（**不执行**，只填，让用户自己按回车）
- 刷新按钮

---

## 3. 非目标

- 不做 SFTP 上传/下载/编辑（只读列表）
- 不做端口转发、代理跳板、多跳
- 不做密钥生成、不做 `ssh-copy-id`
- 不做主机分组、标签、搜索
- 不做会话录制
- 不改本地 PTY 的任何既有行为（A 卡与 T1/T2 的所有测试必须原样全绿）
- 不改 `page/` 带路页
- 不改 `docs/`、`.trellis/spec/`、`TASK.md`、`TASK-V2-A.md`、`TASK-V2-B.md`

---

## 4. 文件清单

| 文件 | 动作 |
|---|---|
| `package.json` | 加 `ssh2: 1.17.0` |
| `.gitignore` | 加 `secrets.json` `secrets.key` `known_hosts.json` |
| `src/ssh/client.mjs` | 新增 |
| `src/ssh/registry.mjs` | 新增 |
| `src/ssh/sftp.mjs` | 新增 |
| `src/config/store.mjs` | 扩展：`hosts` 增删改、`secrets` 加解密、`knownHosts` 读写 |
| `src/server/http.mjs` | 加 `/api/hosts*` 路由 |
| `src/server/ws.mjs` | 帧路由先查远程再查本地；`session.created` 带 `kind`；新增 `pty.create` 的 `hostId` 可选字段 |
| `app/ui/hosts-panel.js` | 新增（面板 + 列表 + 表单 + 指纹核对卡） |
| `app/ui/file-tree.js` | 新增 |
| `app/app.js` | 接线 rail-hosts、远程标签、`handleFrame` 认 `kind` |
| `app/ui/tab-bar.js` | `titleFor()` 认远程；加 kind 图标 |
| `app/core/session-store.js` | session 加 `kind`/`hostId`/`hostName` |
| `app/styles/components.css` | 面板与表单样式 |
| `app/styles/tokens.css` | 只加变量 |
| `test/ssh/registry.test.mjs` | 新增（用假 client，不打真网络） |
| `test/ssh/validate.test.mjs` | 新增（主机字段校验 + 注入尝试必须 400） |
| `test/config/secrets.test.mjs` | 新增（加解密往返、篡改密文必须解密失败、缺 key 文件不崩） |

---

## 5. 验收（真跑，贴原始输出）

```
E1. "D:/nodejs/install/node.exe" --test        -> 0 fail，且原有测试数一条不少
E2. node --test                                 -> 0 fail
E3. node scripts/doctor.mjs                     -> 全过
E4. require 检查：在 magpie-bun 1.4.4 里 require("ssh2") 成功（贴真实输出）
E5. 真连接（本机 sshd，127.0.0.1:22）
      - POST /api/hosts 建一条 username=41807, authType=privateKey, privateKeyPath=C:/Users/41807/.ssh/id_probe
        （需要先 ssh-keygen 生成一把测试钥匙并把公钥加到 authorized_keys，测完删掉公钥、恢复 authorized_keys 原状，
          备份到 authorized_keys.bak-v2b 并在报告里说明已恢复、wc -l 为 1）
      - GET /api/hosts 断言不含任何密码/私钥字段（贴出真实响应 JSON）
      - POST /api/hosts/:id/test -> 贴 {ok, durationMs}
      - 建远程标签 -> 贴 magpie 日志里的 session.created(kind=remote) 与 pty.output 首字节时间
      - 在远程终端里输入 echo REMOTE_OK -> 贴真实回显
      - GET /api/hosts/:id/files?path=C:/Users/41807 -> 贴前 5 个条目
E6. 指纹门
      - 首次连一条没记录过的 host -> 必须回 known:false 并弹核对卡（贴前端截图或 DOM 断言）
      - 手工把 known_hosts.json 里该 host 的 fingerprint 改成错误的 -> 再连必须失败并返回 HOST_KEY_MISMATCH（贴真实错误）
E7. 凭据加密
      - 贴出 secrets.json 前 80 字符（证明不是明文）
      - 断言文件里搜不到密码原文（grep 结果为 0）
      - 把 secrets.key 改名 -> 重启服务 -> GET /api/hosts 仍 200 且 hasSecret:false（不崩）
E8. 回归：A 卡的布局不退化
      - 视口 829x721 下 xterm cols 仍 >= 100
      - 打开 .hosts 面板后 cols 不变（面板是覆盖层不是挤压）
E9. 注入尝试（必须 400，贴真实状态码）
      - host: "10.0.0.1; rm -rf /"
      - host: "$(whoami)"
      - username: "root`id`"
      - port: 70000
E10. 密钥扫描：仓库内无真实密码/私钥；git status 里三个敏感文件被 ignore
```

---

## 6. 禁止

- 不许在日志、错误信息、响应体里出现密码或私钥正文
- 不许自动接受未知指纹（没有「忽略」路径）
- 不许把凭据明文落盘
- 不许改本地 PTY 行为或降低 A 卡/card 测试的期望
- 不许 `git add` / `git commit`
- 不许新增 ssh2 以外的依赖
- 不许在 `authorized_keys` 里留下测试公钥

---

## 7. 报告

写 `REPORT-V2B.md`：
1. 按文件说改了什么
2. 第 5 节每条的真实输出
3. `authorized_keys` 已恢复的证据（`wc -l` 与内容）
4. 没做到 / 打折的地方
5. 安全自评：凭据路径、指纹路径、注入防线，各贴一条真实证据

末尾一段话说清：能连几种认证方式、文件树能不能用、还有什么坑。
