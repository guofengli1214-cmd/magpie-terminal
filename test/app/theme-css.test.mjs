// TASK-FIX17-B：tokens.css 的静态约束（AC4 / AC6 / AC8 / R2 / R3）。
//
// 为什么要有这一组：颜色是 CSS 里的静态声明，运行时探针（scripts/probe-theme.mjs）
// 只能证明「这一套配色在这台机器上是对的」，证明不了「换了主题别的分支也不会跑偏」。
// 下面这些断言把规则本身钉住：
//   * 不许再出现 `@media (prefers-color-scheme: dark)`
//   * 颜色字面量只许出现在变量声明里（可以 grep 出来数一数）
//   * `--term-panel-2` 不许是 rgba(…, 小 alpha)（问题 8 的根因）
//   * `is-dark` / `is-light` 必须有真实声明
//   * ANSI 16 色必须两套都有
//
// 读文件而不是跑浏览器：这组断言要求秒级、无依赖、失败信息可定位到行号。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const TOKENS_CSS = path.join(REPO, "app", "styles", "tokens.css");

const css = await readFile(TOKENS_CSS, "utf8");

/** 去掉注释，只为「在真实声明里 grep」而不是匹配到说明文字。 */
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 按行返回 `[行号, 文本]`，失败信息里能指出是哪一行。 */
const lines = (text) => text.split(/\r?\n/).map((line, i) => [i + 1, line]);

/* ---------------------------------------------------------------- AC4 */

