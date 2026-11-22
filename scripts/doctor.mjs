// 端到端自检：直接 import startServer（拿进程内 token），跑 D3 八步。
// 退出码：全过 0，任一失败 1。断言实测值落盘 doctor-report.json，控制台只打摘要。

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startServer } from "../src/server/http.mjs";
import { checkOrphans, readProcessTable, sleep } from "./check-orphans.mjs";
import { runD7 } from "./d7-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(HERE, "..", "doctor-report.json");

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assertContains(output, needle, label) {
  if (typeof output !== "string" || !output.includes(needle)) {
    throw new AssertionError(
      `${label || "assertContains"} failed: expected ${JSON.stringify(needle)} in output` +
        ` (got ${output ? JSON.stringify(output.slice(-400)) : "<empty>"})`,
    );
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new AssertionError(`${label || "assertEqual"} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertTrue(value, label) {
  if (!value) throw new AssertionError(`${label || "assertTrue"} failed`);
}

function quietLogger() {
  return () => {};
}

/**
 * 把服务端 handle 包装成一个 WS 客户端，收集所有帧。
 */
function connectWs(port, token) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/ws?token=${token}`;
    const ws = new WebSocket(url);
    const frames = [];
    const waiters = new Set();

    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.match(frame)) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      }
    });
    ws.addEventListener("error", (event) => {
      if (ws.readyState !== WebSocket.OPEN) reject(new Error(`ws error before open: ${event.message || "unknown"}`));
    });
    ws.addEventListener("open", () => {
      resolve({
        send(frame) {
          ws.send(JSON.stringify(frame));
        },
        close() {
          try {
            ws.close();
          } catch {
            // 忽略。
          }
        },
        frames,
        waitFor(match, timeoutMs = 8000) {
          const existing = frames.find(match);
          if (existing) return Promise.resolve(existing);
          return new Promise((resolveWaiter, rejectWaiter) => {
            const waiter = {
              match,
              resolve: resolveWaiter,
              timer: setTimeout(() => {
                waiters.delete(waiter);
                rejectWaiter(new Error("ws wait timed out"));
              }, timeoutMs),
            };
            waiters.add(waiter);
          });
        },
      });
    });
  });
}

