# Agent 协议规范（卡 C / 卡 D 共用，改动前必读）

> 本文件是**唯一权威**。卡 C（界面）与卡 D（内核）都按这里实现，不许各自发明字段名。

---

## 1. 配置文件新增字段（`src/config/store.mjs`）

`KNOWN_FIELDS` 从 `["model"]` 扩展为：

```js
export const KNOWN_FIELDS = Object.freeze([
  "model",
  "autonomy",
  "allowlist",
  "reviewModel",
  "basePrompt",
]);
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autonomy` | `"strict" \| "balanced" \| "loose"` | `"balanced"` | 自动执行档位 |
| `allowlist` | `Array<{pattern: string, mode: "prefix"\|"exact", enabled: boolean}>` | `[]` | 用户白名单，最多 200 条 |
| `reviewModel` | `string \| null` | `null` | 第二 AI 审阅用的模型；`null` = 跟对话模型同款；`""`（空串）= 关闭审阅 |
| `basePrompt` | `string \| null` | `null` | 用户自定义基础提示词；`null` = 用内置默认 |

**校验规则（服务端必须实现，返回 400 + code）：**

- `autonomy` 不在三值内 → `INVALID_AUTONOMY`
- `allowlist` 不是数组或超 200 条 → `INVALID_ALLOWLIST`；每条 `pattern` 必须是 1–500 字符的字符串且不含换行，`mode` 必须是 `prefix` 或 `exact` → `INVALID_ALLOWLIST`
- `reviewModel` 不是 `string|null` 或长度 > 200 → `INVALID_REVIEW_MODEL`
- `basePrompt` 不是 `string|null` 或长度 > 8000 → `INVALID_BASE_PROMPT`

`DEFAULT_CONFIG` 要带上这四项的默认值。`normalize()` 遇到非法值一律回落默认（不抛错）。

**注意**：`test/config/store.test.mjs` 有一条测试断言 `KNOWN_FIELDS` 等于 `["model"]`，本卡要把它改成新字段列表（这是**允许的**改动，不是放宽测试）。

---

## 2. 白名单匹配语义

```js
// pattern 已 trim；大小写敏感；不做通配符展开
// prefix 模式：command.startsWith(pattern) && (剩下的第一个字符是空白或结尾)
//   → 可以写 "mkdir"，命中 "mkdir a b"，不命中 "mkdirx"
// exact 模式：command.trim() === pattern.trim()
```

多个条目按数组顺序，命中第一个 `enabled: true` 的即算命中。`enabled: false` 跳过。

---

## 3. WebSocket 帧协议（`src/server/ws.mjs` 新增分支）

**旧的 `ai.ask` / `ai.reply` / `ai.error` 分支保留不动**（别删，测试和降级路径还在用）。

### 3.1 客户端 → 服务端

```ts
// 发起一个 agent 任务
{ type: "agent.run", requestId: string, question: string, model?: string,
  context?: { cwd?: string, shell?: unknown, recentOutput?: string, sessionId?: string } }

// 对某一步的审批（approvalId 来自 agent.approval 帧）
{ type: "agent.approve", requestId: string, approvalId: string,
  approved: boolean, scope?: "once" | "rest" }   // scope 默认 "once"

// 停止任务：只掐后续步骤，不杀已在跑的命令
{ type: "agent.stop", requestId: string }
```

### 3.2 服务端 → 客户端

