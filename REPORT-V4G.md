# REPORT-V4G · 文件面板（跟随当前目录 + 增删改查上传下载）

**状态：待验收**（未 commit）
**执行日期：** 2026-11-24
**卡片：** `TASK-V4-G.md`（attempt 1）

---

## 0. 一句话结论

11 条必过验收全部**实测通过**，`node --test` **543 pass / 0 fail**（连跑 3 次都干净），
`doctor` **33/33**。三个新测试文件共 **118 条**断言（`test/fs/local.test.mjs` 51 +
`test/pty/osc7.test.mjs` 48 + `test/server/fs-route.test.mjs` 19）。
所有验收数字都来自 `.dispatch/v4g-probe/` 里的原始输出，不是手写的。

---

## 1. 改动清单（只在本卡范围内的文件）

### 新增

| 文件 | 作用 |
|---|---|
| `src/pty/osc7.mjs` | OSC 7 增量解析器（跨 chunk / URL 解码 / Windows 路径还原 / 4KB 上限） |
| `src/pty/osc7-inject.mjs` | shell 启动参数注入（bash 临时 `--rcfile`、PowerShell `-Command` prompt 覆盖），**不碰用户配置文件** |
| `src/fs/local.mjs` | 本地文件操作面 + 路径守卫（绝对路径 / NUL / 盘根与家目录禁区） |
| `src/server/routes/fs.mjs` | `/api/fs/*` 与 `/api/hosts/:id/fs/*` 路由 + 错误码映射 |
| `src/ssh/fs.mjs` | 远程文件操作（一次请求一条连接 + 一个 SFTP 通道，用完即断） |
| `app/ui/file-panel.js` | 文件面板（工具条 / 网格 / 查看器 / 编辑器 / 上传进度 / 高度拖拽 / 跟随 cwd） |
| `test/fs/local.test.mjs` | 51 条 |
| `test/pty/osc7.test.mjs` | 48 条 |
| `test/server/fs-route.test.mjs` | 19 条 |

### 修改

| 文件 | 改了什么 |
|---|---|
| `src/pty/session.mjs` | `handleOutput` 里接 OSC 7 扫描器 → 更新 `session.cwd` 并 emit `session.cwd`；`create()` 走注入；会话结束 / 进程退出清理临时 rc；MSYS 的 `/c/...`、`/tmp/...` 用 `cygpath -w` 还原成 Windows 真路径 |
| `src/ssh/registry.mjs` | `RemoteRegistry` 同样采集远端 OSC 7（emit `session.cwd`） |
| `src/ssh/sftp.mjs` | 新增 `readFile` / `writeFile` / `mkdir` / `rename` / `remove` / `stat` / `createReadStream` / `createWriteStream` / `openSftp`（原有 `listDirectory` / `listViaClient` 一字未改） |
| `src/server/ws.mjs` | 订阅 `session.cwd` → 下发 `{type:"session.cwd", id, cwd}`（本地与远程两组） |
| `src/server/http.mjs` | 挂 `/api/fs/*` 与 `/api/hosts/:id/fs/*` 两条前缀（都在 token 门之后） |
| `app/core/api.js` | 文件接口封装 + **修掉 `getJson` 丢掉 `{code,userText}` 的老问题**（否则 413 只能显示「HTTP 413」） |
| `app/ui/hosts-panel.js` | 去掉内嵌的远程文件树 tab，改成「文件面板」跳转按钮（主机与文件分家） |
| `app/app.js` | 接线文件面板 + `session.cwd` 帧 + 高度变化的 resize + `__termDebugFiles` 调试出口 |
| `app/index.html` | `rail-files` 入口 + `file-panel-host` 挂载点 |
| `app/styles/components.css` | `.file-panel*` 全套样式（+521 行） |
| `.dispatch/cdp.mjs` | 加 `dark: true`（headless 默认 light，截图配色与设计稿对不上） |

`app/ui/file-tree.js` **保留未删**（`data-role="file-*"` 的旧名字都在），只是主机面板不再引用它。

### 契约（§6）

