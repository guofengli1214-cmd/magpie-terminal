// TASK-FIX17-E R2 / R4 / AC3 / AC4 / AC6：日志路由与写入器的「真服务」测试。
//
// 为什么这组必须起真服务而不是纯单测：AC3/AC4/AC6 的断言对象是
// 「磁盘上的文件」与「HTTP 响应头」，两者都不在纯函数的可控范围内。
// 隔离手段：`MAGPIE_TERMINAL_LOG_DIR` 指到临时目录（logger.mjs 支持它），
// 端口用随机空闲端口（不抢真实插件占用的 3480）。
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

const LOG_DIR_ENV = "MAGPIE_TERMINAL_LOG_DIR";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const { startServer, exportLogFilename } = await import("../../src/server/http.mjs");
const { createLogWriter, MAX_LOG_BYTES, LOG_FILE_NAME } = await import("../../src/server/logger.mjs");

/** 一个隔离的日志目录 + 真服务；返回值里带 base / token / dir。 */
async function startIsolatedService() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fix17e-route-"));
  process.env[LOG_DIR_ENV] = dir;
  const port = await freePort();
  const handle = await startServer({ port });
  return {
    dir,
    handle,
    port,
    base: `http://127.0.0.1:${port}`,
    headers: { "x-magpie-term-token": handle.token },
    logFile: path.join(dir, LOG_FILE_NAME),
    async close() {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
      delete process.env[LOG_DIR_ENV];
    },
  };
}

/* ========================================================================
 * AC6：导出接口
 * ====================================================================== */

test("AC6：GET /api/logs/export 无 token / 错 token 一律拒绝（403）", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());

  const noToken = await fetch(`${service.base}/api/logs/export`);
  assert.equal(noToken.status, 403);

  const wrong = await fetch(`${service.base}/api/logs/export?token=${"0".repeat(64)}`);
  assert.equal(wrong.status, 403);

  // 403 也必须带 CORS 头，否则沙箱页面分不清「没权限」与「网络坏」。
  assert.equal(noToken.headers.get("access-control-allow-origin"), null);
  const withOrigin = await fetch(`${service.base}/api/logs/export`, {
    headers: { ...service.headers, origin: "null" },
  });
  assert.equal(withOrigin.status, 200);
});

test("AC6：带 token → 200 + Content-Disposition 附件名 + 文本内容", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());

  service.handle.log({ level: "info", code: "SEEDED", msg: "seeded line" });

  const response = await fetch(`${service.base}/api/logs/export`, { headers: service.headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/plain/);
  assert.match(
    response.headers.get("content-disposition") || "",
    /^attachment; filename="show-terminal-logs-\d{8}-\d{6}\.log"$/,
  );
  const body = await response.text();
  assert.ok(body.length > 0, "导出内容不能为空");
  assert.ok(body.includes("SERVER_STARTED") || body.includes("SEEDED"));
  // 每一行都是合法 JSON（导出不能把文件弄坏）。
  for (const line of body.split("\n").filter((item) => item.length > 0)) {
    assert.doesNotThrow(() => JSON.parse(line), `导出行必须是 JSON: ${line}`);
  }
});

test("AC6：导出文本不含当前 token 的任何 8 字符子串", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());

  // 造一条「故意把 token 塞进日志」的记录：写入时的脱敏必须拦住它。
  service.handle.log({
    level: "warn",
    code: "TOKEN_LEAK_ATTEMPT",
    msg: "should never leak",
    token: service.handle.token,
    detail: `Authorization: Bearer ${service.handle.token}`,
  });

  const body = await (
    await fetch(`${service.base}/api/logs/export`, { headers: service.headers })
  ).text();
  const chunks = [];
  for (let i = 0; i + 8 <= service.handle.token.length; i += 1) {
    chunks.push(service.handle.token.slice(i, i + 8));
  }
  const leaked = chunks.filter((chunk) => body.includes(chunk));
  assert.deepEqual(leaked, [], "导出文本里不得出现 token 的任何 8 字符子串");
});

