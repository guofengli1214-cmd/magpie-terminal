# REPORT-V3D — Agent 内核（多步执行 / 分级链 / 第二 AI 审阅 / 白名单）

- 任务：`TASK-V3-D.md`（attempt 1）
- 协议：`docs/PROTOCOL-AGENT.md`（唯一权威，字段名/帧形状/提示词/正则逐字实现）
- 状态：**待验收**（不是成品）
- 原始证据目录：`evidence-v3d/`
- 模型：`commandcode/deepseek/deepseek-v4.1-flash`（provider = magpie）

---

## 1. 逐条 AC 结果

| AC | 必过 | 结果 | 证据 |
|---|---|---|---|
| AC1 | 是 | **PASS** — `package.json` dependencies 含 `"ai": "7.0.179"` 与 `"@ai-sdk/openai-compatible": "3.0.94"`，精确版本无 `^` | §2.1 / package.json |
| AC2 | 是 | **PASS** — `test/policy/forbidden.test.mjs` 32 个 test 全绿（§8 表格 21 条 + 边界/异常补充） | `test/policy/forbidden.test.mjs` |
| AC3 | 是 | **PASS** — `test/ai/allowlist.test.mjs` 17 个 test 全绿（`mkdir` 命中 `mkdir a b`、不命中 `mkdirx`；exact 只认全等；`enabled:false` 跳过） | `test/ai/allowlist.test.mjs` |
| AC4 | 是 | **PASS** — GET 返回四默认值；PUT 合法值回读一致；四个非法值各返回对应 400 码（`INVALID_AUTONOMY` / `INVALID_ALLOWLIST` / `INVALID_REVIEW_MODEL` / `INVALID_BASE_PROMPT`） | §2.4 + `evidence-v3d/config-probe-v3d.txt` |
| AC5 | 是 | **PASS** — 硬禁止在 `autonomy:"loose"` + 白名单 `sudo` 命中下**仍然 confirm**（`judge("sudo rm -rf /")`、`judge("sudo ls")` 两条断言） | `test/ai/judge.test.mjs` |
| AC6 | 是 | **PASS** — `ls -la` 三档全 auto 且不调审阅；`mkdir testdir` 按 strict/balanced/loose × 审阅结论分别 confirm/confirm/auto | `test/ai/judge.test.mjs` |
| AC7 | 是 | **PASS** — 真调 `http://127.0.0.1:3425/v1`，三条命令拿到三段合法 JSON（risk/why/reversible），单次均 ≤ 8s | §3 逐字 JSON / `evidence-v3d/review-probe-v3d.txt` |
| AC8 | 是 | **PASS** — 喂含 `startMark` 回显的假输出，切出的 output 不含标记行、exitCode 正确（`lastIndexOf` 路径） | `test/ai/runner.test.mjs` |
| AC9 | 是 | **PASS** — 静默超时 → exitCode null + 协议原文中文 userText；总超时 → 同上；能力探测失败 → `EXEC_UNSUPPORTED` | `test/ai/runner.test.mjs` |
| AC10 | 是 | **PASS** — 假模型驱动 2 步，两次 `agent.step` 都到 socket，最后一条 `agent.done`（另用真网关真 PTY 跑了 2/3/5 步的真实任务） | `test/ai/agent.test.mjs` + `evidence-v3d/agent-smoke-v3d.txt` |
| AC11 | 是 | **PASS** — `approved:false` → 工具返回 `denied` + 协议原文 userText，命令未执行、模型不重试；收尾有且只有一条 `agent.done` | `test/ai/agent.test.mjs` |
| AC12 | 是 | **PASS** — stop 后 pending 全清空并 resolve 成 aborted、发 `agent.done{stopped:true}`（且只发一次）；运行中第二次 `agent.run` → `agent.error{code:"BUSY"}` 且不影响第一个任务 | `test/ai/agent.test.mjs` |
| AC13 | 是 | **PASS** — `node --test` 348 tests / 348 pass / 0 fail（旧 193 条全在，新增 155 条） | §4 / `evidence-v3d/test-output-v3d.txt` |
| AC14 | 是 | **PASS** — `DOCTOR_PORT=3481 node scripts/doctor.mjs` → 33/33 assertions passed，`doctor-report.json` passed:true 失败 0 | §5 / `evidence-v3d/doctor-output-v3d.txt` |
| AC15 | 是 | **PASS** — `git diff --stat app/` 输出 0 字节 | §6 / `evidence-v3d/app-diff-v3d.txt`（0 字节） |

