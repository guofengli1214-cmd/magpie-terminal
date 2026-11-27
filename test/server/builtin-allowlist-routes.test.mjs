// TASK-FIX17-I 的「真 HTTP」行为锁：`GET/PUT /api/config` 的 `builtinAllowlist`。
//
// 隔离手段与 test/server/download-dir-routes.test.mjs 同一套：
//   - `MAGPIE_TERMINAL_CONFIG_PATH` → 临时 config.json（绝不碰用户真配置）；
//   - `MAGPIE_TERMINAL_LOG_DIR`     → 临时日志目录；
//   - 随机空闲端口；token 用 startServer 句柄给的（`x-magpie-term-token`）。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";

import { CONFIG_PATH_ENV } from "../../src/config/store.mjs";
import { DEFAULT_BUILTIN_ALLOWLIST } from "../../src/policy/allowlist.mjs";
import { startServer, makeLogger } from "../../src/server/http.mjs";

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

async function withService(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mt-i-http-"));
  const configFile = path.join(root, "config", "config.json");
  const logDir = path.join(root, "logs");
  await mkdir(logDir, { recursive: true });
  const previousConfig = process.env[CONFIG_PATH_ENV];
  const previousLog = process.env[LOG_DIR_ENV];
  process.env[CONFIG_PATH_ENV] = configFile;
  process.env[LOG_DIR_ENV] = logDir;
  const port = await freePort();
  const log = makeLogger({ log() {}, warn() {} }, { file: true, dedupeWindowMs: 0 });
  const handle = await startServer({ port, log });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-magpie-term-token": handle.token };
  const api = async (pathname, init = {}) =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
  const getConfig = async () => {
    const response = await api("/api/config");
    assert.equal(response.status, 200);
    return response.json();
  };
  const putConfig = async (patch) => {
    const response = await api("/api/config", { method: "PUT", body: JSON.stringify(patch) });
    const body = await response.json();
    return { status: response.status, body };
  };
  try {
    return await fn({ handle, base, getConfig, putConfig, configFile });
  } finally {
    await handle.close();
    if (previousConfig === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previousConfig;
    if (previousLog === undefined) delete process.env[LOG_DIR_ENV];
    else process.env[LOG_DIR_ENV] = previousLog;
    await rm(root, { recursive: true, force: true });
  }
}

test("I-R1 GET /api/config 带 builtinAllowlist（默认清单）+ builtinAllowlistDefaults", async () => {
  await withService(async ({ getConfig }) => {
    const body = await getConfig();
    assert.deepEqual(body.builtinAllowlist, [...DEFAULT_BUILTIN_ALLOWLIST]);
    assert.deepEqual(body.builtinAllowlistDefaults, [...DEFAULT_BUILTIN_ALLOWLIST]);
    // 不破坏既有响应形状：原有键都还在。
    for (const key of ["model", "autonomy", "allowlist", "reviewModel", "basePrompt", "downloadDir"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(body, key), `缺少既有键 ${key}`);
    }
  });
});

test("I-R1 PUT builtinAllowlist → 200 + GET 读回一致（去重后落盘）", async () => {
  await withService(async ({ getConfig, putConfig }) => {
    const saved = await putConfig({ builtinAllowlist: ["free", "git status", "free"] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.builtinAllowlist, ["free", "git status"]);
    const body = await getConfig();
    assert.deepEqual(body.builtinAllowlist, ["free", "git status"]);
    // 默认清单不受用户清单影响（「恢复默认」要靠它）。
    assert.deepEqual(body.builtinAllowlistDefaults, [...DEFAULT_BUILTIN_ALLOWLIST]);
  });
});

test("I-R1 PUT builtinAllowlist: [] → 200，读回仍是空数组（不是回落默认）", async () => {
  await withService(async ({ getConfig, putConfig }) => {
    const saved = await putConfig({ builtinAllowlist: [] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.builtinAllowlist, []);
    assert.deepEqual((await getConfig()).builtinAllowlist, []);
  });
});

test("I-R1 PUT 非法 builtinAllowlist → 400 INVALID_BUILTIN_ALLOWLIST + 人话，且配置不被改动", async () => {
  await withService(async ({ getConfig, putConfig }) => {
    const before = await getConfig();
    for (const bad of [["ls; rm -rf /"], ["git  status"], ["a b c d"], "ls", ["a".repeat(65)]]) {
      const result = await putConfig({ builtinAllowlist: bad });
      assert.equal(result.status, 400, JSON.stringify(bad));
      assert.equal(result.body.code, "INVALID_BUILTIN_ALLOWLIST", JSON.stringify(bad));
      assert.equal(typeof result.body.userText, "string");
      assert.ok(result.body.userText.length > 0);
    }
    assert.deepEqual((await getConfig()).builtinAllowlist, before.builtinAllowlist);
  });
});

test("I-R1 PUT 未知字段仍然 400（builtinAllowlist 是新增的已知字段，拼错的不收）", async () => {
  await withService(async ({ putConfig }) => {
    const result = await putConfig({ builtinAllowlistV2: ["free"] });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "UNKNOWN_FIELD");
  });
});