```ts
// 任务开始（每条 agent.run 只会收到一次）
{ type: "agent.start", requestId: string, taskId: string, model: string, targetSessionId: string }

// 一步的生命周期（同一 stepId 会多次推送，前端按 stepId upsert）
{ type: "agent.step", requestId: string, taskId: string,
  stepId: string, index: number,        // index 从 1 开始
  kind: "command" | "note",             // note = 模型的纯文字说明
  status: "pending" | "running" | "awaiting" | "done" | "failed" | "denied" | "skipped",
  command?: string, why?: string,
  output?: string,                      // 已 strip ANSI、已截断到 4000 字符（头部 1000 + 尾部 3000）
  exitCode?: number | null,
  durationMs?: number,
  userText?: string }                   // 失败时的大白话说明

// 需要用户确认（一个 stepId 只会收到一次）
{ type: "agent.approval", requestId: string, taskId: string, stepId: string,
  approvalId: string, command: string, why: string,
  // 下面四个审阅字段：任何 autonomy 档位都会有值（strict 也照跑审阅），
  // 只有审阅调用失败 / 超时时才是 null（此时角标置灰，一律要求用户确认）。
  risk: "safe" | "caution" | "danger" | null,   // 审阅 AI 的结论
  effect: string | null,                        // 大白话：执行后会发生什么
  confirmWhy: string | null,                    // 大白话：为什么要用户亲自确认
  reversible: boolean | null,
  reviewModel: string | null }

// 任务结束（成功或失败都会发一次，且只发一次）
{ type: "agent.done", requestId: string, taskId: string,
  text: string,                          // 模型的最终大白话总结
  steps: number,                         // 总步数
  stopped: boolean,                      // 是否被用户停止
  durationMs: number }

{ type: "agent.error", requestId: string, taskId: string,
  code: string, userText: string }
```

**字段缺失规则**：可选字段没有值就不要出现（不要写 `undefined`，JSON 会丢掉，但别写 `null` 占位，除非上面明确允许 `null`）。

---

## 4. 命令执行通道（`src/ai/runner.mjs` 新增）

**在用户真实 PTY 里执行**，这样命令跟随用户 shell 的当前目录，用户也能在终端里看见发生了什么。

### 4.1 包装串

```js
const nonce = crypto.randomBytes(6).toString("hex");
const startMark = `__MT_S_${nonce}__`;
const endMark = `__MT_E_${nonce}__`;
const payload = `printf '\\n%s\\n' '${startMark}'; ( ${command}\n ) 2>&1; printf '${endMark}%s\\n' "$?"\n`;
```

写入：`registry.write(sessionId, payload)`（本地是 `sessions.write`，远程是 `remote.write`）。

### 4.2 切分（**这里有个必须处理的坑**）

终端的回显里也会出现 `startMark`（因为它出现在 `printf` 的参数里）。所以：

1. 累积该 sessionId 的 `pty.output` 文本到 buffer
2. `stripped = stripAnsi(buffer)`
3. 找 **最后一次** 出现的 `startMark`（`lastIndexOf`），从它之后开始算
4. 在该区间里找 `endMark` + 紧跟的数字 → `exitCode`
5. 输出 = 两次标记之间的文本，去掉首尾空白

`stripAnsi` 用正则 `/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g`。

### 4.3 结束判定

满足任一即结束：

- 收到 `endMark<数字>` → 拿 exitCode
- 静默 ≥ `quietMs`（默认 1000ms）**且** 已过 `minWaitMs`（默认 300ms）→ exitCode 为 `null`，附 `userText: "命令没有按预期结束，可能进入了交互模式（比如等待输入）。"`，同时发 `agent.stop` 语义给模型让它别等了
- 超过 `timeoutMs`（默认 90000ms）→ 同上，`userText: "命令超过 90 秒还没结束，已放弃等待。"`

### 4.4 能力探测（每个会话一次，缓存在 Map 里，按 sessionId）

第一次执行前先跑：

```
printf '__MT_PROBE_<nonce>__%s\n' "ok"
```

能读到 `__MT_PROBE_<nonce>__ok` → 支持；否则标记 `unsupported`，之后所有自动执行请求直接返回
`{ ok: false, code: "EXEC_UNSUPPORTED", userText: "这个终端不支持自动执行（可能是 Windows 的 cmd.exe），我把命令列给你，你复制到终端里运行。" }`。

发送 `EXEC_UNSUPPORTED` 时，模型应改为只用文字回答并给出命令列表，不再调 `run_command`。

### 4.5 铁律

- **绝不**在日志里打印完整命令（只打 `commandLength` 和前 40 字符）
- **绝不**把 PTY 原始字节直接塞给模型（必须先 stripAnsi 再截断）
- 执行期间不改用户的终端尺寸、不发 `pty.resize`

