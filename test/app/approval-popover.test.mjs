// TASK-FIX17-L3：未开抽屉时的浮层确认卡（问题清单第 3 条）的静态契约 + 纯函数单测。
//
// 为什么是「源码级断言 + 纯函数单测」而不是 DOM 单测：本仓没有 jsdom / happy-dom
// （见 download-dir-ui.test.mjs 的说明），卡片依赖 getBoundingClientRect / 真点击 /
// 真 WebSocket 帧，只能在真浏览器里证。这里锁死的是「别人改回去会当场红」的那几条：
//   * 两段人话的**字段优先级**（why→command、confirmWhy→effect→固定兜底句）逐条断言
//   * 显示条件只看 pendingApprovals.length 与 isDrawerOpen()，不猜 DOM
//   * 点击走注入的 onApprove（app.js 唯一实现），不发帧、不写 PTY
//   * 三条按钮的 data-role 逐字
//   * CSS 段只追加、只用变量、没有颜色字面量
//
// 行为验证交给 scripts/probe-approval-popover.mjs（真 Chrome + CDP）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  approvalEffectText,
  approvalReviewState,
  approvalWhyText,
  EFFECT_FALLBACK,
  LABEL_EFFECT,
  LABEL_WHY,
  POPOVER_TITLE,
} from "../../app/ui/approval-popover.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

async function read(rel) {
  return readFile(path.join(REPO, rel), "utf8");
}

const POPOVER_JS = await read("app/ui/approval-popover.js");
const APP_JS = await read("app/app.js");
const DRAWER_JS = await read("app/ui/ai-drawer.js");
const COMPONENTS_CSS = await read("app/styles/components.css");

/** 去掉注释与空行，只在真代码里断言（不匹配说明文字）。 */
const code = (source) =>
  source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");

const POPOVER_CODE = code(POPOVER_JS);
const APP_CODE = code(APP_JS);

/* ------------------------------------------------- R1：组件形态与导出 */

