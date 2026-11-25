// TASK-FIX17-D：抽屉的静态结构约束（问题 7/8/9/10/11）。
//
// 为什么这组要读文件而不是跑浏览器：运行时探针（scripts/probe-drawer.mjs）能证明
// 「这一套 CSS 在这台机器上算出来是对的」，但证明不了「别人改回去会当场红」。
// 下面这些规则把本卡的 DOM/CSS 契约钉死：
//   * `.main` 必须是 overflow: clip（问题 7 的根因之一）
//   * 三处菜单底色必须是 `--term-panel-solid`，不许再用 `--term-panel-2`（问题 8）
//   * composer 段不许再有 `.composer-hint` 与 `grid-template-areas`（问题 9/11）
//   * 单一动作按钮 `[data-role="composer-action"]` + `.is-busy`（问题 10）
//   * 抽屉段与 composer 段不许出现颜色字面量（theme-tokens.md §5）
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const LAYOUT_CSS = await readFile(path.join(REPO, "app", "styles", "layout.css"), "utf8");
const COMPONENTS_CSS = await readFile(path.join(REPO, "app", "styles", "components.css"), "utf8");
const DRAWER_JS = await readFile(path.join(REPO, "app", "ui", "ai-drawer.js"), "utf8");
const INDEX_HTML = await readFile(path.join(REPO, "app", "index.html"), "utf8");

/** 去掉注释，只为「在真实声明里 grep」而不是匹配到说明文字。 */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const LAYOUT = strip(LAYOUT_CSS);
const COMPONENTS = strip(COMPONENTS_CSS);

/** 取 `.selector { ... }` 的声明块（只用于断言，不追求完整 CSS 解析）。 */
function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))].map((m) => m[1]);
  return matches.join("\n");
}

/* ---------------------------------------------------------------- AC1：抖动 */

test("AC1：.main 用 overflow: clip（不是只有 hidden）—— 不再产生横向滚动容器", () => {
  const block = blockOf(LAYOUT, '[data-role="main"]');
  assert.match(block, /overflow:\s*hidden/, "hidden 必须保留作旧内核降级");
  assert.match(block, /overflow:\s*clip/, "必须有 clip 那一行（真修法）");
  // 顺序：hidden 在前、clip 在后（后者覆盖前者）
  const hiddenAt = block.indexOf("overflow: hidden");
  const clipAt = block.indexOf("overflow: clip");
  assert.ok(clipAt > hiddenAt, "clip 必须写在 hidden 之后才会生效");
});

