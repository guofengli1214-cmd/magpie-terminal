# TASK-FIX17-H 剥离无害重定向 + 扩充只读白名单（修「审阅不可用」误报）

你要在 `C:/Users/41807/magpie-terminal` 这个仓库里完成下面这一批改动，**自己跑测试、自己取证**，最后按 §9 交报告。

需求与验收标准在 `.trellis/tasks/11-25-task-h-safe-redirect/prd.md`（**先完整读它**），实现设计在 `design.md`。本卡只写「范围、约束、环境、交付」。

---

## 1. 背景（一句话）

用户看到「审阅不可用」不是审阅服务坏了，是分级器把每条带 `2>&1` 的命令判成 `redirect`，judge 因此**跳过 AI 审阅**（`src/ai/judge.mjs:40,112-114`）。修法：剥离**确定无害**的重定向后重判，同时扩充只读白名单，并把真原因显示给用户。

## 2. 前序批次已合入（别回退它们）

仓库已累积 8 批修复，HEAD 即基线。**你的改动必须让基线测试继续全绿**：

| 批次 | commit | 内容 |
|---|---|---|
| A | `a2dfa3c` | 终端内核：真实 shell 枚举、去掉 resize 后硬写 `\r`、终端黑边 |
| B | `bcac4e9` | 主题跟随 magpie（`decodeTokens` 接受裸键、`/api/theme`、全 `color-mix`） |
| C | `52a064e` | 文件面板多选/批量操作/定位按钮 |
| D | `b00157b` | AI 抽屉：不抖、菜单不透明、composer 重排、单按钮双形态、markdown 渲染 |
| E | `9ee519f` | 侧栏图标 + 日志文件/导出/脱敏 |
| E2 | `aa8b033` | 失效口令页面停止轮询、服务端重复告警限流 |
| F | `7853e4c` | ui-ux-pro-max 审查：6 处高对比度修到 ≥4.5 |
| G | (最新) | 设置页版本/检查更新 |

基线数字：`node --test` **1032 pass / 0 fail**；`node scripts/doctor.mjs` **33/33**；`node scripts/probe-terminal-edges.mjs` **10/10**。

## 3. 允许改动的文件（白名单，别越界）

- `src/policy/segments.mjs`（新增剥离器）
- `src/policy/classify.mjs`（多词子命令 + note 字段）
- `src/policy/allowlist.mjs`（扩白名单 + 注释写清为何不加 ps）
- `src/ai/judge.mjs`（只在必要处补 note/透传，**不改 UNREVIEWABLE_HITS 语义**）
- `src/ai/agent.mjs`（approval 帧新增 reviewReason/reviewHit）
- `app/core/agent-store.js`（解析新字段）
- `app/ui/ai-drawer.js`（仅 approval 卡片与 tooltip 文案分支）
- `app/styles/components.css`（**仅当**新文案导致溢出/换行问题才允许，且只许新增规则，不许改既有颜色/间距）
- `test/**`（新增/追加用例）
- 新增 `scripts/probe-review-redirect.mjs`
- `.trellis/spec/backend/security-model.md`、`.trellis/spec/frontend/ui-structure.md`
- `docs/security.md`、新增 `docs/DEV-NOTES.md`
- `.dispatch/fix17-h/**`（证据与日志）

## 4. 禁止改动（违者本批不通过）

- `app/vendor/**`（xterm.js、marked、DOMPurify 全部冻结）
- `app/tokens.css`、`app/styles/tokens.css`、`app/styles/layout.css`、`app/styles/terminal-surface.css`
- `app/ui/file-panel.js`、`app/ui/tab-bar.js`、`app/ui/hosts-panel.js`、`app/ui/settings-panel.js`
- `src/pty/**`、`src/fs/**`、`src/server/**`、`src/config/**`
- `package.json`、`package-lock.json`
- `scripts/doctor.mjs`
- 任何 `.trellis/tasks/archive/**`

改动前先 `git status --porcelain` 确认干净（唯一允许的脏文件是本任务自己的 `.trellis/tasks/11-25-task-h-safe-redirect/task.json`）。

## 5. 本机环境事实（别踩）

