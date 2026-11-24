// TASK-FIX-ACCEPT A：DELETE 的 2xx 契约（客户端不能只认 204）。
//
// app/core/api.js 依赖 document 读取注入的 token；这里用最小 DOM 桩，
// 不引入 jsdom / happy-dom。fetch 也按 Node 内置的 Response 替换。
//
// 背景：文件面板的 DELETE /api/fs 返回 200 + JSON，主机/会话删除返回 204；
// 旧实现只把 204 当成功，导致文件真的删掉了却提示「HTTP 200，请重试」。
import test from "node:test";
import assert from "node:assert/strict";

const TOKEN_META = { getAttribute: () => "test-token" };

async function loadApi() {
  globalThis.document = { querySelector: () => TOKEN_META };
  const mod = await import("../../app/core/api.js");
  return mod.default;
}

test("DELETE /api/fs 的 200 + JSON 必须算删除成功", async (t) => {
  const api = await loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
  });

  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ path: "C:\\tmp\\deleted.txt", type: "file" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await api.fsDelete(null, "C:\\tmp\\deleted.txt", false);
  assert.equal(seen.init.method, "DELETE");
  assert.match(seen.url, /^\/api\/fs\?/);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { path: "C:\\tmp\\deleted.txt", type: "file" });
});

test("DELETE 的 204 仍然成功，data 为 null", async (t) => {
  const api = await loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
  });
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const result = await api.deleteHost("h-1");
  assert.equal(result.ok, true);
  assert.equal(result.data, null);
});

test("DELETE 的非 2xx 仍透出 {code,userText}", async (t) => {
  const api = await loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: "DIR_NOT_EMPTY",
        userText: "这个目录不是空的（1 项）。要连内容一起删就先勾选「递归删除」。",
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  const result = await api.fsDelete(null, "C:\\tmp\\full", false);
  assert.equal(result.ok, false);
  assert.equal(result.code, "DIR_NOT_EMPTY");
  assert.match(result.userText, /不是空的/);
});
