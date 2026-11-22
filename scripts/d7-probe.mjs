// D7 专项检查：缺陷 A / B / D 的可重复断言。
// 用法（CLI）：node scripts/d7-probe.mjs [--port 3480] [--browser]
// 输出：逐条 JSON 行 + 结尾 summary；退出码全过 0。

import { startServer, buildCsp } from "../src/server/http.mjs";
import { sleep } from "./check-orphans.mjs";
import { probeComputedVar } from "./browser-probe.mjs";

const sleepMs = (ms) => sleep(ms);

function rawWs(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const frames = [];
    const waiters = new Set();
    const record = {
      frames,
      openedAt: 0,
      send(frame) {
        ws.send(JSON.stringify(frame));
      },
      destroy() {
        try {
          ws.close();
        } catch {
          // 忽略。
        }
      },
      waitFor(match, timeoutMs = 12000) {
        const existing = frames.find(match);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const waiter = {
            match,
            resolve: res,
            timer: setTimeout(() => {
              waiters.delete(waiter);
              rej(new Error("ws wait timeout"));
            }, timeoutMs),
          };
          waiters.add(waiter);
        });
      },
    };
    ws.addEventListener("message", (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      // 存一份带到达时刻的记录，waitFor 返回的也是这条（D7-1 要断言 <60ms）。
      const frame = { ...parsed, _at: Date.now() - record.openedAt };
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.match(parsed)) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      }
    });
    ws.addEventListener("error", () => {
      if (ws.readyState !== WebSocket.OPEN) reject(new Error("ws error before open"));
    });
    ws.addEventListener("open", () => {
      record.openedAt = Date.now();
      resolve(record);
    });
  });
}

async function health(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { "x-magpie-term-token": token },
  });
  return response.json();
}

/**
 * @param {{port?: number, browser?: boolean, browserUrl?: string, expectedVar?: string}} opts
 */
