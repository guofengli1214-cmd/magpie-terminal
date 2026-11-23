# 方案 V3：把 AI 助手改成真正的 agent（开源选型已实测）

> 状态：**待批准**（等用户回 A/B/C）。批准后才派发。
> 目标仓库：`C:/Users/41807/magpie-terminal`（当前 HEAD `aad9ea3`）

---

## 一、你提的 7 件事，现在的真实病根（已读代码定位，不是猜）

| 你说的问题 | 现在的实际代码 | 病根 |
|---|---|---|
| 设置按钮点了没反应 | `app/ui/rail.js` 第 63 行附近，settings 的 click 监听体是空的，注释写着「本卡只渲染，点击无副作用」 | 从来没实现过 |
| 随便一条命令都弹确认 | `src/server/ws.mjs` 的 `handleAsk()` 只调一次 `classify()`（静态白名单），没有第二 AI、没有用户白名单 | 只有一个判据 |
| 一句话只能一条命令 | `src/ai/gateway.mjs` 的 `buildSystemPrompt()` 写死「给出**一条**命令」，返回 `{command, reason}` | 不是 agent，是命令翻译器 |
| AI 栏在底部 | `app/styles/layout.css` 的 `[data-role="aibar"]` 是 44px 底栏；`app/index.html` 的 `#root` 带 `data-ai-open="true"` | 形态不对 |
| 没有红点 / toast | `app/app.js` 的 `arriveAiResult()` 只在 rail 图标点个圆点 | 不区分「有回答」和「等你确认」 |
| 测试连接首连必失败 | `src/ssh/registry.mjs:415` `testHostConnection()` 先查 known_hosts，没有就抛 `UNKNOWN_HOST_KEY`；`app/ui/hosts-panel.js:347-391` 只显示「失败：…」不引导 | 缺引导 |
| 用户看不懂终端 | 终端是原样 xterm，AI 只回一句命令 + 理由 | 缺总结层 |

---

## 二、开源选型（你要求：能用现成的就别自己写）

全部在本机真跑过，不是查文档。

| 用途 | 选型 | 许可 | 实测结果 |
|---|---|---|---|
| agent 循环 / 工具调用 / 多步 | `ai@7.0.179` | Apache-2.0 | ✅ node v24 与 magpie-bun 1.4.4 都跑通。一句「看看有几个文件、哪个是日志」自动串 **5 步**，最后给中文总结（13084ms，input 3126 / output 781） |
| 接 magpie 网关 | `@ai-sdk/openai-compatible@3.0.94` | Apache-2.0 | ✅ 直连 `http://127.0.0.1:3425/v1`，6 个模型可用 |
| 流式边想边显示 | `streamText`（同包） | Apache-2.0 | ✅ 首块 12ms、52 块、8178ms、2 步 |
| 第二 AI 审阅分级 | `generateText` + 强制 `toolChoice` | 同上 | ✅ 2 模型 × 4 命令全通：`ls -la`→safe；`rm -f -- *.log`→danger；`sudo rm -rf /etc`→danger；`mkdir build-out`（flash 判 safe / gpt-6.2-sol 判 caution，说明要容忍分歧） |
| 命令结束判定 | 输出静默 1s（上限 90s） | — | 真终端事件驱动，无需轮询 |
| **不采用** `@openai/agents` | 0.22.0 MIT | — | ❌ 绑 OpenAI 专有的 interruptions / RunState 形态，magpie 网关未必兼容 |
| **不采用** chaterm 源码 | GPL-3.0（LICENSE 首行确认） | — | ❌ 传染性，只能借产品形态，代码不能搬 |
| **不采用** AI SDK 的 `toolApproval` HITL | — | — | ❌ 跨轮恢复有 bug：第 3 轮报 `Tool result is missing for tool call call_2b2665cd916d4d8fb4d253b6`。实测三种恢复写法只有一种能跑，连跑两轮必崩 |
| **不采用** `shell-quote` 当安全解析 | 1.12.0 MIT | — | ❌ 换行被当空格：`"ls\nrm -rf /"` → `["ls","rm","-rf","/"]`，当安全判据会漏 |
| **保留自写** `src/policy/classify.mjs` | 自有 | — | 428 行 + 193 测试全绿，已实测拦住 `find -fprint`、`curl -I -T`、`git branch <name>`。重写风险 > 收益 |

**结论：agent 内核用 AI SDK，审批不用它的 HITL 而挂在工具执行内部 async 等待（已实测 5 步、两次挂起、批准后继续、拒绝路径可用）。**

---

## 三、卡 C：界面（先做，做完给你看）

### C1. 修设置页（现在是空的）
左栏「设置」点开右侧浮层，四块：

1. **自动执行档位**（三选一，默认「平衡」）：
   - 严格：只有内置只读白名单 + 你加的白名单能自动跑，其余全问
   - 平衡：再加第二 AI 判「只读或幂等」的自动跑
   - 宽松：再加「可撤销的写操作」（如 `mkdir`、`cp` 到新路径）自动跑
2. **命令白名单**：列表增删/启停，每条选「前缀匹配」或「整条匹配」（默认前缀）。例如加 `mkdir` 前缀 → 以后 `mkdir a b` 都不问
3. **审阅模型**：下拉（默认跟对话模型同款），可选「关闭审阅」（关闭后等于严格档）
4. **基础提示词**：textarea，默认值是改写后的系统提示词，可改可恢复默认

