# TASK-ACCEPT-F1：magpie-terminal 功能验收（独立执行会话）

## 0. 你是谁、能碰什么

- 项目根：`C:/Users/41807/magpie-terminal`（以下所有相对路径都相对它）。
- Node 一律用 `D:/nodejs/install/node.exe`（v24.16.0）。不要用全局 `node`。
- **只允许写**：`.dispatch/accept-f1/**` 与仓库根的 `ACCEPT-FUNC.md`（新建）。
- **禁止修改**：`src/`、`app/`、`test/`、`scripts/`、`index.mjs`、`docs/`、`package.json` 及任何产品代码。
  发现缺陷只记录，不要修。修由另一张卡负责。
- 不允许问人类问题。卡内没写清的，按最保守解释执行并在报告里写明你的解释。

## 1. 目标

用**真实服务 + 真实浏览器**把下面 F01–F18 逐条验一遍，产出机器可复核的证据与一份结论表。
这不是跑一遍现有测试；现有测试只作为 F18 的一部分。

方法基线（照抄这些现成文件的写法，不要另起炉灶）：
- 真浏览器驱动：`.dispatch/cdp.mjs` 导出的 `withPage / evaluate / screenshot / sleep`。
- 参考探针：`.dispatch/v4h-probe/v4h-ui.mjs`（UI 走查）、`.dispatch/v4h-probe/v4h-e2e.mjs`（服务端 e2e）、`.dispatch/final-v3-walk.mjs`、`.dispatch/v4g-probe/ac3-7-local-http.mjs`。
- 起服务：`import { startServer } from "../../src/server/http.mjs"`，用**你自己的端口 3681**，不要碰 3480（那是用户正在用的实例）。
- 页面取 token：GET `/` 必须带请求头 `sec-fetch-mode: navigate`；token 在 `<meta name="magpie-term-token" content="...">`；接口认证用请求头 `x-magpie-term-token`。

## 2. 验收项（逐条给 PASS / FAIL / 未验证 + 证据）

对每一条，报告里必须写：判定、你实际做了什么（选择器/命令/点击序列）、原始证据路径。**只写"通过"不算数。**