test("AC1：ai-drawer.js 里没有裸 focus()，也没有 scrollIntoView", () => {
  const codeLines = DRAWER_JS.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const bareFocus = codeLines.filter((line) => /\.focus\(\s*\)/.test(line));
  assert.deepEqual(bareFocus, [], `focus() 必须带 { preventScroll: true }：${JSON.stringify(bareFocus)}`);
  const scrollIntoView = codeLines.filter((line) => /scrollIntoView\s*\(/.test(line));
  assert.deepEqual(scrollIntoView, [], `不许用 scrollIntoView（会滚动 .main）：${JSON.stringify(scrollIntoView)}`);
  // 至少一处 preventScroll（focusInput）
  const guarded = codeLines.filter((line) => /\.focus\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/.test(line));
  assert.ok(guarded.length >= 1, "focusInput 必须用 focus({ preventScroll: true })");
});

/* ---------------------------------------------------------------- AC2：不透明菜单 */

test("AC2：三处菜单的 background 是 var(--term-panel-solid)，不再用 --term-panel-2", () => {
  const menus = [
    '[data-role="ai-drawer"] [data-role="model-menu"]',
    ".file-panel-action-menu",
    '[data-role="ai-drawer"] [data-role="agent-sessions-menu"]',
  ];
  for (const selector of menus) {
    const block = blockOf(COMPONENTS, selector);
    assert.ok(block.length > 0, `找不到菜单规则：${selector}`);
    assert.match(block, /background:\s*var\(--term-panel-solid\)/, `${selector} 的底色必须是实色变量`);
    assert.equal(
      /background:\s*var\(--term-panel-2\)/.test(block),
      false,
      `${selector} 不许再用 --term-panel-2（问题 8 的根因）`,
    );
    assert.match(block, /box-shadow:/, `${selector} 必须有阴影（浮层边界感）`);
    assert.match(block, /border:\s*1px solid var\(--term-border\)/, `${selector} 必须有 1px 实线边框`);
  }
});

test("AC2：--term-panel-solid 由 magpie 令牌派生（不写死色值、不依赖 --term-panel-2）", () => {
  const decl = /--term-panel-solid\s*:\s*([^;]+);/.exec(COMPONENTS);
  assert.ok(decl, "必须声明 --term-panel-solid");
  const value = decl[1].trim();
  assert.match(value, /var\(--magpie-[a-z0-9-]+\)/, `必须从 --magpie-* 派生：${value}`);
  assert.equal(/--term-panel-2/.test(value), false, "不许反过来依赖 --term-panel-2（本批必须独立成立）");
  assert.equal(/transparent/i.test(value), false, "不能含 transparent");
  const rgba = /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(value);
  if (rgba) assert.equal(Number(rgba[1]), 1, `alpha 必须是 1：${value}`);
});

test("AC2：全仓不再有 rgba(120,120,120,…) 这种 88% 透明的浮层底色", () => {
  const hits = COMPONENTS.split(/\r?\n/)
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /rgba?\(\s*120\s*,\s*120\s*,\s*120/i.test(line));
  assert.deepEqual(hits, [], "问题 8 的根因色不许再出现");
});

/* ---------------------------------------------------------------- AC3/AC4：输入区 */

test("AC3：composer-box 不再是 grid（没有 grid-template-areas 的 model/hint 列）", () => {
  const block = blockOf(COMPONENTS, '[data-role="ai-drawer"] .composer-box');
  assert.ok(block.length > 0, "找不到 .composer-box 规则");
  assert.equal(/grid-template-areas/.test(block), false, "grid areas 必须在 R3 里删掉");
  assert.equal(/display:\s*grid/.test(block), false, "composer-box 不再是 grid 容器");
  assert.match(block, /display:\s*block/, "改成块级容器");
});

test("AC4：.composer-hint 的 CSS 规则已全部删除（提示改成了 placeholder）", () => {
  assert.equal(/\.composer-hint\s*\{/.test(COMPONENTS), false, ".composer-hint 不该还有规则");
  assert.equal(
    /\[data-role="composer-hint"\]/.test(COMPONENTS),
    false,
    "composer-hint 的 data-role 选择器也该删掉",
  );
  const decls = DRAWER_JS.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const hintRefs = decls.filter((line) => /composer-hint/.test(line));
  assert.deepEqual(hintRefs, [], `.composer-hint 元素不该再被创建：${JSON.stringify(hintRefs)}`);
  assert.match(DRAWER_JS, /const INPUT_PLACEHOLDER = "Enter 发送 · Shift\+Enter 换行";/);
  assert.match(DRAWER_JS, /placeholder:\s*INPUT_PLACEHOLDER/, "textarea 必须用这个 placeholder");
});

test("AC3：JS 里模型下拉与动作按钮同在 .composer-topbar 下（不在 composer-box 里）", () => {
  assert.match(DRAWER_JS, /const topbar = el\("div", \{ className: "composer-topbar" \}\);/);
  // TASK-FIX17-L4 R4 在模型按钮右侧插入了推理下拉（三子项），
  // 顺序固定：模型 → 推理 → 动作按钮。
  assert.match(
    DRAWER_JS,
    /topbar\.append\(modelSelect, reasoningSelect, actionButton\)/,
    "模型 / 推理 / 按钮必须按顺序 append 到 topbar",
  );
  assert.match(DRAWER_JS, /composerBox\.append\(grow, input\)/, "composer-box 里只留把手与 textarea");
  assert.match(DRAWER_JS, /composerEl\.append\(topbar, modelMenu, composerBox\)/);
  const block = blockOf(COMPONENTS, '[data-role="ai-drawer"] .composer-topbar');
  assert.ok(block.length > 0, "必须有 .composer-topbar 规则");
  assert.match(block, /display:\s*flex/);
  assert.match(block, /justify-content:\s*space-between/, "模型靠左、按钮靠右");
});

/* ---------------------------------------------------------------- AC6/AC7：单按钮 */

test("AC6/AC7：只有一个动作按钮元素，旧的两个 data-role 已从 JS 里消失", () => {
  const codeLines = DRAWER_JS.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  // 只看**精确的 data-role 值**：`agent-send-hint` 是另一个东西（阻塞提示块）
  const oldRoles = codeLines.filter(
    (line) => /["']agent-send["']|["']agent-stop["']/.test(line),
  );
  assert.deepEqual(oldRoles, [], `旧的 agent-send / agent-stop 必须删净：${JSON.stringify(oldRoles)}`);
  assert.match(DRAWER_JS, /"data-role": "composer-action"/, "必须有单一动作按钮");
  assert.match(DRAWER_JS, /actionButton\.classList\.toggle\("is-busy", busy\)/, "用 .is-busy 切形态");
});

test("AC6：忙碌态是「红环 + 深色圆心」，且红环用 --term-danger、不用写死颜色", () => {
  const block = blockOf(COMPONENTS, '[data-role="ai-drawer"] .composer-action.is-busy');
  assert.ok(block.length > 0, "必须有 .is-busy 规则");
  assert.match(block, /border:\s*[1-9]\d*px solid var\(--term-danger\)/, "红环必须用 --term-danger");
  assert.match(block, /background:\s*var\(--term-busy-core\)/, "圆心必须是深色变量");
  // --term-busy-core 必须由 magpie 派生，不许写死 #000
  const decl = /--term-busy-core\s*:\s*([^;]+);/.exec(COMPONENTS);
  assert.ok(decl, "必须声明 --term-busy-core");
  assert.match(decl[1], /var\(--magpie-[a-z0-9-]+\)/, `--term-busy-core 必须派生：${decl[1].trim()}`);
  // 深色主题下要有自己的值（不能用浅色的 fg 当圆心）
  assert.ok(
    /:root:where\(\.is-dark\)\s*\{[\s\S]*?--term-busy-core\s*:/.test(COMPONENTS),
    "深色主题必须单独给 --term-busy-core（否则圆心会变白）",
  );
});

/* ---------------------------------------------------------------- 颜色字面量 */

test("R2/R5：抽屉段与 composer 段不出现颜色字面量（只引用变量）", () => {
  // 抽屉段：从「AI 抽屉」注释头到 composer 段结束（toast 段之前）
  const start = COMPONENTS.indexOf('[data-role="ai-drawer"] .drawer-head');
  const end = COMPONENTS.indexOf(".toast {");
  assert.ok(start > 0 && end > start, "找不到抽屉段边界（CSS 结构变了？）");
  const section = COMPONENTS.slice(start, end);
  const literals = [...section.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], "抽屉/composer 段不许出现写死的 #hex / rgb()");
});

test("R5：markdown 渲染样式段存在，且代码块等宽 + 可横向滚动", () => {
  assert.ok(/markdown 渲染（TASK-FIX17-D R5/.test(COMPONENTS_CSS), "必须有 markdown 渲染样式段");
  const pre = blockOf(COMPONENTS, '[data-role="agent-summary-md"] pre');
  assert.ok(pre.length > 0, "必须有 pre 规则");
  assert.match(pre, /overflow-x:\s*auto/, "代码块必须可横向滚动");
  assert.match(pre, /background:\s*var\(--term-panel-solid\)/, "代码块底色用实色变量");
  const code = blockOf(COMPONENTS, '[data-role="agent-summary-md"] pre code');
  assert.match(code, /font-family:\s*var\(--term-mono\)/, "代码必须等宽");
  assert.match(code, /white-space:\s*pre\b/, "代码不许自动换行（复制出来会坏）");
  const table = blockOf(COMPONENTS, '[data-role="agent-summary-md"] table');
  assert.match(table, /border-collapse:\s*collapse/, "表格必须 border-collapse");
});

/* ---------------------------------------------------------------- 不许碰的地方 */

test("A 批的终端黑边修复仍在（terminal-surface.css 被引用且有权重覆盖）", async () => {
  assert.match(INDEX_HTML, /<link rel="stylesheet" href="\/styles\/terminal-surface\.css">/);
  const surface = await readFile(path.join(REPO, "app", "styles", "terminal-surface.css"), "utf8");
  assert.match(surface, /!important/, "terminal-surface.css 的 !important 覆盖不能被削弱");
});

test("CSS 引入顺序没变：xterm → terminal-surface → tokens → layout → components", () => {
  const order = [
    "/vendor/xterm/xterm.css",
    "/styles/terminal-surface.css",
    "/styles/tokens.css",
    "/styles/layout.css",
    "/styles/components.css",
  ].map((href) => INDEX_HTML.indexOf(href));
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1] > 0 && order[i] > 0, "每个样式表都必须被引用");
    assert.ok(order[i - 1] < order[i], "样式表顺序被改了（要重跑 probe-terminal-edges.mjs）");
  }
});