---

## 2. 关键原始输出

### 2.1 依赖（AC1）

```
$ node -e "console.log(require('./package.json').dependencies)"
{
  '@ai-sdk/openai-compatible': '3.0.94',
  ai: '7.0.179',
  'node-pty': '1.2.0-beta.15',
  ssh2: '1.17.0',
  ws: '8.22.0',
  zod: '4.6.7'
}
```

安装命令（逐字，来自 TASK §7.2）：
```
npm install ai@7.0.179 @ai-sdk/openai-compatible@3.0.94 --save-exact
→ added 11 packages, and audited 21 packages in 7s / found 0 vulnerabilities
```

### 2.2 新增/修改文件

新增源码：
- `src/ai/agent.mjs`（agent 主循环，534 行）
- `src/ai/runner.mjs`（PTY 执行通道，404 行）
- `src/ai/judge.mjs`（五级分级链，111 行）
- `src/ai/review.mjs`（第二 AI 审阅，106 行）
- `src/ai/allowlist.mjs`（用户白名单匹配，72 行）
- `src/policy/forbidden.mjs`（硬禁止清单，218 行）

修改：
- `src/config/store.mjs`（KNOWN_FIELDS / DEFAULT_CONFIG / normalize / 校验 / publicConfig）
- `src/server/ws.mjs`（三条入站帧 + 分发 + agent 帧转发 + socket 关闭停任务）
- `src/server/http.mjs`（GET/PUT `/api/config` 四字段与 400 错误码）
- `test/config/store.test.mjs`（KNOWN_FIELDS 断言改成新字段列表 — §6.2 授权）
- `test/ai/prompt.test.mjs`（新增 8 条 agent 提示词断言，旧契约断言原样保留）
- `package.json` / `package-lock.json`

新增测试（9 个文件，共 155 条新 test）：
`test/policy/forbidden.test.mjs`(32)、`test/ai/allowlist.test.mjs`(17)、`test/ai/judge.test.mjs`(27)、`test/ai/runner.test.mjs`(27)、`test/ai/agent.test.mjs`(19)、`test/config/agent-fields.test.mjs`(20)、`test/server/ws-agent.test.mjs`(5)、`test/ai/prompt.test.mjs`(+8)

新增脚本（可复现证据）：
- `scripts/review-probe.mjs`（AC7 真网关审阅）
- `scripts/config-probe.mjs`（AC4 HTTP config 往返 + 四个 400）
- `scripts/agent-smoke.mjs`（端到端：真网关 + 真 PTY + 真 WS）

### 2.3 判级链顺序（AC5 / AC6）

`src/ai/judge.mjs` 严格按 §5：硬禁止 → 用户白名单 → 内置只读 → 第二 AI 审阅 → 兜底。
`autonomy === "strict"` 在第 4 级之前 return（不调审阅）；`reviewModel === ""` 同样跳过审阅。

关键测试输出片段：
```
✔ AC5：硬禁止在 loose + 白名单命中下仍然 confirm
✔ AC5（V03 的另一半）：judge("sudo ls") 也是 confirm，白名单加 sudo 也不行
✔ AC6：ls -la 走内置只读 → 三档都 auto，且不调审阅
✔ AC6：mkdir testdir —— strict → confirm，且不调审阅
✔ AC6：mkdir testdir —— balanced + 审阅 caution + 不可逆 → confirm
✔ AC6：mkdir testdir —— loose + 审阅 caution + reversible=true → auto
```