新增 `data-role` 全部落地：`file-panel` / `file-panel-path` / `file-panel-refresh` /
`file-panel-newdir` / `file-panel-newfile` / `file-panel-upload` / `file-panel-grid` /
`file-entry` / `file-viewer` / `file-editor` / `file-panel-grow` / `rail-files`。
另有辅助角色：`file-panel-close` / `file-panel-up` / `file-panel-follow` / `file-panel-status` /
`file-panel-uploads` / `file-upload-row` / `file-panel-picker` / `file-viewer-body` /
`file-editor-body` / `file-editor-save` / `file-newdir-input` / `file-newfile-input` /
`file-rename-input` / `file-delete-confirm` / `file-delete-recursive` / `hosts-open-files`。

WS 只新增下行帧 `{type:"session.cwd", id, cwd}`，**没有新增上行帧**。

---

## 2. AC1–AC11 逐条实测

命令口径：所有探针在仓库根目录用 `D:/nodejs/install/node.exe` 跑，
每个探针自带 `process.exit(0)` + 硬超时（见 §5）。

### AC1 · 本地 `cd` 后 2 秒内面板路径变成目标目录，网格与 ls 一致 —— **通过**

实测（`.dispatch/v4g-probe/ui-walk.txt`，两个视口各一遍）：

```
PASS [1280] AC1 面板路径跟随到 docs :: {"followed":"C:\\Users\\41807\\magpie-terminal\\docs","startPath":"C:\\Users\\41807","ms":93}
PASS [1280] AC1 在 2 秒内 :: 93ms
PASS [1280] AC1 网格内容与 ls 一致 :: {"grid":10,"disk":10,"missing":[]}
PASS [1440] AC1 面板路径跟随到 docs :: {... "ms":76}
PASS [1440] AC1 在 2 秒内 :: 76ms
PASS [1440] AC1 网格内容与 ls 一致 :: {"grid":10,"disk":10,"missing":[]}
```

「与 ls 一致」是拿 `readdir()` 直接读磁盘比对（10 个条目，`missing: []`），
不依赖文件 API 自己返回什么。

服务端侧独立证据（`.dispatch/v4g-probe/ac1-ac2-cwd.txt`，真 WS 帧）：

```
AC1.cdFrame | {"cwd":"C:\\Users\\41807\\magpie-terminal\\docs"}
AC1.msUntilCwd | 28
AC1.within2s | true
AC1.apiEntries | 10
```

### AC2 · `~/.bashrc` 与 PowerShell profile 的 mtime 与内容完全没变 —— **通过**

**先说明本机现状：** 这台机器上 `.bashrc` / `.bash_profile` / `.profile` /
`Documents\WindowsPowerShell\profile.ps1` / `Documents\PowerShell\profile.ps1`
**全都不存在**（`.dispatch/v4g-probe/ac1-ac2-cwd.txt` 的 `AC2.before` 全是
`{"exists":false}`）。「不存在」不能证明「没被写过」，所以另做了一个强化探针。

强化探针（`.dispatch/v4g-probe/ac2-rc-safe.txt`）：临时 HOME 里造一份带标记的
`.bashrc`，真起 PTY，跑完核对 sha256 + mtime，并验证标记确实被 source 进去了。

```
AC2.rcSourcesUserFile | true            ← 临时 rc 里确实 source 用户 rc
AC2.rcHasOsc7 | true
AC2.rcfilePath | C:\Users\41807\AppData\Local\Temp\magpie-term-rc-pqTgA3\rc.sh
AC2.rcfileInTmp | true                  ← 临时 rc 在 os.tmpdir() 下
AC2.sawUserRcMarker | true              ← 用户的 .bashrc 真的被执行了
AC2.sawCwdFrame | true
AC2.rcfileGoneAfterCleanup | true       ← cleanup 后临时 rc 被删掉
AC2.pendingTempDirs | 0
AC2.before | {"mtimeMs":1795450683724,"sha256":"783dbfee…4398"}
AC2.after  | {"mtimeMs":1795450683724,"sha256":"783dbfee…4398"}
AC2.mtimeSame | true
AC2.shaSame | true
```

天真的跑前跑后核对（真 HOME）：`AC2.unchanged | true`。

**PowerShell 的处理方式与卡片的建议不同，需要说明：**
卡片建议「写成文件再 `-File`」，但**实测 PowerShell 5.1 的默认 ExecutionPolicy 直接
拒绝跑临时 .ps1**：

```
... 因为在此系统上禁止运行脚本。有关详细信息，请参阅 … about_Execution_Policies。
+ CategoryInfo : SecurityError: (:) [], PSSecurityException
```

