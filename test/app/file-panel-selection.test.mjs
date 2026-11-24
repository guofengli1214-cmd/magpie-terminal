// TASK-FIX17-C R1/R2：文件面板的纯函数（多选状态机 / 定位按钮三态 / 批量移动的计划与分批）。
//
// 为什么不需要 DOM：这几个函数是「输入事件 → 输出状态」的纯映射。
// 把它们提出来单测，比在真浏览器里点来点去更能定位「Shift 区间算错了一项」这类问题。
import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCATE_STATE,
  MOVE_CHUNK_SIZE,
  applySelectionClick,
  baseNameOf,
  chunkMoves,
  locateButtonState,
  movePlan,
  pruneSelection,
  samePath,
} from "../../app/ui/file-panel.js";

const PATHS = ["C:\\w\\a.txt", "C:\\w\\b.txt", "C:\\w\\c.txt", "C:\\w\\d.txt", "C:\\w\\e.txt"];

/* ------------------------------ samePath ------------------------------ */

test("samePath：大小写 / 分隔符 / 尾斜杠都不影响判等", () => {
  assert.equal(samePath("C:\\Users\\Me", "C:\\Users\\Me"), true);
  assert.equal(samePath("c:/users/me", "C:\\Users\\Me"), true);
  assert.equal(samePath("C:\\Users\\Me\\", "C:\\Users\\Me"), true);
  assert.equal(samePath("/home/me/", "/home/me"), true);
  assert.equal(samePath("C:\\Users\\Me", "C:\\Users\\Other"), false);
  assert.equal(samePath("", ""), true, "两个空串判等（都表示「还不知道」）");
  assert.equal(samePath(null, undefined), true, "空值容忍");
  assert.equal(samePath("C:\\a", ""), false);
});

/* ------------------------------ applySelectionClick ------------------------------ */

test("applySelectionClick：普通点击 = 只选这一条，锚点跟着走", () => {
  const result = applySelectionClick({ selected: new Set(PATHS.slice(0, 2)), index: 2, paths: PATHS });
  assert.deepEqual([...result.selected], ["C:\\w\\c.txt"]);
  assert.equal(result.anchor, "C:\\w\\c.txt");
});

test("applySelectionClick：Ctrl 点击切换单项（加 / 减）", () => {
  const first = applySelectionClick({ selected: new Set(), index: 0, paths: PATHS, toggle: true });
  assert.deepEqual([...first.selected], ["C:\\w\\a.txt"]);
  assert.equal(first.anchor, "C:\\w\\a.txt");

  const second = applySelectionClick({ selected: first.selected, anchor: first.anchor, index: 2, paths: PATHS, toggle: true });
  assert.deepEqual([...second.selected].sort(), ["C:\\w\\a.txt", "C:\\w\\c.txt"]);

  const third = applySelectionClick({ selected: second.selected, anchor: second.anchor, index: 0, paths: PATHS, toggle: true });
  assert.deepEqual([...third.selected], ["C:\\w\\c.txt"], "再点已选中的 = 取消它");
});

test("applySelectionClick：AC3 的「Ctrl 点三下 = 已选 3 项」", () => {
  let selected = new Set();
  let anchor = null;
  for (const index of [0, 2, 4]) {
    const next = applySelectionClick({ selected, anchor, index, paths: PATHS, toggle: true });
    selected = next.selected;
    anchor = next.anchor;
  }
  assert.equal(selected.size, 3);
  assert.deepEqual([...selected], ["C:\\w\\a.txt", "C:\\w\\c.txt", "C:\\w\\e.txt"]);
});

test("applySelectionClick：Shift 点击 = 锚点到目标的区间（AC3 的区间选中）", () => {
  // 先普通点第 1 项（index 1）定锚点，再 Shift 点第 4 项（index 3）。
  const first = applySelectionClick({ selected: new Set(), index: 1, paths: PATHS });
  assert.equal(first.anchor, "C:\\w\\b.txt");
  const range = applySelectionClick({ selected: first.selected, anchor: first.anchor, index: 3, paths: PATHS, shift: true });
  assert.deepEqual([...range.selected].sort(), ["C:\\w\\b.txt", "C:\\w\\c.txt", "C:\\w\\d.txt"].sort());
  assert.equal(range.selected.size, 3);
  assert.equal(range.anchor, "C:\\w\\b.txt", "Shift 不改锚点（否则再 Shift 会漂移）");
});