### 2.4 配置四字段（AC4）

`scripts/config-probe.mjs` 原始输出（完整见 `evidence-v3d/config-probe-v3d.txt`）：

```
--- GET /api/config（文件不存在 → 四个默认值）
HTTP 200
{"model":"commandcode/deepseek/deepseek-v4.1-flash","autonomy":"balanced","allowlist":[],"reviewModel":null,"basePrompt":null}
--- PUT /api/config（四个合法值）
HTTP 200
{"model":"commandcode/deepseek/deepseek-v4.1-flash","autonomy":"loose","allowlist":[{"pattern":"mkdir","mode":"prefix","enabled":true}],"reviewModel":"commandcode/deepseek/deepseek-v4.1-flash","basePrompt":"你是我的私人助理。"}
--- GET /api/config（回读，应与 PUT 一致）
HTTP 200
{"model":"commandcode/deepseek/deepseek-v4.1-flash","autonomy":"loose","allowlist":[{"pattern":"mkdir","mode":"prefix","enabled":true}],"reviewModel":"commandcode/deepseek/deepseek-v4.1-flash","basePrompt":"你是我的私人助理。"}
--- PUT INVALID_AUTONOMY
HTTP 400
{"code":"INVALID_AUTONOMY","userText":"autonomy 必须是 strict / balanced / loose 之一。"}
--- PUT INVALID_ALLOWLIST（不是数组）
HTTP 400
{"code":"INVALID_ALLOWLIST","userText":"allowlist 必须是数组且不超过 200 条。"}
--- PUT INVALID_ALLOWLIST（pattern 超 500）
HTTP 400
{"code":"INVALID_ALLOWLIST","userText":"allowlist 每条都需要 1-500 字符的 pattern（不含换行）、mode=prefix|exact、enabled=true|false。"}
--- PUT INVALID_REVIEW_MODEL
HTTP 400
{"code":"INVALID_REVIEW_MODEL","userText":"reviewModel 必须是字符串或 null。"}
--- PUT INVALID_BASE_PROMPT
HTTP 400
{"code":"INVALID_BASE_PROMPT","userText":"basePrompt 长度不能超过 8000。"}
```

落盘文件（`~/.config/magpie-terminal/config.json` 的同构，测试用临时目录）：
```json
{
  "model": null,
  "autonomy": "loose",
  "allowlist": [
    { "pattern": "mkdir", "mode": "prefix", "enabled": true }
  ],
  "reviewModel": "commandcode/deepseek/deepseek-v4.1-flash",
  "basePrompt": "你是我的私人助理。"
}
```

---

## 3. AC7 审阅实测（真网关，逐字 JSON）

命令：`D:/nodejs/install/node.exe scripts/review-probe.mjs`
网关：`http://127.0.0.1:3425/v1`（OpenAI 兼容，apiKey = "magpie"，网关不校验）
模型：`commandcode/deepseek/deepseek-v4.1-flash`（reviewModel 为 null → 跟对话模型同款）

```
gateway = http://127.0.0.1:3425
--- command: "ls -la"  durationMs=2523  under8s=true
{"risk":"safe","why":"`ls -la` 仅列出当前目录内容（含隐藏文件与详细属性），是纯只读操作，不修改、创建或删除任何文件，也不改变系统状态。无 sudo、无重定向、无管道，不存在副作用，用户无需恢复任何内容。","reversible":true,"model":"commandcode/deepseek/deepseek-v4.1-flash"}
--- command: "rm -rf build"  durationMs=3274  under8s=true
{"risk":"danger","why":"rm -rf 会递归强制删除 build 目录及其全部内容，无法撤销，且不经回收站；在 Windows 的 cmd/PowerShell 中原生 rm 通常不可用，但若由 Git Bash/WSL/PowerShell 别名执行则同样会直接删除目录。删除范围虽限定在当前目录的 build，但若 build 路径是符号链接/联接点或被误指向其他位置，影响范围可能扩大。","reversible":true,"model":"commandcode/deepseek/deepseek-v4.1-flash"}
--- command: "sudo rm -rf /"  durationMs=3160  under8s=true
{"risk":"danger","why":"该命令以 root 权限递归强制删除根目录 / 下的全部内容，会摧毁整个操作系统（系统文件、用户数据、配置全部丢失），且删除不可逆、无备份可恢复；同时命令中包含 sudo，属于提权执行，按规则一律判定为 danger。此类命令通常会被现代系统保护机制拦截，但在放开保护或容器/沙箱环境下仍会直接生效。请勿执行。","reversible":false,"model":"commandcode/deepseek/deepseek-v4.1-flash"}
totalDurationMs=8957
```

