// /api/fs 与 /api/hosts/:id/fs 路由的行为锁（TASK-V4-G §5.6，0.3.0 收窄后重写）。
//
// 0.3.0：本机文件面板已删 —— `/api/fs/*` 只剩 `POST /api/fs/reveal`，
// 其余 action 一律 404。文件读写全部走 `/api/hosts/:id/fs/*`（远程）。
// 所以本文件现在锁两件事：
//   1. 本地只剩 reveal，其它 action 是 404（不是 403 / 不是 400）；
//   2. 远程路由的守卫与错误码一个字都没变（token 门 / 未知主机 / 不递归删除）。
//
// 起真服务（startServer），配置路径指到临时目录；临时文件全部在 os.tmpdir() 下。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { startServer } from "../../src/server/http.mjs";
import { CONFIG_PATH_ENV, addHost } from "../../src/config/store.mjs";
import { contentDisposition, statusOf } from "../../src/server/routes/fs.mjs";

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

async function withServer(fn) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "mt-fs-route-"));
  const workDir = await mkdtemp(path.join(os.tmpdir(), "mt-fs-work-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(configDir, "config.json");
  const port = await freePort();
  const handle = await startServer({ port, log: () => {} });
  const base = `http://127.0.0.1:${port}`;
  const headers = (extra = {}) => ({ "x-magpie-term-token": handle.token, ...extra });
  const api = async (pathname, init = {}, extraHeaders = {}) =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { ...headers(extraHeaders), ...(init.headers || {}) },
    });
  try {
    return await fn({ port, handle, base, headers, api, workDir });
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
    await rm(configDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

/** 建一条「已配置但没连过」的主机：远程分支会在建连守卫处停下，够验路由。 */
async function makeHost() {
  return addHost({
    name: "fs-route-host",
    host: "127.0.0.1",
    port: 65022,
    username: "probe",
    authType: "password",
  });
}

test("鉴权组", async (t) => {
  await t.test("不带 token → 403（/api/fs/reveal 与远程分支同门）", async () => {
    await withServer(async ({ base }) => {
      const host = await makeHost();
      for (const [pathname, method] of [
        ["/api/fs/reveal", "POST"],
        [`/api/hosts/${host.id}/fs/list?path=/tmp`, "GET"],
        [`/api/hosts/${host.id}/fs/stat?path=/tmp`, "GET"],
      ]) {
        const response = await fetch(`${base}${pathname}`, {
          method,
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        assert.equal(response.status, 403, `${method} ${pathname}`);
        assert.equal((await response.json()).code, "FORBIDDEN");
      }
    });
  });

  await t.test("错误 token → 403", async () => {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/api/fs/reveal`, {
        method: "POST",
        headers: { "x-magpie-term-token": "nope", "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 403);
    });
  });
});

test("本地收窄组：/api/fs/* 只剩 reveal，其余一律 404", async (t) => {
  await t.test("/api/fs/list（以及 read / stat / download / write / mkdir / newfile / rename / move / upload / DELETE）→ 404 NOT_FOUND", async () => {
    await withServer(async ({ api, workDir }) => {
      const cases = [
        [`/api/fs/list?path=${encodeURIComponent(workDir)}`, {}],
        [`/api/fs/read?path=${encodeURIComponent(workDir)}`, {}],
        [`/api/fs/stat?path=${encodeURIComponent(workDir)}`, {}],
        [`/api/fs/download?path=${encodeURIComponent(workDir)}`, {}],
        [`/api/fs?path=${encodeURIComponent(workDir)}`, {}],
        [`/api/fs/write?path=${encodeURIComponent(workDir)}`, { method: "PUT", body: "x" }],
        ["/api/fs/mkdir", { method: "POST", body: JSON.stringify({ path: workDir }) }],
        ["/api/fs/newfile", { method: "POST", body: JSON.stringify({ path: workDir }) }],
        ["/api/fs/rename", { method: "POST", body: JSON.stringify({ from: "a", to: "b" }) }],
        ["/api/fs/move", { method: "POST", body: JSON.stringify({ items: [{ from: "a", to: "b" }] }) }],
        [`/api/fs/upload?path=${encodeURIComponent(workDir)}`, { method: "POST", body: "x" }],
        [`/api/fs?path=${encodeURIComponent(workDir)}`, { method: "DELETE" }],
      ];
      for (const [pathname, init] of cases) {
        const response = await api(pathname, {
          ...init,
          ...(init.body ? { headers: { "content-type": "application/json" } } : {}),
        });
        assert.equal(response.status, 404, pathname);
        const body = await response.json();
        assert.equal(body.code, "NOT_FOUND", pathname);
        assert.match(body.userText, /本机文件面板已删/, pathname);
      }
    });
  });

  await t.test("POST /api/fs/reveal 缺 body → 400 BAD_BODY（reveal 自己还在）", async () => {
    await withServer(async ({ api }) => {
      const response = await api("/api/fs/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "BAD_BODY");
    });
  });

  await t.test("POST /api/fs/reveal 相对路径 → 400 INVALID_PATH", async () => {
    await withServer(async ({ api }) => {
      const response = await api("/api/fs/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "relative/dir" }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "INVALID_PATH");
      assert.match(body.userText, /绝对路径/);
    });
  });

  await t.test("POST /api/fs/reveal 下载目录之外 → 400 REVEAL_OUT_OF_SCOPE", async () => {
    await withServer(async ({ api, workDir }) => {
      const response = await api("/api/fs/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path.join(workDir, "a.txt") }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "REVEAL_OUT_OF_SCOPE");
    });
  });
});

test("远程路由组（不建真连，只验守卫）", async (t) => {
  await t.test("未知主机 → 404 HOST_NOT_FOUND", async () => {
    await withServer(async ({ api }) => {
      const response = await api("/api/hosts/nope-id/fs/list?path=/tmp");
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "HOST_NOT_FOUND");
    });
  });

  await t.test("远程删除带 recursive=1 → 400（远程不递归）", async () => {
    await withServer(async ({ api }) => {
      const response = await api("/api/hosts/x/fs?path=/tmp/a&recursive=1", { method: "DELETE" });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "INVALID_PATH");
      assert.match(body.userText, /不递归/);
    });
  });

  await t.test("已配置主机但没连过 → 400 UNKNOWN_HOST_KEY（路由确实到了 sftp 封装）", async () => {
    await withServer(async ({ api }) => {
      const host = await makeHost();
      const response = await api(`/api/hosts/${host.id}/fs/list?path=/tmp`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "UNKNOWN_HOST_KEY");
    });
  });

  await t.test("远程 save 缺 body → 400 BAD_BODY", async () => {
    await withServer(async ({ api }) => {
      const host = await makeHost();
      const response = await api(`/api/hosts/${host.id}/fs/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "BAD_BODY");
    });
  });

  await t.test("远程 upload 缺 x-filename → 400 MISSING_FILENAME", async () => {
    await withServer(async ({ api, workDir }) => {
      const host = await makeHost();
      const response = await api(`/api/hosts/${host.id}/fs/upload?path=${encodeURIComponent(workDir)}`, {
        method: "POST",
        body: "x",
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "MISSING_FILENAME");
    });
  });

  await t.test("远程 upload 文件名带分隔符 → 400 INVALID_PATH", async () => {
    await withServer(async ({ api, workDir }) => {
      const host = await makeHost();
      const response = await api(`/api/hosts/${host.id}/fs/upload?path=${encodeURIComponent(workDir)}`, {
        method: "POST",
        headers: { "x-filename": encodeURIComponent("../evil.txt") },
        body: "x",
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_PATH");
    });
  });

  await t.test("远程未知子路径 → 404（提示语仍是「远程文件接口」）", async () => {
    await withServer(async ({ api }) => {
      const host = await makeHost();
      const response = await api(`/api/hosts/${host.id}/fs/nope`);
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.equal(body.code, "NOT_FOUND");
      assert.match(body.userText, /远程文件接口/);
    });
  });

  await t.test("远程接口同样要 token → 403", async () => {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/api/hosts/x/fs/list?path=/tmp`);
      assert.equal(response.status, 403);
    });
  });
});

test("纯函数组", async (t) => {
  await t.test("statusOf 映射固定", () => {
    assert.equal(statusOf("INVALID_PATH"), 400);
    assert.equal(statusOf("BAD_BODY"), 400);
    assert.equal(statusOf("MISSING_FILENAME"), 400);
    assert.equal(statusOf("NOT_FOUND"), 404);
    assert.equal(statusOf("HOST_NOT_FOUND"), 404);
    assert.equal(statusOf("HOST_UNREACHABLE"), 502);
    assert.equal(statusOf("DIR_NOT_EMPTY"), 409);
    assert.equal(statusOf("ALREADY_EXISTS"), 409);
    assert.equal(statusOf("FILE_TOO_LARGE"), 413);
    assert.equal(statusOf("NOT_TEXT"), 415);
    assert.equal(statusOf("FORBIDDEN_PATH"), 403);
    assert.equal(statusOf("SFTP_READ_FAILED"), 502);
  });

  await t.test("contentDisposition 对中文文件名做 RFC 5987 编码", () => {
    const header = contentDisposition("中文 名.txt");
    assert.match(header, /^attachment; filename\*=UTF-8''/);
    assert.equal(header.includes("%E4%B8%AD%E6%96%87"), true);
    // ASCII 名也走同一套（不会出现裸的 filename=）。
    assert.equal(contentDisposition("plain.txt").includes('filename="'), false);
  });
});
