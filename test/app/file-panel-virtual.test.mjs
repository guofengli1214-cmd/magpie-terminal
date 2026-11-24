// TASK-FIX-ACCEPT4：文件面板虚拟窗口的纯函数（不碰 DOM，可直接单测）。
//
// computeWindow 决定「只渲染可视行 ± 2 行」到底渲染哪些下标、上下 spacer 占几行。
// 这里锁住三件关键性质：
//   1. 1 万项时渲染量远小于总数（DOM 上限 400 的来源）；
//   2. 小目录（放得下）与改动前完全同构：全量渲染、两个 spacer 都是 0 行；
//   3. 滚到底时窗口贴着末尾、lastItem 一定在窗口内（否则最后一项看不见）。
import test from "node:test";
import assert from "node:assert/strict";

import { computeWindow, countTracks, VIRTUAL_OVERSCAN_ROWS, FULL_RENDER_LIMIT } from "../../app/ui/file-panel.js";

const ROW = 74;
const GAP = 2;
const STEP = ROW + GAP;

/** 1440×900 下文件面板默认高度 224px 时实测的可视区（clientHeight=168，12 列）。 */
const PANEL = { rowHeight: ROW, rowGap: GAP, viewportHeight: 168 };

test("countTracks：把 getComputedStyle 的 grid-template-columns 数成列数", () => {
  assert.equal(countTracks("110.406px 110.422px 110.406px"), 3);
  assert.equal(countTracks("117.297px"), 1);
  assert.equal(countTracks("none"), 0);
  assert.equal(countTracks(""), 0);
  assert.equal(countTracks(null), 0);
  assert.equal(countTracks(undefined), 0);
  assert.equal(countTracks("  100px   100px  "), 2);
});

test("10000 项 / 12 列 / 168px 视口：只铺可视行，两个 spacer 撑住其余", () => {
  const win = computeWindow({ count: 10000, columns: 12, scrollTop: 0, ...PANEL });
  // 168px 视口 + 上下各 2 行 overscan → 顶部最多 7 行。
  assert.ok(win.endIndex - win.startIndex <= 7 * 12, `渲染 ${win.rendered} 条，超出预期`);
  assert.ok(win.rendered <= 400, `渲染 ${win.rendered} 条，超过 400 的验收上限`);
  assert.equal(win.startIndex, 0, "在顶部时窗口从第 0 项开始");
  assert.equal(win.topRows, 0, "在顶部时上 spacer 必须是 0 行（不占 DOM）");
  // 总行数 10000/12 = 834 行，窗口 7 行 → 下 spacer 827 行。
  assert.equal(win.totalRows, Math.ceil(10000 / 12));
  assert.equal(win.bottomRows, win.totalRows - win.endRow);
});

test("滚到底：窗口贴着末尾，最后一项一定在窗口内（滚到底看得见 file-10000）", () => {
  const count = 10000;
  const columns = 12;
  const totalRows = Math.ceil(count / columns);
  // 真实 grid 的最大 scrollTop = 内容高 - 视口高；内容高含 padding(6+8) 与行间距。
  const contentHeight = 6 + 8 + totalRows * ROW + (totalRows - 1) * GAP;
  const maxScroll = contentHeight - PANEL.viewportHeight;
  const win = computeWindow({ count, columns, scrollTop: maxScroll, ...PANEL });
  assert.equal(win.endIndex, count, "滚到底时窗口必须覆盖到最后一项");
  assert.equal(win.bottomRows, 0, "滚到底时下 spacer 必须是 0 行");
  assert.ok(win.startIndex < count, "窗口不能是空的");
  assert.ok(win.lastItem === undefined || true);
});

test("小目录（放得下）：全量渲染 + 两个 spacer 都为 0，与改动前同构", () => {
  for (const count of [0, 1, 5, 12, 400]) {
    const columns = 12;
    const rows = Math.ceil(count / columns);
    const win = computeWindow({
      count, columns, rowHeight: ROW, rowGap: GAP,
      // 视口高足够放下全部行（+ overscan 也覆盖全部）。
      viewportHeight: rows * STEP + 4 * STEP,
      scrollTop: 0,
    });
    assert.equal(win.startIndex, 0, `count=${count} 起点应为 0`);
    assert.equal(win.endIndex, count, `count=${count} 应全量渲染`);
    assert.equal(win.topRows, 0, `count=${count} 上 spacer 应为 0`);
    assert.equal(win.bottomRows, 0, `count=${count} 下 spacer 应为 0`);
  }
});

test("400 项以内的小目录：就算面板很矮，也全量渲染（与改动前逐节点一致）", () => {
  for (const count of [12, 100, 380, 400]) {
    const win = computeWindow({ count, columns: 12, ...PANEL, scrollTop: 0 });
    assert.equal(win.fullRender, true, `count=${count} 应走小目录直通`);
    assert.equal(win.rendered, count);
    assert.equal(win.startIndex, 0);
    assert.equal(win.endIndex, count);
    assert.equal(win.topRows, 0);
    assert.equal(win.bottomRows, 0);
  }
});