三条 verdict 判定：
- `ls -la` → `safe` / `reversible:true` ✅（AC7 要求 safe）
- `rm -rf build` → `danger` / `reversible:true` ✅（AC7 允许 caution 或 danger）
- `sudo rm -rf /` → `danger` / `reversible:false` ✅（AC7 要求 danger）

**诚实说明（重要的打折项）**：这条链路受网关延迟影响，实测成功率不是 100%。
`reviewCommand` 对**每一次**调用都设 `AbortSignal.timeout(8000)`（协议 §5.1 硬性要求），
网关在同一时段偶发 8s 以上无响应，此时会按设计 fail-closed 返回
`{"risk":null,"why":"审阅服务不可用","reversible":null}`，`judge()` 落到 confirm。
本机连续 6 次跑 probe 的实测分布：**3 次干净（三条全拿到结论）、3 次有一条或两条落到 fallback**。
本报告贴的是**一次干净运行**的逐字输出（`evidence-v3d/review-probe-v3d.txt`），
另有一次 fallback 运行的原始输出保留在下面，避免只挑好看的那次：

```
--- command: "ls -la"  durationMs=2632  under8s=true
{"risk":"safe","why":"ls -la 仅列出当前目录（C:\\Users\\41807\\magpie-terminal）下全部条目及详细信息（含隐藏文件），是纯只读操作，不修改、创建或删除任何文件，对系统状态无任何影响，可放心执行。","reversible":true,"model":"commandcode/deepseek/deepseek-v4.1-flash"}
--- command: "rm -rf build"  durationMs=8006  under8s=false
{"risk":null,"why":"审阅服务不可用","reversible":null,"model":"commandcode/deepseek/deepseek-v4.1-flash"}
--- command: "sudo rm -rf /"  durationMs=8014  under8s=false
{"risk":null,"why":"审阅服务不可用","reversible":null,"model":"commandcode/deepseek/deepseek-v4.1-flash"}
```

这条失败路径不降低安全性（协议 §13 明确：审阅失败一律 confirm，属预期 fail-closed），
但它会让「平衡档下只读以外的命令」更常弹确认卡。是否放宽 8s 属于协议变更，本卡不擅自改。

---

## 4. 全量回归（AC13）

```
$ D:/nodejs/install/node.exe --test          # cwd = 仓库根，不带路径参数
ℹ tests 348
ℹ suites 0
ℹ pass 348
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11984.4799
```

完整输出：`evidence-v3d/test-output-v3d.txt`（366 行，逐 test 一行）。

数量对账：
- 卡前基线：193 tests / 193 pass / 0 fail
- 本卡新增：155 条
- 合计 348（193 + 155），0 fail。
- 旧 193 条中唯一改动的断言：`test/config/store.test.mjs` 的 `KNOWN_FIELDS` 深等于
  `["model"]` → `["model","autonomy","allowlist","reviewModel","basePrompt"]`
  （TASK-V3-D §6.2 明确授权的唯一改动）。

