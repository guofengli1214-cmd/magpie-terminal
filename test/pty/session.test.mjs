// L3 PTY 集成测试：真 TTY、基础输出、resize、退出清理。
// node-pty 加载失败时整组 skip 并打印原因（不是 fail）。

import test from "node:test";
import assert from "node:assert/strict";
import { detectShell, loadNodePty } from "../../src/pty/bridge.mjs";
import { SessionManager } from "../../src/pty/session.mjs";
import { checkOrphans, sleep } from "../../scripts/check-orphans.mjs";
import { classify } from "../../src/policy/classify.mjs";
import { askGateway, probeGateway } from "../../src/ai/gateway.mjs";
import { extractCommand } from "../../src/ai/extract.mjs";
import { buildContext } from "../../src/ai/context.mjs";
import { startFakeGateway500 } from "../fixtures/fake-gateway-500.mjs";
import { startSlowGateway } from "../fixtures/slow-gateway.mjs";

const ptyLoad = loadNodePty();
const skipReason = ptyLoad.ok ? null : `node-pty unavailable: ${ptyLoad.reason}`;

function makeManager() {
  const shell = detectShell({});
  const manager = new SessionManager({ shell, ptyLoad });
  return { manager, shell };
}

function collect(manager) {
  const chunks = [];
  manager.on("pty.output", (frame) => chunks.push(frame.data));
  return {
    read: () => chunks.join(""),
    reset: () => {
      chunks.length = 0;
    },
  };
}

/**
 * 轮询到 timeoutMs 上限，命中即返回（不留固定 sleep）。
 * 返回命中时实际耗时，便于把波动写进报告。
 *
 * @param {() => boolean} fn
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<number>} 命中耗时 ms
 */
async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    if (fn()) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    await sleep(50);
  }
}

/**
 * D9-2：resize 后连敲 10 条的用例原本用固定 12s 超时，满载时会假失败
 * （实测真实耗时波动到 7.49s）。改成「轮询到 20s 上限、命中即返回」。
 */
const BUSY_WAIT_TIMEOUT_MS = 20000;

/**
 * close() 之后必须等 ConPTY 的 onExit 真正到达，再建下一个 PTY / 结束进程。
 *
 * 为什么：Windows 上 node-pty 的 kill 是异步的（先关 pseudoconsole，再由 exit
 * watcher 回调 JS）。kill 完立刻建新 PTY 或让测试进程退出，会撞上原生 teardown，
 * 偶发 `BaseObject::decrease_refcount` 断言 + `HandleScope::CreateHandle` FATAL，
 * 整个测试文件直接消失（无 JS 报错）。真实耗时通常几十毫秒。
 *
 * @param {import("../../src/pty/session.mjs").SessionManager} manager
 * @param {{id: string}} session
 * @returns {Promise<boolean>} 是否在超时内退出
 */
async function closeAndWait(manager, session) {
  manager.close(session.id);
  return manager.whenExited(session, 5000);
}

// skip 只应在 node-pty 不可用时传；传 null 会被 node:test 当成「跳过」。
const ptyTestOptions = skipReason ? { skip: skipReason } : {};