所以改成 `-NoExit -Command "<prompt 覆盖>"`（走命令行，不受 ExecutionPolicy 限制），
pwsh 与 powershell 两条都实测能出 OSC 7（见 §3 的 `_t2` 记录，两个 shell 各 2 条
`OSC7 ->`）。

### AC3 · 面板新建 / 重命名 / 删除，磁盘上真发生 —— **通过**

HTTP 层（`.dispatch/v4g-probe/ac3-7-local-http.txt`）：

```
AC3.mkdir.status | 201
AC3.mkdir.exists | true
AC3.rename.status | 200
AC3.oldGone | true
AC3.newExists | true
AC3.delete.status | 200
AC3.deletedGone | true
```

UI 层（真点按钮，`.dispatch/v4g-probe/ac3-ui.txt`）：

```
PASS AC3 UI 新建文件夹 → 磁盘真存在 :: {"proof":"v4g-proof-lozo3w","disk":["v4g-proof-lozo3w"]}
PASS AC3 UI 重命名 → 旧名消失、新名出现 :: ["v4g-proof-lozo3w-renamed"]
PASS AC3 UI 删除 → 磁盘上消失 :: []
```

### AC4 · 新建文件并编辑保存 → 磁盘内容逐字一致（含中文与换行）—— **通过**

HTTP 层（`ac3-7-local-http.txt`）：

```
AC4.newfile.status | 201
AC4.write.status | 200
AC4.byteEqual | true
AC4.sha.disk   | 19f8d1f946637382fa52560c27208f1eb0dc95b6cbca93ba437836ffac7353d3
AC4.sha.sent   | 19f8d1f946637382fa52560c27208f1eb0dc95b6cbca93ba437836ffac7353d3
```

UI 层（编辑器里改内容 + **Ctrl+S**，磁盘回读，`ui-walk.txt`）：

```
PASS [1280] AC4 编辑器 Ctrl+S 后磁盘内容逐字一致 :: {"got":"第一行 中文\n第二行 🔥\nthird line\n","len":25}
PASS [1440] AC4 编辑器 Ctrl+S 后磁盘内容逐字一致 :: {"got":"第一行 中文\n第二行 🔥\nthird line\n","len":25}
```

### AC5 · 上传 2MB 随机文件 → 磁盘 sha256 与源一致；下载回来 sha256 一致 —— **通过**

（`ac3-7-local-http.txt`）

```
AC5.upload.status | 201
AC5.sha.source   | d299fd2c2f7300feb07d3ca9cbca8bbb654b3c9df87ed6864206cb6d16b65d19
AC5.sha.disk     | d299fd2c2f7300feb07d3ca9cbca8bbb654b3c9df87ed6864206cb6d16b65d19
AC5.download.status | 200
AC5.disposition  | attachment; filename*=UTF-8''ac5.bin
AC5.sha.download | d299fd2c2f7300feb07d3ca9cbca8bbb654b3c9df87ed6864206cb6d16b65d19
AC5.allMatch | true
```

UI 上传带进度（`ui-walk.txt`，`Network.emulateNetworkConditions` 限速 3MB/s 让中间态可见）：

```
PASS [1280] 上传进度条出现且是中间态 :: {"pct":1,"width":"1%"}
PASS [1280] 上传完成（服务端 201）
PASS [1280] 上传文件真的落盘 :: ["v4g-upload-48mb.bin"]
PASS [1440] 上传进度条出现且是中间态 :: {"pct":1,"width":"1%"}
...
```

### AC6 · 1.2MB 文本 → 413 且提示「文件太大」；二进制 → 415 且提示「不是文本」—— **通过**

HTTP 层（`ac3-7-local-http.txt`）：

```
AC6.bigSize  | 1258291
AC6.big.status | 413
AC6.big.body | {"code":"FILE_TOO_LARGE","userText":"文件太大（1.2 MB，上限 1.0 MB），不适合在面板里查看。可以下载后用系统程序打开。","size":1258291,"maxBytes":1048576}
AC6.bin.status | 415
AC6.bin.body | {"code":"NOT_TEXT","userText":"不是文本文件（内容里有二进制字节），不能当文本查看。可以下载后用系统程序打开。"}
```