---

## 5. 分级链（`src/ai/judge.mjs` 新增）

输入 `{ command, config, reviewModel }`，输出 `{ decision: "auto"|"confirm", reason, hit, risk, effect, confirmWhy, reversible, reviewModel }`。

**严格按此顺序，命中即返回：**

1. **硬禁止**（`src/policy/forbidden.mjs`）→ 永远 `confirm`

   | 分类 | 匹配（命令下划线化后做词边界匹配） |
   |---|---|
   | 提权 | `sudo` `su ` `runas` `doas` `pkexec` |
   | 磁盘 | `mkfs` `dd ` `diskpart` `format ` `fdisk` `parted` |
   | 递归删除危险目标 | `rm` + `-r`/`-rf`/`--recursive` 且目标是 `/` `/*` `~` `~/*` `$HOME` `C:\` |
   | 权限 | `chmod -R` `chown -R` `takeown` `icacls` |
   | 系统 | `shutdown` `reboot` `halt` `poweroff` `init 0` `init 6` |
   | 管道执行 | 含 `|` 且右侧是 `sh`/`bash`/`zsh`/`python`/`node` |
   | 强推 | `git push` 带 `--force`/`-f` |
   | 历史改写 | `git reset --hard` `git clean -fd` |
   | Windows 注册表 | `reg delete` |

2. **用户白名单**（config.allowlist，按 §2 语义）→ `auto`，`reason: "你的白名单"`，`hit: 命中的 pattern`

3. **内置只读白名单**（`src/policy/classify.mjs` 的现有 `classify()`）→ 结果是 `auto` 就 `auto`

4. **第二 AI 审阅**（`config.reviewModel !== ""`，默认开；**三个档位都强制执行，没有任何档位跳过这一步**）
   - 调 `src/ai/review.mjs` 的 `reviewCommand({command, model})`
   - 返回 `{ risk, effect, confirmWhy, reversible, model }`
   - 审阅照跑之后，档位只决定「审阅结论怎么用」：
     - `strict`：审阅结论只用于确认卡展示与日志，**绝不据此自动放行**；能 auto 的只有第 2 步用户白名单和第 3 步内置只读白名单，其余全部 `confirm`
     - `balanced`：`risk === "safe"` 且 `reversible === true` → `auto`
     - `loose`：在 `balanced` 基础上，`risk === "caution"` 且 `reversible === true` → `auto`
     - `risk === "danger"`：**任何档位都不 auto**
   - 审阅调用失败/超时（8s）→ **任何档位都 `confirm`**，`reason: "审阅服务不可用，按需要确认处理"`，确认卡角标置灰（`data-review="none"`）；不得静默降级为跳过审阅

5. **兜底** → `confirm`

### 5.1 第二 AI 审阅实现（`src/ai/review.mjs`）

**不要用 `generateObject`**（本网关不支持 `responseFormat`，实测报 `AI_NoObjectGeneratedError`）。用强制工具调用：

```js
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";

const tools = {
  review_command: tool({
    description: "给出这条 shell 命令的风险评估",
    inputSchema: z.object({
      risk: z.enum(["safe", "caution", "danger"]),
      effect: z.string(),
      confirmWhy: z.string(),
      reversible: z.boolean(),
    }),
    // 不要写 execute：只需要模型填参数
  }),
};