test("pty 集成组", ptyTestOptions, async (t) => {
  await t.test("#1 真 TTY：stty size 有输出", async () => {
    const { manager } = makeManager();
    const out = collect(manager);
    const session = manager.create({ cols: 100, rows: 30 });
    assert.ok(session);
    manager.write(session.id, "echo TTY_$(stty size)\n");
    await waitFor(() => /TTY_\d+ \d+/.test(out.read()), 8000, "stty size");
    assert.match(out.read(), /TTY_\d+ \d+/);
    assert.equal(await closeAndWait(manager, session), true, "close 后 onExit 必须到达");
  });

  await t.test("#2 基础输出：echo hi 含 hi", async () => {
    const { manager } = makeManager();
    const out = collect(manager);
    const session = manager.create({ cols: 100, rows: 30 });
    manager.write(session.id, "echo hi-$((2+2))\n");
    await waitFor(() => out.read().includes("hi-4"), 8000, "echo");
    assert.ok(out.read().includes("hi-4"));
    assert.equal(await closeAndWait(manager, session), true, "close 后 onExit 必须到达");
  });

  await t.test("#4 resize：30 100 → 40 132 生效", async () => {
    const { manager } = makeManager();
    const out = collect(manager);
    const session = manager.create({ cols: 100, rows: 30 });
    manager.write(session.id, "echo SZ1_$(stty size)\n");
    await waitFor(() => /SZ1_30 100/.test(out.read()), 8000, "initial size");
    out.reset();
    manager.resize(session.id, 132, 40);
    await sleep(400);
    manager.write(session.id, "echo SZ2_$(stty size)\n");
    await waitFor(() => /SZ2_40 132/.test(out.read()), 8000, "resized size");
    assert.match(out.read(), /SZ2_40 132/);
    assert.equal(await closeAndWait(manager, session), true, "close 后 onExit 必须到达");
  });

  await t.test("#5 resize 后连敲 10 次不丢字符", async () => {
    const { manager } = makeManager();
    const out = collect(manager);
    const session = manager.create({ cols: 100, rows: 30 });
    await sleep(200);
    manager.resize(session.id, 120, 32);
    for (let i = 1; i <= 10; i += 1) manager.write(session.id, `echo R${i}-$((1+1))\n`);
    const markers = Array.from({ length: 10 }, (_v, i) => `R${i + 1}-2`);
    // 命中即返回：不等满上限，也不会因为「恰好比 12s 慢一点」假失败。
    await waitFor(() => markers.every((m) => out.read().includes(m)), BUSY_WAIT_TIMEOUT_MS, "10 markers");
    const missing = markers.filter((m) => !out.read().includes(m));
    assert.deepEqual(missing, []);
    assert.equal(await closeAndWait(manager, session), true, "close 后 onExit 必须到达");
  });

  await t.test("#6/#7 退出清理：kill 后 >1.1s pid 消失", async () => {
    const { manager } = makeManager();
    const session = manager.create({ cols: 100, rows: 30 });
    // ConPTY 的 pid 要等连接建立后才可读，这里先等它出现。
    await waitFor(() => {
      manager.pids();
      return session.pid;
    }, 15000, "session pid");
    const pid = session.pid;
    assert.ok(pid);
    assert.equal(await closeAndWait(manager, session), true, "close 后 onExit 必须到达");
    const result = await checkOrphans({ pids: [pid], names: { [pid]: "bash.exe" }, waitMs: 2500 });
    assert.deepEqual(result.orphans, []);
  });
});

test("close() 只 kill 一次：onExit 不再重复关 pseudoconsole", async () => {
  // 回归测试：close() 后 node-pty 仍会触发 onExit，handleExit() 曾经再 kill 一次。
  // Windows 上二次 ClosePseudoConsole 会诱发原生崩溃（node-pty #989）。
  let kills = 0;
  let onExitCb = null;
  const fakeHandle = {
    pid: 0,
    _isReady: true,
    onData() {},
    onExit(cb) {
      onExitCb = cb;
    },
    kill() {
      kills += 1;
    },
    write() {},
    resize() {},
  };
  const manager = new SessionManager({
    shell: detectShell({}),
    ptyLoad: { ok: true, module: { spawn: () => fakeHandle } },
  });
  const session = manager.create({ cols: 80, rows: 24 });
  assert.equal(kills, 0);

  manager.close(session.id);
  assert.equal(kills, 1, "close 必须 kill 一次");

  // 模拟 node-pty 的 exit watcher 稍后回调 handleExit。
  assert.equal(typeof onExitCb, "function", "create 必须挂 onExit");
  onExitCb({ exitCode: 0, signal: 0 });
  assert.equal(kills, 1, "onExit 之后不能再 kill 第二次");
  assert.equal(session.state, "closed");

  assert.equal(await manager.whenExited(session, 200), true, "whenExited 必须立刻返回 true");
});