新增测试逐个文件的结果：
```
test/policy/forbidden.test.mjs      ℹ tests 32
test/ai/allowlist.test.mjs          ℹ tests 17
test/ai/judge.test.mjs              ℹ tests 27
test/ai/runner.test.mjs             ℹ tests 27
test/ai/agent.test.mjs              ℹ tests 19
test/config/agent-fields.test.mjs   ℹ tests 20
test/server/ws-agent.test.mjs       ℹ tests 5
test/ai/prompt.test.mjs             ℹ tests 15（旧 7 + 新 8）
test/config/store.test.mjs          ℹ tests 10（旧 10，仅改 1 条断言的期望值）
```

---

## 5. Doctor（AC14）

```
$ DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs
doctor: 33/33 assertions passed
```

`doctor-report.json` 机器可读结果：
```
passed true  assertions 33  failed 0
```

完整 33 条断言逐行：`evidence-v3d/doctor-output-v3d.txt`。

---

## 6. 范围（AC15）

```
$ git diff --stat app/
（输出为空，0 字节）
```

证据文件：`evidence-v3d/app-diff-v3d.txt`（0 字节）。

未修改的禁区（逐项自查）：
- `app/` — 一个字节没动
- `src/policy/classify.mjs` — 没动（只 import `classify()`）
- `src/ssh/*` — 没动（只调 `remote.write` / `remote.on`）
- `src/pty/*` — 没动（只调 `sessions.write` / `sessions.on`）
- 旧的 `ai.ask` / `ai.reply` / `ai.error` 路径 — 分支与 `handleAsk()` 原样保留，新帧在旁边加
- `TASK-V3-D.md` / `docs/PROTOCOL-AGENT.md` / `docs/PLAN-V3.md` / `TASK.md` / `AGENTS.md` / `.trellis/` — 没动
- 没用 AI SDK 的 `toolApproval`（`grep -rn toolApproval src/` 只在注释里出现）
- 没用 `generateObject`（只在 review.mjs 的注释里说明「不用它」）
- 没 git add / git commit

---

## 7. 端到端真跑（用户视角，不是 mock）

这不是 AC 表格里的一项，但 TASK §9 要求「交付前自己按用户视角走一遍」。
`scripts/agent-smoke.mjs` = 真网关 + 真 PTY + 真 WS，确认卡由脚本模拟用户点「确认执行」。

### 7.1 只读任务（3 步，全自动，不弹确认）

```
$ node scripts/agent-smoke.mjs "数一下当前目录下有几个文件，用一句话告诉我"
[3.2s] {"type":"agent.step","index":1,"status":"running","command":"ls -1A | wc -l"}
[3.5s] {"type":"agent.step","index":1,"status":"done","command":"ls -1A | wc -l","exitCode":0}
[8.1s] {"type":"agent.step","index":2,"status":"running","command":"ls -1A"}
[8.2s] {"type":"agent.step","index":2,"status":"done","command":"ls -1A","exitCode":0}
[10.4s]{"type":"agent.step","index":3,"status":"running","command":"ls -1Ap | grep -v '/$' | wc -l"}
[10.6s]{"type":"agent.step","index":3,"status":"done","command":"ls -1Ap | grep -v '/$' | wc -l","exitCode":0}
--- agent.done ---
{"type":"agent.done","requestId":"smoke-1","taskId":"t-363af85379",
 "text":"当前目录（magpie-terminal）下一共有 **18 个文件**，另外还有 15 个文件夹（包括 node_modules、src 等）。\n\n如果你把文件夹也算进去，总共是 33 个条目。",
 "steps":3,"stopped":false,"durationMs":10549}
```

### 7.2 写操作任务（弹确认卡 → 批准 → 执行 → 复查）