test("applySelectionClick：Shift 反向点击（锚点在下、目标在上）也算同一区间", () => {
  const first = applySelectionClick({ selected: new Set(), index: 3, paths: PATHS });
  const range = applySelectionClick({ selected: first.selected, anchor: first.anchor, index: 1, paths: PATHS, shift: true });
  assert.deepEqual(
    [...range.selected].sort(),
    ["C:\\w\\b.txt", "C:\\w\\c.txt", "C:\\w\\d.txt"].sort(),
    "反向区间与正向区间必须是同一组",
  );
});

test("applySelectionClick：Shift 区间是加法语义（不清掉区间外的旧选择）", () => {
  const seeded = new Set(["C:\\w\\e.txt"]);
  const first = applySelectionClick({ selected: seeded, index: 0, paths: PATHS });
  assert.deepEqual([...first.selected], ["C:\\w\\a.txt"], "普通点击先清空");
  const range = applySelectionClick({
    selected: new Set(["C:\\w\\e.txt", "C:\\w\\a.txt"]),
    anchor: "C:\\w\\a.txt",
    index: 1,
    paths: PATHS,
    shift: true,
  });
  assert.deepEqual([...range.selected].sort(), ["C:\\w\\a.txt", "C:\\w\\b.txt", "C:\\w\\e.txt"].sort());
});

test("applySelectionClick：锚点已不在列表里（切过目录）→ 退化成普通点击", () => {
  const result = applySelectionClick({
    selected: new Set(["C:\\other\\x.txt"]),
    anchor: "C:\\other\\x.txt",
    index: 2,
    paths: PATHS,
    shift: true,
  });
  assert.deepEqual([...result.selected], ["C:\\w\\c.txt"]);
  assert.equal(result.anchor, "C:\\w\\c.txt");
});

test("applySelectionClick：没有锚点时的 Shift 点击 = 普通点击", () => {
  const result = applySelectionClick({ selected: new Set(), anchor: null, index: 3, paths: PATHS, shift: true });
  assert.deepEqual([...result.selected], ["C:\\w\\d.txt"]);
});

test("applySelectionClick：非法 index / 空列表不抛，选择原样返回", () => {
  for (const index of [-1, 99, Number.NaN]) {
    const result = applySelectionClick({ selected: new Set(["C:\\w\\a.txt"]), index, paths: PATHS });
    assert.deepEqual([...result.selected], ["C:\\w\\a.txt"]);
  }
  const empty = applySelectionClick({ selected: new Set(), index: 0, paths: [] });
  assert.equal(empty.selected.size, 0);
});

test("applySelectionClick：不修改传入的 Set（返回新的）", () => {
  const original = new Set(["C:\\w\\a.txt"]);
  const result = applySelectionClick({ selected: original, index: 1, paths: PATHS });
  assert.deepEqual([...original], ["C:\\w\\a.txt"], "调用方的 Set 必须原样");
  assert.notEqual(result.selected, original);
});

/* ------------------------------ pruneSelection ------------------------------ */

test("pruneSelection：只留下仍然存在的路径", () => {
  const selected = new Set(["a", "b", "c"]);
  const survivors = new Set(["b"]);
  assert.deepEqual([...pruneSelection(selected, survivors)], ["b"]);
  assert.equal(pruneSelection(selected, new Set()).size, 0);
  assert.equal(pruneSelection(new Set(), survivors).size, 0);
});

/* ------------------------------ locateButtonState ------------------------------ */

test("locateButtonState：AC2 的三态", () => {
  const noSession = locateButtonState({ termCwd: "C:\\w", path: "C:\\w", hasSession: false });
  assert.equal(noSession.state, LOCATE_STATE.NO_TERMINAL);
  assert.equal(noSession.disabled, true);
  assert.match(noSession.title, /没有终端/);

  const noCwd = locateButtonState({ termCwd: null, path: "C:\\w", hasSession: true });
  assert.equal(noCwd.state, LOCATE_STATE.NO_TERMINAL);
  assert.equal(noCwd.disabled, true);
  assert.match(noCwd.title, /还没上报目录/);

  const current = locateButtonState({ termCwd: "C:\\w", path: "c:/W/", hasSession: true });
  assert.equal(current.state, LOCATE_STATE.CURRENT);
  assert.equal(current.disabled, false, "已在此目录也不能隐藏 —— 只能弱化");
  assert.match(current.title, /已在此目录/);

  const away = locateButtonState({ termCwd: "C:\\w", path: "C:\\w\\sub", hasSession: true });
  assert.equal(away.state, LOCATE_STATE.AWAY);
  assert.equal(away.disabled, false);
  assert.match(away.title, /定位到终端所在目录/);
  assert.ok(away.title.includes("C:\\w"), "title 里要带真实目录，用户才知道会去哪");
});

