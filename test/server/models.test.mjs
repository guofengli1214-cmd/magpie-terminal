// GET /api/models 的行为锁（TASK-V2-A §2.3 / D6 / D7 / D8）。
//
// 全部用假网关（test/fixtures/fake-gateway-500.mjs）或本地内联 stub，
// 不打真实 3425：真实网关的可用性不该让单元测试变红。
// 「网关不可达 → 200 + reachable:false + models:[]」这条走真实端口占用/关闭的
// stub（fake-gateway-500 本身就是 http server，先用它拿一个端口，再关掉）。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { startServer } from "../../src/server/http.mjs";
import { startFakeGateway500 } from "../fixtures/fake-gateway-500.mjs";
import {
  MODEL_FAILURE_TTL_MS,
  clearModelFailure,
  modelFailuresSnapshot,
  rememberModelFailure,
  resetModelFailures,
} from "../../src/ai/gateway.mjs";

const ENV_URL = "MAGPIE_TERMINAL_GATEWAY_URL";

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

/** 起一个返回固定 JSON 的假 /v1/models 网关。 */
function startModelsGateway(models) {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      const body = JSON.stringify({ data: models });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    const body = JSON.stringify({ error: { message: "not found" } });
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

const MODELS = [
  {
    id: "commandcode/deepseek/deepseek-v4.1-flash",
    magpie_label: "DeepSeek V4.1 Flash (latest) · Command Code",
    context_length: 1000000,
  },
  { id: "anyrouter/claude-fable-5-2", magpie_label: "", context_length: 1000000 },
];

async function withEnv(url, fn) {
  const previous = process.env[ENV_URL];
  process.env[ENV_URL] = url;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[ENV_URL];
    else process.env[ENV_URL] = previous;
  }
}

async function withServer(fn) {
  const port = await freePort();
  const handle = await startServer({ port, log: () => {} });
  try {
    return await fn({ port, handle });
  } finally {
    await handle.close();
  }
}

function authHeaders(handle) {
  return { "x-magpie-term-token": handle.token };
}

