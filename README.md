# magpie-terminal（终端）

> 状态：**设计阶段，代码未开始（T1 未启动）**——设计已定，代码未开始：`docs/architecture.md`、`docs/platform-notes.md` 已写完，但仓库里没有 `package.json`、没有 `index.mjs`、没有 `src/`，装不上也跑不起来。

在 magpie 窗口里放一个真终端，右侧配一个会说中文的 AI 命令助手。
A real terminal inside the magpie window, with a Chinese-speaking AI command assistant on the right.

---

## 这是什么

magpie 侧栏多一页「终端」，整页是一个真正的 TTY：多标签、每个标签独立 shell 与工作目录，右侧一栏用中文说需求就能拿到命令。产品形态参考 [github.com/chaterm/Chaterm](https://github.com/chaterm/Chaterm)，只借鉴「每步可审核」的交互，不移植任何代码。

## 解决什么问题

1. **不想为了跑一条命令切窗口。** magpie 里已经在看对话、看模型额度，再开一个系统终端就要 alt-tab；这一页把终端留在同一个窗口里（证据：插件页由宿主渲染成同窗口内的 iframe，见 `docs/platform-notes.md`）。
2. **AI 给的命令要能落地。** 网页版聊天给出的命令只能复制粘贴，还得自己判断能不能跑；这里 AI 直接拿到「当前 cwd + 终端最近输出 + shell 类型」，命令可以一键执行（T2 范围）。
3. **危险命令需要人点一下。** 分级器把只读命令自动跑、破坏性命令做成确认卡，避免「AI 说得很顺就照着回车」（设计见 `docs/architecture.md`，验收第 5 条）。
4. **要真 TTY，不是命令回显。** `vim`、`top` 这类全屏程序必须跑在 PTY 上；本机已用 `node-pty` 实测 `stty size` 回读 `30 100`、`isatty` 为 true（实测记录见 `docs/pty-notes.md` 第 1 节的对照表）。
5. **插件装在本机、不经过市场。** 用本地路径 `magpie plugin add` 安装，代码不出这台机器（`magpie` 段不发布到市场，见「非目标」）。

## 界面形态

```
┌ 标签栏： [ bash: ~/project ×] [ bash: ~/huoshu ×] [+]
├──────────────────────────────────┬──────────────┐
│                                  │  AI 栏        │
│   xterm.js 真终端（主区）          │  「看看谁占   │
│                                  │   着 3480」   │
│                                  │  → 建议命令   │
│                                  │  [执行][复制] │
└──────────────────────────────────┴──────────────┘
```

- 多标签，每个标签独立 PTY、独立 cwd。
- 窗口主题（明/暗）与字体跟随 magpie 传入的 `tokens`。
- AI 栏：说中文需求 → 结合当前上下文给命令；只读命令自动执行，危险命令弹确认卡。

## 功能范围

| 卡片 | 范围 | 出口条件 |
|---|---|---|
| **T1** 骨架 + 真终端 | 插件包、`package.json` 的 `magpie` 段、`index.mjs` 起 3480 服务、带路页、xterm.js UI、多标签、主题同步、无 PTY 降级 | 能 `magpie plugin add` 装上；`app.log` 出现 `plugin: [magpie-terminal] listening on http://127.0.0.1:3480`；侧栏有「终端」；浏览器里能敲命令 |
| **T2** AI 栏 + 分级执行 | 网关客户端（`/v1/models` 探活 + 聊天补全）、上下文采集、命令抽取、白名单分级、自动跑 / 确认卡、输出回喂继续解释 | AI 说一句 → 命令真跑出来，输出可见 |
| **T3** 打磨 | 快捷键、命令历史、错误提示、README/安装/卸载/端口/权限、自测脚本 | 可交付 |
| **V1** 独立核验 | 真浏览器驱动关键路径 + 分级器单测 + 安全边界 + 孤儿进程检查 | 核验原始结果落盘 |

必过验收 7 条（原文与「怎么验 / 证据落在哪」在 `docs/roadmap.md` 第 3 节）：装得上并在日志里有 listening 行、`cd`/`ls`/`echo hi` 有真实输出且 `vim` 能开能退、resize 后连敲 10 次不丢字符、「看看谁占着 3480」只读命令自动执行、删除类命令弹确认卡且不点不动、伪造 `Origin`/错 `Host`/缺 token 全部 403、关标签与退 magpie 后无孤儿 shell（pid 核验）。

### 非目标

- 不做多主机 SSH / 堡垒机。
- 不发布到插件市场（用本地路径安装）。
- 会话不跨 magpie 重启保留。
- 不做内联 Ghost text 命令推荐。

## 安装与卸载

本项目不发布到市场，安装时给本地路径：

```bash
magpie plugin add C:/Users/41807/magpie-terminal
magpie plugin list --json          # 确认列表里出现 magpie-terminal
magpie plugin rm magpie-terminal   # 卸载
```

- **默认端口 3480。** 选它是因为 3425（网关）、3477（page-chat）、3488（agent-console 的 gate）、3496（model-quota）已被占用，而 3480/3466/3478/3490 空闲（实测，见 `docs/platform-notes.md` 端口表）。
- **改端口有两条途径**，两处必须改成同一个值：
  1. 编辑本仓库 `package.json` 的 `magpie.options.port`（同时 `magpie.page.service.port` 要一致，样板 page-chat v0.1.14 两处都是 3477）；
  2. 已装好的插件用 `magpie plugin options` 改选项，不必重新 `plugin add`。
- 改完要完全退出 magpie 再打开：旧进程还占着 3480 时新服务绑不上端口。宿主关 stdin 时会直接 `process.exit()` 把插件宿主带走（见 `docs/platform-notes.md` 的 `index.mjs` 契约），所以正常退出不会留残留进程。

## 健康检查

日志：`C:\Users\41807\AppData\Local\magpie\logs\app.log`

必看这一行：

```
plugin: [magpie-terminal] listening on http://127.0.0.1:3480
```

没有这一行 = 服务没起来，先看同一份日志里 `[magpie-terminal]` 的错误输出；有这一行但页面空白/报错，按「常见故障」处理。这条日志格式与宿主对其它页面插件的输出一致（实测 page-chat 为 `plugin: [page-chat] listening on http://127.0.0.1:3477`）。

## 安全说明

一句话版：这个服务只给本机的这个窗口用，别的网页碰不到；AI 只能自动跑只读命令，会改东西的命令一定要你点「执行」。

展开说：

- **只听本地。** 应用服务绑定 `127.0.0.1:3480`，不监听 `0.0.0.0`，局域网里的其它机器连不上。
- **每个请求都验 token 与 Host。** 进程启动时生成 32 字节随机 hex 写进页面，所有 `/api/*` 与 WebSocket 升级都要带，服务端用 `timingSafeEqual` 比对；`Host` 必须是 `127.0.0.1:3480` 或 `localhost:3480`（防 DNS 重绑定）；`Origin` 只接受 `undefined`、字面量 `"null"`（沙箱 iframe 的 opaque origin 就是 `null`）或自身。
- **只读命令自动跑。** 分级器按 `&& || ; |` 切段，每段命令头命中只读白名单才自动执行。
- **危险命令必须点确认。** 出现 `>` 重定向、命中黑名单（`rm`/`mv`/`del`/`cp`/`npm i`/`pip install`/`git push`/`git reset`/`sudo` 等）、或切不开的命令串，一律弹确认卡；不点不动（fail-closed）。
- **你手敲的命令直接执行。** 那是你自己的终端，不经过分级器——分级器只约束 AI 生成的命令。

## 依赖

| 依赖 | 版本/位置 | 说明 |
|---|---|---|
| Node.js | `>= 20`，开发机实测 `v24.16.0`（npm `11.13.0`） | 插件代码按 Node 20 的 API 面写，避免用只有 24 才有的特性 |
| Bun | 由 magpie 自带，`C:/Users/41807/.cache/magpie/bun/1.4.5/magpie-bun.exe` | 不在 PATH 里，不要指望 `bun` 命令；`state.json` 当前指向 1.4.5 |
| node-pty | `1.2.0-beta.15`，已在 `C:\Users\41807\.config\magpie\plugins\node_modules\` | 纯预编译，不需要 node-gyp / VS Build Tools；带 `prebuilds/win32-x64`、`win32-arm64`、`darwin-*`、`linux-*` |
| ws / zod / ignore / node-addon-api | 同上目录已存在 | 依赖复用宿主 `plugins/node_modules`，不要重复安装另一份（会导致 Bun 装错版本，见平台笔记的坑 3） |

## 开发与文档导航

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 进程/组件关系、两条关键时序、模块边界、关键设计决策、数据存哪 |
| `docs/platform-notes.md` | magpie 平台事实、页面插件机制、`package.json` 字段、`index.mjs` 契约、WebView2 故障专章、网关与端口 |
| `docs/security.md` | 安全模型与威胁边界（由另一份任务维护） |
| `docs/pty-notes.md` | node-pty 实测记录与三个必修坑（由另一份任务维护） |
| `docs/roadmap.md` | T1/T2/T3 的排期与依赖（由另一份任务维护） |
| `.trellis/spec/` | 分层编码规范，子 agent 实现前必读 |

## 开发流程（trellis）

本项目按 trellis 工作流推进：**先规划、再实现、最后验收**，每个任务在 `.trellis/tasks/` 下有独立目录，规范在 `.trellis/spec/`。三阶段是 Plan → Execute → Finish，详见 `.trellis/workflow.md`。

```bash
# 首次使用，登记开发者身份（生成 .trellis/.developer 与 workspace 目录）
python ./.trellis/scripts/init_developer.py <your-name>

# 看当前活动任务
python ./.trellis/scripts/task.py current --source

# 列出可用包与 spec 层
python ./.trellis/scripts/get_context.py --mode packages

# 看某个步骤的详细指引（例：1.1 需求探索）
python ./.trellis/scripts/get_context.py --mode phase --step 1.1

# 新建任务 / 激活任务（激活后状态才变 in_progress，才能开始写代码）
# create 会把标题加上 MM-DD- 前缀作为任务目录名；--description 不能留空（archive 时会校验）
python ./.trellis/scripts/task.py create "标题" --slug 任务名 -d "一句话描述"
python ./.trellis/scripts/task.py start 任务目录名

# 收尾
python ./.trellis/scripts/task.py finish
python ./.trellis/scripts/task.py archive <name>
```

> `task.py start` 需要会话身份；没有身份时会报错并给出提示，按提示设置 `TRELLIS_CONTEXT_ID` 后重试。

### 开发状态

- **T1 + T2 已实现，待人工眼验与提交**（2026-11-22）。仓库里已有 `package.json`、`index.mjs`、`page/`、`app/`、`src/`、`scripts/`、`test/`，`node_modules/` 与 `app/vendor/xterm/` 是本地依赖与前端库副本，均不入库。
- **自动化门槛**：`npm test`（= `node --test`，**不要带 `test/` 路径参数**：本机 node v24.16.0 会把目录参数当模块解析并报错，node v26 会静默把 `test/fixtures/*` 当测试跑）→ 112 pass / 0 fail / 0 skip；v24.16.0 与 v26.12.1 两个 node 各自实跑都一致；`node scripts/doctor.mjs` → 33/33 断言、exit 0。
- **已在真 Chrome（headless + CDP）里走过的路径**：页面骨架与主题变量生效（`--magpie-bg` 为传入的 `#1e1e2e` 而非兜底 `Canvas`）、打开即自动建首个标签、真键盘输入落到真 PTY、`vim` 能进能退、resize 后连敲 10 条无丢字符、AI 栏真调网关拿到 `ls -la`、非只读命令弹确认卡且不点不动、Esc 关卡后文件仍在。
- **尚未验证的两件事**（需要人眼看着）：`magpie plugin add` 真装到本机 magpie 之后，侧栏是否出现「终端」入口、`app.log` 是否出现 `plugin: [magpie-terminal] listening on http://127.0.0.1:3480`、以及 WebView2 沙箱 iframe 里页面是否真的画出来（这条没法用自动化脚本断言）。
- **推 GitHub 等开发完成后再做**（当前本机无 `gh` CLI、无 GitHub token、无 SSH 私钥）。
- 设计事实以本仓库 `docs/` 下 5 份主文档 + `.trellis/spec/` 下 15 份规范为准，代码与文档冲突时先改文档再改代码。`docs/sources/` 下是编写期工作记录归档（可追溯，但不是事实源）。任务书是根目录 `TASK.md`，实现方的自测报告是根目录 `REPORT.md`。
- `.trellis/tasks/00-bootstrap-guidelines` 已归档（`.trellis/tasks/archive/2026-11/`，`status: completed`）。

### 正文里的简称

- `BRIEF` / `BRIEF 2.1` → `docs/sources/brief.md`（编写期简报）的节号。
- `F:412` / `FINDINGS 6a` → `docs/sources/pty-probe-findings.md`（本机 PTY 探测原始记录）的行号 / 节号。
- 两份文件逐字节归档、行号有意保持原样；要改内容就必须同步改引用，否则不要动它们。

## 常见故障

**所有插件页同时报「此页面已停止工作」，magpie 自带页正常、宿主日志健康** → 是 WebView2 把沙箱 iframe 隔离成 OOPIF，跟本插件无关，别改插件文件也别重装插件。症状指纹、根因、规避命令与撤销方法见 `docs/platform-notes.md` 的「WebView2 已知故障」章节。

## 许可证

**MIT。** `LICENSE` 文件已在仓库根目录（21 行，版权行 `Copyright (c) 2026 王宁`）；`package.json` 将来定 `"license": "MIT"`。

产品形态参考 chaterm/Chaterm，未移植任何代码——因此不需要单独建 `NOTICE`，致谢只写在这一段。

## 已定项

| 项 | 结论 |
|---|---|
| 默认 shell | **bash（msys）优先，PowerShell 回退**；探测顺序、WindowsApps 陷阱与 msys 校验见 `docs/architecture.md` 第 7 节 |
| 许可证 | MIT，`LICENSE` 已存在（见上） |
| 是否推送到 GitHub | **要推，时机在开发完成之后**（T3 完成、README 定稿后）；前置两件：解决认证（当前无 `gh` CLI、无 `GH_TOKEN`、无 SSH 私钥）、做一次历史与路径脱敏审查 |
| 文档语言 | 用简体中文，**不采用** trellis 模板默认的「All documentation should be written in English」；理由：只有一位中文开发者。属有意偏离，不是遗漏 |