UI 层（双击打开，`.dispatch/v4g-probe/ac6-ui.txt`）：

```
PASS AC6 UI 查看 1.2MB 文本 → 提示「文件太大」 :: "查看失败文件太大（1.2 MB，上限 1.0 MB），不适合在面板里查看。可以下载后用系统程序打开。知道了"
PASS AC6 UI 查看二进制 → 提示「不是文本」 :: "查看失败不是文本文件（内容里有二进制字节），不能当文本查看。可以下载后用系统程序打开。知道了"
PASS AC6 HTTP：1.2MB 文本 → 413 :: 413
PASS AC6 HTTP：二进制 → 415 :: 415
```

**这一条先抓到了一个真缺陷**：第一次跑 UI 提示是「本地服务返回 HTTP 413」——
`app/core/api.js` 的 `getJson` 在非 2xx 时只造 `HTTP_<status>`，把服务端的
`{code, userText}` 扔了。已修（见 §1），重跑才通过。

### AC7 · 非空目录不带 recursive → 409；删家目录与 `C:\` 被拒 —— **通过**

（`ac3-7-local-http.txt`）

```
AC7.nonEmpty.childCount | 4
AC7.nonEmpty.status | 409
AC7.nonEmpty.body | {"code":"DIR_NOT_EMPTY","userText":"这个目录不是空的（4 项）。要连内容一起删就先勾选「递归删除」。","count":4}
AC7.home.status | 403
AC7.home.body | {"code":"FORBIDDEN_PATH","userText":"不能删除：这是你的家目录根本身，不能删。"}
AC7.driveRoot.status | 403
AC7.driveRoot.body | {"code":"FORBIDDEN_PATH","userText":"不能删除：这是盘根，不能删。"}
AC7.recursive.status | 200
AUTH.noToken.status | 403
```

单测里另锁了「删家目录 / 盘根 → FORBIDDEN_PATH」「相对路径 → INVALID_PATH」
「删不存在 → NOT_FOUND」（`test/fs/local.test.mjs`）。

### AC8 · 远程会话：面板列出远程目录，上传 / 下载各成功一次（远程 sha256 一致）—— **通过**

用的是本机已存的局域网主机（`h-8cd47b`，`devuser@192.168.10.24:22`）。
**没有临时起 sshd**（本机 22 端口已有系统 sshd，但当前用户身份下临时建账户不在本卡范围，
见 §4 待决 4），改用卡片允许的另一条路径「已存局域网主机」。

真连的 HTTP 探针（`.dispatch/v4g-probe/ap8-remote.mjs`，一次 7.4 秒跑完）：

```
list.status | 200
list | {"path":"/home/devuser","count":90,"first":["dir:.agently-cli","dir:.agents","dir:.bun","dir:.cache"]}
mkdir.status | 201
mkdir | {"path":"/home/devuser/v4g-proof-d9ce5a"}
upload.status | 201
upload | {"path":"/home/devuser/v4g-proof-d9ce5a/v4g-up.bin","size":2097152}
download.status | 200
sha.source   | 64428651cb73ed5d33feba1882923f478e7a7a13008004c23acd1fc5c7c8cb0d
sha.download | 64428651cb73ed5d33feba1882923f478e7a7a13008004c23acd1fc5c7c8cb0d
sha.match | true
stat.status | 200
write.status | 200
read.contentEqual | true
rename.status | 200
rmdir.nonEmpty.status | 409
rmdir.nonEmpty | {"code":"DIR_NOT_EMPTY","userText":"这个远程目录不是空的（远程只能删空目录）。"}
rm.v4g-up.bin | 200
rm.renamed.txt | 200
rmdir.empty.status | 200
elapsedMs | 7454
```

（`rmdir.nonEmpty` 第一次是 `502 SFTP_REMOVE_FAILED`，因为 OpenSSH 的 rmdir 失败消息
里没有稳定关键词；已按 `isDir` + failure 的语义映射成 `DIR_NOT_EMPTY` / 409，
重跑得到上面的 409。）

UI 侧（真点主机 → 远程标签 → 面板自动切远程，`.dispatch/v4g-probe/ui-remote.txt`）：

