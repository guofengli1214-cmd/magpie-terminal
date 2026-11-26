// TASK-FIX17-F2（F-12）：终端面板给右侧把手让出 24px 常驻空带。
//
// 为什么要这组断言：这条改动的「修法」和「看起来合理的错法」只差一个位置。
// 给 `[data-role="terminal-host"]` 加 padding 是最直觉的写法，但 `.terminal-pane`
// 是 `position: absolute; inset: 0`，父级 padding 对它完全无效 —— 改完看不出任何
// 变化，问题（把手压住终端最右一列）依旧在。所以这里把「inset 的四值缩写必须是
// `0 var(--term-handle-width) 0 0`」钉死，同时防两件历史上真出现过的回归：
//   * 把 inset 改回 `0`（等于修复被回滚）
//   * 重新用 `::before` 把把手热区外扩（ACCEPT3 的 V04 FAIL：盖住最右一列、拖选不中字）
//
// 只读 CSS 文本断言，不起浏览器、不写探针。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const LAYOUT_CSS = await readFile(path.join(REPO, "app", "styles", "layout.css"), "utf8");
const TOKENS_CSS = await readFile(path.join(REPO, "app", "styles", "tokens.css"), "utf8");
const SURFACE_CSS = await readFile(path.join(REPO, "app", "styles", "terminal-surface.css"), "utf8");

/** 去掉注释，只为「在真实声明里 grep」而不是匹配到说明文字。 */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const LAYOUT = strip(LAYOUT_CSS);
const TOKENS = strip(TOKENS_CSS);
// terminal-surface.css 的注释里带着上游规则的原文（含花括号），不先去掉注释
// 会让下面的规则抽取把注释当成选择器。
const SURFACE = strip(SURFACE_CSS);

/** 取 `.selector { ... }` 的声明块（只用于断言，不追求完整 CSS 解析）。 */
function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))].map((m) => m[1]);
  return matches.join("\n");
}

/** 取「选择器列表里包含该选择器」的那一条规则的前缀 + 声明块。
    terminal-surface.css 的最后一条是三个选择器共用的组规则，
    blockOf 只能匹配「选择器紧接 {」，拿不到组规则。 */
function ruleWith(css, selector) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const hit = rules.find((m) => m[1].split(",").some((part) => part.trim() === selector));
  return hit ? { prelude: hit[1], decls: hit[2] } : { prelude: "", decls: "" };
}

test("F-12：.terminal-pane 右侧让出 --term-handle-width（inset 四值）", () => {
  const block = blockOf(LAYOUT, '[data-role="terminal-host"] .terminal-pane');
  assert.ok(block.trim().length > 0, "找不到 [data-role=\"terminal-host\"] .terminal-pane 规则");
  assert.match(
    block,
    /inset:\s*0 var\(--term-handle-width\) 0 0/,
    "pane 必须右侧让出把手宽度；给 host 加 padding 是无效写法（pane 是 inset:0 绝对定位）",
  );
});

test("F-12：inset 没有被改回 0（防回滚）", () => {
  const block = blockOf(LAYOUT, '[data-role="terminal-host"] .terminal-pane');
  assert.equal(
    /inset:\s*0\s*;/.test(block),
    false,
    "不能出现 `inset: 0;` —— 那是修复被回滚的样子",
  );
  assert.equal(
    /inset:\s*0\s*$/.test(block.split(/\r?\n/).find((line) => /inset:/.test(line)) || ""),
    false,
    "不能出现裸的 `inset: 0`",
  );
});

test("F-12：把手宽度仍是 24px，--term-handle-hit 没有跟着变", () => {
  assert.match(TOKENS, /--term-handle-width:\s*24px/, "让位带宽度必须与把手同宽（24px）");
  assert.match(TOKENS, /--term-handle-hit:\s*24px/, "热区不得外扩（ACCEPT3 V04 的历史教训）");

  const handle = blockOf(LAYOUT, '[data-role="ai-handle"]');
  assert.ok(handle.trim().length > 0, "找不到 [data-role=\"ai-handle\"] 规则");
  assert.match(handle, /width:\s*var\(--term-handle-width\)/, "把手宽度必须走同一个变量");
});

test("F-12：把手块内没有 ::before 热区外扩（防回归）", () => {
  const handle = blockOf(LAYOUT, '[data-role="ai-handle"]');
  assert.equal(
    /::before/.test(handle),
    false,
    "把手本体不许再出现 ::before —— 扩到 48px 会盖住终端最右一列，从该带起拖选不中字",
  );
  // 整个 layout.css 里也不许有指向把手的伪元素规则
  const pseudo = [...LAYOUT.matchAll(/\[data-role="ai-handle"\][^{]*::(before|after)[^{]*\{/g)].map((m) => m[0]);
  assert.deepEqual(pseudo, [], `layout.css 里不该有把手伪元素规则：${JSON.stringify(pseudo)}`);
});

test("F-12：让位带里不会露出异色底（xterm 三处底色都取 --term-bg）", () => {
  // 空带本身由 [data-role="terminal-host"] 的 background 兜底
  const host = blockOf(LAYOUT, '[data-role="terminal-host"]');
  assert.match(
    host,
    /background:\s*var\(--term-bg\)/,
    "host 底色必须是 --term-bg，否则 24px 空带会与终端本体不同色",
  );

  // 组规则：.xterm / .xterm .xterm-screen / .terminal-pane 共用同一个兜底底色
  const group = ruleWith(SURFACE, '[data-role="terminal-host"] .terminal-pane');
  assert.ok(group.decls.length > 0, "找不到 .xterm 组的兜底底色规则（terminal-surface.css 结构变了？）");
  for (const selector of [".xterm", ".xterm .xterm-screen"]) {
    assert.ok(
      group.prelude.split(",").some((part) => part.trim() === selector),
      `组规则里必须同时有 ${selector}，否则 canvas 尺寸取整时会露出别色`,
    );
  }
  assert.match(group.decls, /background-color:\s*var\(--term-bg/, "组规则的兜底色必须是 --term-bg");

  // viewport 与 composition-view 是上游写死 #000 的两处（黑边的直接来源）
  assert.match(
    blockOf(SURFACE, ".xterm .xterm-viewport"),
    /background-color:\s*var\(--term-bg/,
    ".xterm-viewport 必须覆盖上游写死的 #000",
  );
  assert.match(
    blockOf(SURFACE, ".xterm .composition-view"),
    /background:\s*var\(--term-bg/,
    ".composition-view 必须覆盖上游写死的 #000",
  );
});
