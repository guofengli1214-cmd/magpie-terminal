// 状态栏 shell 文案（TASK-FIX-RECONNECT O1；0.3.0 收窄到「只看活动会话」）。
//
// 背景：0.3.0 删掉了本机 PTY，`/api/health` 不再返回 `shell` 字段。
// 所以状态栏的 shell 一栏只剩一个来源：当前活动会话自己的 `shell`（服务端
// session.created 里带，远程是 `ssh user@host`）。
//   * 有活动会话且 shell 非空 → `shell：<会话 shell>`
//   * 没有活动会话 / 活动会话 shell 是空串 → `shell：未知`
// shellLabel 是纯函数，这里逐条锁死文案。
import test from "node:test";
import assert from "node:assert/strict";

import { shellLabel } from "../../app/ui/status-bar.js";

function snapshot(overrides = {}) {
  return { sessions: [], activeId: null, ...overrides };
}

test("有活动会话：显示会话自己的 shell（远程是 ssh user@host）", () => {
  const snap = snapshot({
    sessions: [
      { id: "s-1", shell: "ssh root@10.0.0.2" },
      { id: "s-2", shell: "ssh dev@build" },
    ],
    activeId: "s-2",
  });
  assert.equal(shellLabel(snap), "shell：ssh dev@build");
});

test("活动会话切换：文案跟着活动会话走，不看别的会话", () => {
  const snap = snapshot({
    sessions: [
      { id: "s-1", shell: "ssh root@10.0.0.2" },
      { id: "s-2", shell: "ssh dev@build" },
    ],
    activeId: "s-1",
  });
  assert.equal(shellLabel(snap), "shell：ssh root@10.0.0.2");
});

test("有活动会话但 shell 是空串：显示未知（不再退回 health）", () => {
  const snap = snapshot({ sessions: [{ id: "s-1", shell: "" }], activeId: "s-1" });
  assert.equal(shellLabel(snap), "shell：未知");
});

test("没有会话：显示未知", () => {
  assert.equal(shellLabel(snapshot()), "shell：未知");
});

test("既没有活动会话也没有快照：显示未知", () => {
  assert.equal(shellLabel(null), "shell：未知");
  assert.equal(shellLabel(undefined), "shell：未知");
});

test("activeId 指向不存在的会话：显示未知", () => {
  const snap = snapshot({ sessions: [{ id: "s-1", shell: "ssh dev@build" }], activeId: "s-9" });
  assert.equal(shellLabel(snap), "shell：未知");
});

test("health 不再参与文案：传进来也不会改变结果", () => {
  const snap = snapshot({ sessions: [{ id: "s-1", shell: "ssh root@10.0.0.2" }], activeId: "s-1" });
  // 第二个参数已无意义；带上一个「像老 health」的对象，文案必须一字不变。
  assert.equal(shellLabel(snap, { shell: { name: "bash", version: "5.2.37" } }), "shell：ssh root@10.0.0.2");
  assert.equal(shellLabel(snapshot(), { shell: { name: "bash", version: "5.2.37" } }), "shell：未知");
});