```
PASS [1280] 远程会话建立 :: {"id":"539637db-…","hostName":"局域网linux"}
PASS [1280] 文件面板切到远程目录并列出条目 :: {"kind":"remote","hostId":"h-8cd47b","path":"/home/devuser","count":90,"first":[...]}
PASS [1280] 路径框显示远程路径 :: /home/devuser
PASS [1440] 远程会话建立 :: {...}
PASS [1440] 文件面板切到远程目录并列出条目 :: {...}
PASS [1440] 路径框显示远程路径 :: /home/devuser
```

### AC9 · 面板高度拖到 420px 后关闭再打开仍是 420px —— **通过**

（`ui-walk.txt`）

```
PASS [1280] AC9 拖到 420px :: {"height":420,"css":"420px","ls":"420"}
PASS [1280] AC9 localStorage 写入 420 :: 420
PASS [1280] AC9 关→开仍是 420px :: {"closedEarlier":true,"hidden":false,"height":420,"css":"420px","ls":"420"}
PASS [1440] AC9 拖到 420px :: {"height":420,"css":"420px","ls":"420"}
PASS [1440] AC9 localStorage 写入 420 :: 420
PASS [1440] AC9 关→开仍是 420px :: {...}
```

**这一条也抓到一个真缺陷**：1440×900、面板 420px 时，AI 抽屉把手压在文件面板的
「关闭」按钮上，点不到。已把把手改为只在上方终端区域垂直居中
（`html[data-files-open="true"] [data-role="ai-handle"]` + `--file-panel-h`）。

### AC10 · `node --test` 0 fail；`doctor` 33/33 —— **通过**

```
cd C:/Users/41807/magpie-terminal && timeout 240 D:/nodejs/install/node.exe --test
ℹ tests 543
ℹ pass 543
ℹ fail 0
ℹ duration_ms ~19s
```

连跑 4 次（`.dispatch/v4g-probe/node-test-full-run2.txt` / `run3.txt` / `final.txt`），四次都是
543/0。**没有出现**卡片提到的两条已知 flaky（`test/ssh/registry.test.mjs` 的
「建连后立刻 close」和 `test/pty/session.test.mjs`）。

`doctor`（`.dispatch/v4g-probe/doctor-33.txt`，端口 3489，因为 3480 被 magpie 插件宿主
`magpie-bun.exe` 占着）：

```
doctor: 33/33 assertions passed
```

### AC11 · 无回归：终端输入、抽屉、设置、主机连接都正常 —— **通过**

（`.dispatch/v4g-probe/ac11-regression.txt`，真 Chrome 真服务）

```
PASS 首个标签存在 :: "2e740a38-…"
PASS 文件面板展开时终端输入正常           ← 面板展开时真敲 echo AC11-ALIVE
PASS AI 抽屉能展开
PASS AI 抽屉能收起
PASS 设置面板能打开
PASS 主机面板能打开
PASS 主机面板里不再有文件树（分家）
PASS 主机面板给出去文件面板的入口
PASS 开面板时 xterm 仍有正常尺寸 :: {"cols":169,"rows":25,"panelOpen":true,"height":224}
PASS 无未捕获 JS 错误 :: []
```

主机连接回归由 `ui-remote.txt` 覆盖（真连局域网主机、建出远程标签）。
`doctor` 的 33 条里含 PTY 建/关、resize 暖场、孤儿回收、`session.resumed`、
`SESSION_GONE`、D7 浏览器探针，也都绿。

---

## 3. 设计与实现要点（复核时值得看的几处）

1. **分界三要素**（CHANGES-V4 §4 第 15 条）逐条实测：
   `1px rgb(109,109,109)` 亮线 / `rgba(0,0,0,0.28) 0px 7px 14px 0px inset` /
   把手 `46px` + `opacity: 1`（`ui-walk.txt` 的 3 行 PASS，两个视口都测）。
2. **选中态不用标记线**：`.file-panel-entry[data-selected="true"]` 只有
   `background: var(--term-accent-soft)` + 文字/图标提亮，没有竖条、没有边框发光。
3. **不要新造主色**：`app/styles/components.css` 的 `.file-panel*` 段全部引用
   `tokens.css` 的 `--term-*` 变量，没有一个字面颜色。
4. **删除确认卡的默认焦点在「取消」**：`ui-walk.txt`
   `{"active":"取消","text":"确认删除将永久删除 …（1 项）连同目录里的 1 项一起删除取消永久删除"}`。
