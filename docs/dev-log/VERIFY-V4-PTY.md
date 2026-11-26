# VERIFY-V4-PTY：pty 测试原生崩溃（flaky）定位与修复

日期：2026-11-24　执行：主 agent 亲跑全部实验　仓库：`C:/Users/41807/magpie-terminal`

## 1. 症状

`test/pty/session.test.mjs` 偶发**整个测试文件消失**（无 JS 报错）：

```
✖ test\pty\session.test.mjs (1841.2107ms)  'test failed'
ℹ tests 3 / pass 2 / fail 1
```

进程被原生断言带走，栈形如：

```
node::BaseObject::decrease_refcount (src\base_object.cc:133)
Assertion failed: (metadata->strong_ptr_count) > (0)
node::MultiIsolatePlatform::DisposeIsolate
FATAL ERROR: v8::HandleScope::CreateHandle() Cannot create a handle without a HandleScope
```

环境：Node v24.16.0（`D:/nodejs/install/node.exe`，MODULE_VERSION 137），node-pty `1.2.0-beta.15`。

## 2. 排查过程（全部主 agent 亲跑，脚本在 `.dispatch/`）

| 探针 | 结论 |
| --- | --- |
| `probe-pty-crash.mjs` / `probe-pty-crash2.mjs`（每步同步落盘） | 单纯 create→write→close 循环 1/6~1/10 静默死，位置在 `created` 之后 |
| `probe-pty-case5.mjs`（精确复现 #5，45 轮） | 全过；说明不是 resize/连敲导致 |
| `probe-gc-finalize.mjs`（`--expose-gc`，25 轮×3） | 全过；GC/finalize 假设不成立 |
| `probe-double-kill.mjs`（`dbl_immediate`：连按两次 kill） | **1/4 崩溃**；`single`/`dbl_onexit` 全过 |
| `probe-exit-race.mjs`（8 个 handle） | `killeXit`（kill 后立刻 `process.exit(0)`）**挂死**（timeout 70s→EXIT=124）；`waitExit`（等 onExit 再退）6s 干净退出；`noKill` 也干净退出 |
| `probe-kill-count.mjs`（计数 handle.kill 调用） | 修复前 `close()` 杀 1 次、node-pty onExit 再杀 1 次 = **kills 2**；修复后 kills 1 |
| Node 26.12.1 交叉验证 | 同样不稳定（6 次里 1 次 16 项全过后进程不退出）→ 不是 Node 24 独有 |
| 孤儿进程清理（`probe-clean-orphans.mjs --kill`） | 清掉 134 个孤儿（git 127 / bash 7 / conhost 3）；清完后仍有崩溃（见 §4 A/B）→ 孤儿只是放大器，不是根因 |

上游查证（GitHub API）：node-pty
- [#989](https://github.com/microsoft/node-pty/issues/989)：`PtyKill` 关掉 pseudoconsole 后 `hpc` 未置 null，第二次 kill 会重复关同一个 pseudoconsole → 进程被带走。
- [#951](https://github.com/microsoft/node-pty/issues/951)：`ThreadSafeFunction` 在 Node 环境销毁期间回调 → abort；修法（`NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS`）在 beta.15/17/main 的 `binding.gyp` 里都没有。
- 本机没有 MSVC，不能本地重编译 node-pty；升级到 beta.18 也不含上述修复 → 只能业务侧避险。

## 3. 根因

两条同时成立：

1. **我方双重 kill**：`SessionManager.close()` 调 `handle.kill()`，node-pty 随后仍触发 `onExit` → `handleExit()` 在 `session.handle` 上再 `kill()` 一次。同一次会话生命周期内关两次 pseudoconsole，正好命中 #989 的崩溃路径。实测 `dbl_immediate` 探针 1/4 崩溃。
2. **kill 是异步的**：`kill()` 返回时 ConPTY 还没关完（exit watcher 之后才回调 JS）。此期间建下一个 PTY 或让进程退出，就会撞进原生 teardown（`probe-exit-race` 的 `killeXit` 挂死、`waitExit` 干净）。

## 4. 修法

**`src/pty/session.mjs`**
- 新增 `killOnce(session)`：`session.killed` 标记，同一会话只 kill 一次；`close()` / `handleExit()` / `killAllSync()` 全部走它。
- 新增 `markExited(session)`：`onExit` 到达时 resolve `session.exitPromise`。
- 新增 `SessionManager.whenExited(session, timeoutMs = 5000)`：等真正退出，超时返回 false。
- `handleExit` / `close` / `killAllSync` 的其余清理逻辑与事件顺序不变，`close()` 仍是同步返回 true。

**`test/pty/session.test.mjs`**
- 新增 `closeAndWait(manager, session)`：`close()` 后 `await manager.whenExited(session, 5000)`，断言为 true。5 个用例全部改用它，保证「先等 ConPTY 关干净，再建下一个 PTY / 结束进程」。
- 新增回归用例「close() 只 kill 一次：onExit 不再重复关 pseudoconsole」（假 handle 计 kill 次数，并验证 `whenExited`）。

产品 API 未变，无新增依赖。

## 5. 验收证据（主 agent 亲跑）

**A/B 对照（同一台机器、已清孤儿进程，变量只有代码）**

| 组 | 命令 | 轮次 | 结果 |
| --- | --- | --- | --- |
| 修复前（`git stash` 回 HEAD） | `node --test test/pty/session.test.mjs` | 12 | **1 次崩溃**（`.dispatch/ab-8.txt`：`tests 3 / pass 2 / fail 1`，文件级 `'test failed'`，与历史症状一致），11 次 16/16 |
| 修复后 | 同上 | 8 | 8 次 17/17（`.dispatch/ab2-1..8.txt`） |
| 修复后（早前批次） | 同上 | 16 | 16 次 17/17（`.dispatch/pt2-*.txt`、`pt3-*.txt`） |

**全量测试**（修复后）：`node --test` 三轮 `674/674 pass / 0 fail`，各 ~18.4s（`.dispatch/ft-1..3.txt`；基线 673 + 新增 1 条回归用例）。

**双重 kill 消除**：`probe-kill-count.mjs` 修复前 `kills 2`，修复后 `kills 1`，`state=closed`。

汇总：修复后 27 次运行 0 崩溃；修复前同一环境下 12 次里 1 次崩溃（历史记录中曾达 2/5）。

## 6. 残余风险与已知边界

- node-pty 上游缺陷未修（#989 / #951 / #960），本次是**业务侧避险**：我们不再二次 kill，并给测试加了「等退出」的原语。若将来上游修复，`killOnce` 可保留（幂等 kill 本身是正确语义）。
- `process.on('exit')` 里的 `killAllSync()` 仍会在进程退出时同步 kill——这是 `probe-exit-race` 里 `killeXit` 的危险形态（可能挂住退出）。当前只影响「magpie 服务进程被外部强杀」的场景，不影响测试；已记录为后续可选优化（改为 SIGINT/SIGTERM 优雅关闭 + 超时兜底）。
- 本机孤儿进程会放大该类问题（历史事故：139 个孤儿 shell → `too many consoles in use, max consoles is 128`）。本次开工时清掉 134 个孤儿。
