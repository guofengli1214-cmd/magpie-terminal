// TASK-FIX17-L2：终端悬浮球（问题清单第 2 条）的静态契约。
//
// 为什么是源码级断言而不是 DOM 单测：本仓没有 jsdom / happy-dom（见
// download-dir-ui.test.mjs 的说明），悬浮球依赖 getBoundingClientRect / 过渡 /
// 真命中测试，只能在真浏览器里证。这里锁死的是「别人改回去会当场红」的那几条：
//   * 三条用户原话的行为分支还在（必定展开 / 有内容不收回只降透明度 / 发送不开抽屉）
//   * 与抽屉共用同一条发送链路（不是自己拼 agent.run 帧）
//   * CSS 段只追加、只用变量、没有颜色字面量
//   * 常量只抽不改（EMPTY_QUESTION_TEXT / BLOCKED_PENDING_TEXT 与抽屉同一句）
//
// 行为验证交给 scripts/probe-orb.mjs（真 Chrome + CDP）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

async function read(rel) {
  return readFile(path.join(REPO, rel), "utf8");
}

const ORB_JS = await read("app/ui/command-orb.js");
const APP_JS = await read("app/app.js");
const CONSTANTS_JS = await read("app/core/constants.js");
const COMPONENTS_CSS = await read("app/styles/components.css");
const DRAWER_JS = await read("app/ui/ai-drawer.js");

/** TASK-FIX17-L3 的段头（浮层确认卡）；用作球段的结束边界。 */
const L3_SECTION_MARKER = "/* =====================================================================\n * 浮层确认卡";

/** 去掉注释与空行，只在真代码里断言（不匹配说明文字）。 */
const code = (source) =>
  source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");

const ORB_CODE = code(ORB_JS);
const APP_CODE = code(APP_JS);

/** 取 `.selector { ... }` 的声明块。 */
function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))].map((m) => m[1]);
  return matches.join("\n");
}

const CSS_STRIPPED = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/* ------------------------------------------------- R1：组件形态与导出 */