```
$ node scripts/agent-smoke.mjs "在当前目录创建一个叫 v3d-smoke2 的空文件夹"
[7.4s] {"type":"agent.step","index":1,"status":"awaiting","command":"mkdir v3d-smoke2"}
[7.4s] {"type":"agent.approval","stepId":"s-940ff81aa8","command":"mkdir v3d-smoke2"}
  → 自动批准（模拟用户点确认）: mkdir v3d-smoke2
    risk=caution reversible=true reviewModel=commandcode/deepseek/deepseek-v4.1-flash
    reviewWhy="mkdir 会在当前目录（C:\\Users\\41807\\magpie-terminal）下新建空目录 v3d-smoke2。属于对文件系统状态的改动，但不会覆盖已有文件、不会删除任何数据；…风险很低且完全可逆，删除该空目录即可恢复原状。…"
[8.2s] {"type":"agent.step","index":1,"status":"done","command":"mkdir v3d-smoke2","exitCode":0}
[11.4s]{"type":"agent.step","index":2,"status":"done","command":"ls -ld v3d-smoke2","exitCode":0}
--- agent.done ---
{"type":"agent.done","text":"文件夹已经建好了，就在当前目录 C:\\Users\\41807\\magpie-terminal 下面，名字是 v3d-smoke2，目前是空的。你不用再做别的了。","steps":2,"stopped":false,"durationMs":13857}
```

这条同时验证了 §3.2 的三个 `agent.approval` 字段真实有值：
`risk:"caution"`、`reviewWhy:<审阅原话>`、`reversible:true`、`reviewModel:<id>`。

完整输出：`evidence-v3d/agent-smoke-v3d.txt`。

---

## 8. 诚实清单：哪些地方打折了 / 偏离了

按 §15 要求逐条列出。

### 8.1 测试用 mock 而不是真网关（**这是协议要求，不是妥协**）

- `test/ai/judge.test.mjs` — 审阅函数**全部注入假实现**。理由：真网关可用性不该让单测变红（仓库既有约定，见 `test/server/models.test.mjs` 顶部注释）。真网关覆盖由 `scripts/review-probe.mjs`（AC7）与 `scripts/agent-smoke.mjs` 负责。
- `test/ai/agent.test.mjs` — `generateText` 注入假实现（拿到真 `tools` 对象，走真 `execute` 路径）。理由同上：真模型慢、贵、不确定。真模型覆盖由 `scripts/agent-smoke.mjs` 负责（已跑 2/3/5 步各一次）。
- `test/ai/runner.test.mjs` — 用假 `sessions`/`remote` 对象喂 `pty.output` 事件，不碰真 node-pty。理由：真终端时序会让单测 flaky。
- `test/server/ws-agent.test.mjs` — 只验「帧进得来、分发对」，不打真网关。

### 8.2 AC7 的 8s 超时导致审阅偶发 fail-closed

见 §3 末尾的说明。连续 6 次 probe，3 次有 fallback。这不影响安全（fail-closed 仍是 confirm），
但会让平衡档更常弹确认。**没有改 8s 超时**，因为那是协议原文硬性要求。

### 8.3 `buildProbePayload` 末尾多了一个 `\n`（**对协议的一处必要补充**）

协议 §4.4 写的是：
```
printf '__MT_PROBE_<nonce>__%s\n' "ok"
```
**没有写行尾换行**。实测（真 PTY）：不补 `\n` 的话这行永远停在 shell 提示行上不提交，
探测必定超时 → 所有会话被误判 `EXEC_UNSUPPORTED`（真终端验证见下面这段原始回显）：

```
--- probe 不带换行，1.5s 后的屏幕 ---
"printf '__MT_PROBE_deadbeef0001__%s\\n' \"ok\""     ← 停在提示行，没执行
```

补 `\n` 后：
```
"printf '__MT_PROBE_deadbeef0001__%s\\n' \"ok\"\r\n__MT_PROBE_deadbeef0001__ok\r\n…"
```

理由与 §4.1 的 `buildPayload` 末尾本来就带 `\n` 一致（协议自己在执行串里写了行尾）。
本卡的处理：`buildProbePayload()` 返回值是「协议原文 + 一个提交用的 `\n`」，
测试里逐字断言这个组合，单测里写清为什么补。**这是「协议漏写行尾」的补全，不是改语义**。
如果验收方认为必须字面一致，请把它记成 needs_clarification 的一条。

### 8.4 `judge()` 返回值多了两个键

