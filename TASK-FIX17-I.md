# TASK-FIX17-I 内置只读白名单可在设置页增删改

在 `C:/Users/41807/magpie-terminal` 完成这一批，自己跑测试与取证，最后按 §8 交报告。

需求与 AC：`.trellis/tasks/11-25-task-i-allowlist-editable/prd.md`（**先完整读**）；实现设计：`design.md`。

## 1. 一句话目标

把写死在 `src/policy/allowlist.mjs` 里的只读白名单变成配置项 `builtinAllowlist`，设置页默认显示全部条目并能增/删/改/恢复默认；**黑名单、危险参数表、参数级允许集仍然硬编码不可配置**。

## 2. 前序批次（别回退）

基线 = H 批合入后的 HEAD（H 批刚做完「剥离无害重定向 + 扩只读白名单」）。开工先 `git log --oneline -5` 与 `git status --porcelain`：

- H 批已经把 `2>&1` / `>/dev/null` 这类无害重定向剥离、扩了 ALLOW_HEADS（`free`/`df`/`uptime`/`uname`/`whoami`/`hostname`/`nproc`/`date`）与 docker/git/npm 子命令；
- **你要在 H 之后的基础上摊平出 `DEFAULT_BUILTIN_ALLOWLIST`**，不要凭本卡抄一份清单（那样会和代码漂移）。
- 基线测试：`node --test` 全绿（H 批验收后的数字，自己跑一遍拿到）；doctor 33/33。

工作区必须干净（唯一允许的脏文件是本任务自己的 `.trellis/tasks/11-25-task-i-allowlist-editable/task.json`）。

## 3. 允许改

- `src/policy/allowlist.mjs`、`src/policy/classify.mjs`（只加 `allowlist` 覆盖能力，不改安全分支顺序）
- `src/ai/judge.mjs`（把 config 的清单传进 classify）
- `src/config/store.mjs`
- `src/server/http.mjs`（`GET /api/config` 增加两个键；`PUT` 的 `KNOWN_FIELDS` 增加 `builtinAllowlist`）
- `app/ui/settings-panel.js`（新增一个 block）
- `app/styles/components.css`（**只许在设置模态段 1216-1540 内新增规则**，不许改既有规则值，不许写颜色字面量）
- `test/**`
- 新增 `scripts/probe-allowlist-ui.mjs`
- `.trellis/spec/backend/security-model.md`、`docs/security.md`
- `.dispatch/fix17-i/**`

## 4. 禁止改

`app/vendor/**`、`app/tokens.css`、`app/styles/tokens.css`、`app/styles/layout.css`、`app/styles/terminal-surface.css`、`app/ui/ai-drawer.js`、`app/ui/file-panel.js`、`app/ui/tab-bar.js`、`app/ui/hosts-panel.js`、`src/pty/**`、`src/fs/**`、`src/server/ws.mjs`、`src/server/logger.mjs`、`src/server/log-redact.mjs`、`src/ai/runner.mjs`、`package.json`、`package-lock.json`、`scripts/doctor.mjs`、`.trellis/tasks/archive/**`。

## 5. 环境事实

- **别把临时文件写进仓库 `tmp/`**（magpie 每 1 秒扫插件目录，`tmp/` 不在跳过名单 → 会重启插件宿主、丢终端会话）。证据写 `.dispatch/fix17-i/`，一次性脚本写 `C:/Users/41807/AppData/Local/hermes/cache/scratch/mt-i/`。
- 临时配置：`MAGPIE_TERMINAL_CONFIG_PATH=$PWD/.dispatch/fix17-i/cfg/config.json`；`doctor` 用 `DOCTOR_PORT=3498`。
- **绝对不要读写 `~/.config/magpie-terminal/config.json`**（那是用户的真实配置），也**不要碰** `~/.config/magpie/settings.json`。
- 真实插件服务在 `127.0.0.1:3480`，别重启。独立服务自己 `startServer({port, token})`，请求头 `x-magpie-term-token`，token 64 位 hex；`/api` 鉴权失败一律 403。
- 后台跑 node 要 `< /dev/null`，前台不用。
- node 在 `D:/nodejs/install`；原生程序不认 `/c/...` 路径，path 参数写 `C:/Users/...`。

## 6. 硬要求（真判真改，不许糊）

1. **单一数据源**：`DEFAULT_BUILTIN_ALLOWLIST` 由现有 heads/subcommands 摊平；`DEFAULT_ALLOWLIST` 必须与 `builtinRulesFrom(DEFAULT_BUILTIN_ALLOWLIST)` 逐项相等（单测锁死）。
2. **安全判据不可配置**：把 `rm` / `find` / `curl` / `git` 加进清单后，`rm -rf x`、`find . -delete`、`curl -o out http://x`、`git push` 仍必须 `confirm`，各有一条单测（hit 分别是 `deny:rm`、`deny:find -delete`、参数表 hit、`deny:git push`）。
3. **空清单语义**：`builtinAllowlist: []` → `ls`/`cat`/`git status` 全部 `confirm`，`rm` 仍 `deny:rm`。
4. **配置校验**：字符集只允许 `[A-Za-z0-9_.:+/@-]` 与单词间单空格，单条 ≤64 字符，≤300 条，去重；非法值返回 `INVALID_BUILTIN_ALLOWLIST` + 人话 userText，**不许静默丢弃**。
5. **老配置升级**：缺该字段 → 按默认值工作，且设置页**不因为字段缺失就把默认值写回**（未动过就不标 dirty）。
6. **设置页必须真好用**：列表可滚动、每条能「编辑」（就地改，改完保存回列表）和「删除」、添加有校验提示、恢复默认有「点保存后生效」提示、空态有说明；保存后 `GET /api/config` 对齐。
7. **真浏览器验证**：新增探针必须真的点按钮、真的保存、真的用保存后的配置判级，不许只跑单测。

## 7. 交付物（落盘，正文只给路径）

- `.dispatch/fix17-i/REPORT.md`：做了什么、AC1–AC8 逐条结果（表格：实际结果 / 证据路径）、未做项与理由、风险、`verdict: PASS|BLOCKED`。
- `.dispatch/fix17-i/evidence/`：`node --test` 原始输出、doctor、探针 JSON + 人读输出、设置页截图（默认态/删掉一条/恢复默认三种）、`GET /api/config` 前后对比、禁改文件 `git status` 为空、文档 diff。
- 代码改在工作区，**不要 commit**。

## 8. 完成判定

`node --test` 全绿 + 新增 ≥25 条；doctor 33/33；`node scripts/probe-allowlist-ui.mjs` 全过；6 条安全不变式单测全过；`git status` 只出现白名单内文件。做不到 → REPORT 写 `BLOCKED: <原因>`，不要假装完成。
