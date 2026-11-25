// TASK-FIX17-E2 R3：重复告警限流（makeLogger 的去重层）。
//
// 为什么必须单测：现场症状是「旧页面的 403 每秒一条，把 2MB 日志滚掉」。
// 限流靠窗口与计数，真等 60 秒会让测试又慢又脆，所以 `now` 与
// `dedupeWindowMs` 都能注入（见 makeLogger 的 JSDoc）。
//
// 五条用例对应卡片 R3：
//   ① 同键 5 连发只落 1 条；
//   ② 不同 route 各自落 1 条；
//   ③ 窗口过后再发带 suppressed 计数且计数正确；
//   ④ info 不被限流；
//   ⑤ 限流后重启（新的 logger 实例）计数从头开始。
import test from "node:test";
import assert from "node:assert/strict";

const { LOG_DEDUPE_WINDOW_MS, makeLogger } = await import("../../src/server/http.mjs");

/** 收集器：stdout 侧收到的每一行（字符串）。 */
function collector() {
  const lines = [];
  return {
    lines,
    log(line) {
      lines.push(line);
    },
    warn() {
      // 限流本身不 warn；留着以防 writer 降级路径被触发。
    },
    entries() {
      return lines.map((line) => JSON.parse(line));
    },
  };
}

/** 固定窗口 10s 的 logger + 可拨的时钟；`file: false` 不碰磁盘。 */
function makeClockLogger(windowMs = 10000) {
  const sink = collector();
  const clock = { t: 1_700_000_000_000 };
  const log = makeLogger(sink, {
    file: false,
    dedupeWindowMs: windowMs,
    now: () => clock.t,
  });
  return { sink, clock, log };
}

/** 一条典型的重复告警（形状与 http.mjs / ws.mjs 的实际调用一致）。 */
function warn(extra = {}) {
  return { level: "warn", code: "AUTH_TOKEN_MISMATCH", msg: "api forbidden", route: "GET /api/theme", ...extra };
}

test("① 同一键（level|code|route）5 连发只落 1 条", () => {
  const { sink, log } = makeClockLogger();
  for (let i = 0; i < 5; i += 1) log(warn());
  assert.equal(sink.lines.length, 1, "窗口内同键只允许第一条落盘");
  const entry = sink.entries()[0];
  assert.equal(entry.code, "AUTH_TOKEN_MISMATCH");
  assert.equal(entry.route, "GET /api/theme");
  // 第一发本身没有任何被压掉的，不该凭空多出 suppressed 字段。
  assert.equal("suppressed" in entry, false);
});

test("② 不同 route 各自落 1 条（键里必须包含 route，不能只按 code 合并）", () => {
  const { sink, log } = makeClockLogger();
  log(warn());
  log(warn({ route: "ws /ws" }));
  log(warn({ route: "GET /api/health" }));
  log(warn());
  log(warn({ route: "ws /ws" }));
  assert.equal(sink.lines.length, 3);
  assert.deepEqual(
    sink.entries().map((entry) => entry.route),
    ["GET /api/theme", "ws /ws", "GET /api/health"],
  );
});

test("③ 窗口过后再发：落一条并带上一窗口的 suppressed 计数；新窗口内继续被压", () => {
  const { sink, clock, log } = makeClockLogger(10000);
  log(warn()); // 窗口 1：落盘
  for (let i = 0; i < 4; i += 1) {
    clock.t += 10;
    log(warn()); // 窗口 1：压掉 4 条
  }
  assert.equal(sink.lines.length, 1);

  clock.t = 1_700_000_010_000; // 恰好满 10s：新窗口开始
  log(warn());
  assert.equal(sink.lines.length, 2);
  const second = sink.entries()[1];
  assert.equal(second.suppressed, 4, "suppressed 必须等于上一窗口压掉的条数");
  assert.equal(second.code, "AUTH_TOKEN_MISMATCH");

  // 新窗口内继续发：又被压掉，不落盘。
  for (let i = 0; i < 3; i += 1) {
    clock.t += 10;
    log(warn());
  }
  assert.equal(sink.lines.length, 2);

  // 再过 10s：第三条带 suppressed=3，证明计数按窗口重新开始。
  clock.t += 10000;
  log(warn());
  assert.equal(sink.lines.length, 3);
  assert.equal(sink.entries()[2].suppressed, 3);
});

