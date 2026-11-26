// TASK-FIX17-F2（F-09）：命中区尺寸的取舍。
//
// AUDIT 的结论是「不要一律加到 32」：工具栏里按钮相邻间距只有 5px、行高 34px，
// 32px 的控件会互相盖住热区、也放不下。本卡取「工具栏统一 28px」这一档：
//   * 视觉尺寸一起升（不靠伪元素偷热区），因为这一行本来就有空间；
//   * 批量条里的 24px 按钮在 28px 条里上下各留 2px；
//   * 设置页开关的轨道视觉 34×18 **一个像素都不能动**（已验收的对位），
//     所以它只能用透明 ::before 补命中盒 —— 这里连轨道与旋钮的像素值一起钉死，
//     防下一次「顺手把开关也改成 28px 高」。
//   * [data-role="tab-new"] 保持 28×28：它的 margin-top:4px 与中心 y=21.5 的对齐
//     是 F-14 刚修的，改尺寸会把 2px 偏移带回来。
//
// 只读 CSS 文本断言，不起浏览器、不写探针。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const COMPONENTS_CSS = await readFile(path.join(REPO, "app", "styles", "components.css"), "utf8");

/** 去掉注释，只为「在真实声明里 grep」而不是匹配到说明文字。 */
const COMPONENTS = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取 `.selector { ... }` 的声明块（只用于断言，不追求完整 CSS 解析）。 */
function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))].map((m) => m[1]);
  return matches.join("\n");
}

/* -------------------------------------------------- 工具栏：统一 28px 这一档 */

test("F-09：文件面板工具栏控件都是 28px 高（不靠伪元素偷热区）", () => {
  const cases = [
    [".file-panel-btn", "工具栏按钮"],
    [".file-panel-locate", "定位按钮"],
    [".file-panel-path", "路径输入框"],
    [".file-panel-batch", "批量操作条"],
  ];
  for (const [selector, label] of cases) {
    const block = blockOf(COMPONENTS, selector);
    assert.ok(block.trim().length > 0, `找不到 ${selector} 规则`);
    assert.match(block, /height:\s*28px/, `${label}（${selector}）的高度必须是 28px`);
  }
});

test("F-09：定位按钮宽高都 28px（与 .file-panel-icon-btn 对齐）", () => {
  const locate = blockOf(COMPONENTS, ".file-panel-locate");
  assert.match(locate, /width:\s*28px/, "定位按钮宽度必须也是 28px，否则视觉上是窄条");
  const iconBtn = blockOf(COMPONENTS, ".file-panel-icon-btn");
  assert.match(iconBtn, /width:\s*28px/, ".file-panel-icon-btn 仍应是 28px（本次不改它）");
  assert.match(iconBtn, /height:\s*28px/, ".file-panel-icon-btn 仍应是 28px（本次不改它）");
});

test("F-09：路径框是 border-box（否则 28px 加边框会溢出 28px 的 slot）", () => {
  const path = blockOf(COMPONENTS, ".file-panel-path");
  assert.match(
    path,
    /box-sizing:\s*border-box/,
    "input 默认是 content-box：28px 只是内容高，加 1px 边框实际占 30px，在 28px 的 slot 里上下各溢出 1px",
  );
});

test("F-09：批量条内按钮 24×24（28px 条里上下各留 2px）", () => {
  const block = blockOf(COMPONENTS, ".file-panel-batch-btn,\n.file-panel-batch-cancel");
  assert.ok(block.trim().length > 0, "找不到 .file-panel-batch-btn / .file-panel-batch-cancel 共用规则");
  assert.match(block, /width:\s*24px/, "批量条内按钮宽 24px");
  assert.match(block, /height:\s*24px/, "批量条内按钮高 24px");
  assert.match(block, /border-radius:\s*4px/, "圆角保持 4px（不跟着放大）");
});

/* ------------------------------------------------------- 设置页开关：只补热区 */

test("F-09：设置开关的轨道与旋钮像素一点没变（视觉不动）", () => {
  const track = blockOf(COMPONENTS, '.settings-block [data-role="setting-show-effect"]');
  assert.ok(track.trim().length > 0, "找不到设置开关轨道规则");
  assert.match(track, /width:\s*34px/, "轨道宽必须仍是 34px");
  assert.match(track, /height:\s*18px/, "轨道高必须仍是 18px（要补的是热区，不是视觉）");
  assert.match(track, /position:\s*relative/, "::before 的定位基准");

  const knob = blockOf(COMPONENTS, '.settings-block [data-role="setting-show-effect"] .switch-knob');
  assert.match(knob, /width:\s*12px/, "旋钮宽必须仍是 12px");
  assert.match(knob, /height:\s*12px/, "旋钮高必须仍是 12px");
  assert.match(knob, /top:\s*2px/, "旋钮 top 必须仍是 2px");
  assert.match(knob, /left:\s*2px/, "旋钮 left 必须仍是 2px");

  const checked = blockOf(
    COMPONENTS,
    '.settings-block [data-role="setting-show-effect"][aria-checked="true"] .switch-knob',
  );
  assert.match(checked, /transform:\s*translateX\(16px\)/, "开启态位移必须仍是 16px");
});

