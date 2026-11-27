// TASK-FIX17-G R1/R3/AC1/AC3/AC4/AC7：/api/version 与 /api/update/check 的真服务测试。
//
// 隔离手段：
//   - MAGPIE_TERMINAL_CONFIG_PATH 与 MAGPIE_PLUGINS_PATH 都指到 mkdtemp；
//   - 端口用随机空闲端口，不抢真实插件占用的 3480；
//   - 更新检查注入 fetchImpl / cache / 时钟，**绝不真连 GitHub**；
//   - packageInfo 通过 startServer 注入，避免临时改 package.json。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { startServer } from "../../src/server/http.mjs";
import { CONFIG_PATH_ENV } from "../../src/config/store.mjs";
import { PLUGINS_PATH_ENV, PLUGIN_ROOT } from "../../src/config/install-kind.mjs";
import { UPDATE_CACHE_TTL_MS } from "../../src/config/update-check.mjs";

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

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

/**
 * 临时配置 + 临时 plugins.json + 真服务。
 * `options.plugins` 是 plugins.json 的内容；`options.server` 透传给 startServer。
 */
async function withServer(fn, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fix17g-meta-"));
  const configFile = path.join(dir, "config.json");
  const pluginsFile = path.join(dir, "plugins.json");
  await writeFile(configFile, JSON.stringify({ version: 1 }), "utf8");
  if (options.plugins !== undefined) {
    await writeFile(pluginsFile, JSON.stringify(options.plugins), "utf8");
  }

  const previousConfig = process.env[CONFIG_PATH_ENV];
  const previousPlugins = process.env[PLUGINS_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = configFile;
  process.env[PLUGINS_PATH_ENV] = pluginsFile;

  const port = await freePort();
  const handle = await startServer({ port, log: () => {}, ...(options.server || {}) });
  try {
    return await fn({ port, handle, dir, pluginsFile });
  } finally {
    await handle.close();
    if (previousConfig === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previousConfig;
    if (previousPlugins === undefined) delete process.env[PLUGINS_PATH_ENV];
    else process.env[PLUGINS_PATH_ENV] = previousPlugins;
    await rm(dir, { recursive: true, force: true });
  }
}

function authHeaders(handle) {
  return { "x-magpie-term-token": handle.token, "content-type": "application/json" };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("AC7：/api/version 与 /api/update/check 不带 token / 错 token 一律 403", async () => {
  await withServer(
    async ({ port, handle }) => {
      for (const route of ["/api/version", "/api/update/check"]) {
        const noToken = await fetch(`http://127.0.0.1:${port}${route}`);
        assert.equal(noToken.status, 403, `${route} 无 token 必须 403`);
        const body = await noToken.json();
        assert.equal(body.code, "FORBIDDEN");

        const wrong = await fetch(`http://127.0.0.1:${port}${route}?token=${"0".repeat(64)}`);
        assert.equal(wrong.status, 403, `${route} 错 token 必须 403`);

        const ok = await fetch(`http://127.0.0.1:${port}${route}`, { headers: authHeaders(handle) });
        assert.equal(ok.status, 200, `${route} 带 token 必须 200`);
      }
    },
    { plugins: { plugins: [{ spec: PLUGIN_ROOT }] } },
  );
});

test("AC1：/api/version 与 package.json 一致；本机裸路径 → local-path / 无 repository / 不支持检查", async () => {
  await withServer(
    async ({ port, handle }) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/version`, {
        headers: authHeaders(handle),
      });
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.deepEqual(Object.keys(body).sort(), [
        "installKind",
        "name",
        "repository",
        "updateSupported",
        "version",
      ]);
      assert.equal(body.version, packageJson.version);
      assert.equal(body.name, packageJson.name);
      assert.equal(body.repository, null);
      assert.equal(body.installKind, "local-path");
      assert.equal(body.updateSupported, false);
    },
    {
      plugins: { plugins: [{ spec: PLUGIN_ROOT }] },
      // 显式注入「没有 repository」的包信息：真 package.json 现在带 repository
      // （公开发布必需），不能再靠它来表达「未配置仓库」这条分支。
      server: {
        packageInfo: { version: packageJson.version, name: packageJson.name, repository: undefined },
      },
    },
  );
});

test("AC3：repository 字符串 + registry → /api/version 给可点地址，updateSupported:true", async () => {
  await withServer(
    async ({ port, handle }) => {
      const body = await (
        await fetch(`http://127.0.0.1:${port}/api/version`, { headers: authHeaders(handle) })
      ).json();
      assert.equal(body.repository, "https://github.com/acme/magpie-terminal");
      assert.equal(body.installKind, "registry");
      assert.equal(body.updateSupported, true);
    },
    {
      plugins: { plugins: [{ spec: "magpie-terminal@latest" }] },
      server: {
        packageInfo: {
          version: "0.1.0",
          name: "magpie-terminal",
          repository: "https://github.com/acme/magpie-terminal",
        },
      },
    },
  );
});

test("AC3：repository 对象 {type,url} → 归一成 https；读不到 plugins.json → unknown 且不支持检查", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ tag_name: "v9.9.9" }));
  await withServer(
    async ({ port, handle }) => {
      const body = await (
        await fetch(`http://127.0.0.1:${port}/api/version`, { headers: authHeaders(handle) })
      ).json();
      assert.equal(body.repository, "https://github.com/acme/magpie-terminal");
      assert.equal(body.installKind, "unknown");
      assert.equal(body.updateSupported, false);

      // 安装方式未知时 update/check 不发网络请求，也不假装成功。
      const update = await fetch(`http://127.0.0.1:${port}/api/update/check`, {
        headers: authHeaders(handle),
      });
      assert.equal(update.status, 200);
      const updateBody = await update.json();
      assert.equal(updateBody.hasUpdate, false);
      assert.match(updateBody.error, /无法判断安装方式/);
      assert.equal(fetchImpl.calls.length, 0);
    },
    {
      server: {
        packageInfo: {
          version: "0.1.0",
          name: "magpie-terminal",
          repository: { type: "git", url: "git+https://github.com/acme/magpie-terminal.git" },
        },
        updateCheck: { fetchImpl, cache: new Map() },
      },
    },
  );
});

