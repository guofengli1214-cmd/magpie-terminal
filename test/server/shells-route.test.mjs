// GET /api/shells 与 PUT /api/config{defaultShell} 的行为锁
// （TASK-V4-F §5.6 起的契约；TASK-FIX17-A R1 把它从「三个写死 id」扩成「动态发现的格式校验」）。
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
import { BUILTIN_SHELL_IDS, isValidShellId } from "../../src/pty/shells.mjs";

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

test("GET /api/shells 带 token → 200：前四条是内置四项，旧字段语义不变，只多 group/detail", async () => {
  await withServer(async ({ port, handle }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/shells`, {
      headers: authHeaders(handle),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.shells));
    // TASK-FIX17-A：清单从「三个写死 id」扩成「运行时发现」，前四条固定是内置四项。
    assert.deepEqual(
      body.shells.slice(0, 4).map((item) => item.id),
      [...BUILTIN_SHELL_IDS],
    );
    // 本机至少这四条都在（AC1）。
    for (const id of BUILTIN_SHELL_IDS) {
      assert.ok(body.shells.some((item) => item.id === id), `清单里没有 ${id}`);
    }
    for (const item of body.shells) {
      // 老字段一个都不许改名或删除（AC10）。
      assert.equal(typeof item.name, "string");
      assert.equal(typeof item.version, "string");
      assert.equal(typeof item.path, "string");
      assert.equal(typeof item.available, "boolean");
      // 新字段：group 一定是三选一；detail 只在 wsl/profile 上有，有就必须是字符串。
      assert.ok(["local", "wsl", "profile"].includes(item.group), `group 异常: ${item.id} → ${item.group}`);
      if (item.detail !== undefined) assert.equal(typeof item.detail, "string");
      // id 必须是格式合法的（config 与 ws 帧共用同一套约束）。
      assert.equal(isValidShellId(item.id), true, `id 不合法: ${JSON.stringify(item.id)}`);
      // 不该把 args 之类的实现细节漏出去（前端只用 id/name/version/available）。
      assert.equal(item.args, undefined);
    }
    const bash = body.shells.find((item) => item.id === "bash");
    assert.equal(bash.available, true);
    assert.match(bash.version, /^\d+\.\d+/);
    const cmd = body.shells.find((item) => item.id === "cmd");
    assert.equal(cmd.available, true, `本机 cmd 应该可用（path=${JSON.stringify(cmd.path)}）`);
    assert.equal(cmd.group, "local");
    // 本机装了 WSL 发行版时，wsl:<发行版> 必须出现且带 detail（AC1）。
    const wslItems = body.shells.filter((item) => item.group === "wsl");
    for (const item of wslItems) {
      assert.match(item.id, /^wsl:/);
      assert.equal(item.detail, item.id.slice(4));
    }
    // default 是生效的默认 shell id（隔离配置下是自动探测的 bash）。
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

test("PUT /api/config {defaultShell:'cmd'} → 200 并落盘（TASK-FIX17-A AC4：新 id 不被白名单误杀）", async () => {
  await withServer(async ({ port, handle, configFile }) => {
    const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers: authHeaders(handle),
      body: JSON.stringify({ defaultShell: "cmd" }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).defaultShell, "cmd");
    assert.equal(JSON.parse(await readFile(configFile, "utf8")).defaultShell, "cmd");

    // /api/shells 的 default 也跟着变成 cmd（本机 cmd 可用）。
    const shells = await (
      await fetch(`http://127.0.0.1:${port}/api/shells`, { headers: authHeaders(handle) })
    ).json();
    assert.equal(shells.configured, "cmd");
    assert.equal(shells.default, "cmd");
  });
});

test("PUT /api/config {defaultShell:'wsl:<发行版>'} → 200 并落盘（冒号不被拒）", async () => {
  await withServer(async ({ port, handle, configFile }) => {
    // 用清单里真实的 wsl id；本机没有发行版时用格式合法的假值验证「格式校验」这一层
    // （存在性不归 config 管：不可用时 resolveShellForRequest 静默回落）。
    const shells = await (
      await fetch(`http://127.0.0.1:${port}/api/shells`, { headers: authHeaders(handle) })
    ).json();
    const wslItem = shells.shells.find((item) => item.group === "wsl" && item.available);
    const wanted = wslItem ? wslItem.id : "wsl:Ubuntu-24.04";

    const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers: authHeaders(handle),
      body: JSON.stringify({ defaultShell: wanted }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).defaultShell, wanted);
    assert.equal(JSON.parse(await readFile(configFile, "utf8")).defaultShell, wanted);
  });
});

test("PUT /api/config {defaultShell:'bad shell!'} → 400 INVALID_SHELL，不落盘", async () => {
  await withServer(async ({ port, handle, configFile }) => {
    const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PUT",
      headers: authHeaders(handle),
      body: JSON.stringify({ defaultShell: "bad shell!" }),
    });
    assert.equal(put.status, 400);
    const body = await put.json();
    assert.equal(body.code, "INVALID_SHELL");
    assert.equal(typeof body.userText, "string");

    const get = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: authHeaders(handle),
    });
    assert.equal((await get.json()).defaultShell, null);

    // 配置文件要么不存在，要么里面没有这个非法值。
    const raw = await readFile(configFile, "utf8").then(
      (text) => JSON.parse(text),
      () => null,
    );
    if (raw) assert.notEqual(raw.defaultShell, "bad shell!");
  });
});

test("PUT /api/config {defaultShell:'bad shell!'} 的兄弟形态：换行 / 超长 / 非字符串都 400", async () => {
  await withServer(async ({ port, handle }) => {
    for (const bad of ["a\nb", "x".repeat(65), 42, {}, "has/slash", "has space"]) {
      const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: "PUT",
        headers: authHeaders(handle),
        body: JSON.stringify({ defaultShell: bad }),
      });
      assert.equal(put.status, 400, `应当被拒: ${JSON.stringify(bad)}`);
      assert.equal((await put.json()).code, "INVALID_SHELL");
    }
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