test("R1：approval-popover.js 导出 createApprovalPopover → { render, destroy }", () => {
  assert.match(POPOVER_CODE, /export default function createApprovalPopover\(/);
  assert.match(POPOVER_CODE, /^\s*render,\s*$/m);
  assert.match(POPOVER_CODE, /destroy\(\)\s*\{/);
  // 自建 DOM（不要求改 index.html）。
  assert.match(POPOVER_CODE, /document\.createElement\(tag\)/);
  assert.equal(/index\.html/.test(POPOVER_CODE), false, "卡片不许要求改 index.html");
  // 自己建节点并挂到传入的 mount（默认 document.body）。
  assert.match(POPOVER_CODE, /host\.appendChild\(root\)/);
});

test("R1：DOM 契约逐字（data-role 与 class 名与 design.md 一致）", () => {
  for (const role of [
    "approval-popover",
    "popover-command",
    "popover-why",
    "popover-effect",
    "popover-approve",
    "popover-reject",
    "popover-approve-rest",
    "popover-count",
  ]) {
    assert.ok(POPOVER_JS.includes(`"data-role": "${role}"`), `缺少 data-role="${role}"`);
  }
  for (const cls of [
    "approval-popover",
    "ap-head",
    "ap-risk",
    "ap-command",
    "ap-section",
    "ap-label",
    "ap-why",
    "ap-effect",
    "ap-actions",
  ]) {
    assert.ok(POPOVER_JS.includes(`"${cls}"`) || POPOVER_JS.includes(` ${cls}`), `缺少 class ${cls}`);
  }
  // 标题与两段小标题逐字（PRD R4）。
  assert.equal(POPOVER_TITLE, "AI 想执行一条命令");
  assert.equal(LABEL_WHY, "要做什么");
  assert.equal(LABEL_EFFECT, "执行后会怎样");
});

/* ------------------------------------------------- R4：两条文字必须来自真实字段 */

test("R4.3「要做什么」= why，空则回落 command（空字符串/纯空白也算空）", () => {
  assert.equal(approvalWhyText({ why: "想看看磁盘占用", command: "df -h" }), "想看看磁盘占用");
  assert.equal(approvalWhyText({ why: "", command: "df -h" }), "df -h");
  assert.equal(approvalWhyText({ why: "   ", command: "df -h" }), "df -h");
  assert.equal(approvalWhyText({ why: null, command: "df -h" }), "df -h");
  assert.equal(approvalWhyText({ command: "df -h" }), "df -h");
  // 两个都没有 → 空串（渲染层给「（这条命令没有内容）」占位，不编一句人话）。
  assert.equal(approvalWhyText({ why: "", command: "" }), "");
  assert.equal(approvalWhyText(null), "");
});

test("R4.4「执行后会怎样」= confirmWhy → effect → 固定兜底句（顺序不许调换）", () => {
  assert.equal(
    approvalEffectText({ confirmWhy: "会删掉 3 个文件", effect: "会写文件", reversible: false }),
    "会删掉 3 个文件",
  );
  assert.equal(approvalEffectText({ confirmWhy: "", effect: "会写文件" }), "会写文件");
  assert.equal(approvalEffectText({ confirmWhy: null, effect: "会写文件" }), "会写文件");
  assert.equal(approvalEffectText({ confirmWhy: "  ", effect: "会写文件" }), "会写文件");
  assert.equal(approvalEffectText({ effect: "" }), EFFECT_FALLBACK);
  assert.equal(approvalEffectText({}), EFFECT_FALLBACK);
  assert.equal(approvalEffectText(null), EFFECT_FALLBACK);
  // 兜底句逐字（PRD R4.4）。
  assert.equal(EFFECT_FALLBACK, "会直接在这台电脑上执行，无法自动撤销。");
});

test("R4.5 风险四态归一化：认不出的值当 none（与抽屉同一条规则）", () => {
  assert.equal(approvalReviewState({ risk: "safe" }).state, "ok");
  assert.equal(approvalReviewState({ risk: "caution" }).state, "caution");
  assert.equal(approvalReviewState({ risk: "danger" }).state, "danger");
  assert.equal(approvalReviewState({ risk: null }).state, "none");
  assert.equal(approvalReviewState({ risk: "whatever" }).state, "none");
  assert.equal(approvalReviewState(null).state, "none");
  // 与抽屉的 REVIEW_STATE 四态逐字一致（两层不许各说一套）。
  for (const [risk, state] of [
    ["safe", "ok"],
    ["caution", "caution"],
    ["danger", "danger"],
  ]) {
    assert.ok(
      DRAWER_JS.includes(`${risk}: { state: "${state}"`),
      `抽屉的 REVIEW_STATE 里 ${risk} 应当是 "${state}"`,
    );
  }
});

/* ------------------------------------------------- R2 / R5：显示条件与接线 */

test("R2：显示条件只看 pendingApprovals 与 isDrawerOpen()（不猜 DOM 类名）", () => {
  assert.match(POPOVER_CODE, /const pool = snapshot && Array\.isArray\(snapshot\.pendingApprovals\)/);
  assert.match(POPOVER_CODE, /isDrawerOpen\(\) === true/);
  assert.match(POPOVER_CODE, /if \(total === 0 \|\| drawerOpen\) \{/);
  // 不许读 DOM 类名 / 属性来判抽屉开合。
  assert.equal(/classList\.contains\(\s*["']open/.test(POPOVER_CODE), false);
  assert.equal(/data-ai-open/.test(POPOVER_CODE), false);
  // 多条待批只显示队首 + 「还有 N 条等待」。
  assert.match(POPOVER_CODE, /const approval = pool\[0\]/);
  assert.match(POPOVER_CODE, /还有 \$\{waiting\} 条等待/);
});

test("R5：app.js 接线四处（每个 agent.* 帧末尾 / onApprove 后 / 抽屉开合 / beginRun 后）", () => {
  // ① 每个 agent.* 帧处理末尾（handleFrame 里统一判前缀）。
  assert.match(APP_CODE, /frame\.type\.startsWith\("agent\."\)/);
  assert.match(APP_CODE, /refreshApprovalPopover\(\);/);
  // ② onApprove 之后（抽屉的 onApprove 与浮层的 onApprove 都走 approveAgent）。
  assert.match(APP_CODE, /function approveAgent\(\{ approvalId, approved, scope \}\)/);
  assert.match(APP_CODE, /const ok = approveAgent\(payload\);[\s\S]{0,200}refreshApprovalPopover\(\);/);
  // ③ 抽屉开合。
  const openBlock = APP_CODE.slice(APP_CODE.indexOf("function openDrawer("), APP_CODE.indexOf("function toggleAi("));
  assert.match(openBlock, /refreshApprovalPopover\(\);/);
  // ④ beginRun 之后。
  const askBlock = APP_CODE.slice(APP_CODE.indexOf("function askAgent("), APP_CODE.indexOf("function agentBusy("));
  assert.match(askBlock, /agentStore\.beginRun\([\s\S]{0,300}refreshApprovalPopover\(\);/);
  // 组件自己建在 app.js 里，并且 isDrawerOpen 读 store（不是读 DOM）。
  assert.match(
    APP_CODE,
    /isDrawerOpen: \(\) => store\.getSnapshot\(\)\.aiOpen === true/,
  );
});

test("R5：审批只有一份实现 —— 浮层与抽屉都调 approveAgent，不许各发一次帧", () => {
  // 全仓（app.js）只允许出现一处 `type: "agent.approve"`。
  const hits = [...APP_CODE.matchAll(/type:\s*"agent\.approve"/g)];
  assert.equal(hits.length, 1, `agent.approve 帧必须只有一处实现，实际 ${hits.length} 处`);
  // ai-drawer.js 仍然只调注入的 onApprove（一个字都没改）。
  assert.equal(/type:\s*"agent\.approve"/.test(DRAWER_JS), false, "抽屉不许自己拼审批帧");
  assert.match(DRAWER_JS, /onApprove\(\{ approvalId: approval\.approvalId, approved: true, scope: "once" \}\)/);
  assert.match(DRAWER_JS, /onApprove\(\{ approvalId: approval\.approvalId, approved: true, scope: "rest" \}\)/);
  assert.match(DRAWER_JS, /onApprove\(\{ approvalId: approval\.approvalId, approved: false, scope: "once" \}\)/);
});

test("R4.5 抽屉卡片总提供 scope=rest，浮层也提供（保持一致）", () => {
  assert.match(POPOVER_CODE, /decide\(\{ approved: true, scope: "once" \}\)/);
  assert.match(POPOVER_CODE, /decide\(\{ approved: false, scope: "once" \}\)/);
  assert.match(POPOVER_CODE, /decide\(\{ approved: true, scope: "rest" \}\)/);
  // 抽屉侧存在 scope:"rest" 的按钮（approval-rest）→ 浮层的第三条才有依据。
  assert.match(DRAWER_JS, /"data-role": "approval-rest"/);
});

test("R4.6 risk===null && reviewReason 时显示真实原因；danger 三态不被覆盖", () => {
  assert.match(POPOVER_CODE, /const showReason = approval\.risk === null && reason\.length > 0;/);
  assert.match(POPOVER_CODE, /审阅没有送审：\$\{reason\}/);
  // 不许把「审阅不可用」写进浮层（那是另一档，抽屉里已有）。
  assert.equal(POPOVER_JS.includes("审阅不可用"), false, "浮层不许显示「审阅不可用」");
});

test("组件不发网络帧、不写 PTY（只把意图交给 app.js）", () => {
  assert.equal(/wsClient|WebSocket|\bfetch\(/.test(POPOVER_CODE), false, "组件不许自己发帧");
  assert.equal(/pty\.input|pty\.write/.test(POPOVER_CODE), false, "组件不许直接写 PTY");
  assert.match(POPOVER_CODE, /ok = onApprove\(\{ approvalId, approved, scope \}\) === true;/);
});

/* ------------------------------------------------- R3 / R6：样式 */

const CSS_STRIPPED = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取 `.selector { ... }` 的声明块。 */
function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))].map((m) => m[1]);
  return matches.join("\n");
}

test("R6：样式段只追加在文件末尾，选择器全以 .approval-popover / .ap- 开头", () => {
  const marker = "/* =====================================================================\n * 浮层确认卡";
  const start = COMPONENTS_CSS.indexOf(marker);
  assert.ok(start > 0, "「浮层确认卡」段必须存在");
  const tail = COMPONENTS_CSS.slice(start);
  // 段之后没有别的段头（= 确实是最后一段）。
  const headers = [...tail.matchAll(/\/\* ={69}/g)];
  assert.equal(headers.length, 1, "浮层确认卡段必须是最后一段");
  const selectors = [...tail.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) =>
    m[2].trim(),
  );
  assert.ok(selectors.length >= 15, `选择器数量异常：${selectors.length}`);
  for (const selector of selectors) {
    const ok = /^(\.approval-popover|\.ap-)/.test(selector) || /^@media/.test(selector);
    assert.ok(ok, `新段里出现了会命中既有元素的选择器：${selector}`);
  }
});

test("R3：fixed + 居中 + 浮球上方 96px + 宽 400 + 高度上限 + 窄窗不溢出", () => {
  const rootBlock = blockOf(CSS_STRIPPED, ".approval-popover");
  assert.ok(rootBlock.length > 0, "缺少 .approval-popover 规则");
  assert.match(rootBlock, /position:\s*fixed/);
  // 与浮球同一个水平基准（终端区中心 = 视口中心 + rail/2）。
  assert.match(
    rootBlock,
    /left:\s*calc\(50% \+ \(var\(--term-rail-width\) - var\(--term-handle-width\)\) \/ 2\)/,
    "与浮球同一水平基准：终端区中心 = 视口中心 + (rail - 把手带)/2（TASK-FIX17-F2 F-12）",
  );
  assert.match(rootBlock, /bottom:\s*96px/);
  assert.match(rootBlock, /width:\s*min\(400px, calc\(100vw - 24px\)\)/);
  assert.match(rootBlock, /max-height:\s*min\(50vh, 420px\)/);
  assert.match(rootBlock, /overflow-y:\s*auto/);
  // 层级：高于浮球 30、低于设置 40。
  const zIndex = Number(/z-index:\s*(\d+)/.exec(rootBlock)?.[1]);
  assert.ok(zIndex === 35, `z-index 必须是 35（高于球 30、低于设置 40），实际 ${zIndex}`);
});

test("R6：颜色只用变量，本段没有颜色字面量", () => {
  const marker = "/* =====================================================================\n * 浮层确认卡";
  const tail = COMPONENTS_CSS.slice(COMPONENTS_CSS.indexOf(marker));
  const strippedTail = tail.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(strippedTail), false, "本段不许出现十六进制颜色");
  assert.equal(/\brgba?\(/.test(strippedTail), false, "本段不许出现 rgb()/rgba()");
  assert.equal(/\bhsla?\(/.test(strippedTail), false, "本段不许出现 hsl()");
  // 颜色声明必须全部是 var(...)。
  for (const match of strippedTail.matchAll(/\b(color|background|border-color|border|box-shadow|outline):\s*([^;]+);/g)) {
    assert.match(match[2], /var\(|currentColor|none|transparent|inherit/, `颜色值不许写字面量：${match[0]}`);
  }
});

test("R3：命令行不折行（横向滚动）、卡片内部滚动，命令不会被读成两行", () => {
  const cmdBlock = blockOf(CSS_STRIPPED, ".approval-popover .ap-command");
  assert.match(cmdBlock, /white-space:\s*pre/);
  assert.match(cmdBlock, /overflow-x:\s*auto/);
  assert.match(cmdBlock, /font-family:\s*var\(--term-mono\)/);
});
