// 前端 API 封装的锁（TASK-FIX17-L1 R4）：fsSave / revealPath / logsExportToDir 的请求形状。
//
// app/core/api.js 依赖 document 读取注入的 token；这里用最小 DOM 桩（与
// test/app/api-delete.test.mjs 同一套），fetch 用 Node 内置的 Response 替换。

import test from "node:test";
import assert from "node:assert/strict";

const TOKEN_META = { getAttribute: () => "test-token" };

async function loadApi() {
  globalThis.document = { querySelector: () => TOKEN_META };
  const mod = await import("../../app/core/api.js");
  return mod.default;
}

async function withFetch(t, handler, fn) {
  const api = await loadApi();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
  });
  const result = await fn(api, calls);
  return { result, calls };
}

test("fsSave：本地 → POST /api/fs/save，body {path}，带 token", async (t) => {
  const { result, calls } = await withFetch(
    t,
    async () => new Response(JSON.stringify({ ok: true, savedPath: "C:\\dl\\a.txt", bytes: 3, name: "a.txt" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    (api) => api.fsSave(null, "C:\\work\\a.txt"),
  );
  assert.equal(calls[0].url, "/api/fs/save");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { path: "C:\\work\\a.txt" });
  assert.equal(calls[0].init.headers["x-magpie-term-token"], "test-token");
  assert.equal(result.ok, true);
  assert.equal(result.data.savedPath, "C:\\dl\\a.txt");
});

test("fsSave：远程 → POST /api/hosts/:id/fs/save（同名同形）", async (t) => {
  const { calls } = await withFetch(
    t,
    async () => new Response(JSON.stringify({ ok: true, savedPath: "C:\\dl\\a", bytes: 1, name: "a" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    (api) => api.fsSave({ hostId: "h-1" }, "/remote/a"),
  );
  assert.equal(calls[0].url, "/api/hosts/h-1/fs/save");
});

test("fsSave：200 + {ok:false, NO_DOWNLOAD_DIR} 不是错误（前端据此回落）", async (t) => {
  const { result } = await withFetch(
    t,
    async () =>
      new Response(JSON.stringify({ ok: false, code: "NO_DOWNLOAD_DIR", userText: "还没有设置下载目录" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    (api) => api.fsSave(null, "C:\\a.txt"),
  );
  assert.equal(result.ok, true, "HTTP 200 就不能翻成 ok:false");
  assert.equal(result.data.ok, false);
  assert.equal(result.data.code, "NO_DOWNLOAD_DIR");
});

test("revealPath：POST /api/fs/reveal，body {path}", async (t) => {
  const { result, calls } = await withFetch(
    t,
    async () => new Response(JSON.stringify({ ok: true, revealed: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    (api) => api.revealPath("C:\\dl\\a.txt"),
  );
  assert.equal(calls[0].url, "/api/fs/reveal");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { path: "C:\\dl\\a.txt" });
  assert.equal(result.ok, true);
});

test("revealPath：400 REVEAL_OUT_OF_SCOPE 透出 code + userText", async (t) => {
  const { result } = await withFetch(
    t,
    async () =>
      new Response(JSON.stringify({ code: "REVEAL_OUT_OF_SCOPE", userText: "只能打开下载目录里的文件或文件夹。" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    (api) => api.revealPath("C:\\Windows\\cmd.exe"),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "REVEAL_OUT_OF_SCOPE");
  assert.match(result.userText, /下载目录/);
});

test("logsExportToDir：POST /api/logs/export-to-dir，body {}", async (t) => {
  const { result, calls } = await withFetch(
    t,
    async () =>
      new Response(
        JSON.stringify({ ok: true, savedPath: "C:\\dl\\show-terminal-logs-20260101-000000.log", bytes: 12, name: "show-terminal-logs-20260101-000000.log" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    (api) => api.logsExportToDir(),
  );
  assert.equal(calls[0].url, "/api/logs/export-to-dir");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
  assert.equal(result.ok, true);
  assert.match(result.data.savedPath, /show-terminal-logs-/);
});

test("logsExportToDir：400 NO_DOWNLOAD_DIR 透出 code（设置页据此回落 blob 下载）", async (t) => {
  const { result } = await withFetch(
    t,
    async () =>
      new Response(JSON.stringify({ code: "NO_DOWNLOAD_DIR", userText: "还没有设置下载目录" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    (api) => api.logsExportToDir(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_DOWNLOAD_DIR");
});