test("④ info 绝不被限流（含 SERVER_STARTED），且 warn/error 的判定边界正确", () => {
  const { sink, log } = makeClockLogger();
  for (let i = 0; i < 5; i += 1) {
    log({ level: "info", code: "SERVER_STARTED", msg: "listening", port: 3480 });
  }
  for (let i = 0; i < 5; i += 1) {
    log({ level: "info", code: "PAGE_SERVED", msg: "app page served", route: "GET /" });
  }
  assert.equal(sink.lines.length, 10, "info 每一发都必须落盘");
  assert.ok(sink.entries().every((entry) => entry.level === "info"));

  // 没有字符串 code 的 warn 不是「同类告警」，不参与合并（否则会误伤自由文本）。
  for (let i = 0; i < 3; i += 1) log({ level: "warn", msg: "pty spawn failed", sessionId: `s${i}` });
  assert.equal(sink.lines.length, 13);

  // error 与 warn 是不同键：同样的 code 也要各落一条。
  log({ level: "warn", code: "SAME_CODE", msg: "w", route: "GET /x" });
  log({ level: "error", code: "SAME_CODE", msg: "e", route: "GET /x" });
  assert.equal(sink.lines.length, 15);
});

test("⑤ 限流后重启计数从头开始（新的 logger 实例没有历史窗口）", () => {
  const first = makeClockLogger();
  for (let i = 0; i < 5; i += 1) first.log(warn());
  assert.equal(first.sink.lines.length, 1);

  // 「重启」= 进程内重新 makeLogger，时钟甚至不需要前进。
  const second = makeClockLogger();
  second.log(warn());
  assert.equal(second.sink.lines.length, 1, "新实例必须立刻落第一条");
  assert.equal("suppressed" in second.sink.entries()[0], false, "新实例没有上一窗口的计数");
});

test("R3 附加：stdout 与文件两条路内容逐字一致，被限流的行两边都不落", () => {
  const sink = collector();
  const written = [];
  const writer = {
    write(line) {
      written.push(line);
      return true;
    },
  };
  const log = makeLogger(sink, {
    writer,
    dedupeWindowMs: 60000,
    now: () => 1_700_000_000_000,
  });
  for (let i = 0; i < 5; i += 1) log(warn());
  log({ level: "info", code: "SERVER_STARTED", msg: "listening", port: 3480 });

  assert.equal(sink.lines.length, 2);
  assert.equal(written.length, 2);
  assert.deepEqual(written, sink.lines, "stdout 与文件必须是同一批行（限流的行两边都没有）");
  for (const line of written) {
    assert.doesNotThrow(() => JSON.parse(line), `日志行必须是合法 JSON：${line}`);
  }
});

test("R3 附加：dedupeWindowMs <= 0 关闭限流（探针数原始条数用）", () => {
  const clock = { t: 1_700_000_000_000 };
  for (const dedupeWindowMs of [0, -1]) {
    const sink = collector();
    const log = makeLogger(sink, { file: false, dedupeWindowMs, now: () => clock.t });
    for (let i = 0; i < 5; i += 1) log(warn());
    assert.equal(
      sink.lines.filter((line) => line.includes("AUTH_TOKEN_MISMATCH")).length,
      5,
      `dedupeWindowMs=${dedupeWindowMs} 必须关闭限流`,
    );
  }
});

test("默认窗口常量是 60 秒（卡片 R3 的硬要求）", () => {
  assert.equal(LOG_DEDUPE_WINDOW_MS, 60000);
});