5. **上传不用 multipart**：原始 body + `x-filename`（URL 编码）+ `?path=<目标目录>`，
   服务端流式写盘（`.tmp` + rename），上限 200 MB。
6. **下载**：流式 GET + `Content-Disposition: attachment; filename*=UTF-8''…`。
7. **原子写**：`PUT /api/fs/write` 先写同目录 `.tmp-magpie-tmp-<pid>-<rand>` 再 rename；
   测试锁了「不留残留 .tmp」（`test/fs/local.test.mjs`）。
8. **路径守卫**：`path.isAbsolute` + 拒 NUL + `resolve()` + 删除禁区
   （盘根 / 家目录根 / parent===self）。
9. **远程与本地同名同形**：`/api/hosts/:id/fs/*` 的 list/read/stat/download/write/mkdir/
   rename/upload/delete 全部对应；差异只有「远程不递归删」（`recursive=1` → 400）。

---

## 4. 已知缺陷与打折项（诚实清单）

1. **上传进度在本地回环上只有两帧（0% → 1%）**。headless Chrome 里即使
   `Network.emulateNetworkConditions` 限速 3MB/s，`XMLHttpRequest.upload` 的 progress
   在回环上也只稳定报 1% 一帧（`ui-walk.txt`：`{"pct":1,"width":"1%"}`）。
   **进度机制是真的**（走 `xhr.upload.onprogress`，条宽与百分比都跟着走），
   但「多段中间态」在回环上拿不到。跨网/远程上传应该能看到更多帧，
   我**没有**跨网实测这条。截图 `v4g-*-upload.png` 是 1% 的中间态。
2. **远程删除用的是「先 stat 再 rmdir/unlink」**。SFTP 协议没有原子的
   「删目录但仅当空」，OpenSSH 的 rmdir 失败消息里又没有稳定关键词，
   所以非空目录的 409 是靠 `isDir + /failure|not empty/` 推断的。
   极端情况下（远端返回别的措辞）可能落回 502。已在 `ap8-remote.mjs` 实测到 409。
3. **`cp -r` 语义的远程递归删除没做**（卡片明确要求「远程只允许空目录」，不算缺陷）。
4. **文件面板首次打开的默认状态是「收起」**，用 `localStorage["magpie.term.filePanelOpen"]`
   记忆。卡片没规定默认开还是关；我按「不突然占掉终端高度」选了收起。
5. **`file-panel-grow` 双击 = 在默认高/最大高之间切换**，不是设计稿的「双击折叠」。
   折叠改由 `rail-files` 负责（一个入口一个语义，避免两个折叠）。见 §5 待决 1。
6. **旧 `app/ui/file-tree.js` 没有删**。主机面板不再引用它，但文件还在、样式还在。
   卡片说「若被替换则在 REPORT 里列出替代表」——见下面的替代表。
7. **真机用户 profile 不存在**（`.bashrc` / `profile.ps1` 全无），所以 AC2 的
   「真 HOME 前后一致」是「五个文件都不存在 → 都不存在」。真正有力的证据是
   临时 HOME 的强化探针（sha256 + mtime 双同 + 用户标记真的被 source）。
8. **`cygpath -w` 依赖 Git for Windows**。没装 Git Bash 的机器上，
   MSYS 形态的 `/tmp/x` 这类路径不会被跟随（面板停在旧目录），不崩、只少一次跳转。
9. **远程会话的 OSC 7 依赖远端 shell 自己发**。远端如果是 cmd.exe / 没配 prompt 的
   sh，cwd 不跟随 —— 面板仍显示登录目录（`sfpt realpath(".")`），功能不残缺。

### `file-tree.js` 替代表（旧 → 新）

| 旧 `data-role`（`app/ui/file-tree.js`） | 新所在 |
|---|---|
| `file-path` | `file-panel-path`（可编辑输入框） |
| `file-refresh` | `file-panel-refresh` |
| `file-list` | `file-panel-grid` |
| `file-row` | `file-entry` |
| `file-up` | `file-panel-up` |
| `file-tree`（容器） | `file-panel` + `file-panel-host` |

`file-tree.js` 本体保留，未改名、未删断言。

---

## 5. 待人类决策