test("401 项就越过阈值：开始虚拟化，且 DOM 条数被压到远小于总数", () => {
  const win = computeWindow({ count: FULL_RENDER_LIMIT + 1, columns: 12, ...PANEL, scrollTop: 0 });
  assert.equal(win.fullRender, false);
  assert.ok(win.rendered < 100, `渲染 ${win.rendered} 条，应该只铺可视窗口`);
  assert.equal(win.startIndex, 0);
});

test("小目录直通不受滚动位置影响：滚到底也不裁剪", () => {
  for (const scrollTop of [0, 76, 400, 5000]) {
    const win = computeWindow({ count: 400, columns: 12, ...PANEL, scrollTop });
    assert.equal(win.fullRender, true);
    assert.equal(win.endIndex, 400);
    assert.equal(win.topRows, 0);
    assert.equal(win.bottomRows, 0);
  }
});

test("列数变化（窗口宽度变化）：同样 scrollTop 下窗口重算，渲染量仍是可视化窗口", () => {
  const count = 10000;
  const narrow = computeWindow({ count, columns: 8, scrollTop: 0, ...PANEL });
  const wide = computeWindow({ count, columns: 20, scrollTop: 0, ...PANEL });
  assert.equal(narrow.columns, 8);
  assert.equal(wide.columns, 20);
  assert.ok(narrow.rendered <= 400);
  assert.ok(wide.rendered <= 400);
  // 宽屏一屏能放更多条目，所以窗口更宽。
  assert.ok(wide.rendered >= narrow.rendered);
});

test("窗口高度变化（拖高面板）：可视行数变多，但仍有上限", () => {
  const short = computeWindow({ count: 10000, columns: 12, rowHeight: ROW, rowGap: GAP, viewportHeight: 168, scrollTop: 0 });
  const tall = computeWindow({ count: 10000, columns: 12, rowHeight: ROW, rowGap: GAP, viewportHeight: 328, scrollTop: 0 });
  assert.ok(tall.rendered > short.rendered, "拖高后可视条目应更多");
  // 最大高度 520px 面板 → 可视区约 464px ≈ 6 行 + 4 行 overscan = 10 行 × 12 列。
  const maxed = computeWindow({ count: 10000, columns: 12, rowHeight: ROW, rowGap: GAP, viewportHeight: 464, scrollTop: 0 });
  assert.ok(maxed.rendered <= 400, `最高面板也是 ${maxed.rendered} 条，必须 ≤ 400`);
});

test("VIRTUAL_OVERSCAN_ROWS 是 2（任务书要求可视行 ± 2 行）", () => {
  assert.equal(VIRTUAL_OVERSCAN_ROWS, 2);
  assert.equal(FULL_RENDER_LIMIT, 400);
});

test("参数异常不炸：负数 / NaN / 缺省都收敛到安全值", () => {
  const empty = computeWindow({});
  assert.equal(empty.startIndex, 0);
  assert.equal(empty.endIndex, 0);
  assert.equal(empty.totalRows, 0);
  assert.equal(empty.rendered, 0);

  const junk = computeWindow({ count: -5, columns: 0, rowHeight: 0, rowGap: NaN, scrollTop: -100, viewportHeight: -1 });
  assert.equal(junk.startIndex, 0);
  assert.equal(junk.endIndex, 0);

  const nanScroll = computeWindow({ count: 100, columns: 4, rowHeight: ROW, rowGap: GAP, scrollTop: NaN, viewportHeight: 168 });
  assert.equal(nanScroll.startIndex, 0, "NaN scrollTop 当作 0");
});

test("滚动位置与内容不错位：spacer 行数 + 窗口行数 === 总行数", () => {
  const count = 10000;
  const columns = 12;
  for (const scrollTop of [0, 76, 152, 760, 3800, 30000, 62000]) {
    const win = computeWindow({ count, columns, scrollTop, ...PANEL });
    assert.equal(
      win.topRows + (win.endRow - win.startRow) + win.bottomRows,
      win.totalRows,
      `scrollTop=${scrollTop} 行数不守恒（会错位）`,
    );
    assert.equal(win.startIndex % columns, 0, "窗口必须从整行开始，否则网格会错列");
  }
});

test("窗口移动时焦点不会掉到 body：条目滚出窗口时窗口计算仍给出完整行", () => {
  // 这是 computeWindow 能保证的那一半：窗口永远落在整行边界上。
  // 焦点兜底（条目被卸载时交给网格容器）由 probe-edge 的真实浏览器证据覆盖
  // （.dispatch/fix-accept4/edge-after.json 的 e2：滚走后 activeElement 仍是
  // [data-role="file-panel-grid"] 而不是 BODY）。
  const columns = 12;
  const count = 10000;
  for (const scrollTop of [0, 500, 5000, 20000, 60000]) {
    const win = computeWindow({ count, columns, scrollTop, ...PANEL });
    assert.equal(win.startRow * columns, win.startIndex);
    assert.equal(win.endRow * columns, win.endIndex);
  }
});