- **不要把临时文件写进仓库 `tmp/`**：magpie 对裸路径安装的插件每 1 秒扫目录，`tmp/` 不在跳过名单里（`.dispatch/`、`.trellis/`、`node_modules` 会跳过）。写文件会导致插件宿主重启、终端会话丢失。证据写 `.dispatch/fix17-h/`，一次性脚本写到 `C:/Users/41807/AppData/Local/hermes/cache/scratch/mt-h/`。
- node 在 `D:/nodejs/install`，pi 在 `/c/Users/41807/AppData/Roaming/npm`；需要时 `export PATH="/c/Users/41807/AppData/Roaming/npm:/d/nodejs/install:$PATH"`。
- 原生程序（node/git/python）不认 `/c/...` 与 `/tmp`：path 参数写 `C:/Users/...` 形式，临时目录用 `$LOCALAPPDATA/Temp` 或上面给的目录。
- `doctor` 会去抢固定端口，跑它请隔离配置：`MAGPIE_TERMINAL_CONFIG_PATH=$PWD/.dispatch/fix17-h/cfg/config.json`（内容 `{"version":1,"defaultShell":null}`）+ `DOCTOR_PORT=3497`。
- 真实插件服务在 `127.0.0.1:3480` 跑着（magpie-bun）。**不要重启它、不要改 `~/.config/magpie/settings.json` 与 `~/.config/magpie-terminal/config.json`**。需要独立服务时自己 `startServer({port, token})`，token 用 64 位 hex，请求头名是 `x-magpie-term-token`。
- `/api` 鉴权失败一律 **403**（不是 401，见 `docs/security.md` §2.3）。
- 后台跑 node 要重定向 `< /dev/null`（否则 stdin is not a tty 直接 exit 1）；前台不需要。
- 网关 `http://127.0.0.1:3425` 在跑（OpenAI 兼容，`/v1/models` 可查），真实审阅模型是 `commandcode/deepseek/deepseek-v4.1-flash`。审阅超时 `REVIEW_TIMEOUT_MS=8000`。

## 6. 必须做到的几条硬要求（其余看 prd）

1. **安全边界不打开**：`ls > out.txt`、`echo x >> ~/.bashrc`、`cat /etc/passwd > /tmp/leak.txt`、`>&out.txt`（bash 写文件）、`2>&12`、`>NUL`、`2>$null`、`ls 2>/dev/null > out.txt`、`ls; 2>/dev/null`（剥离后空段）**全部仍 confirm**，`hit` 仍是 `redirect`。这 9 条每条都要有单测。
2. **引号内不动**：`echo "a 2>&1 b"` 与 `echo '> x'` 的引号内容原样保留。
3. **段数不变**：`ls 2>&1; rm -rf x` 仍是两段且第二段 confirm(`deny:rm`)。
4. **`ps` 不加进白名单**（信息泄露），理由写进 `allowlist.mjs` 注释。
5. **前端必须说真话**：能看到「需要你批准：命令含输出重定向，可能写文件」，不再一律「审阅不可用」。真浏览器验证，不许只跑单测。
6. **文档同步**：`security-model.md` 5.1/5.4 改掉「见到 `>` 就 confirm」，新增 5.4.2 白名单节；`docs/security.md:171` 同步；`grep -rn "只要出现就确认" docs .trellis/spec` 必须为空。
7. **负对照真跑**：探针必须证明「改前版本」对这些命令判 confirm，否则数字不算（用 `git show HEAD:src/policy/segments.mjs` + `git show HEAD:src/policy/classify.mjs` 到临时目录动态 import）。

## 7. 交付物（全部落盘，正文只给路径与短摘要）

- `.dispatch/fix17-h/REPORT.md`：做了什么、逐条 AC 结果、实测命令与输出摘录、未做项与理由、风险。
- `.dispatch/fix17-h/evidence/`：① `node --test` 原始输出（含 tests/pass/fail 三行）② doctor ③ probe-review-redirect 的 JSON 与人读输出 ④ 负对照输出 ⑤ 真机/真浏览器截图或 DOM 文本（approval 卡片两种文案）⑥ 禁改文件 `git status --porcelain -- <清单>` 为空 ⑦ 文档改动 diff。
- 代码改动直接改在工作区（不要 commit，我来验收后提交）。

## 8. 完成判定

`node --test` 全绿且用例数 ≥ 1032 + 你新增的、doctor 33/33、`node scripts/probe-review-redirect.mjs` 全过、9 条安全反例仍 confirm、`git status` 只出现白名单内文件。任何一条做不到 → 在 REPORT 里明确写 `BLOCKED: <原因>`，不要假装完成。

## 9. 报告格式

REPORT.md 末尾一行写 `verdict: PASS` 或 `verdict: BLOCKED`。前面用表格逐条列 AC1–AC9 的「实际结果 / 证据文件路径」。
