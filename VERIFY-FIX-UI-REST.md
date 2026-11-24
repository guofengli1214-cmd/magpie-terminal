# VERIFY-FIX-UI-REST：AI 把手居中 + 文件条目动作条溢出（TASK-FIX-UI-REST）

> 结论：**通过**（主 agent 独立复核，2026-11-24）
> 任务书 `TASK-FIX-UI-REST.md`（用户 m02595「1B」②A 批准，`--thinking max`）
> 执行报告 `REPORT-FIX-UI-REST.md`（15.4K）／执行者探针 68 断言全 PASS（`.dispatch/fix-ui/summary.txt`）
> 起始 HEAD `1fb3dc2`；工作区改动 `app/styles/layout.css +4/−1`、`app/ui/file-panel.js +378`、`app/styles/components.css`、新增 `test/app/file-panel-menu.test.mjs`（17 条纯函数单测）

## 1. 两个缺陷
- **F09 把手不居中**：`[data-role="ai-handle"]` 的 `top:50%` 挂在 `.main`（高 = 视口 − 26px 状态栏）里，1440×900 下 centerY=437 而视口中心 450，差 −13px。
- **文件条目横向溢出**：格子 110.4px 宽、行内动作条 156px（5 个文字按钮），左溢出 49.6px（1280 档 42.7px）；每行 6 个 button。

## 2. 修法
- `layout.css`：`top: calc(50% + var(--term-statusbar-height) / 2)`，只改这一条。
- `file-panel.js`：删整段 `.file-panel-fmore` 行内动作条，行内只留 `⋯`（`aria-haspopup=menu`），5/3 个动作改成**面板级弹出菜单**（挂 `.file-panel` 根，不挂 grid/card，因虚拟滚动会裁掉/丢弃行内浮层）；新增纯函数 `actionsForEntry` / `menuSizeFor` / `clampMenuPosition`；`runAction(action, entry)` 签名不变。
- `components.css`：删 `.file-panel-fmore`/`.file-panel-action` 全部规则，新增 `.file-panel-action-menu` / `.file-panel-menu-item`（26px 行高，与 JS 常量对齐）。
- 执行者记录了 2 处与任务书公式的**必要偏差**（报告 §2.1）：垂直基准由 `⋯` 按钮改成整张卡片（否则菜单底边离按钮 2px 时会横向压住自己这行的文件名，实测相交 302–312px²）；上下都放不下时改「摆到卡片旁边」（`placement:"side"`）而不是硬贴面板顶边。两种情况都仍严格钳在面板 rect 内。

## 3. 主 agent 亲跑证据（自己写的探针，不复用执行者脚本）
脚本 `.dispatch/my-ui-verify.mjs`（独立实例端口 3751、独立 state、自建 fixture 26 项），输出 `.dispatch/my-ui-verify2.txt`：**22/22 PASS**。

| 断言 | 1440×900 | 1280×760 |
|---|---|---|
| 把手 24×78、贴右缘、`8px 0 0 8px` | ✓ | ✓ |
| 把手中心 = 视口中心（`\|Δ\|≤1`），收起态 | **450 vs 450，Δ0** | **380 vs 380，Δ0** |
| 同一断言，抽屉展开态 | Δ0 | Δ0 |
| 条目横向溢出条数（26 项全扫） | **0** | **0** |
| `.file-panel-fmore` / `.file-panel-action` 存在数 | 0 / 0 | 0 / 0 |
| 每条目 button 数上限 | **1**（只有 `⋯`） | 1 |
| `⋯` 常显不透明度（非 hover-only） | **0.7** | 0.7 |
| 菜单：`role=menu`、挂面板根、不在 grid / 不在 card | ✓ | ✓ |
| 菜单 rect 四边在面板 rect 内 | ✓ | ✓ |
| 菜单文案顺序 | 查看/编辑/重命名/下载/删除 | 同 |
| 菜单与本行文件名相交面积 | **0**（`placement:"side"`） | **0** |
| Esc 关闭 + 焦点还回 `⋯` | ✓ | ✓ |
| 点菜单外关闭 | ✓ | ✓ |

视觉复核（本模型 `vision_analyze` 不可用，走网关 `shuaiapihermes/gpt-6.2-sol`）：`.dispatch/my-ui/menu-open-1440.png` 与放大 3 倍裁图 `crop-menu.png` —— 菜单 5 项齐、左缘不压本行文件名、不越面板边框；未见过错位/重叠/截断。

## 4. 回归
`node --test --test-force-exit` → `.dispatch/my-final-full.txt`：**722 / 722 pass，0 fail**（含本卡新增 17 条菜单纯函数单测）；`scripts/doctor.mjs` → **33/33 assertions passed**（`.dispatch/my-doctor-final.txt`）。
虚拟滚动未回归：执行者探针 10000 项目录 DOM 80 条、滚到底可选中/查看/删除（`summary.txt` AC10a–d 全 PASS），主 agent 上一卡（`1fb3dc2`）亲验数据一致。

## 5. 说明
- 菜单宽度固定 120px、高 134px（5 项），必然覆盖相邻格子——任务书 §7 明确允许；不允许的是压住**正在操作的那一行**，已实测为 0。
- 面板高度只有两三行时选「侧放」属执行者记录的设计决定，视觉与几何都验证过；若后续想要「菜单盖住自己那行」的传统形态，需要另开卡改任务书约束。
- 本卡未碰 `src/**`、`docs/**`、`app/ui/ai-drawer.js`、`app/ui/toast.js`（`git status` 只有 3 个预期文件 + 1 个新测试文件）。