test("/api/models 未带 token → 403（与 /api/health 同一道门）", async () => {
  const gateway = await startModelsGateway(MODELS);
  try {
    await withEnv(`http://127.0.0.1:${gateway.port}`, () =>
      withServer(async ({ port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/models`);
        assert.equal(response.status, 403);
      }),
    );
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
  }
});

test("/api/models 带 token → 200，label 取 magpie_label，缺省回落 id", async () => {
  const gateway = await startModelsGateway(MODELS);
  try {
    await withEnv(`http://127.0.0.1:${gateway.port}`, () =>
      withServer(async ({ port, handle }) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/models`, {
          headers: authHeaders(handle),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.gateway.reachable, true);
        assert.equal(typeof body.gateway.durationMs, "number");
        assert.equal(body.gateway.baseUrl, `http://127.0.0.1:${gateway.port}`);
        assert.equal(body.models.length, 2);
        assert.deepEqual(
          body.models.map((m) => m.id),
          MODELS.map((m) => m.id),
        );
        assert.equal(body.models[0].label, MODELS[0].magpie_label);
        // magpie_label 为空 → 回落 id
        assert.equal(body.models[1].label, MODELS[1].id);
        assert.equal(body.models[0].contextLength, 1000000);
        assert.equal(body.models[0].available, true);
        assert.equal(body.models[0].note, null);
        // default 必须是清单内的 id
        assert.ok(body.models.some((m) => m.id === body.default));
      }),
    );
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
  }
});

test("/api/models 网关 502 → 仍返回 200 + reachable:false + models:[] + default", async () => {
  const gateway = await startFakeGateway500(0);
  try {
    await withEnv(`http://127.0.0.1:${gateway.port}`, () =>
      withServer(async ({ port, handle }) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/models`, {
          headers: authHeaders(handle),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.gateway.reachable, false);
        assert.deepEqual(body.models, []);
        assert.equal(typeof body.default, "string");
        assert.ok(body.default.length > 0, "网关不可达时 default 也必须给出，下拉不能空白");
      }),
    );
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
  }
});

test("/api/models 网关连不上（端口关闭）→ 同样 200 + reachable:false", async () => {
  const gateway = await startFakeGateway500(0);
  const port = gateway.port;
  await new Promise((resolve) => gateway.server.close(resolve));
  await withEnv(`http://127.0.0.1:${port}`, () =>
    withServer(async ({ port: appPortNumber, handle }) => {
      const response = await fetch(`http://127.0.0.1:${appPortNumber}/api/models`, {
        headers: authHeaders(handle),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.gateway.reachable, false);
      assert.deepEqual(body.models, []);
    }),
  );
});

test("失败记忆：GATEWAY_HTTP_502 记一笔 → available:false + note；成功一次即清除", async () => {
  resetModelFailures();
  const modelId = "anyrouter/claude-fable-5-2";
  rememberModelFailure(modelId, { code: "GATEWAY_HTTP_502", userText: "网关返回 HTTP 502" });
  const snapshot = modelFailuresSnapshot();
  assert.ok(snapshot.has(modelId));
  assert.match(snapshot.get(modelId).note, /502/);

  const gateway = await startModelsGateway(MODELS);
  try {
    await withEnv(`http://127.0.0.1:${gateway.port}`, () =>
      withServer(async ({ port, handle }) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/models`, {
          headers: authHeaders(handle),
        });
        const body = await response.json();
        const failed = body.models.find((m) => m.id === modelId);
        assert.equal(failed.available, false);
        assert.ok(failed.note && failed.note.length > 0);
        const healthy = body.models.find((m) => m.id !== modelId);
        assert.equal(healthy.available, true);
      }),
    );
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
  }

  clearModelFailure(modelId);
  assert.equal(modelFailuresSnapshot().has(modelId), false);
});

test("失败记忆：不在三种错误码内的错误不记（例如 GATEWAY_TIMEOUT）", () => {
  resetModelFailures();
  rememberModelFailure("m/timeout", { code: "GATEWAY_TIMEOUT", userText: "超时" });
  rememberModelFailure("m/unreachable", { code: "GATEWAY_UNREACHABLE", userText: "连不上" });
  assert.equal(modelFailuresSnapshot().size, 0);
  rememberModelFailure("m/404", { code: "GATEWAY_HTTP_404", userText: "404" });
  rememberModelFailure("m/502", { code: "GATEWAY_HTTP_502", userText: "502" });
  rememberModelFailure("m/badjson", { code: "GATEWAY_BAD_JSON", userText: "坏 JSON" });
  assert.equal(modelFailuresSnapshot().size, 3);
  resetModelFailures();
});

test("失败记忆 TTL 是 10 分钟（常量锁）", () => {
  assert.equal(MODEL_FAILURE_TTL_MS, 10 * 60 * 1000);
});

test("GET /api/config 文件不存在 → 返回默认值（不抛错）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-cfg-"));
  const file = path.join(dir, "config.json");
  const previous = process.env.MAGPIE_TERMINAL_CONFIG_PATH;
  process.env.MAGPIE_TERMINAL_CONFIG_PATH = file;
  try {
    await withServer(async ({ port, handle }) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: authHeaders(handle) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(typeof body.model, "string");
      assert.ok(body.model.length > 0);
    });
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_TERMINAL_CONFIG_PATH;
    else process.env.MAGPIE_TERMINAL_CONFIG_PATH = previous;
  }
});

test("PUT /api/config 未带 token → 403", async () => {
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });
    assert.equal(response.status, 403);
  });
});

test("PUT /api/config 不在清单里的 model → 400 INVALID_MODEL", async () => {
  const gateway = await startModelsGateway(MODELS);
  try {
    await withEnv(`http://127.0.0.1:${gateway.port}`, () =>
      withServer(async ({ port, handle }) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
          method: "PUT",
          headers: { ...authHeaders(handle), "content-type": "application/json" },
          body: JSON.stringify({ model: "nope/nope" }),
        });
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.code, "INVALID_MODEL");
      }),
    );
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
  }
});

test("PUT /api/config 未知字段 → 400 UNKNOWN_FIELD", async () => {
  const gateway = await startModelsGateway(MODELS);
  try {
    await withEnv(`http://127.0.0.1:${gateway.port}`, () =>
      withServer(async ({ port, handle }) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
          method: "PUT",
          headers: { ...authHeaders(handle), "content-type": "application/json" },
          body: JSON.stringify({ modle: "typo" }),
        });
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.code, "UNKNOWN_FIELD");
      }),
    );
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
  }
});