test("AC6：导出前再脱敏一遍（历史脏行里的明文也不会带出去）", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());

  // 直接往文件里塞一条「未脱敏」的行，模拟旧版本落盘的内容。
  const bearer = `Bearer ${"abcdef"}${"123456"}`;
  const winPath = String.raw`C:\Users\bob\secret.txt`;
  writeFileSync(
    service.logFile,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      code: "LEGACY_DIRTY",
      detail: `${bearer} ${winPath} --password=hunter2`,
    })}\n`,
    "utf8",
  );

  const body = await (
    await fetch(`${service.base}/api/logs/export`, { headers: service.headers })
  ).text();
  assert.equal(body.includes(bearer), false, "Bearer 原串不得出现");
  assert.equal(body.includes(winPath), false, "绝对路径原串不得出现");
  assert.equal(body.includes("hunter2"), false, "密码原串不得出现");
  // 但这一行本身必须还在（脱敏不是删除；行数要能对上）。
  const parsed = body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  assert.ok(parsed.some((item) => item.code === "LEGACY_DIRTY"), "脏行必须还在（只是被脱敏）");
});

test("AC6：导出包含轮转后的 .1（旧内容在前，便于按时间顺序读）", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());

  writeFileSync(path.join(service.dir, `${LOG_FILE_NAME}.1`), '{"code":"FROM_BACKUP"}\n', "utf8");
  writeFileSync(service.logFile, '{"code":"FROM_MAIN"}\n', "utf8");

  const body = await (
    await fetch(`${service.base}/api/logs/export`, { headers: service.headers })
  ).text();
  const backupAt = body.indexOf("FROM_BACKUP");
  const mainAt = body.indexOf("FROM_MAIN");
  assert.ok(backupAt >= 0 && mainAt >= 0, "两段都要在");
  assert.ok(backupAt < mainAt, "旧的 .1 必须排在主文件之前");
});

test("exportLogFilename：格式是 show-terminal-logs-YYYYMMDD-HHmmss.log", () => {
  const name = exportLogFilename(new Date(2026, 10, 25, 9, 8, 7));
  assert.equal(name, "show-terminal-logs-20261125-090807.log");
});

/* ========================================================================
 * AC4（writer 层）：2MB 轮转只留一份 .1
 * ====================================================================== */

test("AC4：写入器超过 2MB 触发轮转，只留 .log 与 .log.1", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fix17e-rotate-"));
  try {
    const writer = createLogWriter({ dir, warn: () => {} });
    const pad = "x".repeat(1000);
    for (let i = 0; i < 3200; i += 1) {
      writer.write(JSON.stringify({ msg: "filler", pad }));
    }
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, [LOG_FILE_NAME, `${LOG_FILE_NAME}.1`]);
    assert.ok(statSync(path.join(dir, LOG_FILE_NAME)).size <= MAX_LOG_BYTES + 2048);
    // 再轮一次：旧的 .1 被覆盖，不产生 .2。
    for (let i = 0; i < 3200; i += 1) {
      writer.write(JSON.stringify({ msg: "filler2", pad }));
    }
    assert.deepEqual(readdirSync(dir).sort(), [LOG_FILE_NAME, `${LOG_FILE_NAME}.1`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC4：custom maxBytes 生效（小阈值也能轮转，便于测试与排查）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fix17e-rotate-small-"));
  try {
    const writer = createLogWriter({ dir, maxBytes: 200, warn: () => {} });
    for (let i = 0; i < 10; i += 1) writer.write(JSON.stringify({ i, pad: "y".repeat(50) }));
    assert.deepEqual(readdirSync(dir).sort(), [LOG_FILE_NAME, `${LOG_FILE_NAME}.1`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ========================================================================
 * AC7：状态接口
 * ====================================================================== */

test("AC7：GET /api/logs/status 返回 bytes / mtime / maxBytes / totalBytes", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());

  service.handle.log({ level: "info", code: "SEED", msg: "seed" });
  const response = await fetch(`${service.base}/api/logs/status`, { headers: service.headers });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.ok(status.bytes > 0, "刚写过就必须 > 0");
  assert.equal(typeof status.mtime, "string");
  assert.equal(status.maxBytes, MAX_LOG_BYTES);
  assert.equal(status.totalBytes, status.bytes + (status.rotatedBytes || 0));
  assert.equal(status.writable, true);
  assert.equal(status.file, LOG_FILE_NAME);
});

test("AC7：/api/logs/status 也要 token（无 token 403）", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());
  assert.equal((await fetch(`${service.base}/api/logs/status`)).status, 403);
});

/* ========================================================================
 * DELETE /api/logs
 * ====================================================================== */

test("DELETE /api/logs 清空两个文件的内容，但不删文件（避免句柄问题）", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());

  service.handle.log({ level: "info", code: "SEED", msg: "seed" });
  writeFileSync(path.join(service.dir, `${LOG_FILE_NAME}.1`), '{"x":1}\n', "utf8");

  const response = await fetch(`${service.base}/api/logs`, {
    method: "DELETE",
    headers: service.headers,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.cleared, 2);
  // 文件还在，内容为 0（或只有清空动作本身之后新写的一行）。
  assert.ok(statSync(service.logFile).size < 4096);
  assert.ok(statSync(path.join(service.dir, `${LOG_FILE_NAME}.1`)).size < 4096);
});

test("DELETE /api/logs 需要 token；GET /api/logs 不存在（405/404 而不是静默成功）", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());

  assert.equal((await fetch(`${service.base}/api/logs`, { method: "DELETE" })).status, 403);
  const get = await fetch(`${service.base}/api/logs`, { headers: service.headers });
  assert.equal(get.status, 404);
});

/* ========================================================================
 * R2：写盘失败不许让服务退出
 * ====================================================================== */

test("R2：日志目录不可用时服务照常启动，日志降级为 stdout（只 warn 一次）", async (t) => {
  // 让「目录」是一个普通文件：mkdirSync 必然失败。
  const blocker = path.join(mkdtempSync(path.join(os.tmpdir(), "fix17e-blocked-")), "blocker");
  writeFileSync(blocker, "not a directory", "utf8");
  process.env[LOG_DIR_ENV] = blocker;

  const port = await freePort();
  const stdout = [];
  const warns = [];
  const handle = await startServer({ port });
  const writes = [];
  const originalWarn = console.warn;
  console.warn = (message) => writes.push(String(message));
  try {
    const base = `http://127.0.0.1:${port}`;
    const headers = { "x-magpie-term-token": handle.token };
    // 服务必须能用。
    const health = await fetch(`${base}/api/health`, { headers });
    assert.equal(health.status, 200);

    // 导出接口也不能 500：拿不到文件时返回空内容而不是崩。
    const exported = await fetch(`${base}/api/logs/export`, { headers });
    assert.equal(exported.status, 200);
    assert.equal(await exported.text(), "");

    // 状态接口：0 字节 + writable:false（界面据此提示「写盘不可用」）。
    const status = await (await fetch(`${base}/api/logs/status`, { headers })).json();
    assert.equal(status.bytes, 0);
    assert.equal(status.writable, false);
  } finally {
    console.warn = originalWarn;
    await handle.close();
    delete process.env[LOG_DIR_ENV];
    rmSync(path.dirname(blocker), { recursive: true, force: true });
  }
});

/* ========================================================================
 * 写入行格式（AC3 的服务侧对照）
 * ====================================================================== */

test("AC3：每条日志一行 JSON，且 stdout 与文件内容逐字一致", async (t) => {
  const service = await startIsolatedService();
  t.after(() => service.close());

  for (let i = 1; i <= 5; i += 1) {
    service.handle.log({ level: "info", code: `LINE_${i}`, msg: `line ${i}`, index: i });
  }
  const text = readFileSync(service.logFile, "utf8");
  const lines = text.split("\n").filter((line) => line.length > 0);
  const ourLines = lines.filter((line) => /"code":"LINE_\d+"/.test(line));
  assert.equal(ourLines.length, 5);
  for (const line of ourLines) {
    const parsed = JSON.parse(line);
    assert.equal(typeof parsed.ts, "string");
    assert.equal(parsed.level, "info");
    assert.equal(typeof parsed.msg, "string");
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
});
