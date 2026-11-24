// agent 四字段的往返与校验锁（TASK-V3-D §6.2 / AC4）。
//
// 两部分：
//   1. store 层（normalize / updateConfig / validateConfigPatch）——纯本地，不联网；
//   2. HTTP 层（GET/PUT /api/config）——用真 startServer + 假网关。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  ALLOWLIST_MAX_ENTRIES,
  CONFIG_PATH_ENV,
  DEFAULT_CONFIG,
  KNOWN_FIELDS,
  isValidAllowlistEntry,
  publicConfig,
  readConfig,
  updateConfig,
  validateConfigPatch,
} from "../../src/config/store.mjs";
import { startServer } from "../../src/server/http.mjs";
import { DEFAULT_MODEL } from "../../src/ai/gateway.mjs";

const ENV = CONFIG_PATH_ENV;

async function tempFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-agentcfg-"));
  return path.join(dir, "config.json");
}

async function withPath(file, fn) {
  const previous = process.env[ENV];
  process.env[ENV] = file;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

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

/** 假 /v1/models 网关：只为了「PUT model 时要验证清单」这条老路径。 */
function startModelsGateway(models) {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      const body = JSON.stringify({ data: models });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

async function withEnv(url, fn) {
  const previous = process.env.MAGPIE_TERMINAL_GATEWAY_URL;
  process.env.MAGPIE_TERMINAL_GATEWAY_URL = url;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_TERMINAL_GATEWAY_URL;
    else process.env.MAGPIE_TERMINAL_GATEWAY_URL = previous;
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

const MODELS = [{ id: "commandcode/deepseek/deepseek-v4.1-flash", magpie_label: "flash" }];

// ------------------------------------------------------------ store 层：默认值

test("DEFAULT_CONFIG 带上 agent 四字段 + defaultShell + showApprovalEffect 的默认值", () => {
  assert.equal(DEFAULT_CONFIG.autonomy, "balanced");
  assert.deepEqual(DEFAULT_CONFIG.allowlist, []);
  assert.equal(DEFAULT_CONFIG.reviewModel, null);
  assert.equal(DEFAULT_CONFIG.basePrompt, null);
  assert.equal(DEFAULT_CONFIG.defaultShell, null);
  assert.equal(DEFAULT_CONFIG.showApprovalEffect, false);
});

test("KNOWN_FIELDS 是 model + 四个 agent 字段 + defaultShell + showApprovalEffect", () => {
  assert.deepEqual([...KNOWN_FIELDS], [
    "model",
    "autonomy",
    "allowlist",
    "reviewModel",
    "basePrompt",
    "defaultShell",
    "showApprovalEffect",
  ]);
});

test("publicConfig 把缺失字段补成默认值", () => {
  const view = publicConfig({ model: "a/b" });
  assert.equal(view.model, "a/b");
  assert.equal(view.autonomy, "balanced");
  assert.deepEqual(view.allowlist, []);
  assert.equal(view.reviewModel, null);
  assert.equal(view.basePrompt, null);
  assert.equal(view.defaultShell, null);
  assert.equal(view.showApprovalEffect, false);
});

test("TASK-V4-H §6：showApprovalEffect 默认关，PUT 后 GET 一致，非法类型 400 INVALID_SHOW_EFFECT", async () => {
  const file = await tempFile();
  await withPath(file, () =>
    withServer(async ({ port, handle }) => {
      const headers = { "x-magpie-term-token": handle.token, "content-type": "application/json" };
      const before = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers })).json();
      assert.equal(before.showApprovalEffect, false, "默认必须是关");

      const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ showApprovalEffect: true }),
      });
      assert.equal(put.status, 200);
      assert.equal((await put.json()).showApprovalEffect, true);

      const after = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers })).json();
      assert.equal(after.showApprovalEffect, true);

      const bad = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ showApprovalEffect: "yes" }),
      });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).code, "INVALID_SHOW_EFFECT");
    }),
  );
});

// ------------------------------------------------------------ store 层：往返