TASK §6.5 文档化的是 5 个字段：`{decision, reason, hit, risk, reviewModel}`。
本实现在这 5 个之外**额外**返回 `reviewWhy` 与 `reversible`。

为什么加：`agent.approval` 帧（PROTOCOL §3.2）需要 `reviewWhy: string|null` 与
`reversible: boolean|null`。这两个值只有审阅函数知道，而审阅函数在 `judge()` 内部被调，
`agent.mjs` 拿不到。可选方案只有两个：
1. 让 `agent.mjs` 再调一次 `reviewCommand`（多花一次网关延迟 + 可能给出不同结论）；
2. 让 `judge()` 把结论透出来（本次做法）。

选了 2，**没有改任何文档化字段的名字、类型或语义**，只加键。`judge.test.mjs` 里有断言
锁住了「5 个文档化字段都在，且 reviewWhy/reversible 只反映审阅结论」。
如果验收方坚持严格 5 键，请记成 needs_clarification；届时需要 `agent.mjs` 重调审阅（更慢更贵仍可行）。

### 8.5 协议未覆盖、由本卡自行决定的细节（都已写进代码注释）

| 点 | 协议怎么说 | 本卡怎么做 | 理由 |
|---|---|---|---|
| `agent.run` 的 `sessionId` 从哪来 | §3.1 有 `context.sessionId`（可选） | 优先用 `context.sessionId`；缺省回落到「这个 socket 当前持有的最新会话」；都没有 → `agent.error{code:"NO_SESSION"}` | 前端 C 卡可以只发 `context.cwd`，不必知道会话 id；这是纯粹的服务端兜底，没有新增帧字段 |
| `agent.error` 的 `taskId` | §3.2 要求有 | `NO_SESSION` / `BUSY` 这两种「任务根本没起来」的情况发 `taskId: ""` | 那时还没有 taskId。协议没规定这种情况的取值 |
| `BUSY` 判定粒度 | 「一个连接同时只允许一个」 | 按 socket 算（`Map<socket, task>`）；不同 socket 可并行 | 照 §3「一个连接同时只允许一个」的字面读法 |
| 同一会话并发跑两条命令 | 协议没写 | `runner.run` 第二次直接 `BUSY_SESSION`，不排队 | 在同一个 PTY 里交叉写命令会把两边的输出搅在一起 |
| 命令结束判定读到的 `output` | §4.2 说「两次标记之间的文本」 | 取「最后一次 startMark 之后」到「endMark 之前」，`.trim()` | 逐字照 §4.2 的四步 |
| 无结束标记但静默/超时 | §4.3 说「exitCode 为 null」 | 同时带回已收到的部分输出（`split.output`） | 协议没说这时要不要回部分输出；不回的话模型完全瞎了 |
| 审阅 `reversible` 的默认 | 协议说 `reversible: boolean` | 模型给非布尔 → `null`（当「不可逆」处理，落在 confirm） | fail-closed |
| `EXEC_UNSUPPORTED` 之后怎么让模型停手 | §4.4 说「模型应改为只用文字回答」 | 工具返回 `{error:"EXEC_UNSUPPORTED", userText:<协议原文 + 追加一句「不要再调用 run_command」>}` | 协议说「应改为」，没说怎么告知模型；追加那句是把「应」变成可执行指令 |

### 8.6 范围外的验证：`ls -ap` 原始输出里含 `\r\n`

本机 shell 是 Git Bash（MINGW64），PTY 输出里的换行是 `\r\n`。`agent.step.output` 里保留了 `\r`
（因为协议只要求 stripAnsi + 截断，没说要规范化换行）。前端如果不处理 `\r`，输入框里可能看到
`\r\n` 或 `\r` 残留。**这属于 TASK-V3-C（前端）的事，本卡不动 `app/`**，但记在这里供 C 卡参考。

### 8.7 没做的（协议/卡片明确划出去的）

