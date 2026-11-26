# TASK-FIX17-A-VERIFY — A 批独立复核 + spec 漂移同步

Active task: C:/Users/41807/magpie-terminal/.trellis/tasks/11-25-task-a-shell-core
父任务: C:/Users/41807/magpie-terminal/.trellis/tasks/11-25-fix-17-parent
工作目录: C:/Users/41807/magpie-terminal
Node: D:/nodejs/install/node.exe（bash 里 `node` 已指向它）

## 你是谁

你是**独立复核会话**，不是执行会话。A 批代码已由前一个 pi 会话实现完毕，报告在
`.dispatch/fix17-a/REPORT.md`，证据在 `.dispatch/fix17-a/evidence/`，**工作区未 commit**。
你的任务是：先把 spec 漂移同步掉，然后**独立重跑**全部关键验收并留证，最后给 PASS/FAIL。

不要相信 REPORT.md 里的数字，自己跑。已知 REPORT.md 有一处瑕疵：它声称
`evidence/AC9-doctor.txt` 是「33/33」，但磁盘上那份文件实际是「14/17，3 条 FAIL」，
且它引用的 `evidence/AC9-doctor-rawcmd.txt` 并不存在。你重跑后把真实结果写成新证据，
并在 VERIFY.md 的「残留问题清单」里如实记录这件事（**不要修改 REPORT.md**）。

## 第一步：同步 spec 漂移（本卡唯一的代码库写入）

A 批把「resize 后向 PTY 写一个垃圾 `'\r'`」这一做法**整段删掉了**（现在暖场只做输入排队，
不写任何字节）。但两份 spec 仍描述旧做法，必须改成与实现一致：

1. `.trellis/spec/backend/pty-lifecycle.md`
   - 第 95 行「修复流程」那一行：把「2) 立刻向 PTY 写一个垃圾 `'\r'`；」改为不写字节的表述
     （执行 resize → 进入输入排队窗口 250–500ms 内按键入队 → 窗口结束后按序冲刷）。
   - 第 98 行「为什么发 `'\r'` 而不是别的」这一行：改写为「为什么不发任何字节」，
     说明 2026-11-25 A 批实测：发 `'\r'` 会在终端上多出一个空提示符行（用户可见），
     而纯排队窗口同样能让首字符不丢（`scripts/probe-resize-blank.mjs` 的 AC5/AC6 证据）。
2. `.trellis/spec/frontend/terminal-rendering.md`
   - 第 70 行「输入封锁窗口 250–500ms」：把「实测对策是 resize 后先发一个垃圾 `'\r'`、
     等 250–500ms 再接受真实输入」改为「实测对策是 resize 后进入 250–500ms 纯排队窗口，
     不发任何字节」。
   - 第 71 行「垃圾字节由谁发」：改为「没有任何字节需要发送；服务端只负责开窗口并在
     窗口结束时按序冲刷队列，前端只负责窗口内排队」。

**不要改** `docs/sources/brief.md`、`docs/sources/pty-probe-findings.md`、
`docs/pty-notes.md`、`.trellis/spec/backend/quality-guidelines.md` ——
那些是历史实测证据原文，保留原样（它们记录的是当时的做法）。

改写时保留表格结构与中文风格，不要整篇重写，只动上述 4 行涉及的段落。

## 第二步：独立复核（只读 + 落证）

所有原始输出写入 `.dispatch/fix17-a/verify/`（自建目录），一个检查一个文件。

**V1 `node --test`**
跑 `node --test > .dispatch/fix17-a/verify/V1-node-test.txt 2>&1`，
把 `ℹ tests` / `ℹ pass` / `ℹ fail` 三行原样记进 VERIFY.md。要求 763/763、fail 0。
若失败：先看是不是 pty 集成组超时（`test/pty/session.test.mjs`）。本机有历史遗留的
`bash.exe` 孤儿进程会耗尽 ConPTY 的 console 名额（Windows 上限 128），症状是
`console device allocation failure - too many consoles in use` 或整组 timeout。
处理办法见 V2 的清理步骤；**绝不许改测试、放宽断言、加 skip**。