test("updateConfig 四字段往返一致（读回来还在）", async () => {
  const file = await tempFile();
  await withPath(file, async () => {
    const saved = await updateConfig({
      autonomy: "loose",
      allowlist: [
        { pattern: "mkdir", mode: "prefix", enabled: true },
        { pattern: "npm run build", mode: "exact", enabled: false },
      ],
      reviewModel: "shuaiapi/gpt-6-luna",
      basePrompt: "你是我的私人助理。",
    });
    assert.equal(saved.autonomy, "loose");
    assert.equal(saved.allowlist.length, 2);
    assert.equal(saved.reviewModel, "shuaiapi/gpt-6-luna");
    assert.equal(saved.basePrompt, "你是我的私人助理。");

    const back = await readConfig();
    assert.deepEqual(back.config.allowlist, saved.allowlist);
    assert.equal(back.config.autonomy, "loose");
    assert.equal(back.config.reviewModel, "shuaiapi/gpt-6-luna");
    assert.equal(back.config.basePrompt, "你是我的私人助理。");

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.autonomy, "loose");
    assert.equal(raw.allowlist.length, 2);
  });
});

test("reviewModel 空串保留（= 关闭审阅，不能当 null 处理）", async () => {
  const file = await tempFile();
  await withPath(file, async () => {
    await updateConfig({ reviewModel: "" });
    const back = await readConfig();
    assert.equal(back.config.reviewModel, "");
  });
});

test("allowlist 里带多余字段的条目被裁成三字段", async () => {
  const file = await tempFile();
  await withPath(file, async () => {
    const saved = await updateConfig({
      allowlist: [{ pattern: "ls", mode: "prefix", enabled: true, note: "多余", id: "x" }],
    });
    assert.deepEqual(saved.allowlist, [{ pattern: "ls", mode: "prefix", enabled: true }]);
  });
});

// ------------------------------------------------------------ store 层：normalize 回落

test("normalize：非法 autonomy 回落 balanced（不抛错）", async () => {
  for (const autonomy of ["yolo", 123, null, undefined, {}, ["loose"]]) {
    const view = publicConfig({ autonomy });
    assert.equal(view.autonomy, "balanced", `autonomy=${JSON.stringify(autonomy)}`);
  }
});

test("normalize：allowlist 非数组 → []；非法条目被丢掉；超过 200 条被截断", () => {
  assert.deepEqual(publicConfig({ allowlist: "mkdir" }).allowlist, []);
  assert.deepEqual(publicConfig({ allowlist: null }).allowlist, []);
  const mixed = publicConfig({
    allowlist: [
      { pattern: "ls", mode: "prefix", enabled: true },
      { pattern: "", mode: "prefix", enabled: true },
      { pattern: "x", mode: "glob", enabled: true },
      { pattern: "y", mode: "exact", enabled: true },
    ],
  });
  assert.deepEqual(mixed.allowlist, [
    { pattern: "ls", mode: "prefix", enabled: true },
    { pattern: "y", mode: "exact", enabled: true },
  ]);
  const many = Array.from({ length: ALLOWLIST_MAX_ENTRIES + 50 }, (_, i) => ({
    pattern: `cmd${i}`,
    mode: "prefix",
    enabled: true,
  }));
  assert.equal(publicConfig({ allowlist: many }).allowlist.length, ALLOWLIST_MAX_ENTRIES);
});

test("normalize：reviewModel / basePrompt 类型不对或超长 → null", () => {
  assert.equal(publicConfig({ reviewModel: 123 }).reviewModel, null);
  assert.equal(publicConfig({ reviewModel: "x".repeat(201) }).reviewModel, null);
  assert.equal(publicConfig({ basePrompt: {} }).basePrompt, null);
  assert.equal(publicConfig({ basePrompt: "x".repeat(8001) }).basePrompt, null);
  // 边界值本身是合法的。
  assert.equal(publicConfig({ reviewModel: "x".repeat(200) }).reviewModel.length, 200);
  assert.equal(publicConfig({ basePrompt: "x".repeat(8000) }).basePrompt.length, 8000);
});

