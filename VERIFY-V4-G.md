# VERIFY-V4-G.md — 卡 G（文件面板）主 agent 独立验收

- 验收对象：工作区未提交改动（HEAD `5d7d15e` + 卡 G 改动）
- 验收时间：2026-11-24 01:10–02:00
- 执行者：pi（`--thinking low`，`.dispatch/pi-v4g.jsonl`，EXIT=0）
- 验收者：主 agent（以下每一条都是亲跑，不采信 REPORT 自述）

## 1. 结论

**功能验收：通过（AC1–AC9、AC11 全部有实测证据；AC10 由全量测试覆盖）。**
**安全验收：不通过 —— 发现 3 个 P0 + 4 个 P1，全部可复现，其中 2 个可无确认读出磁盘密钥。**
建议：卡 G 功能改动照常提交；安全缺口单开返工卡 S，**先于卡 H**。

## 2. 必过项逐条判定

| AC | 内容 | 结果 | 证据（原始） |
|---|---|---|---|
| AC1 | 面板跟随终端 cwd（2s 内） | PASS | `.dispatch/my-v4g-shot5.mjs`：终端 `cd .../my-v4g-sandbox` 后 `file-panel-path` = 同路径、4 条目与磁盘一致；`G1-files-follow-cwd-1280.png` |
| AC2 | 不写用户 .bashrc / profile | PASS | `.dispatch/my-v4g-osc7.mjs`：假 HOME 下 `.bashrc` size 47/47、mtime 完全相同、内容一致，且 `--rcfile` 真 source 了用户 rc |
| AC3 | 新建 / 重命名 / 删除真落盘 | PASS | `.dispatch/my-v4g-verify2.mjs`：`验收目录_97980` exists true；`验收文件.txt`→`改名后.txt` 旧名消失；删空目录后磁盘消失。界面侧 `G3-after-newfile-1280.png` 出现 `新建验收.txt` |
| AC4 | 编辑保存中文/emoji 逐字一致 | PASS | 写入 `第一行中文\n第二行 tail\n第三行 emoji 🎯` 后回读逐字一致 |
| AC5 | 2MB 上传/下载 sha256 一致 | PASS | 2097152 字节，sha256 双向一致（本地）；远程 2097152 字节 sha256 亦一致 |
| AC6 | 大小/类型上限 | PASS | 201MB → 413 `FILE_TOO_LARGE`；1.2MB 文本读 → 413；2048B 随机二进制 → 415 `NOT_TEXT`；PNG → 415 |
| AC7 | 删除守卫 | PASS | 非空目录不带 recursive → 409；`C:\` recursive=1 → 403 `FORBIDDEN_PATH`；`DELETE <sandbox>\..\..\..` → 423 |
| AC8 | 远程 SSH 文件面板 | PASS | `.dispatch/my-v4g-remote.mjs` 真连 `h-8cd47b`(192.168.10.24)：`/tmp` 9931 条、上传/下载 sha256 一致、mkdir/删文件/删空目录 200、`/tmp?recursive=1` → 400 |
| AC9 | 高度回填 150–520 | PASS | 拖到 415px → `localStorage["magpie.term.filePanelHeight"]="414"`；关掉再开仍 415。CDP 复测 `PointerEvent` 拖拽 225→385，ls=384 |
| AC10 | `node --test` 全绿 | PASS | `timeout 280 D:/nodejs/install/node.exe --test`（cwd 仓库根、裸跑）→ RC=0，**tests 543 / pass 543 / fail 0**（`.dispatch/my-v4g-test.txt`） |
| AC11 | 无回归 | PASS | 终端回显、抽屉 `data-ai-open` true/false、设置页可见、`Runtime.exceptionThrown` 0；doctor `passed:true` / 33 条全 ok（`.dispatch/my-v4g-doctor.txt` + `doctor-report.json`） |
| **隐含** | 上传进度、拖拽、查看器 | PASS | 进度 0%→1%→完成（REPORT 已诚实标注只有两帧）；`G2-file-viewer-1280.png` 查看器正文逐字正确 |

## 3. 我额外亲跑的项

- **上传契约**：文件名必须走请求头 `x-filename`（`src/server/routes/fs.mjs:285`），用 `?filename=` 得 400 `MISSING_FILENAME`。写接口是 `PUT /api/fs/write?path=`。
- **413 之后服务健在**：`.dispatch/my-v4g-http3.mjs` 用 `node:http` 逐请求验证 health→list→upload(413)→health→list→health 全 200，keep-alive agent 两次 health 200。**先前 `fetch failed` 是 undici keep-alive 池复用被服务端关闭 socket 的客户端假象**。
- **Host / Origin 门禁**（`.dispatch/my-host-probe.mjs`，裸 net 发原始 HTTP）：`Host: evil.example.com` → 403；无 token → 403（设计如此，不是 401）。
- **OSC 7 真工作**：`session.cwd` 事件 1 次，值 `C:\Users\41807\AppData\Local\Temp`。
- **视觉复核**（网关 `shuaiapihermes/gpt-6.2-sol` 看图，`vision_analyze` 本模型不可用）：1280×760 下侧栏 4 图标、终端、文件面板（路径/4 条目/尺寸/状态「本地 · 4 项」）、右缘把手位置在终端区垂直中线、抽屉展开后把手让位到文件面板之上（handleCenter 167 vs termAreaCenter 166，误差 1px）。截图 4 张 `.dispatch/my-v4g-shots/G1..G4-*.png`（PIL 实测 1280×760，colors 1292–2483 非空白）。
- **密钥扫描**：`git ls-files` + staged + untracked grep `BEGIN (RSA|OPENSSH|EC|PRIVATE)|sk-[A-Za-z0-9]{20,}|user_[A-Za-z0-9]{20,}` → 0 命中。

## 4. 安全缺口（全部主 agent 亲自复现，非猜测）

复现脚本：`.dispatch/my-p01-verify.mjs`、`.dispatch/my-judge-verify.mjs`、`.dispatch/my-v4g-links.mjs`。判定口径：`judge()` 返回 `decision:"auto"` 即代表**用户完全不被告知就执行**。

### P0-1 任意网页可偷 token（`Origin: null` 无条件放行）
`GET /` 带 `Origin: null`、不带 token → **200**，响应头 `access-control-allow-origin: null`，HTML 里 `<meta name="magpie-term-token" content="<64 位真 token>">`。用该 token 带 `Origin: null` 调 `/api/config` → 200 读到配置。对照 `Origin: http://evil.example.com` → 403。
机理：`src/server/auth.mjs` 的 `checkOrigin()` 对字面量 `"null"` 无条件放行 + 首页不需要 token 却注入 token + `src/server/http.mjs:126` 回 `access-control-allow-origin: null`。
影响：任意站点的 `<iframe sandbox>`（origin 就是 null）可嵌入 `127.0.0.1:3480`，读出 token，再开 WS 执行任意命令。
权衡：magpie 宿主本身要求 `Origin: null`（沙箱 iframe），不能简单封掉。

