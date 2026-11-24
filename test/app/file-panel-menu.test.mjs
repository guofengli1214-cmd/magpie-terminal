// TASK-FIX-UI-REST §6.2/§6.3：文件条目动作清单 + 面板级菜单定位（纯函数，不碰 DOM）。
//
// 两条锁死的东西：
//   1. actionsForEntry 的文案与顺序（文件 5 项 / 目录 3 项）——菜单就是照它渲染的，
//      「查看/编辑/重命名/下载/删除」错一个字，AC5 就挂。
//   2. clampMenuPosition 的四条边界：正常在按钮下方、靠底边翻到上方、靠右边缘左移、
//      面板比菜单还窄时不产生负数坐标（菜单绝不出面板）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  actionsForEntry,
  clampMenuPosition,
  menuSizeFor,
  MENU_CHROME,
  MENU_GAP,
  MENU_ITEM_HEIGHT,
  MENU_MARGIN,
  MENU_WIDTH,
} from "../../app/ui/file-panel.js";

/* ------------------------------ actionsForEntry ------------------------------ */

test("actionsForEntry：目录 → 打开/重命名/删除（3 项，逐字）", () => {
  const actions = actionsForEntry({ type: "dir", name: "alpha-dir", path: "C:/tmp/alpha-dir" });
  assert.deepEqual(actions, [
    { label: "打开", action: "open" },
    { label: "重命名", action: "rename" },
    { label: "删除", action: "delete" },
  ]);
  assert.deepEqual(actions.map((a) => a.action), ["open", "rename", "delete"]);
  assert.deepEqual(actions.map((a) => a.label), ["打开", "重命名", "删除"]);
});

test("actionsForEntry：文件 → 查看/编辑/重命名/下载/删除（5 项，逐字）", () => {
  const actions = actionsForEntry({ type: "file", name: "note-01.md", path: "C:/tmp/note-01.md" });
  assert.deepEqual(actions, [
    { label: "查看", action: "view" },
    { label: "编辑", action: "edit" },
    { label: "重命名", action: "rename" },
    { label: "下载", action: "download" },
    { label: "删除", action: "delete" },
  ]);
  assert.deepEqual(actions.map((a) => a.action), ["view", "edit", "rename", "download", "delete"]);
  assert.deepEqual(actions.map((a) => a.label), ["查看", "编辑", "重命名", "下载", "删除"]);
});

test("actionsForEntry：null / 未给 type 都走文件分支（5 项）", () => {
  for (const value of [null, undefined, {}, { type: "link" }, { type: "file" }]) {
    const actions = actionsForEntry(value);
    assert.equal(actions.length, 5, `${JSON.stringify(value)} 应该走文件分支`);
    assert.equal(actions[0].action, "view");
    assert.equal(actions[4].action, "delete");
  }
});

test("actionsForEntry：每次返回新数组（调用方改了不污染下一次）", () => {
  const first = actionsForEntry({ type: "dir" });
  first.push({ label: "注入", action: "boom" });
  const second = actionsForEntry({ type: "dir" });
  assert.equal(second.length, 3);
});

/* ------------------------------ menuSizeFor ------------------------------ */

test("menuSizeFor：高度 = 项数 × 行高 + 边框内边距开销，宽度固定 120", () => {
  assert.deepEqual(menuSizeFor(3), { width: MENU_WIDTH, height: 3 * MENU_ITEM_HEIGHT + MENU_CHROME });
  assert.deepEqual(menuSizeFor(5), { width: MENU_WIDTH, height: 5 * MENU_ITEM_HEIGHT + MENU_CHROME });
  assert.equal(menuSizeFor(0).height, 0);
  assert.equal(menuSizeFor(null).height, 0);
  assert.equal(menuSizeFor("3").height, 3 * MENU_ITEM_HEIGHT + MENU_CHROME);
  assert.equal(MENU_WIDTH, 120, "与 CSS 的 min-width: 120px 对齐");
  assert.equal(MENU_ITEM_HEIGHT, 26, "与 CSS 的 .file-panel-menu-item height: 26px 对齐");
});

/* ------------------------------ clampMenuPosition ------------------------------ */

/** 一个 1440×900 下的样板：面板 48..1432 × 640..866。 */
const PANEL = { left: 48, top: 640, right: 1432, bottom: 866 };
const MENU = menuSizeFor(5); // 120 × 134

test("clampMenuPosition：正常情况下菜单贴在 ⋯ 按钮下方、左缘对齐按钮", () => {
  const btn = { left: 300, top: 650, right: 328, bottom: 678 };
  const pos = clampMenuPosition({ btn, menu: MENU, panel: PANEL });
  assert.equal(pos.left, 300);
  assert.equal(pos.top, 678 + MENU_GAP);
  // 完全在面板内。
  assert.ok(pos.left >= PANEL.left);
  assert.ok(pos.left + MENU.width <= PANEL.right);
  assert.ok(pos.top >= PANEL.top);
  assert.ok(pos.top + MENU.height <= PANEL.bottom);
});