test("normalize：配置文件被手改坏时 readConfig 不崩（拿默认值）", async () => {
  const file = await tempFile();
  await withPath(file, async () => {
    await writeFile(
      file,
      JSON.stringify({ model: 123, autonomy: "yolo", allowlist: "x", reviewModel: 9, basePrompt: [] }),
      "utf8",
    );
    const view = publicConfig((await readConfig()).config);
    assert.equal(view.model, null);
    assert.equal(view.autonomy, "balanced");
    assert.deepEqual(view.allowlist, []);
    assert.equal(view.reviewModel, null);
    assert.equal(view.basePrompt, null);
  });
});

// ------------------------------------------------------------ store 层：校验

test("validateConfigPatch：四个非法值各返回对应错误码", () => {
  assert.equal(validateConfigPatch({ autonomy: "yolo" }).code, "INVALID_AUTONOMY");
  assert.equal(validateConfigPatch({ allowlist: "mkdir" }).code, "INVALID_ALLOWLIST");
  assert.equal(validateConfigPatch({ allowlist: [{ pattern: "", mode: "prefix", enabled: true }] }).code, "INVALID_ALLOWLIST");
  assert.equal(validateConfigPatch({ allowlist: [{ pattern: "a\nb", mode: "prefix", enabled: true }] }).code, "INVALID_ALLOWLIST");
  assert.equal(validateConfigPatch({ allowlist: [{ pattern: "a", mode: "glob", enabled: true }] }).code, "INVALID_ALLOWLIST");
  assert.equal(
    validateConfigPatch({ allowlist: Array.from({ length: 201 }, () => ({ pattern: "a", mode: "prefix", enabled: true })) }).code,
    "INVALID_ALLOWLIST",
  );
  assert.equal(validateConfigPatch({ reviewModel: 1 }).code, "INVALID_REVIEW_MODEL");
  assert.equal(validateConfigPatch({ reviewModel: "x".repeat(201) }).code, "INVALID_REVIEW_MODEL");
  assert.equal(validateConfigPatch({ basePrompt: 1 }).code, "INVALID_BASE_PROMPT");
  assert.equal(validateConfigPatch({ basePrompt: "x".repeat(8001) }).code, "INVALID_BASE_PROMPT");
});

test("validateConfigPatch：合法值返回 null", () => {
  assert.equal(
    validateConfigPatch({
      autonomy: "strict",
      allowlist: [],
      reviewModel: "",
      basePrompt: null,
    }),
    null,
  );
  assert.equal(validateConfigPatch({}), null);
  assert.equal(validateConfigPatch(null), null);
});

test("isValidAllowlistEntry 边界：pattern 1..500、mode 二选一、enabled 布尔", () => {
  assert.equal(isValidAllowlistEntry({ pattern: "a", mode: "prefix", enabled: true }), true);
  assert.equal(isValidAllowlistEntry({ pattern: "a", mode: "prefix", enabled: false }), true);
  assert.equal(isValidAllowlistEntry({ pattern: "", mode: "prefix", enabled: true }), false);
  assert.equal(isValidAllowlistEntry({ pattern: "a".repeat(500), mode: "exact", enabled: true }), true);
  assert.equal(isValidAllowlistEntry({ pattern: "a".repeat(501), mode: "exact", enabled: true }), false);
  assert.equal(isValidAllowlistEntry({ pattern: "a", mode: "prefix", enabled: "yes" }), false);
});

// ------------------------------------------------------------ HTTP 层

test("GET /api/config 返回 agent 四字段的默认值", async () => {
  const file = await tempFile();
  await withPath(file, () =>
    withServer(async ({ port, handle }) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { "x-magpie-term-token": handle.token },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.model.length > 0, true);
      assert.equal(body.autonomy, "balanced");
      assert.deepEqual(body.allowlist, []);
      assert.equal(body.reviewModel, null);
      assert.equal(body.basePrompt, null);
    }),
  );
});