test("AC4：tokens.css 里没有 @media (prefers-color-scheme) 段", () => {
  const hits = lines(stripped).filter(([, line]) => /@media[^{]*prefers-color-scheme/i.test(line));
  assert.deepEqual(hits, [], "深浅色必须由 magpie 决定，不能用系统媒体查询");
});

test("AC4：没有 `background-color: #000` / `#fff` 这类绝对色声明", () => {
  const hits = lines(stripped).filter(([, line]) =>
    /background(-color)?\s*:\s*(#000|#000000|#fff|#ffffff)\b/i.test(line),
  );
  assert.deepEqual(hits, [], "绝对色会被写进硬编码，主题一换就错");
});

test("AC4：没有 rgba(120,120,120,…) 这种与主题无关的中性透明色", () => {
  const hits = lines(stripped).filter(([, line]) => /rgba?\(\s*120\s*,\s*120\s*,\s*120/i.test(line));
  assert.deepEqual(hits, [], "问题 8 的根因就是它（88% 透明的面板底色）");
});

test("AC4：颜色字面量只出现在变量声明里（不在选择器的属性里硬编码）", () => {
  // 「变量声明」= 以 `--xxx:` 开头的行。其余任何行出现 #rrggbb 都算违规。
  const offenders = [];
  for (const [no, line] of lines(stripped)) {
    const colour = /#[0-9a-fA-F]{3,8}\b/.exec(line);
    if (!colour) continue;
    const isVarDecl = /^\s*--[a-z0-9-]+\s*:/i.test(line);
    if (!isVarDecl) offenders.push({ line: no, text: line.trim() });
  }
  assert.deepEqual(offenders, [], "颜色只能出现在 --var 声明处（唯一允许字面量的地方）");
});

/* ---------------------------------------------------------------- AC8 */

test("AC8：--term-panel-2 不再是半透明（问题 8 的根因已消除）", () => {
  const decl = /--term-panel-2\s*:\s*([^;]+);/.exec(stripped);
  assert.ok(decl, "必须声明 --term-panel-2");
  const value = decl[1].trim();
  // 允许 color-mix()（结果不透明）或 var()；不允许 rgba(…, <1) 或 transparent。
  assert.equal(/transparent/i.test(value), false, `--term-panel-2 不能含 transparent：${value}`);
  const rgba = /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(value);
  if (rgba) assert.equal(Number(rgba[1]), 1, `--term-panel-2 的 alpha 必须是 1：${value}`);
});

test("AC8：--term-panel-2 由 magpie 令牌派生（不是写死的色值）", () => {
  const decl = /--term-panel-2\s*:\s*([^;]+);/.exec(stripped);
  assert.ok(decl);
  const value = decl[1].trim();
  assert.match(
    value,
    /var\(--magpie-[a-z0-9-]+\)/,
    `--term-panel-2 必须从 --magpie-* 派生（R4：底色来源跟着主题）：${value}`,
  );
});

/* ---------------------------------------------------------------- AC6 */

test("AC6：is-dark / is-light 都有真实声明（不是空类）", () => {
  // 允许 `:root:where(.is-dark)` 这种降特异性写法（必须低于注入的 html:root）。
  const darkBlocks = stripped.match(/(?::root)?:where\(\.is-dark\)\s*\{[\s\S]*?\}/g) || [];
  const lightBlocks = stripped.match(/(?::root)?:where\(\.is-light\)\s*\{[\s\S]*?\}/g) || [];
  assert.ok(darkBlocks.length > 0, "is-dark 必须有 CSS 规则");
  assert.ok(lightBlocks.length > 0, "is-light 必须有 CSS 规则");
  // 每条规则里必须有真声明（不是 `{}`）。
  for (const block of [...darkBlocks, ...lightBlocks]) {
    assert.match(block, /--[a-z0-9-]+\s*:/, `规则不能是空声明：${block.slice(0, 60)}`);
  }
});

test("AC6：is-dark / is-light 的选择器特异性不得高于注入层的 html:root", () => {
  // 注入的是 `html:root{…}`（0,1,1）。如果这里用 `:root.is-dark`（0,2,0），
  // 就会盖掉用户自定义主题（D7-2b 真浏览器实测失败）。所以必须带 :where()。
  const selectors = [...stripped.matchAll(/^\s*([^{}\n]*\.is-(?:dark|light)[^{}\n]*)\{/gm)].map((m) => m[1].trim());
  assert.ok(selectors.length > 0, "必须找到 .is-dark / .is-light 规则");
  for (const selector of selectors) {
    // `:root` 或 `html` 不能与 `.is-*` 处在同一个复合选择器里而不加 :where()。
    const hasWhere = /:where\(/.test(selector);
    const compound = /(:root|html)\s*\.is-(dark|light)/.test(selector);
    assert.equal(
      compound && !hasWhere,
      false,
      `选择器会盖掉注入主题（必须用 :where() 降特异性）：${selector}`,
    );
  }
});

/* ---------------------------------------------------------------- R3：两套 ANSI */

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
];

/** 取某个块的声明文本。 */
function blockOf(selectorPattern) {
  const re = new RegExp(`${selectorPattern}\\s*\\{[\\s\\S]*?\\}`, "g");
  return (stripped.match(re) || []).join("\n");
}

test("R3：ANSI 16 色在 :root 与 is-dark 里各有一套（共 16 个键 × 2）", () => {
  const rootBlock = /(^|\n):root\s*\{[\s\S]*?\n\}/.exec(stripped);
  assert.ok(rootBlock, "必须有 :root 块");
  const rootText = rootBlock[0];
  const darkText = blockOf(":root:where\\(\\.is-dark\\)");

  for (const key of ANSI_KEYS) {
    assert.match(rootText, new RegExp(`--term-ansi-${key}\\s*:\\s*#[0-9a-fA-F]{3,8};`), `:root 缺 --term-ansi-${key}`);
    assert.match(darkText, new RegExp(`--term-ansi-${key}\\s*:\\s*#[0-9a-fA-F]{3,8};`), `is-dark 缺 --term-ansi-${key}`);
  }
});

test("R3：浅色与深色的 ANSI 是两套不同色值（不是同一套）", () => {
  const rootText = /(^|\n):root\s*\{[\s\S]*?\n\}/.exec(stripped)[0];
  const darkText = blockOf(":root:where\\(\\.is-dark\\)");
  const pick = (text, key) => new RegExp(`--term-ansi-${key}\\s*:\\s*([^;]+);`).exec(text)[1].trim();
  const same = ANSI_KEYS.filter((key) => pick(rootText, key) === pick(darkText, key));
  assert.ok(same.length <= 4, `至少 12 个 ANSI 色应该不同（实测相同的有 ${same.length} 个：${same.join(", ")}）`);
});

/* ---------------------------------------------------------------- R2：--term-bg */

test("R2：--term-bg 是真实色值派生（不是 Canvas 这类关键字）", () => {
  const decl = /--term-bg\s*:\s*([^;]+);/.exec(stripped);
  assert.ok(decl, "必须声明 --term-bg");
  const value = decl[1].trim();
  assert.equal(
    /^(Canvas|CanvasText|ButtonFace|GrayText|Window|WindowText)$/i.test(value),
    false,
    `--term-bg 不能是系统色关键字（xterm 拿到关键字会回落纯黑）：${value}`,
  );
  assert.match(value, /var\(--magpie-bg\)|#[0-9a-fA-F]{3,8}/, `--term-bg 必须是可解析的色值：${value}`);
});

test("R2：没有 --term-bg / --term-fg 的硬编码明暗二套（必须由 --magpie-* 派生）", () => {
  // 修之前有 `@media (prefers-color-scheme: dark) { :root { --term-bg: … } }` 那一整套。
  // 现在只允许在 :root 里声明一次（由 --magpie-bg 派生）。
  const decls = [...stripped.matchAll(/^\s*--term-bg\s*:\s*([^;]+);/gm)].map((m) => m[1].trim());
  assert.equal(decls.length, 1, `--term-bg 只该声明一次，实际 ${decls.length} 次：${JSON.stringify(decls)}`);
});

/* ---------------------------------------------------------------- AC7：字号 */

test("AC7：--term-font-size 由 --mt-font-scale 派生（textSize 能传到终端）", () => {
  const decl = /--term-font-size\s*:\s*([^;]+);/.exec(stripped);
  assert.ok(decl, "必须声明 --term-font-size");
  assert.match(decl[1], /var\(--mt-font-scale\)/, `--term-font-size 必须跟随字号缩放：${decl[1].trim()}`);
  // 默认 scale = 1（读不到 magpie 设置时保持原尺寸）。
  assert.match(stripped, /--mt-font-scale\s*:\s*1\s*;/, "必须给 --mt-font-scale 一个 1 的默认值");
});
