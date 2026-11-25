// 推理强度配置字段的行为锁（TASK-FIX17-L4 R1 + AC2 / AC5 的服务端一半）。
//
// 全部用 MAGPIE_TERMINAL_CONFIG_PATH 指到临时目录，绝不碰
// ~/.config/magpie-terminal/config.json；HTTP 部分用真 startServer + 随机端口。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import {
  CONFIG_PATH_ENV,
  DEFAULT_CONFIG,
  KNOWN_FIELDS,
  REASONING_LEVELS,
  configPath,
  publicConfig,
  readConfig,
  updateConfig,
  validateConfigPatch,
} from "../../src/config/store.mjs";
import { startServer } from "../../src/server/http.mjs";

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

async function withPath(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-l4-cfg-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(dir, "config.json");
  try {
    return await fn({ dir, file: configPath() });
  } finally {
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
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

const LEVEL_TEXT = "off / low / medium / high / xhigh / max";

/* --------------------------------------------------------- R1：形状与默认 */

test("R1：REASONING_LEVELS 是与网关一致的六个档位（冻结、顺序固定）", () => {
  assert.deepEqual([...REASONING_LEVELS], ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(Object.isFrozen(REASONING_LEVELS), true, "冻结：调用方只读");
});

test("R1：KNOWN_FIELDS 加上 conversationReasoning / reviewReasoning", () => {
  assert.ok(KNOWN_FIELDS.includes("conversationReasoning"));
  assert.ok(KNOWN_FIELDS.includes("reviewReasoning"));
});

test("R1：DEFAULT_CONFIG 两个推理字段都是 null（= 不指定，交给网关默认）", () => {
  assert.equal(DEFAULT_CONFIG.conversationReasoning, null);
  assert.equal(DEFAULT_CONFIG.reviewReasoning, null);
});

test("R1：publicConfig 总是带上两个字段，非法值归一成 null", () => {
  assert.equal(publicConfig({}).conversationReasoning, null);
  assert.equal(publicConfig({}).reviewReasoning, null);
  assert.equal(publicConfig({ conversationReasoning: "turbo" }).conversationReasoning, null);
  assert.equal(publicConfig({ reviewReasoning: 123 }).reviewReasoning, null);
  assert.equal(publicConfig({ conversationReasoning: " high " }).conversationReasoning, "high");
  assert.equal(publicConfig({ reviewReasoning: "max" }).reviewReasoning, "max");
});

test("R1/AC2：validateConfigPatch —— \"turbo\" → INVALID_REASONING_LEVEL（userText 列出合法值）", () => {
  const invalid = validateConfigPatch({ conversationReasoning: "turbo" });
  assert.equal(invalid.code, "INVALID_REASONING_LEVEL");
  assert.ok(invalid.userText.includes(LEVEL_TEXT), invalid.userText);
  assert.equal(validateConfigPatch({ reviewReasoning: "HIGH" }).code, "INVALID_REASONING_LEVEL");
  assert.equal(validateConfigPatch({ reviewReasoning: 5 }).code, "INVALID_REASONING_LEVEL");
});

test("R1/AC2：validateConfigPatch —— 空串 / null / 合法档位都放行", () => {
  assert.equal(validateConfigPatch({ conversationReasoning: "" }), null);
  assert.equal(validateConfigPatch({ conversationReasoning: "   " }), null);
  assert.equal(validateConfigPatch({ conversationReasoning: null }), null);
  for (const level of REASONING_LEVELS) {
    assert.equal(validateConfigPatch({ conversationReasoning: level }), null, level);
    assert.equal(validateConfigPatch({ reviewReasoning: level }), null, level);
  }
});

test("R1/AC2：updateConfig —— 空串归一成 null 落盘，\"high\" 原样落盘", async () => {
  await withPath(async ({ file }) => {
    await updateConfig({ conversationReasoning: "high", reviewReasoning: "low" });
    let raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.conversationReasoning, "high");
    assert.equal(raw.reviewReasoning, "low");

    await updateConfig({ conversationReasoning: "" });
    raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.conversationReasoning, null, "空串必须存成 null");
    assert.equal(raw.reviewReasoning, "low", "另一个字段不许被顺手改掉");

    const { config } = await readConfig();
    assert.equal(config.conversationReasoning, null);
    assert.equal(config.reviewReasoning, "low");
  });
});

test("R1：手改 config.json 写进非法档位 → 读到内存也回落 null（不许发进请求体）", async () => {
  await withPath(async ({ file }) => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ conversationReasoning: "turbo", reviewReasoning: " ultra " }),
      "utf8",
    );
    const view = publicConfig((await readConfig()).config);
    assert.equal(view.conversationReasoning, null);
    assert.equal(view.reviewReasoning, null);
  });
});

/* --------------------------------------------------- AC2 / AC5：真 HTTP */

test("AC2：PUT \"turbo\" → 400 INVALID_REASONING_LEVEL；\"\" → null；\"high\" 落盘", async () => {
  await withPath(async ({ file }) =>
    withServer(async ({ port, handle }) => {
      const headers = { "x-magpie-term-token": handle.token, "content-type": "application/json" };
      const base = `http://127.0.0.1:${port}`;

      const bad = await fetch(`${base}/api/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ conversationReasoning: "turbo" }),
      });
      assert.equal(bad.status, 400);
      const badBody = await bad.json();
      assert.equal(badBody.code, "INVALID_REASONING_LEVEL");
      assert.ok(badBody.userText.includes(LEVEL_TEXT));
      assert.equal((await readFile(file, "utf8").catch(() => "")).includes("turbo"), false, "非法值不许落盘");

      const cleared = await fetch(`${base}/api/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ conversationReasoning: "" }),
      });
      assert.equal(cleared.status, 200);
      assert.equal((await cleared.json()).conversationReasoning, null);

      const saved = await fetch(`${base}/api/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ conversationReasoning: "high", reviewReasoning: "low" }),
      });
      assert.equal(saved.status, 200);
      const savedBody = await saved.json();
      assert.equal(savedBody.conversationReasoning, "high");
      assert.equal(savedBody.reviewReasoning, "low");

      const raw = JSON.parse(await readFile(file, "utf8"));
      assert.equal(raw.conversationReasoning, "high");
      assert.equal(raw.reviewReasoning, "low");

      // AC5/AC6 的刷新恢复靠这一条：GET /api/config 必须真的带出来。
      const got = await (await fetch(`${base}/api/config`, { headers })).json();
      assert.equal(got.conversationReasoning, "high");
      assert.equal(got.reviewReasoning, "low");
    }),
  );
});

test("AC5：GET /api/config 默认带 conversationReasoning / reviewReasoning（都为 null）", async () => {
  await withPath(async () =>
    withServer(async ({ port, handle }) => {
      const headers = { "x-magpie-term-token": handle.token };
      const payload = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers })).json();
      assert.equal(Object.prototype.hasOwnProperty.call(payload, "conversationReasoning"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, "reviewReasoning"), true);
      assert.equal(payload.conversationReasoning, null);
      assert.equal(payload.reviewReasoning, null);
      // 既有字段一个都不许少（只增不改）。
      for (const key of ["model", "autonomy", "allowlist", "reviewModel", "basePrompt", "downloadDir"]) {
        assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `旧字段 ${key} 丢了`);
      }
    }),
  );
});