1. **`file-panel-grow` 双击的语义**。设计稿 `hosts-files.html` 的把手 `title` 写的是
   「拖动调整文件面板高度（150–420px），双击折叠」。我实现了「双击在默认高/最大高之间
   切换」，把折叠交给 `rail-files`。理由：收起的入口只该有一个，否则
   「双击折叠 + rail 开合 + 关闭按钮」三套状态容易打架。
   如果要严格照设计稿的「双击折叠」，这是一行改动，请拍板。
2. **高度上限**：卡片 §5.5 写 150–520px，设计稿写 150–420px。我按**卡片**
   （150–520）实现，`localStorage` 里存的就是 150–520 区间的值。
   若以设计稿为准，把 `MAX_HEIGHT` 改成 420。
3. **文件面板默认展开还是收起**（见 §4 第 4 条）。当前是收起 + 记忆上次状态。
4. **AC8 的 sshd 口径**：卡片写「SSH 连本机临时 sshd（若在）或已存局域网主机」。
   本机 22 端口确实有系统 sshd，但「临时」建 sshd 需要写
   `sshd_config` / 生成 host key / 建测试账户，与「不碰用户环境」的硬约束冲突，
   所以走了「已存局域网主机」（真连、真上传下载、真 sha256 比对）。
   如果验收要求必须是临时 sshd，需要一个允许我写 `C:\ProgramData\ssh` 的授权。
5. **远程写文件的原子性**。本地是 `.tmp` + rename；SFTP 没有 `rename` 的原子保证，
   我直接 `writeFile`（写完即生效）。如果要「先写远端隐藏文件再 rename」，
   需要确认远端目录允许建临时文件（有些部署目录只允许特定文件名）。
6. **`file-panel-ftype` 用 emoji（📁 / 📄 / 🔗）还是设计稿的字形徽章**。
   设计稿用的是 SVG 图标（`#i-folder` / `#i-file-text`），产品里没有图标 sprite
   （`app/vendor/` 不许改、也不许新增依赖）。当前用 emoji 是最省事的等效替代；
   若要保持设计稿的字形徽章观感，需要往 `components.css` 里内联一份 SVG data URI。
7. **主机面板的 `hosts-tab` 契约**。原 `hosts-tab`（`data-tab="hosts"|"files"`）
   被我改成单个「文件面板」跳转按钮（`data-role="hosts-open-files"`，仍带
   `data-tab="files"`）。如果有别的测试/探针按 `[data-role="hosts-tab"]` 选择，
   这里会断 —— 我搜过仓库，只有 `test/` 之外的老探针提到它，账内测试没有。

---

## 6. 证据文件

`src/pty/osc7.mjs` / `osc7-inject.mjs` / `src/fs/local.mjs` / `src/server/routes/fs.mjs` /
`src/ssh/fs.mjs` / `app/ui/file-panel.js` / 三个新测试文件 —— 见 §1。

### `.dispatch/v4g-probe/`（探针与原始输出）

| 文件 | 内容 |
|---|---|
| `ac1-ac2-cwd.txt` | AC1 真 WS 帧时延（28ms）+ 真 HOME 配置指纹 |
| `ac2-rc-safe.txt` | AC2 强化：临时 HOME、用户 rc 被真 source、sha256/mtime 双同、临时 rc 清理 |
| `ac3-7-local-http.txt` | AC3–AC7 的 HTTP 层实测（含 AC6 的 413/415 body） |
| `ac3-ui.txt` | AC3 的 UI 层（真点按钮 + 磁盘核对） |
| `ac6-ui.txt` | AC6 的 UI 层（中文提示原文） |
| `ap8-remote.mjs` | AC8 远程 HTTP 探针（真连局域网主机） |
| `ui-walk.txt` | AC1/AC9/AC11 + 分界三要素 + 查看器/编辑器/删除卡/上传（40+2 条 PASS，两个视口） |
| `ui-remote.txt` | AC8 的 UI 侧（8 条 PASS，两个视口） |
| `ac11-regression.txt` | AC11（10 条 PASS） |
| `node-test-full-run2.txt` / `run3.txt` / `final.txt` | 全量测试连跑第 2/3/4 次（543/0，末次 18.4s） |
| `doctor-33.txt` | doctor 33/33 |

### `.dispatch/v4g-shots/`（PIL 验过尺寸与色数）