每块下面一句话说明「改了会怎样」，说人话。改完即时生效，刷新后保留。

### C2. AI 栏改右侧抽屉
- 360px，**默认收起**；收起时右边缘垂直居中一个 48×96 的把手（✦ 图标）
- 展开时挤左终端并重排（xterm 自动 fit），收起时终端拿满宽度
- 待确认时把手上红色角标显示条数
- 右下角弹 **toast，不自动消失**：「需要确认：`rm -f a.log`」+ 按钮「确认执行」「查看」
- 点「查看」展开抽屉并滚到那条

### C3. 测试连接遇未信任指纹 → 弹核对卡
- `testHostConnection()` 遇 `UNKNOWN_HOST_KEY` 时，前端弹指纹核对卡（算法 + 指纹 + 「信任并记住」）
- 点「信任并记住」→ 写 known_hosts → 自动重试

### C4. 顺手修
- `app/ui/rail.js` 的 settings 监听接线
- 抽屉展开/收起的布局溢出（1280×760 与 829×721 两个视口都要 0 溢出）

---

## 四、卡 D：agent 内核（C 验收后做）

### D1. 用 AI SDK 重写 AI 后端
`src/ai/agent.mjs`（新增）：
```js
generateText({
  model: provider(modelId),
  system: 用户配置的提示词 + 硬规则,
  tools: { run_command },
  stopWhen: stepCountIs(8),
  abortSignal,
})
```
`run_command.execute` 内部：
1. 硬禁止检查（任何档位都不自动）→ 直接 `await awaitingUser()` 等人点
2. 用户白名单命中 → 直接跑
3. 内置只读白名单命中 → 直接跑
4. 第二 AI 审阅（`generateText` + 强制 toolChoice，返回 `{risk, why, reversible}`）
5. 档位映射 → auto 或 `await awaitingUser()`
6. 跑完把**真实输出**回喂模型，进入下一步

`awaitingUser()` = Promise + 超时 + WS 断开时 reject，批准/拒绝都通过 WS 帧回传。

### D2. 多步执行时间线
- 抽屉里显示：✅ 已执行 / ⏸ 等你确认 / ⏳ 进行中 / ❌ 失败
- 每步可展开看命令 + 真实输出
- 「全部执行」= 本任务剩余自动放行（硬禁止除外）
- 「停止」= abort，只掐后续，不杀已在跑的那条

### D3. 面向外行的总结
- 系统提示词明确：用户不懂命令行，不许让他自己跑命令确认；能自己查就自己查；最后必须用大白话给结论
- 命令输出喂回模型时截断（单条 4KB，超长尾部保留）

### D4. 硬禁止集合（任何档位都不自动）
`sudo` / `su` / `runas`、`mkfs` / `dd` / `diskpart` / `format`、`rm -rf` 指向根或家目录或通配、`chmod` / `chown -R`、关机重启、`curl|sh`、`git push --force`

---

## 五、验收标准（必过）

| # | 标准 | 怎么验 |
|---|---|---|
| 1 | 设置页能打开、四块都能改、刷新后保留 | 真点真改，重启服务再读 |
| 2 | 抽屉默认收起、把手位置正确、展开不溢出 | 829×721 与 1280×760 两个视口量几何 |
| 3 | 待确认时红点 + toast 真出现，点「确认执行」真执行 | 写文件副作用验证 |
| 4 | 白名单加 `mkdir` 前缀后不再弹确认 | 加之前弹、加之后不弹 |
| 5 | 同一条命令在严格/宽松下行为不同 | 两档各跑一次 |
| 6 | 硬禁止在宽松档 + 白名单下手也拦 | `sudo rm -rf /` 必弹 |
| 7 | 一句「把这个仓库的测试跑一遍告诉我有没有失败」自动串 ≥2 步并给结论 | 真跑，看执行记录 |
| 8 | 「停止」真截断后续步骤 | 故意跑长命令，看后续不再执行 |
| 9 | 删 known_hosts 后点测试连接弹指纹卡，能信任并连上 | 真连本机 sshd |
| 10 | `node --test` 全绿、`doctor` 33/33、终端/远程/文件树不回归 | 亲自跑 |

---

## 六、风险与退路

| 风险 | 退路 |
|---|---|
| 模型给出危险但看起来正常的命令 | 硬禁止 + 第二 AI 审阅 + 默认平衡档三重 |
| 审批 Promise 悬挂导致任务永久卡住 | 超时（120s）+ WS 断开 reject + 「停止」按钮 |
| AI SDK 在 magpie-bun 下某 API 不可用 | 已实测 generateText / streamText / tools 都通；若遇个别 API 缺失，回落 node 子进程 |
| 多步执行把终端搞乱 | 每步前后打印分隔标记，用户能看到边界 |
| 审阅模型判错 | 审阅只影响「要不要问」，不影响「能不能跑」；硬禁止独立兜底 |

---

## 七、成本与调度

- 执行：pi（`--provider magpie --model commandcode/deepseek/deepseek-v4.1-flash`），一张卡一个新会话
- 审批：主 agent 只判定，不写代码
- 顺序：C → 验 → D → 验。C 做完先给你看界面
