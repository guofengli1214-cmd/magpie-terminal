# 开发笔记（DEV-NOTES）

本文件记「开发时会踩、但不属于产品行为」的事实。每条都写**可核对的事实**，不写推测；
写推测的地方必须明写「未验证」。

---

## 插件目录自动重载（2026-11-25 排查结论）

### 现象

在仓库里（`C:\Users\41807\magpie-terminal`）写一个临时脚本或证据文件，**插件宿主会在 1 秒内重启**，
正在用的终端会话随之消失。看起来像「终端自己断了」，其实是 magpie 把插件当成「源码变了，重新加载」。

### 事实（已在 magpie 源码里逐条核对）

`~/.config/magpie/plugins.json` 里本项目是**以裸路径安装**的：

```json
{ "spec": "C:\\Users\\41807\\magpie-terminal" }
```

对这类「路径插件」（`plugin.IsPath(spec)` 为真），magpie 的宿主会定期给插件的目录做一次
**内容指纹**（`internal/plugin/pathstamp.go`）：

| 事实 | 位置 | 说明 |
|---|---|---|
| 每 **1 秒** 允许重算一次指纹 | `pathstamp.go`：`var pathsEvery = time.Second` | `pathsStamp()` 在 `pathsEvery` 内直接返回上一次结果 |
| 指纹 = 每个文件的 `路径:ModTime:Size` | `stampPath()` | 文件名、修改时间、大小任一变化都算「变了」 |
| 单次最多看 **2000** 个文件 | `const pathsMax = 2000` | 超过就 `SkipAll`（只看前 2000 个） |
| 遍历**跳过** `node_modules` 与**所有点开头的目录** | `stampPath()`：`d.Name() == "node_modules" \|\| strings.HasPrefix(d.Name(), ".")` | 所以 `.git`、`.trellis`、`.dispatch` 都不会被看到 |
| **`tmp/` 不在跳过名单里** | 同上 | 仓库里的 `tmp/` 是普通目录 → 写文件就会被看见 |
| 指纹变了 → `hostStale = true` + `changed()` | `internal/plugin/store.go`：`checkList()` | 调用方（gateway / host）随之重启整个**插件宿主** |
| 检查在**每次调用插件**时跑 | `checkList()` 的调用点：`gateway.go:253,357`、`host.go:1012`、`providers.go:724` | 不是后台定时器，是「有人用插件时顺手看一眼」 |

### 结论与做法

1. **开发期的临时脚本、证据、日志一律写到仓库外**（本项目的约定是
   `C:/Users/41807/AppData/Local/hermes/cache/scratch/<批次>/` 与仓库内的点开头目录
   `.dispatch/`、`.trellis/`）。
2. 想继续用 `tmp/` 这个名字的话，把它改成点开头（`.tmp/`）即可绕开指纹；两种做法选一种。
3. **没有任何 CLI / settings / 环境变量开关能关掉它**（2026-11-25 核对：
   - `pathsEvery` / `pathsMax` 是 `internal/plugin/pathstamp.go` 的**包级变量**，没有 flag、没有 settings 入口；
   - 本机 magpie 源码快照里全部 `MAGPIE_*` 环境变量共 27 个（`grep -rhoE "MAGPIE_[A-Z0-9_]+" | sort -u`），
     没有一个是目录监视 / 插件重载相关的；
   - `magpie --help` 的全部子命令里也没有相关开关。
   - 要改频率只能改源码重新编译。）

### 附带结论：为什么「重启」会杀终端会话

插件宿主进程就是跑我们 `startServer()` 的那个进程（magpie-bun 里的插件入口）。宿主重启 =
本进程退出 → 它拉起的 PTY 子进程一起没了。所以这不是「重连逻辑的 bug」，重连也救不回来。

---

## 诊断用的「审阅为什么没跑」

`src/ai/judge.mjs` 第 3.5 级：命中 `UNREVIEWABLE_HITS`（`unparsable` / `substitution` / `redirect` /
`exception` / `invalid-input`）时**直接 confirm，不调审阅**。这是有意为之（fail-closed）：
切不开的命令审阅模型往往只看第一行就回 safe。

要让用户知道「不是审阅坏了、是这条命令没送审」，必须把 judge 的 `reason` 传给前端
（`agent.approval` 的 `reviewReason` / `reviewHit`），见
`.trellis/spec/frontend/ui-structure.md` 的「确认卡（approval）的字段与文案分支」。

`2026-11-25` 之前的 `2>&1` 误报就是这条链的副作用：`splitSegments` 见到 `>` 就返回
`hit:"redirect"` → 跳过审阅 → 卡片只能写「审阅不可用」。现在无害重定向先剥离再判
（`.trellis/spec/backend/security-model.md` 5.4.2）。