test("R1：command-orb.js 导出 createCommandOrb，返回 setBusy / destroy / state", () => {
  assert.match(ORB_CODE, /export default function createCommandOrb\(/);
  assert.match(ORB_CODE, /setBusy\(value\)\s*\{/);
  assert.match(ORB_CODE, /destroy\(\)\s*\{/);
  assert.match(ORB_CODE, /get state\(\)\s*\{/);
  // 自建 DOM，不依赖 index.html 改动。
  assert.match(ORB_CODE, /document\.createElement\(tag\)/);
  assert.equal(/index\.html/.test(ORB_CODE), false, "球不许要求改 index.html");
});

test("R1：DOM 结构逐字（data-role=command-orb / orb-ball / orb-input / orb-action）", () => {
  for (const role of ["command-orb", "orb-ball", "orb-input", "orb-action"]) {
    assert.ok(ORB_JS.includes(`"data-role": "${role}"`), `缺少 data-role="${role}"`);
  }
  assert.match(ORB_CODE, /ball\.innerHTML = ORB_ICON/);
  // F-11 教训：图标必须是内联 SVG，不许 emoji。
  assert.match(ORB_JS, /const ORB_ICON =\s*\n?\s*'<svg /);
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(ORB_JS), false, "不许用 emoji 当图标");
});

test("R2：球默认 aria-label=\"AI 输入\"，忙碌时变「停止」", () => {
  assert.match(ORB_JS, /"aria-label": "AI 输入"/);
  assert.match(ORB_CODE, /ball\.setAttribute\("aria-label", busy \? "停止" : "AI 输入"\)/);
  assert.match(ORB_CODE, /action\.setAttribute\("aria-label", busy \? "停止" : "发送"\)/);
});

/* ------------------------------------------------- R3：三条用户原话的落点 */

test("R3-1：鼠标移上去**必定**展开（展开条件与有没有内容无关）", () => {
  // wantExpanded = !suppressExpand && (hover || focused || content)
  assert.match(
    ORB_CODE,
    /const wantExpanded = !suppressExpand && \(hover \|\| focused \|\| content\);/,
    "hover 必须单独构成展开条件（不看 content）",
  );
  // 进入时清掉 Esc 的压制标记，保证「再移上去一定展开」。
  assert.match(ORB_CODE, /pointerenter[\s\S]{0,200}suppressExpand = false;/);
});

test("R3-2：有内容 + 鼠标移开 → 仍展开，只是 state=open-muted（与焦点无关）", () => {
  // 用户原话就是「输入了内容鼠标移开只会变半透明」：判定只看 hover，不看焦点。
  assert.match(
    ORB_CODE,
    /const nextState = !wantExpanded\s*\?\s*"ball"\s*:\s*content && !hover \? "open-muted" : "open";/,
    "有内容 + 鼠标移开只能是 open-muted，不许回 ball",
  );
  // 关键反例：content 分支里不许出现 "ball"。
  assert.equal(
    /content[^;]{0,40}\?\s*"ball"/.test(ORB_CODE),
    false,
    "有内容移开绝不许收回成球",
  );
  // 空内容移开必须真的收回（含交出焦点），否则 AC3.4 的「清空后收回」做不到。
  assert.match(ORB_CODE, /if \(!hasContent\(\)\) \{\s*collapse\(\);/);
});

test("R3-3：Esc 两态正确（有内容先清空，再收回球）", () => {
  assert.match(ORB_CODE, /if \(event\.key === "Escape"\)\s*\{/);
  assert.match(ORB_CODE, /if \(hasContent\(\)\) input\.value = "";/);
  assert.match(ORB_CODE, /collapse\(\);/);
  assert.match(ORB_CODE, /function collapse\(\)\s*\{\s*\n\s*suppressExpand = true;/);
});

test("R3：点球 = 展开并聚焦输入框（触屏 / 键盘路径），且用 preventScroll", () => {
  assert.match(ORB_CODE, /ball\.addEventListener\("click",[\s\S]{0,400}expandAndFocus\(\)/);
  assert.match(ORB_CODE, /input\.focus\(\{ preventScroll: true \}\)/);
  // 球自己拿到焦点时**不许**展开：展开会 display:none 掉球，焦点当场丢给 body。
  assert.match(ORB_CODE, /focused = event\.target === input;/);
});

/* ------------------------------------------------- R4：发送 */

test("R4：Enter 发送 / Shift+Enter 换行（与抽屉一致）", () => {
  assert.match(ORB_CODE, /if \(event\.key !== "Enter" \|\| event\.shiftKey\) return;/);
  assert.match(ORB_CODE, /event\.preventDefault\(\);\s*\n\s*send\(\);/);
  // 输入法选词中的回车不发送。
  assert.match(ORB_CODE, /if \(event\.isComposing\) return;/);
});

test("R4：空输入与待确认提示与抽屉同一句（常量共用，文案不改）", () => {
  assert.match(CONSTANTS_JS, /EMPTY_QUESTION_TEXT: "先说一句你想干什么。"/);
  assert.match(CONSTANTS_JS, /BLOCKED_PENDING_TEXT: "先处理上面的待确认命令（或点停止），再问新的。"/);
  assert.match(ORB_JS, /const EMPTY_QUESTION_TEXT = constants\.EMPTY_QUESTION_TEXT;/);
  assert.match(ORB_JS, /const BLOCKED_PENDING_TEXT = constants\.BLOCKED_PENDING_TEXT;/);
  assert.ok(
    DRAWER_JS.includes("先说一句你想干什么。"),
    "抽屉的文案必须还在（本卡不改抽屉行为）",
  );
});

test("R4：发送走 onAsk 且**显式**带 { openDrawer: false }（不许自动打开 AI 栏）", () => {
  assert.match(
    ORB_CODE,
    /result = onAsk\(\{ question, model: safeCall\(getModel, null\) \}, \{ openDrawer: false \}\);/,
    "第三个参数必须是 openDrawer:false",
  );
  assert.equal(
    /openDrawer\(\)/.test(ORB_CODE),
    false,
    "球自己不许调用任何「打开抽屉」的东西",
  );
});

test("R4：成功后清空输入（鼠标还在上面则保持展开，否则收回）", () => {
  assert.match(ORB_CODE, /input\.value = "";/);
  assert.match(ORB_CODE, /if \(!hover\) collapse\(\);\s*\n\s*else sync\(\);/);
});

/* ------------------------------------------------- R5：忙碌态 */

test("R5：忙碌时动作按钮 = 停止（点发送等于停止），setBusy 与抽屉同源", () => {
  assert.match(
    ORB_CODE,
    /action\.addEventListener\("click",[\s\S]{0,200}if \(busy \|\| safeCall\(getBusy, false\)\) \{\s*\n\s*doStop\(\);/,
  );
  assert.match(
    ORB_CODE,
    /if \(busy \|\| safeCall\(getBusy, false\)\) \{\s*\n\s*doStop\(\);\s*\n\s*return "stopped";/,
  );
  // app.js 在 agentStore 订阅里推 setBusy（复用既有帧分发后的订阅点）。
  assert.match(APP_CODE, /if \(commandOrb\) commandOrb\.setBusy\(agentBusy\(snapshot\)\);/);
  assert.match(APP_CODE, /function agentBusy\(snapshot\)[\s\S]{0,200}status === "running" \|\| snapshot\.status === "awaiting"/);
});

/* ------------------------------------------------- R6：接线（app.js） */

test("R6：onAsk 拆成 askAgent + 可选 openDrawer，默认行为保持不变", () => {
  assert.match(
    APP_CODE,
    /function askAgent\(payload, \{ openDrawer: shouldOpenDrawer = true \} = \{\}\)/,
    "第三参默认 true",
  );
  assert.match(APP_CODE, /if \(shouldOpenDrawer\) openDrawer\(\);/);
  // 抽屉那边调用点不变（默认打开）。
  assert.match(APP_CODE, /onAsk: \(payload, opts\) => askAgent\(payload, opts\)/, "抽屉与球共用同一条链路");
  // 门禁文案改为常量（文案一字不改）。
  assert.match(APP_CODE, /statusBar\.setNotice\(constants\.BLOCKED_PENDING_TEXT, "warn"\)/);
});

test("R6：停止逻辑抽成 stopAgent，抽屉与球共用（行为逐字不变）", () => {
  assert.match(
    APP_CODE,
    /function stopAgent\(\) \{\s*\n\s*const snapshot = agentStore\.getSnapshot\(\);\s*\n\s*if \(!snapshot\.requestId\) return;\s*\n\s*wsClient\.send\(\{ type: "agent\.stop", requestId: snapshot\.requestId \}\);\s*\n\s*agentStore\.markStopped\(\);/,
  );
  assert.match(APP_CODE, /onStop: \(\) => stopAgent\(\),/);
  // 球也吃同一个 model（跟抽屉选中的一致）。
  assert.match(APP_CODE, /getModel: \(\) => \(aiDrawer \? aiDrawer\.selectedModel\(\) : null\)/);
});

/* ------------------------------------------------- R7：样式 */

test("R7：CSS 段只追加在文件末尾，选择器全以 .command-orb / .orb- 开头", () => {
  const marker = "/* =====================================================================\n * 终端悬浮球";
  const start = COMPONENTS_CSS.indexOf(marker);
  assert.ok(start > 0, "「终端悬浮球」段必须存在");
  // TASK-FIX17-L3：悬浮球的**下一条**组件段是浮层确认卡（同样只许追加在末尾）。
  // 所以这里改成「从球段到下一个段头为止」——既保住原意（球段还是完整一段、
  // 里面不许有会命中既有元素的选择器），也不禁止后面再追加新段。
  const next = COMPONENTS_CSS.indexOf(L3_SECTION_MARKER, start + marker.length);
  const tail = next > 0 ? COMPONENTS_CSS.slice(start, next) : COMPONENTS_CSS.slice(start);
  // 球段之后再没有别的段（= 球段确实是紧接在 L3 段之前的最后一段）。
  assert.ok(
    next > 0 || !tail.slice(0, tail.length - 1).includes("/* ====================================================================="),
    "悬浮球段之后出现了未登记的段（新增段要先在本测试里登记）",
  );
  const selectors = [...tail.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) =>
    m[2].trim(),
  );
  assert.ok(selectors.length >= 15, `选择器数量异常：${selectors.length}`);
  for (const selector of selectors) {
    const ok = /^(\.command-orb|\.orb-)/.test(selector) || /^@media/.test(selector);
    assert.ok(ok, `新段里出现了会命中既有元素的选择器：${selector}`);
  }
});

test("R7：收起 38px / 展开 360px / open-muted 只降 opacity 不收回宽度", () => {
  const rootBlock = blockOf(CSS_STRIPPED, ".command-orb");
  assert.ok(rootBlock.length > 0, "缺少 .command-orb 规则");
  assert.match(rootBlock, /position:\s*fixed/);
  assert.match(
    rootBlock,
    /left:\s*calc\(50% \+ var\(--term-rail-width\) \/ 2\)/,
    "必须居中于终端区（视口中心 + rail 的一半），否则 AC1 会偏 24px",
  );
  assert.match(rootBlock, /transform:\s*translateX\(-50%\)/);
  assert.match(rootBlock, /width:\s*38px/);
  assert.match(rootBlock, /opacity:\s*0\.72/);
  assert.match(rootBlock, /transition:\s*width 0\.16s ease, opacity 0\.16s ease, transform 0\.16s ease/);
  assert.match(rootBlock, /bottom:\s*calc\(var\(--term-statusbar-height\) \+ 18px\)/);

  const openBlock = blockOf(CSS_STRIPPED, '.command-orb[data-state="open"],\n.command-orb[data-state="open-muted"]');
  assert.ok(openBlock.length > 0, "缺少展开态规则（open / open-muted 共用同一组宽度）");
  assert.match(openBlock, /width:\s*360px/);
  assert.match(openBlock, /height:\s*40px/);

  // open-muted：宽度与 open 在同一组里（360px，所以 blockOf 会抓到两条规则），
  // 自己那条只额外降 opacity —— 不许出现任何 38px 的回退。
  const mutedBlock = blockOf(CSS_STRIPPED, '.command-orb[data-state="open-muted"]');
  assert.match(mutedBlock, /opacity:\s*0\.55/);
  assert.equal(/width:\s*38px/.test(mutedBlock), false, "open-muted 绝不许回到球宽");
});

test("R7：颜色只用既有变量，段里没有任何颜色字面量", () => {
  const tail = CSS_STRIPPED.slice(CSS_STRIPPED.indexOf(".command-orb {"));
  assert.ok(tail.length > 0, "找不到悬浮球段");
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(tail), false, "不许出现颜色字面量");
  assert.equal(/rgba?\(/.test(tail), false, "不许出现 rgba 字面量颜色");
  assert.equal(/hsla?\(/.test(tail), false, "不许出现 hsl 字面量颜色");
  // 边框 / 聚焦 / 忙碌三处必须是规定的变量。
  assert.match(blockOf(CSS_STRIPPED, ".orb-ball"), /border:\s*1px solid var\(--term-line-3\)/);
  assert.match(blockOf(CSS_STRIPPED, ".orb-ball:focus-visible"), /outline:\s*2px solid var\(--term-focus\)/);
  assert.match(blockOf(CSS_STRIPPED, '.orb-action[data-state="busy"]'), /border:\s*3px solid var\(--term-danger\)/);
  assert.match(
    blockOf(CSS_STRIPPED, '.command-orb[data-busy="true"] .orb-ball'),
    /background:\s*var\(--term-busy-core\)/,
  );
});

test("R7：新段不参与布局流（fixed 不占位，不含 position:absolute 的根）", () => {
  const rootBlock = blockOf(CSS_STRIPPED, ".command-orb");
  assert.equal(/position:\s*absolute/.test(rootBlock), false, "根节点必须是 fixed（不许 absolute 撑开文档）");
  assert.match(rootBlock, /z-index:\s*30/, "层级：状态栏之上、抽屉/设置之下");
});
