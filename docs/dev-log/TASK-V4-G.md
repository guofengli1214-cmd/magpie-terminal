---
id: TASK-V4-G
title: 文件面板（跟随当前目录 + 增删改查上传下载）（V4-G）
status: approved
plan_version: docs/mockups-v4（v4b）+ 用户 m03646 第 10 条 + m03696 选 A
approval_ref: 用户 m03646 第 10 条；m03696 选 A（完整版，允许写 shell profile，本卡改用 --rcfile 注入达成同等效果且不碰用户文件）
priority: P0
executor: pi
model_tier: 人类指定 commandcode/deepseek/deepseek-v4.1-flash（provider magpie）
attempt: 1
retry_budget: 2
escalation_policy: ask_human
session_policy: new_session_required
session_id: null
inputs:
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/hosts-files.html（文件区视觉权威）
  - C:/Users/41807/magpie-terminal/docs/mockups-v4/CHANGES-V4.md §2 D2/D6、§4 第 11 与 15 条
  - C:/Users/41807/magpie-terminal/app/ui/file-tree.js（现有远程文件树）
  - C:/Users/41807/magpie-terminal/src/ssh/sftp.mjs（现有 SFTP 列表）
  - C:/Users/41807/magpie-terminal/src/ssh/registry.mjs（listFiles）
  - C:/Users/41807/magpie-terminal/src/pty/session.mjs（会话 cwd 目前只在 create 时记一次）
quality_benchmark: 对照 docs/mockups-v4/shots/ 里 v4b 文件区截图（1280×760 / 1440×900）；可比理由=同一信息密度与配色；不照搬其假数据。
verification: 主 agent 独立实跑（真建目录/真上传/真下载/真删除）+ node --test + doctor
verifier: independent_new_session
depends_on: [TASK-V4-E]
---

# 1. 背景

用户要一个真正的文件面板：主机与文件分开、文件区在终端下方横向铺开、高度可拖、**实时显示当前终端所在目录**，并且能新建、删除、查看、编辑、上传、下载。现在只有 `app/ui/file-tree.js` 一个只读的远程目录列表，本地目录根本没有接口，会话的 cwd 也只在 `create()` 时记一次、之后永不更新。

# 2. 目标

1. 文件面板成为独立区域（终端下方，横向图标网格，可拖高、高度记忆），不再塞在主机面板里。
2. 本地会话：跟随 shell 的当前目录（bash 用 `--rcfile` 注入 OSC 7，PowerShell/pwsh 用 prompt 函数发 OSC 7），服务端与前端都能拿到 cwd。
3. 远程会话：跟随 `cd`（同样靠 OSC 7；远程 shell 一般是 bash，够用）。
4. 文件操作：列表、新建文件夹、新建文件、查看（文本预览）、编辑保存、重命名、删除、上传、下载。
5. 安全边界写清楚：所有接口都要 token；路径必须是绝对路径；删除要显式确认；拒绝删盘根与家目录根。

# 3. 非目标

- 不做拖拽上传之外的花样（拖拽上传可以做，但**文件选择框上传必须有**）。
- 不做图片/PDF 内联预览（文本查看与「下载后用系统程序打开」即可）。
- 不做权限位编辑、不做 chmod、不做搜索（下一轮再说）。
- 不改 SSH 主机管理与 AI 会话（V4-F/H）。
- 不引入新依赖（上传用原始 body PUT，下载用流式 GET，不用 multipart）。

# 4. 病根（已实测）

- `src/pty/session.mjs:78 create({cols,rows,cwd})` 只在建会话时定 `cwd`，`:87 cwd: workdir`，之后 `write()`/`resize()` 都不更新。
- 仓库里没有任何 OSC 7 处理：`grep -r "\\x1b]7" src/ app/` 为空。
- `app/ui/file-tree.js` 只调 `GET /api/hosts/:id/files?path=`，本地没有对应接口。
- `src/ssh/sftp.mjs` 只有 `listViaClient()`（一次请求一条连接），没有 read/write/mkdir/delete/upload/download。

# 5. 执行步骤

## 5.1 服务端：OSC 7 采集 cwd