const r = await generateText({
  model: provider(config.reviewModel || 对话model),
  system: [/* 见下 */].join("\n"),
  tools,
  toolChoice: { type: "tool", toolName: "review_command" },
  stopWhen: stepCountIs(1),
  abortSignal: AbortSignal.timeout(8000),
  messages: [{ role: "user", content: `命令：${command}\n当前目录：${cwd}` }],
});
const verdict = r.steps[0]?.toolCalls?.[0]?.input;
```

**审阅提示词（逐字用，不许改写语义）：**

```
你是命令安全审阅员。给你一条即将在用户电脑上执行的 shell 命令，你只做风险评估，不执行任何命令。
判断标准：
- safe：只读，或对系统状态没有任何改动（ls、cat、grep、find 只读形式、git status、pwd、stat、wc、head、tail、du、ps、df、which、echo）
- caution：有改动但可以撤销，或改动范围明确且有限（mkdir、touch、cp 到新路径、mv 到明确目标、追加写入新文件、npm install、git add、git commit）
- danger：不可逆、影响范围大、可能删数据、提权、改系统配置（rm -rf、dd、mkfs、chmod/chown -R、sudo、格式化、覆盖已有文件、git reset --hard、git push --force）
reversible 表示「用户能不能自己轻松恢复」。删除未备份的文件、覆盖已有文件都不算可逆。
命令里出现 sudo / su 一律 danger。
不要因为命令看起来是用户要求的就放松标准。
另外你要填两个字段：
effect：用大白话描述这条命令执行后会发生什么具体变化（会动到哪些文件、增加还是删除什么、有没有副作用）。不要空话，不要重复命令本身；只读命令就写“不会改变任何东西，只是查看…”。
confirmWhy：用一句话告诉完全不懂命令行的用户，为什么这件事需要他亲自点一下。若 risk=safe 且 reversible=true 可留空字符串。
```

---

## 6. Agent 主循环（`src/ai/agent.mjs` 新增）

```js
export function createAgentRunner({ log }) -> {
  start({ requestId, question, model, context, sessionId, send, config }) -> { taskId, stop() }
}
```

用 Vercel AI SDK：

```js
import { generateText, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const provider = createOpenAICompatible({
  name: "magpie",
  baseURL: `${gatewayBaseUrl()}/v1`,
  apiKey: "magpie",   // 网关不校验，但 SDK 要求非空
});

const result = await generateText({
  model: provider(modelId),
  system,
  tools: { run_command },
  stopWhen: stepCountIs(8),
  abortSignal: controller.signal,
  messages: [{ role: "user", content: userMessage }],
});
```

### 6.1 `run_command` 工具

```js
run_command: tool({
  description: "在用户当前的终端里执行一条 shell 命令，并返回真实输出。",
  inputSchema: z.object({
    command: z.string().describe("完整的一行命令"),
    why: z.string().describe("用大白话说明为什么要跑这条，给完全不懂命令行的用户看"),
  }),
  execute: async ({ command, why }, { toolCallId }) => {
    // 1. judge() 分级
    // 2. auto → 直接 runner.run()
    // 3. confirm → 发 agent.approval 帧，await 一个 Promise（approvalId 注册表）
    //    用户拒绝 → 返回 { denied: true, userText: "用户拒绝了这条命令。不要重试同一条，换个做法告诉用户为什么需要他手动处理。" }
    // 4. 执行 → 发 agent.step(running) → 跑完发 agent.step(done, output, exitCode)
    // 5. 返回 { exitCode, output, truncated: boolean }
  },
})
```

**关键：不要用 AI SDK 的 `toolApproval` 配置项。** 实测跨轮恢复有 bug（第 3 轮必报 `Tool result is missing for tool call call_xxx`）。审批挂在 `execute` 内部 `await`。

### 6.2 系统提示词

```js
function buildAgentSystemPrompt(config) {
  const base = config.basePrompt || DEFAULT_BASE_PROMPT;
  return [
    base,
    "",
    "## 硬性规则",
    "1. 你不是在建议命令，你是在替用户干活。需要看什么就自己调用 run_command 去看。",
    "2. 用户可能完全不懂命令行，所以：不要让他自己敲命令来帮你确认；不要在回答里堆命令；最后必须用大白话讲清楚「发生了什么、现在是什么情况、你要不要做什么」。",
    "3. 一条命令拿不到全部信息就多跑几条，最多 8 步。每一步都要有明确目的，不要重复已跑过的命令。",
    "4. 命令失败（exitCode 非 0）先读错误再决定下一步，不要原样重试。",
    "5. 你自己不执行任何命令，应用会按安全策略自动执行或弹确认卡。所以照常给出用户要的命令，包括 rm / mv 这类删除移动；不要因为「它是破坏性操作」就拒绝给命令。",
    "6. 唯一绝对不给的是 sudo / su 这类提权命令。",
    "7. 不要使用 find，文件检索用 rg -n（搜内容）、rg --files（列文件）或 ls。",
    "8. 查看 HTTP 头用 curl -I，不要用 curl 下载或上传。",
    "9. 如果某条命令被用户拒绝，不要重试，改用别的办法或告诉用户需要他手动做什么。",
    "10. 任务完成后必须用文字给出结论，不要只留一串命令输出。",
  ].join("\n");
}
```

`DEFAULT_BASE_PROMPT`：
```
你是一个内置在终端里的 AI 助手。你的服务对象是不太懂命令行的普通用户。你的工作是理解他想达成什么，然后自己动手在终端里把这件事做完，最后用他自己的语言告诉他结果。
```

### 6.3 审批等待（`awaitApproval`）

```js
const pending = new Map();  // approvalId -> { resolve, timer, stepId, taskId }

export function resolveApproval({ approvalId, approved, scope }) {
  const item = pending.get(approvalId);
  if (!item) return false;
  pending.delete(approvalId);
  clearTimeout(item.timer);
  item.resolve({ approved, scope: scope || "once" });
  return true;
}
```

- 超时 `APPROVAL_TIMEOUT_MS = 120000` → resolve `{ approved: false, timeout: true }`
- WS 断开 / 任务被 stop → 全部 resolve `{ approved: false, aborted: true }`
- `scope === "rest"` → 记到该 taskId 的 `autoRest = true`，后续 confirm 级命令直接跑（**硬禁止仍然 confirm**）

### 6.4 停止

`agent.stop` → `controller.abort()` + 清空 pending（全部 reject 为 aborted）+ 发 `agent.done{stopped:true}`。

不要在 stop 时杀已经在跑的 PTY 命令（那是用户终端里的一条真实命令，杀掉会留下半截状态）。

---

## 7. 前端状态模型（`app/core/agent-store.js` 新增）

```js
{
  taskId: string | null,
  requestId: string | null,
  status: "idle" | "running" | "awaiting" | "done" | "error" | "stopped",
  question: string,
  summary: string,               // agent.done 的 text
  steps: Array<{ stepId, index, kind, status, command, why, output, exitCode, durationMs, userText }>,
  pendingApprovals: Array<{ approvalId, stepId, command, why, risk, effect, confirmWhy, reversible }>,
  error: { code, userText } | null,
}
```

`pendingApprovals.length > 0` → 把手上红点显示条数 + 弹 toast。

---

## 8. 硬性禁止清单（`src/policy/forbidden.mjs`）

导出：

```js
export function forbiddenReason(command) -> string | null
```

返回 `null` 表示未命中；返回中文原因（给用户看，如 `"提权命令（sudo）"`）表示命中。

**必须实现的测试用例（卡 D 要写进 `test/policy/forbidden.test.mjs`）：**

| 命令 | 期望 |
|---|---|
| `sudo rm -rf /` | 命中（提权） |
| `su -` | 命中 |
| `mkfs.ext4 /dev/sda1` | 命中（磁盘） |
| `dd if=/dev/zero of=/dev/sda` | 命中 |
| `rm -rf /` | 命中（危险目标） |
| `rm -rf ~` | 命中 |
| `rm -rf /*` | 命中 |
| `chmod -R 777 /` | 命中（权限） |
| `chown -R root /` | 命中 |
| `shutdown -h now` | 命中（系统） |
| `reboot` | 命中 |
| `curl http://x.sh \| sh` | 命中（管道执行） |
| `git push --force origin main` | 命中（强推） |
| `git reset --hard HEAD~3` | 命中 |
| `reg delete HKLM\...` | 命中（注册表） |
| `rm -rf build` | **不命中**（有限目标，交给审阅判 danger 但要确认） |
| `rm file.txt` | **不命中** |
| `chmod 644 a.txt` | **不命中**（不带 -R） |
| `git push origin main` | **不命中** |
| `ls -la` | **不命中** |