test("R1：local-path + repository → update/check 不发请求，返回 note（不是 error）", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("本地目录安装绝不该发网络请求");
  });
  await withServer(
    async ({ port, handle }) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/update/check`, {
        headers: authHeaders(handle),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.current, "0.1.0");
      assert.equal(body.hasUpdate, false);
      assert.equal(body.error, undefined);
      assert.match(body.note, /git pull/);
      assert.match(body.note, /重启 magpie/);
      assert.equal(fetchImpl.calls.length, 0);
    },
    {
      plugins: { plugins: [{ spec: PLUGIN_ROOT }] },
      server: {
        packageInfo: {
          version: "0.1.0",
          name: "magpie-terminal",
          repository: "https://github.com/acme/magpie-terminal",
        },
        updateCheck: { fetchImpl, cache: new Map() },
      },
    },
  );
});

test("AC3：registry + repository → 200 且有新版本（fetch 注入，不真连 GitHub）", async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      tag_name: "v0.2.0",
      html_url: "https://github.com/acme/magpie-terminal/releases/tag/v0.2.0",
    }),
  );
  await withServer(
    async ({ port, handle }) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/update/check`, {
        headers: authHeaders(handle),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.current, "0.1.0");
      assert.equal(body.latest, "0.2.0");
      assert.equal(body.hasUpdate, true);
      assert.equal(body.url, "https://github.com/acme/magpie-terminal/releases/tag/v0.2.0");
      assert.equal(body.error, undefined);
      assert.equal(fetchImpl.calls.length, 1);
      assert.equal(fetchImpl.calls[0].url, "https://api.github.com/repos/acme/magpie-terminal/releases/latest");
    },
    {
      plugins: { plugins: [{ spec: "magpie-terminal@latest" }] },
      server: {
        packageInfo: {
          version: "0.1.0",
          name: "magpie-terminal",
          repository: "https://github.com/acme/magpie-terminal",
        },
        updateCheck: { fetchImpl, cache: new Map() },
      },
    },
  );
});

test("AC4：GitHub 超时 → HTTP 200 + hasUpdate:false + 人话 error，服务不崩", async () => {
  const fetchImpl = fakeFetch(() => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  });
  await withServer(
    async ({ port, handle }) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/update/check`, {
        headers: authHeaders(handle),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.hasUpdate, false);
      assert.equal(typeof body.error, "string");
      assert.match(body.error, /超时/);
      assert.equal(body.stack, undefined);
      assert.equal(Object.prototype.hasOwnProperty.call(body, "stack"), false);

      // 服务仍然活着：同一进程里 /api/health 继续 200。
      const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: authHeaders(handle),
      });
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
    },
    {
      plugins: { plugins: [{ spec: "magpie-terminal@latest" }] },
      server: {
        packageInfo: {
          version: "0.1.0",
          name: "magpie-terminal",
          repository: "https://github.com/acme/magpie-terminal",
        },
        updateCheck: { fetchImpl, cache: new Map() },
      },
    },
  );
});

test("R3：更新检查结果在 5 分钟内复用缓存，过期后才重新请求", async () => {
  let clock = 1000;
  let count = 0;
  const fetchImpl = fakeFetch(() => {
    count += 1;
    return jsonResponse({ tag_name: "v0.2.0" });
  });
  await withServer(
    async ({ port, handle }) => {
      const call = () =>
        fetch(`http://127.0.0.1:${port}/api/update/check`, { headers: authHeaders(handle) });

      assert.equal((await (await call()).json()).hasUpdate, true);
      assert.equal(count, 1);

      assert.equal((await (await call()).json()).hasUpdate, true);
      assert.equal(count, 1, "5 分钟内第二次点击必须走缓存");

      clock += UPDATE_CACHE_TTL_MS;
      assert.equal((await (await call()).json()).hasUpdate, true);
      assert.equal(count, 2, "TTL 到期后必须重新请求");
    },
    {
      plugins: { plugins: [{ spec: "magpie-terminal@latest" }] },
      server: {
        packageInfo: {
          version: "0.1.0",
          name: "magpie-terminal",
          repository: "https://github.com/acme/magpie-terminal",
        },
        updateCheck: { fetchImpl, cache: new Map(), now: () => clock },
      },
    },
  );
});