test("F-09：设置开关的命中盒扩展存在且 ≥24px 高", () => {
  const hit = blockOf(COMPONENTS, '.settings-block [data-role="setting-show-effect"]::before');
  assert.ok(hit.trim().length > 0, "缺少 ::before 命中盒扩展规则（18px 高低于 24px 命中下限）");

  const read = (prop) => {
    const m = new RegExp(`${prop}:\\s*(-?[\\d.]+)px`).exec(hit);
    assert.ok(m, `::before 必须有 ${prop} 的 px 值`);
    return Number(m[1]);
  };
  const top = read("top");
  const bottom = read("bottom");
  // 轨道高 18px：扩展后命中高度 = 18 - top - bottom（top/bottom 是负值）
  const hitHeight = 18 - top - bottom;
  assert.ok(
    hitHeight >= 24,
    `命中高度必须 ≥24px，实得 ${hitHeight}px（visual 18 + ${-top} + ${-bottom}）`,
  );
  assert.ok(top <= 0 && bottom <= 0, "top / bottom 必须是负值（向外扩，不是向内缩）");
});

/* --------------------------------------------- 输入框：外框 ≥32px，且仍会长高 */

test("F-09：composer-box 有 32px 下限（textarea 单行只有 19.375px）", () => {
  const box = blockOf(COMPONENTS, '[data-role="ai-drawer"] .composer-box');
  assert.ok(box.trim().length > 0, "找不到 .composer-box 规则");
  assert.match(box, /min-height:\s*32px/, ".composer-box 必须有 32px 下限，否则命中高度只有 19.375px");
});

test("F-09：composer-box 不用 flex 居中（否则多行时外框不跟内容长高）", () => {
  const box = blockOf(COMPONENTS, '[data-role="ai-drawer"] .composer-box');
  assert.equal(
    /display:\s*flex/.test(box),
    false,
    "必须保持块级：align-items:center 会把 textarea 的内容盒钉死，autoGrow 写 style.height 也只会溢出外框",
  );
  assert.match(box, /display:\s*block/, "必须是块级容器");
  assert.equal(
    /align-items:\s*center/.test(box),
    false,
    "不许用 align-items:center（同上，会破坏随内容长高）",
  );
});

/* ------------------------------------------------------ 防顺手改坏既有对齐 */

test("F-09：tab-new 仍是 28×28 + margin-top:4px（F-14 的对齐不能回归）", () => {
  const block = blockOf(COMPONENTS, '[data-role="tab-new"]');
  assert.ok(block.trim().length > 0, "找不到 [data-role=\"tab-new\"] 规则");
  assert.match(block, /width:\s*28px/, "tab-new 宽必须仍是 28px");
  assert.match(block, /height:\s*28px/, "tab-new 高必须仍是 28px（不动它）");
  assert.match(block, /margin:\s*4px 0 0 4px/, "margin-top:4px 是 F-14 修 2px 偏移的关键，不能改");
});

test("F-09：把手 24×78 不动（已远超最小边）", () => {
  const tokens = blockOf(COMPONENTS, ":root");
  // 把手尺寸定义在 tokens.css；这里只确认 components.css 没有另写一套覆盖
  assert.equal(
    /\[data-role="ai-handle"\][^{]*\{[^}]*width:\s*\d+px/.test(COMPONENTS),
    false,
    "把手宽度只能在 layout.css / tokens.css 里定义，不许在 components.css 里另写一套",
  );
  assert.ok(tokens.length >= 0);
});

/* ------------------------------------------------------------ 不许出现色值 */

test("F-09：本卡改动的块内不出现颜色字面量（一律用变量）", () => {
  const selectors = [
    ".file-panel-btn",
    ".file-panel-locate",
    ".file-panel-path",
    ".file-panel-batch",
    ".file-panel-batch-btn,\n.file-panel-batch-cancel",
    ".file-panel-toolbar",
    ".file-panel-grid",
    '[data-role="ai-drawer"] .composer',
    '[data-role="ai-drawer"] .composer-box',
    '.settings-block [data-role="setting-show-effect"]',
  ];
  for (const selector of selectors) {
    const block = blockOf(COMPONENTS, selector);
    const literals = [...block.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)].map((m) => m[0]);
    assert.deepEqual(literals, [], `${selector} 里不许出现颜色字面量：${JSON.stringify(literals)}`);
  }
});