export async function runD7(opts = {}) {
  const port = opts.port || 3480;
  const results = [];
  const record = (step, ok, actual, expected) => {
    results.push({ step, ok, actual, expected });
  };

  const handle = await startServer({ port, log: () => {} });
  const base = `http://127.0.0.1:${port}`;
  const token = handle.token;

  try {
    // ---------- D7-1（1）：一条只连 WS、什么都不发的连接，不得改变 sessions ----------
    // 这条专门防「服务端自动建会话」的实现方式：/api/health 的 sessions 必须不变。
    const h0 = await health(port, token);
    record("D7-1.before.sessions", h0.sessions === 0, h0.sessions, 0);

    const quiet = await rawWs(port, token);
    await sleep(500);
    const h1 = await health(port, token);
    const autoFrames = quiet.frames.filter((f) => f.type === "session.created");
    record(
      "D7-1c.silentSocketDoesNotCreate",
      h1.sessions === h0.sessions && autoFrames.length === 0,
      { before: h0.sessions, after500ms: h1.sessions, createdFrames: autoFrames.length },
      { before: 0, after500ms: 0, createdFrames: 0 },
    );
    quiet.destroy();
    await sleep(300);

    // ---------- D7-1（1 续）：服务端只执行收到的 pty.create（由前端发起） ----------
    const creator = await rawWs(port, token);
    creator.send({ type: "pty.create", cols: 90, rows: 28 });
    const created = await creator.waitFor((f) => f.type === "session.created", 5000);
    const createdId = created.id;
    const h2 = await health(port, token);
    record(
      "D7-1a.clientCreateProducesOneSession",
      h2.sessions === 1,
      { sessions: h2.sessions, gotSessionCreated: Boolean(createdId) },
      { sessions: 1, gotSessionCreated: true },
    );

    // ---------- D7-1（2）：重连不重复建（store 非空时前端不再发 pty.create） ----------
    creator.destroy();
    await sleep(300);
    const reconnect = await rawWs(port, token);
    // 模拟前端重连：只发 pty.attach 认领已有 id，不发 pty.create。
    reconnect.send({ type: "pty.attach", id: createdId });
    const resumedOnReconnect = await reconnect.waitFor((f) => f.type === "session.resumed" && f.id === createdId, 5000);
    await sleep(300);
    const createdOnReconnect = reconnect.frames.filter((f) => f.type === "session.created");
    const h3 = await health(port, token);
    record(
      "D7-1b.noDuplicateOnReconnect",
      createdOnReconnect.length === 0 && h3.sessions === h2.sessions && resumedOnReconnect.id === createdId,
      { createdFrames: createdOnReconnect.length, sessionsBefore: h2.sessions, sessionsAfter: h3.sessions },
      { createdFrames: 0, sessionsBefore: 1, sessionsAfter: 1 },
    );

    // 清理：显式关掉这个会话，让环境回到 0。
    reconnect.send({ type: "pty.close", id: createdId });
    await sleep(400);
    reconnect.destroy();
    await sleep(300);
    const h4 = await health(port, token);
    record("D7-1.cleanup.sessions", h4.sessions === 0, h4.sessions, 0);

    // ---------- D7-2：CSP 带 style-src unsafe-inline ----------
    const pageResponse = await fetch(`${base}/?theme=dark&tokens=`, { redirect: "manual" });
    const csp = pageResponse.headers.get("content-security-policy") || "";
    record(
      "D7-2a.cspStyleUnsafeInline",
      /style-src[^;]*unsafe-inline/.test(csp),
      Boolean(/style-src[^;]*unsafe-inline/.test(csp)),
      true,
    );
    record(
      "D7-2a.cspScriptStillSelf",
      /script-src 'self'(;|$)/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp),
      !/script-src[^;]*unsafe-inline/.test(csp),
      true,
    );
    // buildCsp 也必须一致（不依赖 HTTP 响应头的手写）
    record(
      "D7-2a.buildCspMatches",
      /style-src 'self' 'unsafe-inline'/.test(buildCsp(port)),
      /style-src 'self' 'unsafe-inline'/.test(buildCsp(port)),
      true,
    );

    // 真浏览器：getComputedStyle 必须读到注入值
    if (opts.browser !== false) {
      const tokens = Buffer.from(JSON.stringify({ "--magpie-bg": opts.expectedVar || "#1e1e2e" })).toString("base64");
      const url = `${base}/?theme=dark&tokens=${encodeURIComponent(tokens)}`;
      const browserResult = await probeComputedVar({
        url,
        expected: opts.expectedVar || "#1e1e2e",
      });
      record(
        "D7-2b.browserComputedValue",
        browserResult.ok === true,
        { value: browserResult.value, skipped: browserResult.skipped || false, reason: browserResult.reason || null },
        { value: opts.expectedVar || "#1e1e2e" },
      );
      results[results.length - 1].browser = browserResult;

      // D7-1（1）的页面侧证据：真浏览器里 __termDebug().sessions.length === 1。
      record(
        "D7-1a.browserAutoTab",
        browserResult.debugAvailable === true && browserResult.sessionCount === 1,
        {
          debugAvailable: browserResult.debugAvailable === true,
          sessionCount: browserResult.sessionCount,
          xtermCount: browserResult.xtermCount,
        },
        { debugAvailable: true, sessionCount: 1 },
      );
      results[results.length - 1].browser = browserResult;
    }

    // D7-2 的真浏览器会真的打开页面（app.js 会自动建一个标签），
    // 这会留下一个会话。D7-3 要断言确定的数字，先把现存会话清干净。
    const leftovers = [...handle.sessions.sessions.keys()];
    for (const id of leftovers) handle.sessions.close(id);
    await sleep(500);

    // ---------- D7-3：断连回收与重连保留 ----------
    // 1) 建会话 → destroy → 等 12 秒 → sessions 必须回到 0
    const a = await rawWs(port, token);
    a.send({ type: "pty.create", cols: 90, rows: 28 });
    const createdA = await a.waitFor((f) => f.type === "session.created", 5000);
    const idA = createdA.id;
    const beforeDestroy = await health(port, token);
    a.destroy();
    await sleep(500);
    const afterDestroy = await health(port, token);
    await sleepMs(12000);
    const afterGrace = await health(port, token);
    record(
      "D7-3a.sessionsBuild",
      beforeDestroy.sessions === 1,
      { beforeDestroy: beforeDestroy.sessions, afterDestroy: afterDestroy.sessions, afterGrace: afterGrace.sessions },
      { beforeDestroy: 1, afterDestroy: 1, afterGrace: 0 },
    );
    record(
      "D7-3a.orphanKeptDuringGrace",
      afterDestroy.sessions === 1,
      afterDestroy.sessions,
      1,
    );
    record("D7-3a.reclaimedAfterGrace", afterGrace.sessions === 0, afterGrace.sessions, 0);

    // 2) 建会话 → destroy → 2 秒内新连接 attach → session.resumed，会话仍在
    const b = await rawWs(port, token);
    b.send({ type: "pty.create", cols: 90, rows: 28 });
    const createdB = await b.waitFor((f) => f.type === "session.created", 5000);
    const idB = createdB.id;
    const beforeB = await health(port, token);
    b.destroy();
    await sleep(1500);
    const c = await rawWs(port, token);
    c.send({ type: "pty.attach", id: idB });
    const resumed = await c.waitFor(
      (f) => f.type === "session.resumed" && f.id === idB,
      5000,
    );
    const afterResume = await health(port, token);
    record(
      "D7-3b.resumeKeepsSession",
      resumed.type === "session.resumed" &&
        typeof resumed.recentOutput === "string" &&
        resumed.pty === "native" &&
        afterResume.sessions === 1,
      {
        resumedType: resumed.type,
        pty: resumed.pty,
        recentOutputLen: typeof resumed.recentOutput === "string" ? resumed.recentOutput.length : null,
        before: beforeB.sessions,
        after: afterResume.sessions,
      },
      { resumedType: "session.resumed", pty: "native", before: 1, after: 1 },
    );

    // 3) attach 不存在的 id → pty.error / SESSION_GONE
    const bogusId = "00000000-0000-4000-8000-000000000000";
    c.send({ type: "pty.attach", id: bogusId });
    const gone = await c.waitFor(
      (f) => f.type === "pty.error" && f.id === bogusId,
      5000,
    );
    record("D7-3c.sessionGone", gone.code === "SESSION_GONE", gone.code, "SESSION_GONE");

    // 收尾：关掉 D7-3b 的会话
    c.send({ type: "pty.close", id: idB });
    await sleep(500);
    c.destroy();
    await sleep(300);
  } finally {
    await handle.close();
  }

  const failed = results.filter((r) => !r.ok);
  return { ts: new Date().toISOString(), port, passed: failed.length === 0, results };
}

const isMain = Boolean(process.argv[1]) && process.argv[1].endsWith("d7-probe.mjs");
if (isMain) {
  let port = Number(process.env.DOCTOR_PORT || 3480);
  let browser = true;
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--port") port = Number(process.argv[++i]);
    else if (process.argv[i] === "--no-browser") browser = false;
  }
  const report = await runD7({ port, browser });
  for (const result of report.results) {
    const line = {
      step: result.step,
      ok: result.ok,
      actual: result.actual,
      expected: result.expected,
    };
    console.log(JSON.stringify(line));
  }
  console.log(JSON.stringify({ summary: { passed: report.passed, total: report.results.length, failed: report.results.filter((r) => !r.ok).length } }));
  process.exit(report.passed ? 0 : 1);
}