- **F01** 会话列表样式：列表项与分组**没有**左侧竖线/括号装饰（`border-left` 或伪元素都不允许）；当前会话只有底色差异 +（若有）勾号标识。证据：对 `.agent-session-item`、分组容器取 computed style（borderLeftWidth / ::before content）+ 截图。
- **F02** 确认卡右下角审阅角标：四态（ok/caution/danger/none）颜色不同；hover 后 tooltip 出现**两段**文字——「执行后会发生什么」与「为什么需要你确认」。证据：构造四态卡片（或拦截接口伪造），取 tooltip 文本逐字、取角标颜色。
- **F03** 设置页开关「审阅效果常显」：默认关；打开并保存后刷新页面仍为开；打开时确认卡**不 hover** 也显示效果文字。走真接口 `/api/config`（GET/PUT）核对落盘字段。
- **F04** 模型选择：位于输入框左侧、无边框、只显示模型名；点击弹出可选列表；选中后 `/api/config` 的 model 真变了，且下一次对话用的是它。
- **F05** 输入框内提示为「Enter 发送 / Shift+Enter 换行」；发送按钮是**向上箭头**（不是文字"发送"）。证据：DOM 文本 + 元素尺寸/形状。
- **F06** 输入框可放大：拖动 grip 后 textarea 高度增加，且刷新后保持（持久化键要指出来）。
- **F07** 会话列表展示终端类型/主机：本机会话显示 shell 名+版本，远程显示主机名+地址；切到远程终端后新会话徽标为远程。证据：徽标文本 + 宽高（不得被截断）。
- **F08** AI 会话跟随终端：开两个终端标签 A/B，在 A 里问一句，切到 B —— AI 栏必须切到 B 的会话（无则空态），不得把 A 的回答显示在 B 下；切回 A 能看到原会话。证据：切标签前后的会话标题/消息数快照。
- **F09** AI 栏在右、**默认收起**、收起时右侧**垂直居中**有一个突起把手；点它展开、再点收起；除了这个把手**不应有**其它展开/收起入口（左侧/下方按钮、抽屉顶部收起按钮都要没有）。证据：首屏 `#root[data-ai-open]` 值、把手 rect（中心 y 与视口中心差）、全页搜索按钮文案/aria。
- **F10** 有会话已展开时右下角**不弹**通知；收起且有待确认时：把手出现小红点/计数，右下角出现 toast，点 toast 能跳到该确认卡。证据：toast 容器子节点数、把手 badge 的 hidden 属性与文本。
- **F11** 打开插件时终端里**不多出两行提示符**（只应有一个提示符）；展开/收起 AI 会话不会向终端追加空行（对比收起前后终端 buffer 行数）。证据：xterm buffer 行数与内容快照。
- **F12** 真对话：给出一个目标（例如「统计当前目录下最大的三个文件并说明」），观察多轮工具调用、思考块、最终总结；会话可新建、可重命名、可删除。证据：消息条数、工具卡数量、思考块文本长度、会话列表变化。
- **F13** 审阅门控：三档 strict/balanced/loose 可切换；白名单命中的命令直接执行不弹确认；危险命令（例如 `rm -rf`）必须确认；审阅服务不可用时按「需要确认」处理（`REVIEW_FAILED`）。证据：`/api/config` 的档位字段 + 各档对同一命令的判定结果。
- **F14** 文件面板：跟随终端 cwd 实时刷新（cd 到另一目录后 2s 内跟上）；创建/删除/查看/修改/上传/下载各跑一次；远程主机 `/tmp` 也能列。证据：接口响应 + 面板 DOM。
- **F15** 主机面板：列出本机与已配置主机；点面板外关闭；本机终端可选 bash/PowerShell 7/PowerShell 5（不支持的标 unavailable）；顶部加号可选择主机或本机终端。证据：`/api/shells`、`/api/hosts`、点击外部后的面板 `hidden`/class。
- **F16** 设置页能打开（不是点了没反应），基础提示词（system prompt）可保存，保存后 `/api/config` 回读一致。
- **F17** 安全负向抽测（快速）：`Origin: null` 的跨站请求被拒；无 token 的 `/api/*` 返回 401；`/api/fs/list?path=C:/Windows/System32/config` 之类的系统目录被拒（或按白名单拒绝）；`/api/fs/read` 越界路径被拒。证据：状态码原文。
- **F18** 回归：`D:/nodejs/install/node.exe --test` 全量必须 0 fail（记录 tests/pass/fail 数字），`scripts/doctor.mjs` 必须 33/33（用 `DOCTOR_PORT=3683` 之类的独立端口，不要占 3480）。

## 3. 产物

1. `.dispatch/accept-f1/` 下：探针脚本（可重复运行）、每项的原始日志（`*.txt`）、截图（`*.png`，不少于 8 张关键状态）。
2. 仓库根 `ACCEPT-FUNC.md`：结论表（F01–F18：判定 / 证据路径 / 一句话说明），末尾写「缺陷清单」：编号、现象、复现步骤、影响面、严重级别（P0 阻断使用 / P1 明显影响 / P2 观感）。
3. 最后一条消息按下面的 JSON 返回，`summary` ≤200 字：

```json
{"status":"done|failed","passed":0,"failed":0,"unverified":0,"defects":[{"id":"D1","severity":"P0|P1|P2","title":"..."}],"report":"ACCEPT-FUNC.md","evidence_dir":".dispatch/accept-f1"}
```

## 4. 硬性要求

- 每条判定都要有**可重跑的探针 + 落盘原始输出**；不许把"我看了下没问题"当证据。
- 不确定能否自动化的项，写「未验证」并说明原因，不许猜 PASS。
- 结束后关掉你自己起的服务与浏览器，不残留进程；不要动 3480/3477/3488/3496。
- 全程中文报告。
