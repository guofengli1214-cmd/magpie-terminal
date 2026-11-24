// TASK-FIX-RECONNECT O1：状态栏 shell 文案必须是「活动会话的 shell」优先。
//
// 背景：/api/health 探测的是本机默认 shell（bash 5.2.37），但用户配置
// defaultShell=pwsh 时新会话实际跑 PowerShell 7。旧状态栏只看 health，
// 用户看到 bash 却在 PowerShell 里打字。shellLabel 是纯函数，这里逐条锁死。
import test from "node:test";
import assert from "node:assert/strict";

import { shellLabel } from "../../app/ui/status-bar.js";

function snapshot(overrides = {}) {
  return { sessions: [], activeId: null, ...overrides };
}

test("有活动会话：显示会话自己的 shell（PowerShell 7），不用 health 的 bash", () => {
  const snap = snapshot({
    sessions: [
      { id: "s-1", shell: "bash" },
      { id: "s-2", shell: "PowerShell 7" },
    ],
    activeId: "s-2",
  });
  assert.equal(shellLabel(snap, { shell: { name: "bash", version: "5.2.37" } }), "shell：PowerShell 7");
});

test("有活动会话但 shell 是空串：退回 health 的探测值", () => {
  const snap = snapshot({ sessions: [{ id: "s-1", shell: "" }], activeId: "s-1" });
  assert.equal(shellLabel(snap, { shell: { name: "bash", version: "5.2.37" } }), "shell：bash 5.2.37");
});

test("没有会话：用 health 的 {name, version}", () => {
  const snap = snapshot();
  assert.equal(shellLabel(snap, { shell: { name: "bash", version: "5.2.37" } }), "shell：bash 5.2.37");
});

test("health.fallback=true：末尾带「（回退）」", () => {
  const snap = snapshot();
  assert.equal(
    shellLabel(snap, { shell: { name: "bash", version: "5.2.37", fallback: true } }),
    "shell：bash 5.2.37（回退）",
  );
});

test("既没有活动会话也没有 health：显示未知", () => {
  assert.equal(shellLabel(snapshot(), null), "shell：未知");
});
