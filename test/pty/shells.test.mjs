// 本机 shell 枚举的行为锁（TASK-V4-F §5.6）。
//
// 这些断言直接打这台机器的真实安装状态（bash / PowerShell 5 / pwsh 7），
// 不 mock 进程调用 —— 卡片的质量基准就是「真能跑」。

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  SHELL_IDS,
  detectDefaultShell,
  detectShells,
  resetShellsCache,
  resolveShellById,
  resolveShellForRequest,
} from "../../src/pty/shells.mjs";

const shells = detectShells();
const byId = (id) => shells.find((item) => item.id === id);

test("SHELL_IDS 就是 bash / pwsh / powershell 三项", () => {
  assert.deepEqual([...SHELL_IDS], ["bash", "pwsh", "powershell"]);
});

test("detectShells() 返回三项，顺序与 SHELL_IDS 一致", () => {
  assert.equal(shells.length, 3);
  assert.deepEqual(
    shells.map((item) => item.id),
    [...SHELL_IDS],
  );
  for (const item of shells) {
    assert.equal(typeof item.name, "string");
    assert.equal(typeof item.version, "string");
    assert.equal(typeof item.path, "string");
    assert.ok(Array.isArray(item.args));
    assert.equal(typeof item.available, "boolean");
  }
});

test("bash 在这台机器上 available:true，版本与 `bash --version` 实测一致", () => {
  const bash = byId("bash");
  assert.ok(bash, "detectShells() 里没有 bash");
  assert.equal(bash.available, true, `bash 不可用（path=${JSON.stringify(bash.path)}）`);
  assert.deepEqual(bash.args, []);
  const out = execFileSync(bash.path, ["--version"], { encoding: "utf8", timeout: 5000 });
  const match = /GNU bash, version (\d+\.\d+(?:\.\d+)?)/i.exec(out);
  assert.ok(match, "读不到 bash --version 的版本号");
  assert.equal(bash.version, match[1]);
});

test("powershell（Windows PowerShell 5.1）在这台机器上可用，版本以 5.1. 开头", () => {
  const ps = byId("powershell");
  assert.equal(ps.available, true, "Windows PowerShell 5.1 不可用");
  assert.match(ps.path, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.deepEqual(ps.args, ["-NoLogo"]);
  assert.match(ps.version, /^5\.1\./);
});

test("resolveShellById 对不认识的 id 返回 null", () => {
  assert.equal(resolveShellById("nope"), null);
  assert.equal(resolveShellById("zsh"), null);
  assert.equal(resolveShellById(""), null);
  assert.equal(resolveShellById(null), null);
});

test("resolveShellById('pwsh') 的 args 含 -NoLogo（若本机装了 pwsh）", () => {
  const pwsh = byId("pwsh");
  if (!pwsh.available) {
    // 本机没装 pwsh7 时这条无法成立，但要报出来而不是静默跳过。
    assert.equal(resolveShellById("pwsh"), null);
    return;
  }
  const shell = resolveShellById("pwsh");
  assert.ok(shell);
  assert.ok(shell.args.includes("-NoLogo"));
  assert.match(shell.version, /^7\./);
});

test("resolveShellById('powershell') 返回可 spawn 的形状（含 fallback 字段）", () => {
  const shell = resolveShellById("powershell");
  assert.ok(shell);
  assert.equal(shell.id, "powershell");
  assert.match(shell.name, /PowerShell/i);
  assert.equal(shell.fallback, false);
  assert.ok(shell.path.length > 0);
});

test("resolveShellForRequest：非法 shellId → PTY_UNKNOWN_SHELL", () => {
  const result = resolveShellForRequest({ shellId: "zsh" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PTY_UNKNOWN_SHELL");
});

test("resolveShellForRequest：不带 shellId → 走自动探测（bash 优先）", () => {
  const result = resolveShellForRequest({ shellId: null, defaultShell: null });
  assert.equal(result.ok, true);
  assert.equal(result.shell.id, "bash");
});

test("resolveShellForRequest：defaultShell 生效；不可用的 defaultShell 静默回落", () => {
  const pwsh = byId("pwsh");
  const result = resolveShellForRequest({ defaultShell: pwsh.available ? "pwsh" : "bash" });
  assert.equal(result.ok, true);
  assert.equal(result.shell.id, pwsh.available ? "pwsh" : "bash");

  const fallback = resolveShellForRequest({ defaultShell: "zsh" });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.shell.id, "bash");
});

test("detectDefaultShell 复用 bridge.detectShell()：默认是 bash", () => {
  const detected = detectDefaultShell();
  assert.equal(detected.id, "bash");
  assert.match(detected.name, /bash/i);
});

test("resetShellsCache 之后仍能探测（缓存可重置）", () => {
  resetShellsCache();
  const again = detectShells();
  assert.equal(again.length, 3);
  assert.equal(again.find((item) => item.id === "bash").available, true);
});