- `src/pty/session.mjs` 的 `handleOutput(session, data)` 里，用增量解析器扫 `ESC ] 7 ; file://HOST/PATH BEL` 或 `ESC ] 7 ; file://HOST/PATH ESC \`，解出路径（URL 解码，Windows 下 `/C:/Users/x` 要还原成 `C:\Users\x`），更新 `session.cwd`，并 emit `session.cwd` 事件 `{id, cwd}`。
- 解析必须容忍 ANSI 序列被拆到两个 chunk（保留未完成的尾部，上限 4KB，超了丢弃）。
- `ws.mjs` 订阅 `session.cwd` → 推 `session.cwd` 帧给 owner（新增 OutFrame 类型）。
- `GET /api/health` 的 sessions 明细如已有 cwd，会自然变新；不新增字段。

## 5.2 服务端：bash 注入 OSC 7（不改用户文件）

- 启动 bash 时（`shell.id === "bash"`），生成临时 rc 文件到 `os.tmpdir()/magpie-term-rc-<pid>.sh`，内容：
  ```sh
  [ -f ~/.bashrc ] && . ~/.bashrc
  __magpie_osc7() { printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$PWD"; }
  case "$PROMPT_COMMAND" in *__magpie_osc7*) ;; *) PROMPT_COMMAND="__magpie_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;; esac
  ```
  以 `args: ["--rcfile", <path>, "-i"]` 启动（实测这条路径可行，rc 里 source `~/.bashrc` 不会丢用户配置）。
- 临时 rc 在会话退出时删除；进程退出时兜底清理。
- PowerShell / pwsh：`args` 追加 `-NoExit -Command "function global:prompt { \"`e]7;file://$env:COMPUTERNAME/$($PWD.Path -replace '\\\\','/')\`e\\\" ; \"PS $($PWD.Path)> \" }"`（写成文件再 `-File` 更稳，自己选，但**必须实测能出 OSC 7**）。
- 兜底：注入失败（`args` 不生效）时不能崩，只是 cwd 不跟随，日志记一条。

## 5.3 服务端：本地文件 API（新文件 `src/fs/local.mjs` + 路由）

统一前缀 `/api/fs`，全部需要 token：
- `GET /api/fs/list?path=<abs>` → `{ path, parent, entries:[{name,type:"file"|"dir"|"link",size,mtime}] }`，按 dir 优先、名称升序；隐藏文件也返回（前端自己决定是否显示）。
- `GET /api/fs/read?path=<abs>&maxBytes=…` → 文本内容（默认上限 1 MB，超过返回 413 `FILE_TOO_LARGE`；二进制检测：前 8KB 有 NUL 就 415 `NOT_TEXT`）。
- `PUT /api/fs/write?path=<abs>`：原始 body 写到目标（先写 `.tmp` 再 rename，原子）；父目录必须存在。
- `POST /api/fs/mkdir` `{path}`：递归创建。
- `POST /api/fs/rename` `{from,to}`。
- `DELETE /api/fs?path=<abs>&recursive=0|1`：非空目录且 `recursive=0` → 409 `DIR_NOT_EMPTY`。
- `POST /api/fs/upload?path=<dir>`：原始 body + `x-filename` 头（URL 编码），流式写盘，单文件上限 200 MB，超限 413。
- `GET /api/fs/download?path=<abs>`：流式返回，`Content-Disposition: attachment; filename*=UTF-8''…`。
- `GET /api/fs/stat?path=<abs>`。
- 路径守卫：必须 `path.isAbsolute`；拒绝含 `\0`；`resolve()` 后再用；拒绝删除 `C:\`、`C:\Users\<user>`（家目录根本身）、以及任何 root 的上一层（例如 `C:\` 的 parent 是自己）。错误统一 `{code, userText}`，中文人话。

## 5.4 服务端：远程文件 API（扩展 sftp）

- `src/ssh/sftp.mjs` 增加：`readFile(client,path)`、`writeFile(client,path,data)`、`mkdir`、`rename`、`remove`（文件/空目录）、`stat`、`createReadStream`/`createWriteStream`（下载/上传用）。
- 路由 `/api/hosts/:id/fs/*` 与本地同名同形，`list` 复用现有 `listViaClient`。
- 远程删目录：只允许空目录（`rmdir`），不递归，UI 里说清楚。

## 5.5 前端：文件面板

- 新文件 `app/ui/file-panel.js`；挂在 `section.main` 内、终端下方（E 卡已按设计稿留了分界位置）。
- 顶部工具条：当前路径（可点击面包屑/可直接编辑输入框）、刷新、新建文件夹、新建文件、上传（`<input type="file" multiple>` + 拖拽到面板也行）、右上「关闭面板」。
- 主体：横向图标网格（`grid-auto-flow: column` 或 `flex-wrap`，按设计稿），每个条目显示图标 + 名称 + 大小；单击选中，双击目录进入、双击文件打开查看器。
- 条目右键/悬浮操作：查看、编辑、重命名、下载、删除。
- 查看器：模态，文本只读、等宽、可复制；编辑：同模态可写，Ctrl+S 保存（走 `PUT /api/fs/write`）。
- 删除：确认卡写明「将永久删除 X（N 项）」，默认焦点在取消上。
- 上传：显示进度（`XMLHttpRequest` 的 progress 事件），完成后刷新列表；失败给中文原因。
- 跟随 cwd：收到 `session.cwd` 帧且当前面板对应的会话是该会话、且用户没有手动切过目录（记住 `manualPath` 标记）→ 自动跳到新目录；用户手动进目录后停止跟随，工具条上给一个「回到终端目录」按钮恢复跟随。
- 高度：拖拽分界可调 150–520px，写 `localStorage` key **`magpie.term.filePanelHeight`**；分界必须满足 CHANGES-V4 §4 第 15 条（1px 亮线 + `inset 0 7px 14px` 内投影 + 常显 46×4 把手）。
- 主机与文件分开：主机面板只留主机相关；文件入口在左侧图标栏（`rail-files`，可用现有 `rail-hosts` 旁边的位置，自己按设计稿定），点击开合文件面板。
- 远程会话：文件面板自动切到该主机的远程目录（用 `/api/hosts/:id/fs/list`），路径框显示远程路径，上传/下载走远程接口。

## 5.6 测试

- `test/fs/local.test.mjs`：列表/读/写/新建/重命名/删除/越界路径/超限/非空目录不可删，覆盖 8 条以上。
- `test/pty/osc7.test.mjs`：解析器单测（跨 chunk 拆分、URL 解码、Windows 路径还原、非法包丢弃）。
- `test/server/fs-route.test.mjs`：鉴权、绝对路径校验、404/409/413 错误码。
- 不许删已有断言。

# 6. 契约

- 新增 `data-role`：`file-panel`、`file-panel-path`、`file-panel-refresh`、`file-panel-newdir`、`file-panel-newfile`、`file-panel-upload`、`file-panel-grid`、`file-entry`、`file-viewer`、`file-editor`、`file-panel-grow`、`rail-files`。
- 保留 `data-role="file-*"` 已有的名字（现有 file-tree.js 里的不许改名，若被替换则在 REPORT 里列出替代表）。
- 新增 WS 帧：服务端 → 前端 `{type:"session.cwd", id, cwd}`；前端不新增上行帧。

# 7. 验收标准（主 agent 独立复跑）

| 编号 | 必过 | 标准 |
|---|---|---|
| AC1 | 必过 | 本地终端里 `cd /c/Users/41807/magpie-terminal/docs` 后 2 秒内，文件面板路径变成 `C:\Users\41807\magpie-terminal\docs`，网格内容与 `ls` 一致 |
| AC2 | 必过 | bash 用户的 `~/.bashrc` 与 PowerShell profile 的 mtime 与内容在测试前后**完全没变** |
| AC3 | 必过 | 面板里新建文件夹 `v4g-proof-<随机>` → 磁盘上真存在；重命名 → 旧名消失新名出现；删除 → 磁盘上消失 |
| AC4 | 必过 | 新建文件并编辑保存 → 磁盘内容逐字一致（含中文与换行） |
| AC5 | 必过 | 上传一个 2 MB 随机文件 → 磁盘 sha256 与源一致；下载回来 sha256 与原文件一致 |
| AC6 | 必过 | 查看 1.2 MB 文本 → 413 且提示「文件太大」；查看二进制 → 415 且提示「不是文本」 |
| AC7 | 必过 | `DELETE` 非空目录不带 recursive → 409 `DIR_NOT_EMPTY`；删 `C:\Users\41807` 与 `C:\` 被拒（4xx） |
| AC8 | 必过 | 远程会话：SSH 连本机临时 sshd（若在）或已存局域网主机，面板列出远程目录，上传/下载各成功一次（远程 sha256 一致） |
| AC9 | 必过 | 面板高度拖到 420px 后关闭再打开仍是 420px（localStorage 回填） |
| AC10 | 必过 | `node --test` 0 fail；`doctor` 33/33 |
| AC11 | 必过 | 无回归：终端输入、抽屉、设置、主机连接都正常 |

# 8. 执行约束

- 独立新会话；不改 `docs/mockups-v4/`、`app/vendor/`；不新增依赖。
- 绝不在用户 shell 配置文件里写东西（`.bashrc`、`profile.ps1` 一律只读）。
- 所有临时文件用 `os.tmpdir()`，退出时删。
- 探针必须自带 `process.exit` + 60s 硬超时，不留后台进程；测试用的临时目录与临时 sshd 自己清理。
- 不 commit。交付标「待验收」。

# 9. 交付物

`REPORT-V4G.md`（每条 AC 实测结果 + 证据路径 + 已知缺陷）、`.dispatch/v4g-probe/*.txt`、`.dispatch/v4g-shots/*.png`（1280×760 与 1440×900：面板展开、查看器、编辑器、上传进度、远程目录）。