test("clampMenuPosition：靠面板底边时翻到按钮上方，且仍在面板内", () => {
  // 面板 640..866；菜单 134 高。按钮 top=800 / bottom=828：
  // 下方 828+2+134=964 > 862 放不下 → 上方 800-134-2=664，仍在 644..862 内。
  const btn = { left: 300, top: 800, right: 328, bottom: 828 };
  const pos = clampMenuPosition({ btn, menu: MENU, panel: PANEL });
  assert.equal(pos.top, 800 - MENU.height - MENU_GAP);
  assert.ok(pos.top + MENU.height <= PANEL.bottom - MENU_MARGIN, "上方也要在面板内");
  assert.ok(pos.top >= PANEL.top + MENU_MARGIN);
});

test("clampMenuPosition：靠面板右边缘的条目 → 菜单改到卡片左侧（不遮锚点行）", () => {
  const btn = { left: 1400, top: 700, right: 1428, bottom: 728 };
  const pos = clampMenuPosition({ btn, menu: MENU, panel: PANEL });
  assert.equal(pos.placement, "side", "上下放不下且右侧不够 → 改到左侧");
  assert.equal(pos.left, btn.left - MENU.width - MENU_GAP);
  assert.ok(pos.left >= PANEL.left);
  assert.ok(pos.left + MENU.width <= PANEL.right);
});

test("clampMenuPosition：上下都放不下、左右也放不下时贴面板左上角（不产生负数）", () => {
  // 面板只有 100px 高、85px 宽：比 120×134 的菜单还小 → 只能硬塞。
  const panel = { left: 10, top: 100, right: 95, bottom: 200 };
  const btn = { left: 50, top: 150, right: 78, bottom: 178 };
  const pos = clampMenuPosition({ btn, menu: MENU, panel });
  assert.ok(pos.top >= panel.top && pos.top >= 0);
  assert.ok(pos.left >= panel.left && pos.left >= 0);
  assert.equal(pos.left, panel.left + MENU_MARGIN);
  assert.equal(pos.top, panel.top + MENU_MARGIN);
});

test("clampMenuPosition：面板矮但够宽时优先改到卡片右侧（不遮住自己这一行）", () => {
  // 面板 400×100：菜单 134 高放不进上/下 → 右侧放得下就放右边。
  const panel = { left: 0, top: 0, right: 400, bottom: 100 };
  const btn = { left: 50, top: 20, right: 78, bottom: 48 };
  const anchor = { left: 22, top: 20, right: 132, bottom: 94 };
  const pos = clampMenuPosition({ btn, anchor, menu: MENU, panel });
  assert.equal(pos.placement, "side");
  assert.equal(pos.left, anchor.right + MENU_GAP);
  assert.ok(pos.top >= panel.top);
  assert.ok(pos.left + MENU.width <= panel.right);
});

test("clampMenuPosition：面板比菜单还窄时也不产生负数坐标", () => {
  const panel = { left: 10, top: 10, right: 90, bottom: 80 }; // 80 × 70，比 120×134 还小
  const btn = { left: 20, top: 20, right: 48, bottom: 48 };
  const pos = clampMenuPosition({ btn, menu: MENU, panel });
  assert.ok(pos.left >= 0, `left 不能是负数（实得 ${pos.left}）`);
  assert.ok(pos.top >= 0, `top 不能是负数（实得 ${pos.top}）`);
  assert.equal(pos.left, panel.left + MENU_MARGIN);
  assert.equal(pos.top, panel.top + MENU_MARGIN);
});

test("clampMenuPosition：按条目数换高度（目录菜单 3 项更矮，可以留在卡片下方）", () => {
  const dirMenu = menuSizeFor(3); // 120 × 82
  // 按钮 732..760（面板 640..866）：3 项菜单下方放得下（760+2+82=844 ≤ 862），
  // 5 项放不下（760+2+134=896 > 862）→ 改到卡片右侧。
  const btn = { left: 300, top: 700, right: 328, bottom: 728 };
  const anchor = { left: 272, top: 700, right: 382, bottom: 760 };
  const dirPos = clampMenuPosition({ btn, anchor, menu: dirMenu, panel: PANEL });
  assert.equal(dirPos.placement, "below");
  assert.equal(dirPos.top, 760 + MENU_GAP, "3 项菜单在卡片下方放得下");
  const filePos = clampMenuPosition({ btn, anchor, menu: MENU, panel: PANEL });
  assert.notEqual(filePos.placement, "below", "5 项菜单不能再贴在下方");
  assert.equal(filePos.placement, "side");
  assert.equal(filePos.left, anchor.right + MENU_GAP, "改到卡片右侧，不遮锚点行");
  assert.ok(filePos.top >= PANEL.top && filePos.top + MENU.height <= PANEL.bottom);
});

