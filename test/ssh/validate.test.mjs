// 主机字段校验 + 注入防线（TASK-V2-B §2.5 / §5 E9）。
//
// 全部通过 startServer() 起一个临时端口，用真 HTTP 打一遍。
// 配置/凭据/known_hosts 都指到临时目录（MAGPIE_TERMINAL_CONFIG_PATH），绝不碰真文件。

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import net from "node:net";
import { startServer } from "../../src/server/http.mjs";
import { CONFIG_PATH_ENV } from "../../src/config/store.mjs";
import { HOST_PATTERN, USERNAME_PATTERN } from "../../src/server/http.mjs";

let handle = null;
let base = "";
let token = "";
let dir = "";

/** 让内核给一个空闲端口（startServer 不认 0，会回落 3480）。 */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function boot() {
  dir = await mkdtemp(path.join(os.tmpdir(), "mt-hosts-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(dir, "config.json");
  handle = await startServer({ port: await freePort(), log: () => {} });
  base = `http://127.0.0.1:${handle.port}`;
  token = handle.token;
  return () => {
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
  };
}

function headers() {
  return { "content-type": "application/json", "x-magpie-term-token": token };
}

async function post(payload) {
  const response = await fetch(`${base}/api/hosts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function put(id, payload) {
  const response = await fetch(`${base}/api/hosts/${id}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const baseHost = {
  name: "prod-web",
  host: "10.0.0.12",
  port: 22,
  username: "root",
  authType: "password",
  password: "s3cret",
};

test("主机接口组", async (t) => {
  const restore = await boot();
  t.after(async () => {
    if (handle) await handle.close();
    restore();
  });

  await t.test("/api/hosts 未带 token → 403（与 /api/health 同一道门）", async () => {
    const response = await fetch(`${base}/api/hosts`);
    assert.equal(response.status, 403);
  });

  await t.test("合法 POST → 201，响应里没有 password / privateKey / passphrase", async () => {
    const { status, body } = await post(baseHost);
    assert.equal(status, 201);
    assert.equal(body.host.name, "prod-web");
    assert.equal(body.host.hasSecret, true);
    const text = JSON.stringify(body);
    assert.equal(text.includes("s3cret"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body.host, "password"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body.host, "privateKey"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body.host, "passphrase"), false);
  });

  await t.test("GET /api/hosts 不含任何凭据字段", async () => {
    const response = await fetch(`${base}/api/hosts`, { headers: headers() });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(Array.isArray(body.hosts), true);
    assert.equal(body.hosts.length, 1);
    const text = JSON.stringify(body);
    assert.equal(text.includes("s3cret"), false);
    for (const host of body.hosts) {
      assert.equal(Object.prototype.hasOwnProperty.call(host, "password"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(host, "privateKey"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(host, "passphrase"), false);
    }
  });

  // ---- E9：注入尝试必须 400 ----

  await t.test('E9 host: "10.0.0.1; rm -rf /" → 400 INVALID_HOST', async () => {
    const { status, body } = await post({ ...baseHost, host: "10.0.0.1; rm -rf /" });
    assert.equal(status, 400);
    assert.equal(body.code, "INVALID_HOST");
  });

  await t.test('E9 host: "$(whoami)" → 400 INVALID_HOST', async () => {
    const { status, body } = await post({ ...baseHost, host: "$(whoami)" });
    assert.equal(status, 400);
    assert.equal(body.code, "INVALID_HOST");
  });

  await t.test("E9 username: \"root`id`\" → 400 INVALID_HOST", async () => {
    const { status, body } = await post({ ...baseHost, username: "root`id`" });
    assert.equal(status, 400);
    assert.equal(body.code, "INVALID_HOST");
  });

  await t.test("E9 port: 70000 → 400 INVALID_HOST", async () => {
    const { status, body } = await post({ ...baseHost, port: 70000 });
    assert.equal(status, 400);
    assert.equal(body.code, "INVALID_HOST");
  });

  await t.test("其它非法形态：空 name / 带斜杠的 host / 负端口 / 未知 authType 都 400", async () => {
    for (const payload of [
      { ...baseHost, name: "" },
      { ...baseHost, name: "x".repeat(65) },
      { ...baseHost, host: "10.0.0.1/22" },
      { ...baseHost, host: "a$b" },
      { ...baseHost, port: -1 },
      { ...baseHost, port: 0 },
      { ...baseHost, port: 65536 },
      { ...baseHost, username: "a b" },
      { ...baseHost, username: "a|b" },
      { ...baseHost, authType: "agent" },
    ]) {
      const { status } = await post(payload);
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(payload)}`);
    }
  });

  await t.test("host 正则本身拒绝所有命令替换 / 重定向 / 空白", () => {
    for (const bad of [
      "10.0.0.1; rm -rf /",
      "$(whoami)",
      "`id`",
      "a b",
      "a|b",
      "a&&b",
      "a>b",
      "a/b",
      "a\nb",
      "",
    ]) {
      assert.equal(HOST_PATTERN.test(bad), false, `host pattern should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(HOST_PATTERN.test("10.0.0.12"), true);
    assert.equal(HOST_PATTERN.test("prod-web.example.com"), true);
    assert.equal(HOST_PATTERN.test("127.0.0.1"), true);
    assert.equal(HOST_PATTERN.test("localhost"), true);
  });

  await t.test("username 正则拒绝反引号 / 分号 / 空格", () => {
    for (const bad of ["root`id`", "root;id", "ro ot", "$(id)", "a/b"]) {
      assert.equal(USERNAME_PATTERN.test(bad), false, `username pattern should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(USERNAME_PATTERN.test("41807"), true);
    assert.equal(USERNAME_PATTERN.test("root.user_admin-1"), true);
  });

  await t.test("password 认证缺 password → 400", async () => {
    const { status, body } = await post({ ...baseHost, password: undefined });
    assert.equal(status, 400);
    assert.equal(body.code, "INVALID_HOST");
  });

  await t.test("privateKey 认证既没 privateKey 也没 privateKeyPath → 400", async () => {
    const { status, body } = await post({
      name: "k",
      host: "127.0.0.1",
      port: 22,
      username: "u",
      authType: "privateKey",
    });
    assert.equal(status, 400);
    assert.equal(body.code, "INVALID_HOST");
  });

  await t.test("privateKeyPath 是相对路径 → 400", async () => {
    const { status, body } = await post({
      name: "k",
      host: "127.0.0.1",
      port: 22,
      username: "u",
      authType: "privateKey",
      privateKeyPath: "keys/id_test",
    });
    assert.equal(status, 400);
    assert.equal(body.code, "INVALID_HOST");
  });

  await t.test("privateKeyPath 绝对路径但文件不存在 → 400", async () => {
    const { status, body } = await post({
      name: "k",
      host: "127.0.0.1",
      port: 22,
      username: "u",
      authType: "privateKey",
      privateKeyPath: path.join(dir, "no-such-key"),
    });
    assert.equal(status, 400);
    assert.equal(body.code, "INVALID_HOST");
  });

  await t.test("privateKeyPath 存在 → 201，且响应带 privateKeyPath、hasSecret:false（无内联 key）", async () => {
    const keyFile = path.join(dir, "id_test");
    // 故意不用真实的私钥内容：这条用例只验证「路径存在即可」，不是密钥解析。
    await writeFile(keyFile, "not-a-real-key", "utf8");
    const { status, body } = await post({
      name: "key-host",
      host: "127.0.0.1",
      port: 22,
      username: "u",
      authType: "privateKey",
      privateKeyPath: keyFile,
    });
    assert.equal(status, 201);
    assert.equal(body.host.privateKeyPath, keyFile);
    assert.equal(body.host.hasSecret, false);
  });

  await t.test("PUT 只改 name；不传 password 不改密码（hasSecret 仍 true）", async () => {
    const list = await (await fetch(`${base}/api/hosts`, { headers: headers() })).json();
    const target = list.hosts.find((h) => h.name === "prod-web");
    assert.ok(target);
    const { status, body } = await put(target.id, { name: "prod-web-2" });
    assert.equal(status, 200);
    assert.equal(body.host.name, "prod-web-2");
    assert.equal(body.host.hasSecret, true);
  });

  await t.test("PUT 改密码 → hasSecret 仍 true，响应不含明文", async () => {
    const list = await (await fetch(`${base}/api/hosts`, { headers: headers() })).json();
    const target = list.hosts.find((h) => h.name === "prod-web-2");
    const { status, body } = await put(target.id, { password: "n3w-secret" });
    assert.equal(status, 200);
    assert.equal(body.host.hasSecret, true);
    assert.equal(JSON.stringify(body).includes("n3w-secret"), false);
  });

  await t.test("PUT 未知 id → 404", async () => {
    const { status } = await put("h-nope", { name: "x" });
    assert.equal(status, 404);
  });

  await t.test("DELETE → 204；再 GET 就没了；未知 id → 404", async () => {
    const list = await (await fetch(`${base}/api/hosts`, { headers: headers() })).json();
    const target = list.hosts.find((h) => h.name === "prod-web-2");
    const del = await fetch(`${base}/api/hosts/${target.id}`, {
      method: "DELETE",
      headers: headers(),
    });
    assert.equal(del.status, 204);
    const after = await (await fetch(`${base}/api/hosts`, { headers: headers() })).json();
    assert.equal(after.hosts.some((h) => h.id === target.id), false);
    const again = await fetch(`${base}/api/hosts/${target.id}`, { method: "DELETE", headers: headers() });
    assert.equal(again.status, 404);
  });

  await t.test("POST /api/hosts/:id/test 未知主机 → 200 {ok:false, code:HOST_NOT_FOUND}", async () => {
    const response = await fetch(`${base}/api/hosts/h-nope/test`, {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "HOST_NOT_FOUND");
  });

  await t.test("GET /api/hosts/:id/fingerprint 未知主机 → 404", async () => {
    const response = await fetch(`${base}/api/hosts/h-nope/fingerprint`, { headers: headers() });
    assert.equal(response.status, 404);
  });

  await t.test("POST /api/hosts/:id/trust 缺 fingerprint → 400", async () => {
    const list = await (await fetch(`${base}/api/hosts`, { headers: headers() })).json();
    const any = list.hosts[0];
    assert.ok(any);
    const response = await fetch(`${base}/api/hosts/${any.id}/trust`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  });

  await t.test("POST /api/hosts/:id/trust 已有记录且指纹不一致 → 409 HOST_KEY_MISMATCH（不给覆盖捷径）", async () => {
    const list = await (await fetch(`${base}/api/hosts`, { headers: headers() })).json();
    const any = list.hosts[0];
    assert.ok(any);
    const knownHostsPath = path.join(dir, "known_hosts.json");
    await writeFile(
      knownHostsPath,
      JSON.stringify({ [`${any.host}:${any.port}`]: { algo: "ssh-ed25519", fingerprint: "SHA256:stale" } }, null, 2),
      "utf8",
    );
    // 先探测当前真实指纹（服务端会把它一并返回），再拿这个真指纹去 trust：
    // 这样能确定失败原因是「与已记录的不一致」，而不是「前端传错」。
    const probe = await (await fetch(`${base}/api/hosts/${any.id}/fingerprint`, { headers: headers() })).json();
    assert.equal(typeof probe.fingerprint, "string");
    const response = await fetch(`${base}/api/hosts/${any.id}/trust`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ fingerprint: probe.fingerprint }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, "HOST_KEY_MISMATCH");
    assert.equal(typeof body.knownFingerprint, "string");
    // 旧记录必须原样不动。
    const after = JSON.parse(await readFile(knownHostsPath, "utf8"));
    assert.equal(after[`${any.host}:${any.port}`].fingerprint, "SHA256:stale");
  });

  await t.test("GET /api/hosts/:id/files 空 path 用默认值，未知主机 → 404", async () => {
    const response = await fetch(`${base}/api/hosts/h-nope/files?path=/tmp`, { headers: headers() });
    assert.equal(response.status, 404);
  });
});
