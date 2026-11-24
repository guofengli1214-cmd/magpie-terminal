# TASK-VERIFY-ACCEPT：返工后独立复验（只复核、留证、报问题）

## 0. 你的角色

你是**独立核验者**。执行者已按 `TASK-FIX-ACCEPT.md` 改完代码并写了 `REPORT-FIX-ACCEPT.md`。你的任务是**不信任报告、亲手复跑**，用证据判断每条是否真的修好、有没有顺带弄坏别的东西。

- 仓库：`C:/Users/41807/magpie-terminal`。Node：`D:/nodejs/install/node.exe`。
- **只许写**：`.dispatch/verify-accept/**` 与仓库根 `VERIFY-ACCEPT.md`。**不许改产品代码、测试、文档**。发现缺陷只记录。
- 不许问人，不许装新依赖。端口从 3695 起用，不碰 3480/3477/3488/3496。
- 探针可复用：`.dispatch/cdp.mjs`（`withPage/evaluate/screenshot/sleep`，Chrome 在 `C:/Program Files/Google/Chrome/Application/chrome.exe`）、`.dispatch/v4h-probe/v4h-ui.mjs`、`.dispatch/fix-accept/`（执行者的证据）。
- 视觉复核不要自己"感觉"：要么量，要么截图仔看（可参考 `C:/Users/41807/AppData/Local/hermes/cache/scratch/ask2.py <图片> <问题>`，走网关 `http://127.0.0.1:3425/v1/chat/completions`、model `shuaiapihermes/gpt-6.2-sol`、Bearer magpie）。

## 1. 必须复跑的 13 条关键项（每条给原始数值与证据路径）

| # | 对应修复 | 怎么判 |
|---|---|---|
| V01 | A 删除 | 起真服务 + 真 Chrome，建临时文件与空目录各一点「删除 → 永久删除」：**不刷新**列表条目消失、磁盘 stat 不存在；非空目录不勾递归仍得 409 文案。远程主机可连则同样测一次。 |
| V02 | B 对比度 | 独立算出这些文本最终生效色的对比度：确认卡「跳过」/why 文案、主机地址、设置页选中档位说明。正文 ≥4.5、次要 ≥3.0。写清 selector / 计算色 / 背景色 / 比值。 |
| V03 | B 配色 | 确认卡边框/底色/内边距与设计稿一致（边框 `rgba(227,179,65,0.38)`、背景 `rgba(227,179,65,0.07)`，padding 10、按钮组右留白 40）。给 computed style。 |
| V04 | C 把手热区 | 命中宽度 ≥48px；在把手最外侧 5px 内点击能展开抽屉；终端文字仍可选中（无被遮挡）。 |
| V05 | D 可见性 | 不 hover、无焦点时 `.sess-actions`、主机工具、文件「⋯」的 computed `opacity`/`display` 为可见态；hover 后仍可用（点到按钮有效果）。 |
| V06 | E toast | 收起态带待确认：1440×900 与 1280×760 下 toast rect 与状态栏 rect 相交面积 = 0；「立即重连」不再被盖。 |
| V07 | F 模型菜单 | 输入框拖到 132px 高后开菜单：菜单 rect 与 `[data-role=composer-box]` rect 相交面积 = 0，菜单完整可见（顶边不超出抽屉）。 |
| V08 | G 拖拽方向 | 从 grip 向上拖 40px → 变高；向下拖 40px → 变矮；记录前后高度与持久化键值。 |
| V09 | H 文本 | 会话标题有 `title` 全文且最多两行；主机地址有 `title`；工具命令 `pre-wrap`/`anywhere` 长命令不省略。 |
| V10 | H 尺寸 | `drawer-head`/`ai-ctx`/`file-panel`/`file-panel-toolbar` 实际高度 = 声明高度（无 1px 漂移）；主操作热区 ≥28×28；文件面板左内边距统一 9px。 |
| V11 | 未改项 | F04 模型选择仍在原提示行位置、F09 把手仍对齐 `.main` 中心、F17 安全口径未变、L1-07/12/15 未动（diff 里不出现）。 |
| V12 | 回归 | `node --test` 全绿（期望 ≥674 条、0 fail，列出实际数字）；`DOCTOR_PORT=3696 node scripts/doctor.mjs` → 33/33。 |
| V13 | 边界 | 审阅/删除/上传的失败路径未被改坏（网格：无 token 401/403、越界 403、超 2MB 413、非文本 415、REVIEW_FAILED 仍 confirm）。 |

## 2. 还要检查的

- `git diff --stat fefbc2f..HEAD` 与 `git diff --name-only fefbc2f..HEAD`：是否只动了预期文件；`docs/`、`package.json` 依赖、`test/` 的既有断言有没有被删/放宽（新增测试可以）。
- 执行者的 `REPORT-FIX-ACCEPT.md` 与实测是否一致；不一致的逐条列出（不要默认信报告）。
- 两档视口（1440×900 / 1280×760）× 关键状态（收起+待确认、展开+会话列表、确认卡、文件面板、主机面板、设置页）各截图，放 `.dispatch/verify-accept/shots/`。

## 3. 结论与交付

`VERIFY-ACCEPT.md` 结构：结论（通过 / 有条件通过 / 不通过）+ V01–V13 表格（实测值 / 证据路径 / PASS|FAIL）+ 与执行者报告的差异表 + 回归风险 + 未验证项（写原因）。

最后一条消息返回：

```json
{"status":"done","verdict":"pass|partial|fail","v_fail":["V04"],"tests":"674/674","doctor":"33/33","report":"VERIFY-ACCEPT.md","evidence":".dispatch/verify-accept"}
```