test("clampMenuPosition：缺参数不抛异常，回落到 0,0", () => {
  assert.deepEqual(clampMenuPosition(), { left: 0, top: 0, placement: "fit" });
  assert.deepEqual(clampMenuPosition({}), { left: 0, top: 0, placement: "fit" });
  assert.deepEqual(
    clampMenuPosition({ btn: { left: 1, top: 2 }, panel: PANEL }),
    { left: 0, top: 0, placement: "fit" },
  );
});

test("clampMenuPosition：给了 anchor（整张卡片）时垂直按卡片算，不压住自己这一行的名字", () => {
  // 卡片 700..774，⋯ 按钮在 700..728（右上角）。菜单 134px 高。
  const btn = { left: 300, top: 650, right: 328, bottom: 678 };
  const anchor = { left: 272, top: 650, right: 382, bottom: 724 };
  const below = clampMenuPosition({ btn, anchor, menu: MENU, panel: PANEL });
  assert.equal(below.placement, "below");
  assert.equal(below.top, anchor.bottom + MENU_GAP, "贴在整张卡片下方，而不是按钮下方");
  assert.equal(below.left, 300, "水平仍然对齐 ⋯");
  // 同一组参数不传 anchor 时贴在按钮下方（旧行为）—— 两者不同，证明确实读了 anchor。
  const withoutAnchor = clampMenuPosition({ btn, menu: MENU, panel: PANEL });
  assert.equal(withoutAnchor.top, btn.bottom + MENU_GAP);
  assert.ok(below.top > withoutAnchor.top);
});

test("clampMenuPosition：anchor 在上方翻转时也用卡片顶边，不压住自己这一行", () => {
  const anchor = { left: 272, top: 780, right: 382, bottom: 854 };
  const btn = { left: 300, top: 780, right: 328, bottom: 808 };
  const pos = clampMenuPosition({ btn, anchor, menu: MENU, panel: PANEL });
  assert.equal(pos.placement, "above");
  assert.equal(pos.top, anchor.top - MENU.height - MENU_GAP);
  assert.ok(pos.top + MENU.height <= anchor.top, "菜单底边在卡片顶边之上");
});

test("clampMenuPosition：placement 反映真实几何关系（above / below / side / fit）", () => {
  const seen = new Set();
  // 高面板：上下都放得下（below / above 都会出现）。
  const tall = { left: 0, top: 0, right: 800, bottom: 600 };
  for (const top of [10, 100, 300, 460]) {
    const anchor = { left: 100, top, right: 210, bottom: top + 74 };
    const btn = { left: 180, top, right: 208, bottom: top + 28 };
    const pos = clampMenuPosition({ btn, anchor, menu: MENU, panel: tall });
    seen.add(pos.placement);
    assert.ok(pos.top >= tall.top && pos.top + MENU.height <= tall.bottom + 0.001, "永不出面板");
    if (pos.placement === "below") assert.ok(pos.top >= anchor.bottom, `below 应在锚点下方：${pos.top} vs ${anchor.bottom}`);
    if (pos.placement === "above") assert.ok(pos.top + MENU.height <= anchor.top, `above 应在锚点上方：${pos.top + MENU.height} vs ${anchor.top}`);
  }
  assert.ok(seen.has("below"), "至少要出现一次 below");
  assert.ok(seen.has("above"), "至少要出现一次 above");

  // 矮面板：上下都放不下 → side（左右放不平），菜单与锚点行在水平方向错开。
  const short = { left: 0, top: 0, right: 800, bottom: 200 };
  const anchor = { left: 100, top: 60, right: 210, bottom: 134 };
  const btn = { left: 180, top: 60, right: 208, bottom: 88 };
  const side = clampMenuPosition({ btn, anchor, menu: MENU, panel: short });
  assert.equal(side.placement, "side");
  assert.ok(side.top >= short.top && side.top + MENU.height <= short.bottom + 0.001);
  assert.ok(side.left >= anchor.right || side.left + MENU.width <= anchor.left, "side 不能在锚点行上方");

  // 面板比菜单还小：fit（仍在面板内）。
  const tiny = { left: 0, top: 0, right: 100, bottom: 100 };
  const fit = clampMenuPosition({ btn: { left: 20, top: 20, right: 48, bottom: 48 }, menu: MENU, panel: tiny });
  assert.equal(fit.placement, "fit");
  assert.equal(fit.left, tiny.left + MENU_MARGIN);
  assert.equal(fit.top, tiny.top + MENU_MARGIN);
});

test("clampMenuPosition：接受 DOMRect 风格的 {left,top,width,height}（无 right/bottom）", () => {
  const btn = { left: 300, top: 650, width: 28, height: 28 };
  const panel = { left: 48, top: 640, width: 1384, height: 226 };
  const pos = clampMenuPosition({ btn, menu: MENU, panel });
  assert.equal(pos.left, 300);
  assert.equal(pos.top, 678 + MENU_GAP);
});