test("哨兵法降级：强制 sentinel 时 ls 仍有输出，健康报 pty=sentinel", async () => {
  process.env.MAGPIE_TERMINAL_FORCE_SENTINEL = "1";
  // 强制 sentinel 后重新加载 node-pty 状态。
  const { startServer } = await import("../../src/server/http.mjs");
  const net = await import("node:net");
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
  const handle = await startServer({ port, log: () => {} });
  try {
    assert.equal(handle.mode, "sentinel");
    const response = await fetch(`http://127.0.0.1:${port}/api/health?token=${handle.token}`);
    const body = await response.json();
    assert.equal(body.pty, "sentinel");

    const session = handle.sessions.create({ cols: 80, rows: 24 });
    assert.ok(session);
    const chunks = [];
    handle.sessions.on("pty.output", (frame) => chunks.push(frame.data));
    handle.sessions.write(session.id, "echo SENTINEL-$((3+4))\n");
    await waitFor(() => chunks.join("").includes("SENTINEL-7"), 8000, "sentinel output");
    assert.ok(chunks.join("").includes("SENTINEL-7"));
    handle.sessions.close(session.id);
  } finally {
    await handle.close();
    delete process.env.MAGPIE_TERMINAL_FORCE_SENTINEL;
  }
});

test("AI 链路：extract / context 纯函数", async (t) => {
  await t.test("extract 剥 json 围栏", () => {
    const result = extractCommand('```json\n{"command":"ls -la","reason":"列目录"}\n```');
    assert.equal(result.ok, true);
    assert.equal(result.command, "ls -la");
    assert.equal(result.reason, "列目录");
  });

  await t.test("extract 从解释文字中取第一个 {...}", () => {
    const result = extractCommand('好的，建议：{"command":"pwd","reason":"看目录"} 以上。');
    assert.equal(result.ok, true);
    assert.equal(result.command, "pwd");
  });

  await t.test("extract 解析失败不抛", () => {
    const result = extractCommand("没有 JSON");
    assert.equal(result.ok, false);
    assert.equal(result.command, "");
  });

  await t.test("context 只带三个字段并截断", () => {
    const context = buildContext({
      cwd: "/tmp",
      shell: { name: "bash", version: "5.2.37" },
      recentOutput: "x".repeat(5000),
      secret: "should not appear",
    });
    assert.deepEqual(Object.keys(context).sort(), ["cwd", "recentOutput", "shell"]);
    assert.ok(context.recentOutput.length <= 2000);
    assert.equal(context.shell, "bash 5.2.37");
  });

  await t.test("ai.reply 的 command 必须过 classify（不信任模型）", () => {
    assert.equal(classify("ls -la").decision, "auto");
    assert.equal(classify("rm -rf /").decision, "confirm");
  });
});

test("AI 网关负向：fake 500 → GATEWAY_HTTP_500", async () => {
  const { server, port } = await startFakeGateway500(0);
  const previous = process.env.MAGPIE_TERMINAL_GATEWAY_URL;
  process.env.MAGPIE_TERMINAL_GATEWAY_URL = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(
      () => askGateway({ question: "看看目录", context: {} }),
      (err) => err.code === "GATEWAY_HTTP_500",
    );
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_TERMINAL_GATEWAY_URL;
    else process.env.MAGPIE_TERMINAL_GATEWAY_URL = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AI 网关负向：慢网关 → GATEWAY_TIMEOUT", async () => {
  const { server, port } = await startSlowGateway(0);
  const previousUrl = process.env.MAGPIE_TERMINAL_GATEWAY_URL;
  const previousTimeout = process.env.MAGPIE_TERMINAL_GATEWAY_TIMEOUT_MS;
  process.env.MAGPIE_TERMINAL_GATEWAY_URL = `http://127.0.0.1:${port}`;
  process.env.MAGPIE_TERMINAL_GATEWAY_TIMEOUT_MS = "600";
  try {
    await assert.rejects(
      () => askGateway({ question: "看看目录", context: {} }),
      (err) => err.code === "GATEWAY_TIMEOUT",
    );
  } finally {
    if (previousUrl === undefined) delete process.env.MAGPIE_TERMINAL_GATEWAY_URL;
    else process.env.MAGPIE_TERMINAL_GATEWAY_URL = previousUrl;
    if (previousTimeout === undefined) delete process.env.MAGPIE_TERMINAL_GATEWAY_TIMEOUT_MS;
    else process.env.MAGPIE_TERMINAL_GATEWAY_TIMEOUT_MS = previousTimeout;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AI 网关正探活（真实 3425，失败则 skip）", async (t) => {
  let result;
  try {
    result = await probeGateway();
  } catch (err) {
    t.skip(`gateway not reachable: ${err.code || err.message}`);
    return;
  }
  assert.ok(result.count > 0);
});