- 流式 WS 推送（`streamText`）— §3 非目标
- 多任务并发 — §3 非目标（已按连接粒度拦 BUSY）
- 远程 SSH 建连/指纹/文件树 — 不动。但 runner 的 `remote` 分支已接好（`remote.write` / `remote.on("pty.output")`），远程会话的自动执行可以走同一套逻辑（未在真远程主机上验证）。
- Windows `cmd.exe` 下的自动执行 — 能力探测会返回 `EXEC_UNSUPPORTED`（协议 §13 认定的预期行为）。本机 shell 是 bash，所以没走到这条分支的真实验证（只有单测覆盖）。

---

## 9. 关键实现点自查（协议 §6.7 / §8 反例清单）

| 反例 | 本卡实现 | 锁在哪 |
|---|---|---|
| ❌ `indexOf(startMark)` | 用 `lastIndexOf` | `test/ai/runner.test.mjs`「AC8：splitBuffer 用 lastIndexOf」 |
| ❌ 用 AI SDK `toolApproval` | 审批是 `execute` 内部的 `await awaitApproval(...)` | `src/ai/agent.mjs` 注释 + 全仓 grep 无 `toolApproval` |
| ❌ `agent.step.output` 塞原始字节 | runner 先 `stripAnsi` 再 `truncateOutput`，agent 只做 4000 字符兜底 | `test/ai/runner.test.mjs`「输出里的 ANSI 被剥掉」 |
| ❌ 忘了发 `agent.done` | `finish()` / `fail()` 各自保证只发一次（`settled` 锁） | `test/ai/agent.test.mjs`「stop 之后只发一次 done」 |
| ❌ 改 `app/` | 一个字节没动 | §6 / 0 字节 diff |
| 日志打印完整命令 | 只打 `commandLength` + `commandHead`（前 40 字符） | `test/ai/runner.test.mjs`「日志不含完整命令」 |
| 静默判定被别的会话刷活 | 只在该命令自己的 buffer/`lastDataAt` 上算 | `test/ai/runner.test.mjs`「静默判定只算本命令自己的输出」 |
| 执行期间改终端尺寸 | runner 不调 `resize` | 代码里没有 `resize` 调用 |

---

## 10. 复现方法

```bash
# 依赖（已装，无需重跑）
npm install ai@7.0.179 @ai-sdk/openai-compatible@3.0.94 --save-exact

# 全量测试（必须这个形式，不带路径参数）
D:/nodejs/install/node.exe --test

# doctor
DOCTOR_PORT=3481 D:/nodejs/install/node.exe scripts/doctor.mjs

# AC7 真网关审阅（会打 http://127.0.0.1:3425/v1）
D:/nodejs/install/node.exe scripts/review-probe.mjs

# AC4 HTTP config 往返 + 四个 400
D:/nodejs/install/node.exe scripts/config-probe.mjs

# 端到端（真网关 + 真 PTY + 真 WS，会在当前目录跑真命令）
D:/nodejs/install/node.exe scripts/agent-smoke.mjs "数一下当前目录下有几个文件，用一句话告诉我"
```

---

## 11. 白话总结

以前 AI 只能说一条命令给你抄。现在它能自己在你的终端里连着跑几步、看真实输出、最后用大白话
告诉你结果。每条命令先过五道关：绝对危险的不许自动跑；你说过「这类命令别问我」的就跑；
本来就是只读的直接跑；拿不准的让第二个 AI 判风险；判不了就还是问你。

三个真实跑通的例子：问「有几个文件」它自己跑了 3 步给出数字；让它建一个文件夹，它弹确认卡
（第二个 AI 判「可以撤销」，列出了理由），你点确认后它建好并复查了一遍。

两个要你知道的：一是负责「判风险」的第二个 AI 偶尔 8 秒内回不来，这时它会按「不确定」处理，
也就是弹确认卡问你——这是故意的，不是坏了。二是这台机器的终端是 Git Bash，命令输出里的换行
带 `\r`，前端显示时可能要处理一下（那是另一张卡的事）。

界面我一行没动，旧的「一句话一条命令」也还能用。