/** 收集某个会话在一段时间内的输出。 */
function outputCollector(client) {
  let text = "";
  const onFrame = (frame) => {
    if (frame.type === "pty.output") text += frame.data;
  };
  // 直接在 frames 上做增量：记录已消费的索引。
  let cursor = client.frames.length;
  const timer = setInterval(() => {
    while (cursor < client.frames.length) {
      const frame = client.frames[cursor];
      cursor += 1;
      onFrame(frame);
    }
  }, 20);
  return {
    read() {
      while (cursor < client.frames.length) {
        const frame = client.frames[cursor];
        cursor += 1;
        onFrame(frame);
      }
      return text;
    },
    reset() {
      text = "";
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * 轮询等待：命中即返回，超时抛带 code 的错误。
 *
 * `DOCTOR_STEP_TIMEOUT_MS` 可把各步的上限整体压低（用于验证「超时会被报成
 * STEP_TIMEOUT，而不是伪装成第 8 步 orphans 失败」）。不设时用调用点的默认值。
 */
async function waitUntil(fn, timeoutMs, label) {
  const cap = Number(process.env.DOCTOR_STEP_TIMEOUT_MS);
  const limit = Number.isFinite(cap) && cap > 0 ? Math.min(timeoutMs, cap) : timeoutMs;
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > limit) {
      const err = new AssertionError(`${label} timed out after ${limit}ms`);
      // 把超时与「断言为假」区分开：调用方按 code 报 STEP_TIMEOUT。
      err.code = "STEP_TIMEOUT";
      err.step = label;
      throw err;
    }
    await sleep(50);
  }
}

/**
 * 跑完整 D3 检查。返回 {passed, assertions, pids, health, shell, nodePtyVersion}
 */
export async function runDoctor({ port = 3480, waitMs = 5000, d7 = true, d7Browser = true } = {}) {
  const assertions = [];
  const record = (step, ok, actual, expected) => {
    assertions.push({ step, ok, actual, expected });
  };

  const handle = await startServer({ port, log: quietLogger() });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-magpie-term-token": handle.token };

  const pids = [];
  let stepFailure = null;
  let aliveBeforeWait = 0;
  let firstId = null;
  let secondId = null;
  let health = null;

  try {
    // 1. /api/health
    const healthResponse = await fetch(`${base}/api/health`, { headers });
    health = await healthResponse.json();
    record("1.health.status", healthResponse.status === 200, healthResponse.status, 200);
    record("1.health.pty", health.pty === "native", health.pty, "native");
    record(
      "1.health.nodePtyVersion",
      health.nodePtyVersion === "1.2.0-beta.15",
      health.nodePtyVersion,
      "1.2.0-beta.15",
    );
    record(
      "1.health.shell",
      typeof health.shell?.name === "string" && /bash/i.test(health.shell.name),
      health.shell?.name,
      "name contains bash",
    );

    // 2. WS 连接 + session.created
    const client = await connectWs(port, handle.token);
    client.send({ type: "pty.create", cols: 90, rows: 28 });
    const created1 = await client.waitFor((f) => f.type === "session.created");
    firstId = created1.id;
    record("2.session.created", typeof firstId === "string" && firstId.length > 0, firstId, "uuid");
    const created1Frame = client.frames.find((f) => f.type === "session.created" && f.id === firstId);
    record("2.session.pty", created1Frame?.pty === "native", created1Frame?.pty, "native");
    record("2.session.cwd", typeof created1Frame?.cwd === "string", created1Frame?.cwd, "string");

    const out = outputCollector(client);

    // 3. echo M-$((1+1)) → M-2
    client.send({ type: "pty.input", id: firstId, data: "echo M-$((1+1))\n" });
    await waitUntil(() => out.read().includes("M-2"), 8000, "3 echo M-2");
    const echoOutput = out.read();
    assertContains(echoOutput, "M-2", "3.echo");
    record("3.echo.M-2", true, "M-2 present", "M-2 present");

    // 4. stty size → 初始尺寸；resize 132x40 后 → 40 132
    out.reset();
    client.send({ type: "pty.input", id: firstId, data: "echo SZ1_$(stty size)\n" });
    await waitUntil(() => /SZ1_\d+ \d+/.test(out.read()), 8000, "4 stty initial");
    const initialSize = /SZ1_(\d+ \d+)/.exec(out.read())?.[1] || "";
    record("4.stty.initial", initialSize === "28 90", initialSize, "28 90");

    out.reset();
    client.send({ type: "pty.resize", id: firstId, cols: 132, rows: 40 });
    await sleep(400);
    client.send({ type: "pty.input", id: firstId, data: "echo SZ2_$(stty size)\n" });
    await waitUntil(() => /SZ2_\d+ \d+/.test(out.read()), 8000, "4 stty resized");
    const resizedSize = /SZ2_(\d+ \d+)/.exec(out.read())?.[1] || "";
    record("4.stty.resized", resizedSize === "40 132", resizedSize, "40 132");

    // 5. resize 后立刻连发 R1..R10，10 个结果全部出现
    out.reset();
    client.send({ type: "pty.resize", id: firstId, cols: 120, rows: 30 });
    for (let i = 1; i <= 10; i += 1) {
      client.send({ type: "pty.input", id: firstId, data: `echo R${i}-$((1+1))\n` });
    }
    const expectedMarkers = Array.from({ length: 10 }, (_v, i) => `R${i + 1}-2`);
    await waitUntil(
      () => expectedMarkers.every((marker) => out.read().includes(marker)),
      12000,
      "5 warmup 10 commands",
    );
    const warmupOutput = out.read();
    const missing = expectedMarkers.filter((marker) => !warmupOutput.includes(marker));
    record("5.warmup.10of10", missing.length === 0, missing.length === 0 ? "10/10" : `missing ${missing.join(",")}`, "10/10");

    // 6. 新开第二个会话；关第一个后第二个仍可用
    out.reset();
    client.send({ type: "pty.create", cols: 90, rows: 28 });
    const created2 = await client.waitFor(
      (f) => f.type === "session.created" && f.id !== firstId,
    );
    secondId = created2.id;
    const createdCount = client.frames.filter((f) => f.type === "session.created").length;
    record("6.two.sessions", createdCount === 2, createdCount, 2);

    const firstSession = handle.sessions.get(firstId);
    const secondSession = handle.sessions.get(secondId);
    // ConPTY 的 pid 要等连接建立后才可读；没拿到 pid 的孤儿检查是空转。
    await waitUntil(
      () => {
        handle.sessions.pids();
        return Boolean(firstSession && firstSession.pid && secondSession && secondSession.pid);
      },
      15000,
      "session pids",
    );
    if (firstSession?.pid) pids.push({ pid: firstSession.pid, name: "bash.exe" });
    if (secondSession?.pid) pids.push({ pid: secondSession.pid, name: "bash.exe" });
    record("6.pids.collected", pids.length === 2, pids.map((p) => p.pid), "2 pids");

    // 关闭之前先确认这些 pid 真实存在（否则后面的孤儿检查是空转）。
    const beforeTable = await readProcessTable();
    aliveBeforeWait = pids.filter((entry) =>
      beforeTable.some(
        (row) => Number(row.ProcessId) === Number(entry.pid) && String(row.Name).toLowerCase() === entry.name.toLowerCase(),
      ),
    ).length;
    record("6.pids.alive", aliveBeforeWait === pids.length, aliveBeforeWait, pids.length);

    client.send({ type: "pty.close", id: firstId });
    await client.waitFor((f) => f.type === "pty.exit" && f.id === firstId);
    record("6.first.closed", !handle.sessions.get(firstId), !handle.sessions.get(firstId), true);

    out.reset();
    client.send({ type: "pty.input", id: secondId, data: "echo SECOND-$((1+1))\n" });
    await waitUntil(() => out.read().includes("SECOND-2"), 8000, "6 second session works");
    const secondOutput = out.read();
    assertContains(secondOutput, "SECOND-2", "6.second");
    record("6.second.works", true, "SECOND-2 present", "SECOND-2 present");

    // 7. 关掉最后一个 → pty.exit
    client.send({ type: "pty.close", id: secondId });
    const exitFrame = await client.waitFor((f) => f.type === "pty.exit" && f.id === secondId);
    record("7.pty.exit", exitFrame.type === "pty.exit", exitFrame.type, "pty.exit");
    out.stop();
    client.close();
  } catch (err) {
    // D9-3：这里以前是 finally，异常被吞掉，第 5 步 12s 超时会被伪装成第 8 步
    // orphans 失败（actual={"checked":0,...}）。现在把异常记成它自己的失败项，
    // 超时用 code: "STEP_TIMEOUT"，其余用 code: "STEP_FAILED"。
    const isTimeout =
      (err && err.code === "STEP_TIMEOUT") ||
      (err && /timed out/i.test(String(err.message || "")));
    stepFailure = {
      step: "step.failure",
      ok: false,
      actual: {
        code: isTimeout ? "STEP_TIMEOUT" : "STEP_FAILED",
        stepLabel: err && err.step ? err.step : null,
        message: err && err.message ? err.message : String(err),
        name: err && err.name ? err.name : "Error",
      },
      expected: { code: null },
    };
    assertions.push(stepFailure);
  } finally {
    // 8. 孤儿检查：等 >= waitMs 后查 pid（同时匹配进程名）。
    const names = Object.fromEntries(pids.map((entry) => [entry.pid, entry.name]));
    const orphanResult = await checkOrphans({
      pids: pids.map((entry) => entry.pid),
      names,
      waitMs,
      aliveBeforeWait,
    });
    record(
      "8.orphans",
      !stepFailure && pids.length > 0 && orphanResult.aliveBeforeWait === pids.length && orphanResult.orphans.length === 0,
      {
        // 前置步骤失败时 pids 可能为空，这里显式标注，避免读者误以为「孤儿检查失败」。
        skippedBecause: stepFailure ? stepFailure.actual.code : null,
        checked: pids.length,
        aliveBeforeWait: orphanResult.aliveBeforeWait,
        orphans: orphanResult.orphans,
      },
      { skippedBecause: null, checked: 2, aliveBeforeWait: 2, orphans: [] },
    );

    // 让服务端关闭；会话已在步骤 7 全部关闭。
    await handle.close();

    // D7 专项（缺陷 A / B / D）。它自己起一个服务实例，跑完关掉。
    let d7Report = null;
    if (d7 && !stepFailure) {
      d7Report = await runD7({ port, browser: d7Browser });
      for (const result of d7Report.results) {
        const slim = { ...result };
        delete slim.browser;
        assertions.push(slim);
      }
    }

    const failed = assertions.filter((a) => !a.ok);
    const report = {
      ts: new Date().toISOString(),
      port,
      passed: failed.length === 0,
      assertions,
      pids,
      orphans: orphanResult.orphans,
      stepFailure: stepFailure ? stepFailure.actual : null,
      d7: d7Report ? { passed: d7Report.passed, results: d7Report.results } : null,
      health,
      shell: health?.shell || null,
      nodePtyVersion: health?.nodePtyVersion || null,
    };
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.DOCTOR_PORT || 3480);
  const d7Browser = !process.argv.includes("--no-browser");
  runDoctor({ port, d7Browser })
    .then((report) => {
      const failed = report.assertions.filter((a) => !a.ok);
      console.log(`doctor: ${report.assertions.length - failed.length}/${report.assertions.length} assertions passed`);
      for (const assertion of report.assertions) {
        console.log(`  ${assertion.ok ? "PASS" : "FAIL"} ${assertion.step} actual=${JSON.stringify(assertion.actual)} expected=${JSON.stringify(assertion.expected)}`);
      }
      console.log(`report: ${REPORT_PATH}`);
      process.exit(failed.length === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error(`doctor fatal: ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    });
}