test("locateButtonState：空参数不抛（面板还没绑会话）", () => {
  const view = locateButtonState();
  assert.equal(view.state, LOCATE_STATE.NO_TERMINAL);
  assert.equal(view.disabled, true);
  assert.equal(typeof view.title, "string");
});

/* ------------------------------ 批量移动的计划与分批 ------------------------------ */

test("baseNameOf：两种分隔符 + 尾斜杠", () => {
  assert.equal(baseNameOf("C:\\w\\note.txt"), "note.txt");
  assert.equal(baseNameOf("C:/w/note.txt"), "note.txt");
  assert.equal(baseNameOf("C:\\w\\dir\\"), "dir");
  assert.equal(baseNameOf("/home/me/x"), "x");
  assert.equal(baseNameOf(""), "");
  assert.equal(baseNameOf(null), "");
});

test("movePlan：每项推到目标目录下（用原文件名）", () => {
  const plan = movePlan(["C:\\w\\a.txt", "C:\\w\\dir"], "C:\\w\\sub");
  assert.deepEqual(plan, [
    { from: "C:\\w\\a.txt", to: "C:\\w\\sub\\a.txt" },
    { from: "C:\\w\\dir", to: "C:\\w\\sub\\dir" },
  ]);
  // 目标用正斜杠时结果也用正斜杠（不把两种分隔符混在一个路径里）。
  assert.deepEqual(movePlan(["C:\\w\\a.txt"], "C:/w/sub"), [{ from: "C:\\w\\a.txt", to: "C:/w/sub/a.txt" }]);
});

test("movePlan：目标 = 源目录时不产生条目（服务端会判 INVALID_PATH）", () => {
  assert.deepEqual(movePlan(["C:\\w\\a.txt"], "C:\\w"), [], "同一目录 → 没有可移动的");
  assert.deepEqual(movePlan(["C:\\w\\a.txt"], "c:/W/"), [], "大小写/分隔符差异也算同一目录");
});

test("movePlan：空目标 / 空列表 → 空计划", () => {
  assert.deepEqual(movePlan(["C:\\w\\a.txt"], ""), []);
  assert.deepEqual(movePlan(["C:\\w\\a.txt"], "   "), []);
  assert.deepEqual(movePlan([], "C:\\w\\sub"), []);
  assert.deepEqual(movePlan(null, "C:\\w\\sub"), []);
});

test("chunkMoves：按 50 项一批切开，不丢不重", () => {
  const items = Array.from({ length: 123 }, (_, i) => ({ from: `a${i}`, to: `b${i}` }));
  const chunks = chunkMoves(items);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, MOVE_CHUNK_SIZE);
  assert.equal(chunks[1].length, MOVE_CHUNK_SIZE);
  assert.equal(chunks[2].length, 23);
  const flat = chunks.flat();
  assert.equal(flat.length, items.length);
  assert.deepEqual(flat, items, "顺序不能变");
});

test("chunkMoves：边界与脏输入", () => {
  assert.deepEqual(chunkMoves([]), []);
  assert.equal(chunkMoves(Array(50).fill({ from: "a", to: "b" })).length, 1);
  assert.equal(chunkMoves(Array(51).fill({ from: "a", to: "b" })).length, 2);
  assert.equal(chunkMoves(Array(5).fill({ from: "a", to: "b" }), 2).length, 3);
  assert.deepEqual(chunkMoves(null), []);
  // chunkSize 非法时兜底成 1，不产生无限循环。
  assert.equal(chunkMoves([{ from: "a", to: "b" }], 0).length, 1);
  assert.equal(chunkMoves([{ from: "a", to: "b" }], Number.NaN).length, 1);
});
