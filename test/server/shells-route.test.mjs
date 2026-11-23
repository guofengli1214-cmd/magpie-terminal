// GET /api/shells 与 PUT /api/config{defaultShell} 的行为锁（TASK-V4-F §5.6）。
//
// 配置路径一律用 MAGPIE_TERMINAL_CONFIG_PATH 指到临时目录，
// 绝不碰真的 ~/.config/magpie-terminal/config.json。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { startServer } from "../../src/server/http.mjs";
import { CONFIG_PATH_ENV } from "../../src/config/store.mjs";

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

/** 临时配置 + 真服务，跑完都收掉。 */
async function withServer(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-shells-route-"));
  const configFile = path.join(dir, "config.json");
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = configFile;
  const port = await freePort();
  const handle = await startServer({ port, log: () => {} });
  try {
    return await fn({ port, handle, configFile });
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
  }
}

function authHeaders(handle) {
  return { "x-magpie-term-token": handle.token, "content-type": "application/json" };
}

test("GET /api/shells 未带 token → 403（与 /api/models 同一道门）", async () => {
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/shells`);
    assert.equal(response.status, 403);
  });
});

test("GET /api/shells 带 token → 200，三项结构正确", async () => {
  await withServer(async ({ port, handle }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/shells`, {
      headers: authHeaders(handle),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.shells));
    assert.deepEqual(
      body.shells.map((item) => item.id),
      ["bash", "pwsh", "powershell"],
    );
    for (const item of body.shells) {
      assert.equal(typeof item.name, "string");
      assert.equal(typeof item.version, "string");
      assert.equal(typeof item.path, "string");
      assert.equal(typeof item.available, "boolean");
      // 不该把 args 之类的实现细节漏出去（前端只用 id/name/version/available）。
      assert.equal(item.args, undefined);
    }
    const bash = body.shells.find((item) => item.id === "bash");
    assert.equal(bash.available, true);
    assert.match(bash.version, /^\d+\.\d+/);
    // default 是生效的默认 shell id（本机是 bash）。
    assert.equal(typeof body.default, "string");
    assert.equal(body.default, "bash");
    // 没配过时 configured 是 null。
    assert.equal(body.configured, null);
  });
});

test("PUT /api/config {defaultShell:'pwsh'} → 落盘，GET 可回读", async () => {
  await withServer(async ({ port, handle, configFile }) => {
    const shells = await (
      await fetch(`http://127.0.0.1:${port}/api/shells`, { headers: authHeaders(handle) })
    ).json();
    const pwsh = shells.shells.find((item) => item.id === "pwsh");
    const wanted = pwsh && pwsh.available ? "pwsh" : "powershell";

    const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers: authHeaders(handle),
      body: JSON.stringify({ defaultShell: wanted }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.defaultShell, wanted);

    const get = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: authHeaders(handle),
    });
    assert.equal(get.status, 200);
    assert.equal((await get.json()).defaultShell, wanted);

    // 真的落盘了（不只是内存）。
    const raw = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(raw.defaultShell, wanted);

    // /api/shells 也跟着变（configured + default 都是新值）。
    const after = await (
      await fetch(`http://127.0.0.1:${port}/api/shells`, { headers: authHeaders(handle) })
    ).json();
    assert.equal(after.configured, wanted);
    assert.equal(after.default, wanted);
  });
});

test("PUT /api/config {defaultShell:'zsh'} → 400 INVALID_SHELL，不落盘", async () => {
  await withServer(async ({ port, handle, configFile }) => {
    const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers: authHeaders(handle),
      body: JSON.stringify({ defaultShell: "zsh" }),
    });
    assert.equal(put.status, 400);
    const body = await put.json();
    assert.equal(body.code, "INVALID_SHELL");
    assert.equal(typeof body.userText, "string");

    const get = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: authHeaders(handle),
    });
    assert.equal((await get.json()).defaultShell, null);

    // 配置文件要么不存在，要么里面没有 defaultShell 这个非法值。
    const raw = await readFile(configFile, "utf8").then(
      (text) => JSON.parse(text),
      () => null,
    );
    if (raw) assert.notEqual(raw.defaultShell, "zsh");
  });
});

test("PUT /api/config {defaultShell:null} → 回到自动探测（200 + null）", async () => {
  await withServer(async ({ port, handle }) => {
    const headers = authHeaders(handle);
    await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ defaultShell: "powershell" }),
    });
    const reset = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ defaultShell: null }),
    });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).defaultShell, null);

    const shells = await (
      await fetch(`http://127.0.0.1:${port}/api/shells`, { headers })
    ).json();
    assert.equal(shells.configured, null);
    assert.equal(shells.default, "bash");
  });
});