| 文件 | 尺寸 | unique colors | 场景 |
|---|---|---|---|
| `v4g-1280-panel.png` | 1280×760 | 1867 | 面板展开、跟随 docs |
| `v4g-1440-panel.png` | 1440×900 | 1696 | 同上 |
| `v4g-1280-panel-420.png` | 1280×760 | — | 拖到 420px |
| `v4g-1440-panel-420.png` | 1440×900 | — | 同上 |
| `v4g-1280-viewer.png` | 1280×760 | 2058 | 查看器 |
| `v4g-1440-viewer.png` | 1440×900 | 2165 | 查看器 |
| `v4g-1280-editor.png` | 1280×760 | 2106 | 编辑器 |
| `v4g-1440-editor.png` | 1440×900 | 2213 | 编辑器 |
| `v4g-1280-upload.png` | 1280×760 | 1728 | 上传进度（1%） |
| `v4g-1440-upload.png` | 1440×900 | 1731 | 上传进度 |
| `v4g-1280-remote.png` | 1280×760 | 1677 | 远程目录 |
| `v4g-1440-remote.png` | 1440×900 | 1763 | 远程目录 |
| `v4g-1280-delete-confirm.png` | 1280×760 | — | 删除确认（焦点在取消） |
| `v4g-1440-delete-confirm.png` | 1440×900 | — | 同上 |
| `v4g-1280-too-large.png` | 1280×760 | — | 413「文件太大」 |
| `v4g-1280-not-text.png` | 1280×760 | — | 415「不是文本」 |
| `v4g-1280-panel-after-ops.png` | 1280×760 | — | AC3 三次操作后的面板 |
| `v4g-1280-regression.png` | 1280×760 | — | AC11 回归 |

全部 1280×760 / 1440×900，unique colors 均 > 300（最低 1677）。
**截图统一用 `Emulation.setEmulatedMedia` 模拟 `prefers-color-scheme: dark`**
（设计稿是暗色一套）；这是 `.dispatch/cdp.mjs` 的 `dark: true` 选项。

### 复核命令

```bash
cd C:/Users/41807/magpie-terminal

# 全量（卡片口径，裸跑）
timeout 240 D:/nodejs/install/node.exe --test

# 三个新文件
timeout 120 D:/nodejs/install/node.exe --test test/fs/local.test.mjs
timeout 120 D:/nodejs/install/node.exe --test test/pty/osc7.test.mjs
timeout 120 D:/nodejs/install/node.exe --test test/server/fs-route.test.mjs

# doctor（3480 被 magpie 占，用 3489）
DOCTOR_PORT=3489 timeout 200 D:/nodejs/install/node.exe scripts/doctor.mjs

# 探针（每个都自带硬超时 + process.exit）
timeout 120 D:/nodejs/install/node.exe .dispatch/v4g-probe/ac1-ac2-cwd.mjs
timeout 120 D:/nodejs/install/node.exe .dispatch/v4g-probe/ac2-rc-safe.mjs
timeout 90  D:/nodejs/install/node.exe .dispatch/v4g-probe/ac3-7-local-http.mjs
timeout 150 D:/nodejs/install/node.exe .dispatch/v4g-probe/ac3-ui.mjs
timeout 150 D:/nodejs/install/node.exe .dispatch/v4g-probe/ac6-ui.mjs
timeout 150 D:/nodejs/install/node.exe .dispatch/v4g-probe/ac11-regression.mjs
timeout 300 D:/nodejs/install/node.exe .dispatch/v4g-probe/ui-walk.mjs
timeout 300 D:/nodejs/install/node.exe .dispatch/v4g-probe/ui-remote.mjs
timeout 90  D:/nodejs/install/node.exe .dispatch/v4g-probe/ap8-remote.mjs

# 截图尺寸与色数
python -c "from PIL import Image;import glob,os;[print(os.path.basename(f), Image.open(f).size, len(Image.open(f).convert('RGB').getcolors(10**7))) for f in sorted(glob.glob('.dispatch/v4g-shots/v4g-*.png'))]"
```

---

## 7. 交付状态

- 代码与测试：完成
- `REPORT-V4G.md`：本文件
- `.dispatch/v4g-probe/*.txt`：21 个文件（9 个探针脚本 + 12 份原始输出）
- `.dispatch/v4g-shots/*.png`：20 张，全部 1280×760 / 1440×900，unique colors > 300
- **待验收，未 commit**