test("PUT /api/config 只写 agent 字段（不传 model 不打网关）→ 回读一致", async () => {
  const file = await tempFile();
  await withPath(file, () =>
    withServer(async ({ port, handle }) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: "PUT",
        headers: { "x-magpie-term-token": handle.token, "content-type": "application/json" },
        body: JSON.stringify({
          autonomy: "loose",
          allowlist: [{ pattern: "mkdir", mode: "prefix", enabled: true }],
          reviewModel: "shuaiapi/gpt-6-luna",
          basePrompt: "你是我的私人助理。",
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.autonomy, "loose");
      assert.equal(body.reviewModel, "shuaiapi/gpt-6-luna");
      assert.equal(body.basePrompt, "你是我的私人助理。");
      assert.equal(body.allowlist.length, 1);

      const back = await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { "x-magpie-term-token": handle.token },
      });
      const readBack = await back.json();
      assert.deepEqual(readBack.allowlist, [{ pattern: "mkdir", mode: "prefix", enabled: true }]);
      assert.equal(readBack.autonomy, "loose");
    }),
  );
});

test("PUT /api/config 四个非法值 → 400 + 对应错误码", async () => {
  const file = await tempFile();
  await withPath(file, () =>
    withServer(async ({ port, handle }) => {
      const cases = [
        [{ autonomy: "yolo" }, "INVALID_AUTONOMY"],
        [{ allowlist: "mkdir" }, "INVALID_ALLOWLIST"],
        [{ allowlist: [{ pattern: "a".repeat(501), mode: "prefix", enabled: true }] }, "INVALID_ALLOWLIST"],
        [{ reviewModel: 42 }, "INVALID_REVIEW_MODEL"],
        [{ basePrompt: "x".repeat(8001) }, "INVALID_BASE_PROMPT"],
      ];
      for (const [patch, code] of cases) {
        const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
          method: "PUT",
          headers: { "x-magpie-term-token": handle.token, "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        assert.equal(response.status, 400, JSON.stringify(patch));
        const body = await response.json();
        assert.equal(body.code, code, JSON.stringify(patch));
        assert.equal(typeof body.userText, "string");
      }
    }),
  );
});

test("PUT /api/config 未知字段仍然 400 UNKNOWN_FIELD（旧行为不变）", async () => {
  const file = await tempFile();
  await withPath(file, () =>
    withServer(async ({ port, handle }) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: "PUT",
        headers: { "x-magpie-term-token": handle.token, "content-type": "application/json" },
        body: JSON.stringify({ modle: "typo" }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "UNKNOWN_FIELD");
    }),
  );
});

test("PUT /api/config 同时传 model 与 agent 字段都能存住", async () => {
  const file = await tempFile();
  const gateway = await startModelsGateway(MODELS);
  try {
    await withPath(file, () =>
      withEnv(`http://127.0.0.1:${gateway.port}`, () =>
        withServer(async ({ port, handle }) => {
          const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
            method: "PUT",
            headers: { "x-magpie-term-token": handle.token, "content-type": "application/json" },
            body: JSON.stringify({ model: MODELS[0].id, autonomy: "strict" }),
          });
          assert.equal(response.status, 200);
          const body = await response.json();
          // model 回显仍然是网关清单里的 id（旧契约不变）。
          assert.equal(body.model, MODELS[0].id);
          assert.equal(body.autonomy, "strict");
        }),
      ),
    );
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
  }
});

test("PUT /api/config model 非法时仍然是 INVALID_MODEL（旧行为不变）", async () => {
  const file = await tempFile();
  const gateway = await startModelsGateway(MODELS);
  try {
    await withPath(file, () =>
      withEnv(`http://127.0.0.1:${gateway.port}`, () =>
        withServer(async ({ port, handle }) => {
          const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
            method: "PUT",
            headers: { "x-magpie-term-token": handle.token, "content-type": "application/json" },
            body: JSON.stringify({ model: "nope/nope" }),
          });
          assert.equal(response.status, 400);
          assert.equal((await response.json()).code, "INVALID_MODEL");
        }),
      ),
    );
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
  }
});

test("DEFAULT_MODEL 常量仍然可用（旧路径的回落值）", () => {
  assert.equal(typeof DEFAULT_MODEL, "string");
  assert.ok(DEFAULT_MODEL.length > 0);
});
