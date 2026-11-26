// TASK-FIX17-F2（F-13）：结构级间距令牌化。
//
// 只做白名单：tokens.css 新增 --space-1…6（2/4/6/8/10/12），替换 7 个「结构级」
// 选择器的裸 px（工具栏 / 网格 / rail / tabbar / composer 两处 / 批量条 gap）。
// 为什么不一次性全仓替换：全仓 100+ 处间距里有大量 3px / 5px / 9px 的细节奏值，
// 硬塞进六档必须二选一取舍，视觉会整体变样；全仓替换也不是本卡的范围。
//
// 这组断言防三件事：
//   1. 令牌被改成别的值（会静默改动所有引用处）；
//   2. 替换被回滚成裸 px（下次改间距又变成「七处手改」）；
//   3. 有人顺手把 .file-panel-grid 重排（该块是 12 列栅格的对位基准）。
//
// 只读 CSS 文本断言，不起浏览器、不写探针。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const TOKENS_CSS = await readFile(path.join(REPO, "app", "styles", "tokens.css"), "utf8");
const COMPONENTS_CSS = await readFile(path.join(REPO, "app", "styles", "components.css"), "utf8");
const LAYOUT_CSS = await readFile(path.join(REPO, "app", "styles", "layout.css"), "utf8");

/** 去掉注释，只为「在真实声明里 grep」而不是匹配到说明文字。 */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const TOKENS = strip(TOKENS_CSS);
const COMPONENTS = strip(COMPONENTS_CSS);
const LAYOUT = strip(LAYOUT_CSS);

/** 取 `.selector { ... }` 的声明块（只用于断言，不追求完整 CSS 解析）。 */
function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))].map((m) => m[1]);
  return matches.join("\n");
}

/* ------------------------------------------------------------------ 令牌本身 */

test("F-13：tokens.css 有 --space-1…6 六档，值依次 2/4/6/8/10/12", () => {
  const expected = [
    ["--space-1", "2px"],
    ["--space-2", "4px"],
    ["--space-3", "6px"],
    ["--space-4", "8px"],
    ["--space-5", "10px"],
    ["--space-6", "12px"],
  ];
  const root = blockOf(TOKENS, ":root");
  assert.ok(root.trim().length > 0, "找不到 :root 令牌块");
  for (const [name, value] of expected) {
    assert.match(
      root,
      new RegExp(`${name}:\\s*${value.replace(".", "\\.")};`),
      `${name} 必须是 ${value}（4/8 节奏 + 2px 亚节奏，改值会静默影响所有引用处）`,
    );
  }
});

test("F-13：令牌段没有多出第 7 档（不许顺手加档位）", () => {
  const declared = [...TOKENS.matchAll(/--space-\d+\s*:/g)].map((m) => m[0].trim());
  assert.equal(declared.length, 6, `只允许 --space-1…6，实得：${JSON.stringify(declared)}`);
});

/* -------------------------------------------------------------- 白名单 7 处 */

test("F-13：composer 的上下内边距走令牌（原 9/10/8）", () => {
  const block = blockOf(COMPONENTS, '[data-role="ai-drawer"] .composer');
  assert.match(block, /padding:\s*var\(--space-4\) var\(--space-5\) var\(--space-4\)/);
  assert.equal(/padding:\s*9px/.test(block), false, "不应再出现原来的 9px");
});

test("F-13：composer-topbar 的 6px 走令牌", () => {
  const block = blockOf(COMPONENTS, '[data-role="ai-drawer"] .composer-topbar');
  assert.match(block, /padding:\s*0 0 var\(--space-3\)/);
});

test("F-13：文件面板工具栏的 8/9 走令牌（改成左右对称）", () => {
  const block = blockOf(COMPONENTS, ".file-panel-toolbar");
  assert.match(block, /padding:\s*0 var\(--space-4\)/);
});

test("F-13：文件面板网格的 6/14/8/9 走令牌（改成左右对称）", () => {
  const block = blockOf(COMPONENTS, ".file-panel-grid");
  assert.match(
    block,
    /padding:\s*var\(--space-3\) var\(--space-6\) var\(--space-4\) var\(--space-4\)/,
    "上 6 / 右 12 / 下 8 / 左 8",
  );
  for (const bare of ["6px", "14px", "8px", "9px"]) {
    assert.equal(
      new RegExp(`padding:[^;]*${bare.replace(".", "\\.")}`).test(block),
      false,
      `padding 里不应再有裸的 ${bare}`,
    );
  }
});

test("F-13：rail 的 gap 与 padding 走令牌", () => {
  const block = blockOf(COMPONENTS, '[data-role="rail"]');
  assert.match(block, /gap:\s*var\(--space-1\)/);
  assert.match(block, /padding:\s*var\(--space-4\) 0 var\(--space-3\)/);
});

test("F-13：批量条的 gap 走令牌", () => {
  const block = blockOf(COMPONENTS, ".file-panel-batch");
  assert.match(block, /gap:\s*var\(--space-1\)/);
  assert.equal(/gap:\s*2px/.test(block), false, "不应再出现裸的 gap:2px");
});

test("F-13：tabbar 的 gap 与左右内边距走令牌", () => {
  const block = blockOf(LAYOUT, '[data-role="tabbar"]');
  assert.match(block, /gap:\s*var\(--space-1\)/);
  assert.match(block, /padding:\s*0 var\(--space-3\)/);
  assert.equal(/gap:\s*2px/.test(block), false, "不应再出现裸的 gap:2px");
  assert.equal(/padding:\s*0 6px/.test(block), false, "不应再出现裸的 padding:0 6px");
});

/* --------------------------------------------------- 白名单之外一律不动（反向） */

test("F-13：白名单之外的高频细节奏仍是裸 px（没有全仓替换）", () => {
  // 抽几条本卡刻意不动的：工具栏 gap 5px、file-panel-tools gap 3px、轨道页等。
  assert.match(blockOf(COMPONENTS, ".file-panel-toolbar"), /gap:\s*5px/, "工具栏 gap:5px 不在白名单里");
  assert.match(blockOf(COMPONENTS, ".file-panel-tools"), /gap:\s*3px/, "工具组 gap:3px 不在白名单里");
});

test("F-13：.file-panel-grid 块行数没有明显变化（防顺手重排）", () => {
  const block = blockOf(COMPONENTS, ".file-panel-grid");
  const lines = block.split(/\r?\n/).filter((line) => line.trim().length > 0);
  assert.ok(
    lines.length <= 16,
    `.file-panel-grid 声明行数从 13 增到 ${lines.length}（>16）—— 本卡只允许改 padding 那一行`,
  );
  // 栅格对位基准不能动
  assert.match(block, /grid-template-columns:\s*repeat\(auto-fill, minmax\(108px, 1fr\)\)/);
  assert.match(block, /grid-auto-rows:\s*74px/);
  assert.match(block, /gap:\s*2px 4px/, "网格 gap 不在白名单里，不能改成令牌");
});