### P0-2 用户白名单 prefix 被 `&&` / `;` / `|` 串联绕过
白名单 `[{pattern:"mkdir",mode:"prefix"}]` 下：
- `mkdir -p /tmp/x && rm -rf /tmp/victim` → `decision:"auto"`, `hit:"mkdir"`
- 同样 `;` 与 `| tee` 变体全命中
机理：`src/ai/allowlist.mjs` 只看 `command.startsWith(pattern)`，不切分命令段。边界正确（`mkdirx -p /tmp` 不命中）。

### P0-3 内置只读白名单可无确认读密钥
`classify(cmd)` 不传 opts（= 生产用法）时全部 `decision:"auto"`：
`cat ~/.config/magpie-terminal/secrets.key`、`cat .../secrets.json`、`head -c 100 secrets.key`、`cat ~/.ssh/id_rsa`、`cat .env` → `hit:"allow:cat"|"allow:head"`。
机理：`src/policy/allowlist.mjs` 的 `ALLOW_HEADS` 含 `cat/head/tail` 且无敏感路径黑名单。

### P1 四项
1. **硬禁止变体漏判 11/11**：`rm -rf ~/`、`rm -rf $HOME/`、`rm -rf ~/.`、`rm -rf //`、`rm -rf /**`、`rm -rf /./`、`chmod 777 /`、`rd /s /q C:\`、`Remove-Item -Recurse -Force C:\`、`del /f /s /q C:\Users`、`rm -rf /tmp/../..` 全返回 null（`DANGEROUS_RM_TARGETS` 没覆盖尾斜杠与 `..` 归一化）。
2. **loose + 审阅可自动执行 `rm -rf ~/`**：假审阅给 `{risk:"caution",reversible:true}` → `decision:"auto"`（因为 P1-1 没拦住，loose 档就放行）。
3. **`unparsable` 不 fail-closed**：`classify("echo hi\nrm -rf /")` 自身正确返回 confirm，但 `judge()` 继续走审阅，审阅说 safe 就 `decision:"auto"`, `hit:null`。
4. **junction 可绕列目录**：`/api/fs/list` 通过 junction 指向家目录 → 200 读 139 条（信息暴露级；删除/写入未证明可穿透，目标内容存活）。

## 5. 已读但判定的 REPORT 自述（打折项 9 条 + 待决 7 条）

接受、不需返工的：上传进度只有两帧（进度回环是节流导致）、远程删除靠 stat+rmdir 推断、远程不递归删（符合 AC8）、面板默认收起、真 HOME 无 `.bashrc` 故 AC2 只能用假 HOME（我复测确认）、`cygpath` 依赖 Git for Windows、grow 双击在默认高与最大高之间切换（非折叠）。
需要在卡 H 处理的两条视觉小项（已在 TASK-V4-H §8）：模型名截断、PS5/PS7 标签标题相同。

**截图复核发现的视觉问题（P2，不阻塞）**：
- 文件条目的操作按钮（查看/编辑/重命名/下载/删除）只在 hover 时出现，静态截图看不到 —— 对「不懂命令行」的用户可发现性不足。
- 条目副标题（日期 · 大小）灰字偏浅。
- 终端与文件面板的分隔条较粗、46×4 拖柄不够醒目。

## 6. 成本

pi 单次（low）= 90 请求 / 22.4% reasoning / $0.1018。主 agent 验收自写探针 12 个（详见 `.dispatch/my-v4g-*.mjs`），无强档升级。