**V2 doctor ×2**
```bash
mkdir -p tmp/verify-cfg && printf '{"version":1,"defaultShell":null}' > tmp/verify-cfg/config.json
MAGPIE_TERMINAL_CONFIG_PATH="C:/Users/41807/magpie-terminal/tmp/verify-cfg/config.json" \
DOCTOR_PORT=3811 node scripts/doctor.mjs > .dispatch/fix17-a/verify/V2-doctor-3811.txt 2>&1; echo "EXIT=$?" >> ...
# 再跑 DOCTOR_PORT=3812
```
两次都必须 `doctor: 33/33 assertions passed` 且 `EXIT=0`。
出现 `STEP_TIMEOUT` 或 `8.orphans` 失败时：先记下 `tasklist | grep -c "bash.exe"` 与
`tasklist | grep -c "conhost.exe"`；若 bash.exe 明显偏多（>3），用
`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Select ProcessId,CreationDate"`
找出**启动时间早于 2026-11-25 00:47** 的历史孤儿，`Stop-Process -Id ... -Force` 清掉，
再重跑；把清理前后的进程计数与重跑结果都写进证据。**不许改 scripts/doctor.mjs**。

**V3 五个探针全跑**（逐个记录 `x/y passed` 与退出码，原始输出各存一份）
- `node scripts/probe-shells-api.mjs` → 12/12
- `node scripts/probe-resize-blank.mjs` → 6/6
- `node scripts/probe-ai-blank.mjs` → 4/4
- `node scripts/probe-terminal-edges.mjs` → 10/10（真 Chrome，会截图）
- `node scripts/probe-shells-ui.mjs` → 按其自身输出的通过数

**V4 反作弊抽查**（在 VERIFY.md 里逐条打 ✔/✘ 并附命令与输出）
- a) `grep -rn 'handle.write("\\r")' src/pty/` → 0 命中（幽灵回车已彻底删掉）
- b) `git diff --stat aef8063 -- app/vendor/xterm/` → 空（vendor 三文件未被改）
- c) `node -e "import('./src/pty/shells.mjs').then(m=>console.log(JSON.stringify(m.detectShells().map(s=>({id:s.id,group:s.group,available:s.available})),null,1)))"` → 含 cmd/bash/pwsh/powershell 与 `wsl:Ubuntu-24.04`，每条都有 group
- d) `git diff aef8063 -- src/server/http.mjs | grep -n '^-.*shells'` 目视：`/api/shells` 的响应字段只增不改（老字段 id/name/version/path/available 仍在）
- e) `git diff aef8063 -- src/config/store.mjs` 目视：白名单校验已换成格式校验（`isValidShellId` 之类），不再硬拒未知 id
- f) 真实负例：把配置文件的 `defaultShell` 改成 `"wsl:NoSuchDistro-99"` 后启一次服务并 `GET /api/shells`，确认不 500、configured 回落为 null（探针脚本里应已有此能力，没有就写 tmp/ 临时脚本，**跑完删掉**）

**V5 真浏览器截图**
用 `scripts/probe-shells-ui.mjs` 已产出的截图，若没有则用
`node scripts/browser-probe.mjs <url>` 或该探针自行截图，落 `.dispatch/fix17-a/verify/ui-shell-menu.png`，
确认「新建标签 → 本机」菜单里看得见 5 个 shell 项（含 Ubuntu-24.04），不是 3 个。

## 硬约束

1. **唯一允许的写入**：上面第一步的两个 spec 文件；`.dispatch/fix17-a/verify/` 下的证据与 VERIFY.md；`tmp/` 下临时脚本（跑完删）。
2. 不许改 `src/**`、`app/**`、`test/**`、`scripts/**`、`package.json`、`.dispatch/fix17-a/REPORT.md`、`.dispatch/fix17-a/evidence/**`。
3. 不 commit、不 stash、不碰 `.git`、不切分支。
4. 不许放宽断言、删测试、改基线、加 skip 来「变绿」。
5. 卡外决策（例如发现实现有真 bug 需要改代码）→ 停手，在 VERIFY.md 写 `blocked: <原因>`，不要自己动手改。
6. 本机坑：原生程序不认 `/c/...` 和 `/tmp` 路径；bash heredoc 里的 `C:\Windows\...` 反斜杠会被吞，写文件用 node 脚本。

## 交付

`.dispatch/fix17-a/verify/VERIFY.md`：
- V1–V5 逐条：命令、真实数字、证据文件名、✔/✘
- 「残留问题清单」：含 REPORT.md 与磁盘证据不符这一项，以及其他你发现的
- 最后一行只能是 `verdict: PASS` 或 `verdict: FAIL`

跑完在终端最后打印同一行 verdict。
