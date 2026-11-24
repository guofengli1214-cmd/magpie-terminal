// /api/fs 路由的行为锁（TASK-V4-G §5.6）：鉴权、绝对路径校验、404/409/413/415 错误码。
//
// 起真服务（startServer），配置路径指到临时目录；文件操作全部在 os.tmpdir() 下。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { startServer } from "../../src/server/http.mjs";
import { CONFIG_PATH_ENV } from "../../src/config/store.mjs";
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
  try {
    return await fn({ port, handle, base, headers, workDir });
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
    await rm(configDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

function fsUrl(base, action, params = {}) {
  const query = new URLSearchParams(params);
  return `${base}/api/fs/${action}?${query.toString()}`;
}

test("鉴权组", async (t) => {
  await t.test("不带 token → 403（所有 /api/fs 分支同门）", async () => {
    await withServer(async ({ base, workDir }) => {
      for (const url of [
        fsUrl(base, "list", { path: workDir }),
        fsUrl(base, "read", { path: path.join(workDir, "x") }),
        fsUrl(base, "download", { path: path.join(workDir, "x") }),
        fsUrl(base, "stat", { path: workDir }),
        `${base}/api/fs?path=${encodeURIComponent(workDir)}`,
      ]) {
        const response = await fetch(url);
        assert.equal(response.status, 403, url);
        const body = await response.json();
        assert.equal(body.code, "FORBIDDEN");
      }
    });
  });

  await t.test("错误 token → 403", async () => {
    await withServer(async ({ base, workDir }) => {
      const response = await fetch(fsUrl(base, "list", { path: workDir }), {
        headers: { "x-magpie-term-token": "nope" },
      });
      assert.equal(response.status, 403);
    });
  });

  await t.test("PUT /api/fs/write 不带 token → 403，且磁盘上什么都没多出来", async () => {
    await withServer(async ({ base, workDir }) => {
      const target = path.join(workDir, "evil.txt");
      const response = await fetch(fsUrl(base, "write", { path: target }), {
        method: "PUT",
        body: "hacked",
      });
      assert.equal(response.status, 403);
      await assert.rejects(stat(target), (err) => err.code === "ENOENT");
    });
  });
});

test("路径校验组", async (t) => {
  await t.test("GET /api/fs/list 缺 path → 400 INVALID_PATH", async () => {
    await withServer(async ({ base, headers }) => {
      const response = await fetch(fsUrl(base, "list"), { headers: headers() });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "INVALID_PATH");
      assert.match(body.userText, /绝对路径|不能是空/);
    });
  });

  await t.test("相对路径 → 400 INVALID_PATH（三处入口）", async () => {
    await withServer(async ({ base, headers }) => {
      for (const url of [
        fsUrl(base, "list", { path: "relative/dir" }),
        fsUrl(base, "read", { path: "relative.txt" }),
        fsUrl(base, "stat", { path: "./x" }),
      ]) {
        const response = await fetch(url, { headers: headers() });
        assert.equal(response.status, 400, url);
        assert.equal((await response.json()).code, "INVALID_PATH");
      }
    });
  });

  await t.test("含 NUL 的 path → 400 INVALID_PATH", async () => {
    await withServer(async ({ base, headers }) => {
      // `%00` 在 URL 里是合法编码，服务端解码后会得到真正的 NUL。
      const response = await fetch(`${base}/api/fs/list?path=${encodeURIComponent(`${os.tmpdir()}\u0000x`)}`, {
        headers: headers(),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_PATH");
    });
  });

  await t.test("POST /api/fs/mkdir 缺 body → 400 BAD_BODY", async () => {
    await withServer(async ({ base, headers }) => {
      const response = await fetch(`${base}/api/fs/mkdir`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: "not json",
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "BAD_BODY");
    });
  });
});

test("正常流程组（真建 / 真写 / 真删）", async () => {
  await withServer(async ({ base, headers, workDir }) => {
    const dirName = `v4g-proof-${crypto.randomBytes(4).toString("hex")}`;
    const dirPath = path.join(workDir, dirName);

    // mkdir
    let response = await fetch(`${base}/api/fs/mkdir`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ path: dirPath }),
    });
    assert.equal(response.status, 201);
    assert.equal((await stat(dirPath)).isDirectory(), true);

    // newfile + write（中文与换行逐字一致）
    const filePath = path.join(dirPath, "note.txt");
    response = await fetch(`${base}/api/fs/newfile`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ path: filePath }),
    });
    assert.equal(response.status, 201);

    const text = "第一行 中文\n第二行\r\n第三行 🔥\n";
    response = await fetch(fsUrl(base, "write", { path: filePath }), {
      method: "PUT",
      headers: headers(),
      body: text,
    });
    assert.equal(response.status, 200);
    assert.equal(await readFile(filePath, "utf8"), text);

    // read
    response = await fetch(fsUrl(base, "read", { path: filePath }), { headers: headers() });
    assert.equal(response.status, 200);
    const read = await response.json();
    assert.equal(read.content, text);
    assert.equal(read.path, path.resolve(filePath));

    // list：新目录出现在父目录里，条目形状正确
    response = await fetch(fsUrl(base, "list", { path: workDir }), { headers: headers() });
    assert.equal(response.status, 200);
    const listing = await response.json();
    assert.equal(listing.path, path.resolve(workDir));
    const hit = listing.entries.find((entry) => entry.name === dirName);
    assert.ok(hit, "新建的目录应该出现在列表里");
    assert.equal(hit.type, "dir");

    // rename
    const renamed = path.join(workDir, `${dirName}-renamed`);
    response = await fetch(`${base}/api/fs/rename`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ from: dirPath, to: renamed }),
    });
    assert.equal(response.status, 200);
    await assert.rejects(stat(dirPath), (err) => err.code === "ENOENT");
    assert.equal((await stat(renamed)).isDirectory(), true);

    // upload（原始 body + x-filename）
    const uploadName = "上传 文件.bin";
    const payload = crypto.randomBytes(256 * 1024);
    response = await fetch(
      `${base}/api/fs/upload?${new URLSearchParams({ path: renamed }).toString()}`,
      {
        method: "POST",
        headers: headers({ "x-filename": encodeURIComponent(uploadName) }),
        body: payload,
      },
    );
    assert.equal(response.status, 201);
    const uploaded = await readFile(path.join(renamed, uploadName));
    const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
    assert.equal(sha(uploaded), sha(payload));

    // download：sha256 与源一致
    const downloadPath = path.join(renamed, uploadName);
    response = await fetch(fsUrl(base, "download", { path: downloadPath }), { headers: headers() });
    assert.equal(response.status, 200);
    const disposition = response.headers.get("content-disposition") || "";
    assert.match(disposition, /^attachment; filename\*=UTF-8''/);
    const downloaded = Buffer.from(await response.arrayBuffer());
    assert.equal(sha(downloaded), sha(payload));

    // stat
    response = await fetch(fsUrl(base, "stat", { path: downloadPath }), { headers: headers() });
    assert.equal(response.status, 200);
    const info = await response.json();
    assert.equal(info.type, "file");
    assert.equal(info.size, payload.length);

    // delete（先删目录里的文件、再删目录）
    response = await fetch(`${base}/api/fs?path=${encodeURIComponent(downloadPath)}`, {
      method: "DELETE",
      headers: headers(),
    });
    assert.equal(response.status, 200);
    await assert.rejects(stat(downloadPath), (err) => err.code === "ENOENT");

    // note.txt 也跟着目录改名搬过来了：先删它，目录才空。
    response = await fetch(`${base}/api/fs?path=${encodeURIComponent(path.join(renamed, "note.txt"))}`, {
      method: "DELETE",
      headers: headers(),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${base}/api/fs?path=${encodeURIComponent(renamed)}`, {
      method: "DELETE",
      headers: headers(),
    });
    assert.equal(response.status, 200);
    await assert.rejects(stat(renamed), (err) => err.code === "ENOENT");
  });
});

test("错误码组", async () => {
  await withServer(async ({ base, headers, workDir }) => {
    // 404：读不存在的文件
    let response = await fetch(fsUrl(base, "read", { path: path.join(workDir, "ghost.txt") }), {
      headers: headers(),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "NOT_FOUND");

    // 404：列不存在的目录
    response = await fetch(fsUrl(base, "list", { path: path.join(workDir, "nodir") }), {
      headers: headers(),
    });
    assert.equal(response.status, 404);

    // 413：1.2MB 文本
    const bigText = path.join(workDir, "big.txt");
    await writeFile(bigText, Buffer.alloc(Math.round(1.2 * 1024 * 1024), 0x41));
    response = await fetch(fsUrl(base, "read", { path: bigText }), { headers: headers() });
    assert.equal(response.status, 413);
    const bigBody = await response.json();
    assert.equal(bigBody.code, "FILE_TOO_LARGE");
    assert.match(bigBody.userText, /文件太大/);

    // 415：二进制
    const binary = path.join(workDir, "bin.dat");
    await writeFile(binary, Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01]));
    response = await fetch(fsUrl(base, "read", { path: binary }), { headers: headers() });
    assert.equal(response.status, 415);
    const binBody = await response.json();
    assert.equal(binBody.code, "NOT_TEXT");
    assert.match(binBody.userText, /不是文本/);

    // 409：非空目录不带 recursive
    const full = path.join(workDir, "full");
    await mkdir(full);
    await writeFile(path.join(full, "a.txt"), "a");
    response = await fetch(`${base}/api/fs?path=${encodeURIComponent(full)}`, {
      method: "DELETE",
      headers: headers(),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "DIR_NOT_EMPTY");
    assert.equal((await stat(full)).isDirectory(), true);

    // 409：rename 到已存在的目标
    const a = path.join(workDir, "ra.txt");
    const b = path.join(workDir, "rb.txt");
    await writeFile(a, "a");
    await writeFile(b, "b");
    response = await fetch(`${base}/api/fs/rename`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ from: a, to: b }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "ALREADY_EXISTS");

    // 403：删家目录 / 盘根
    response = await fetch(`${base}/api/fs?path=${encodeURIComponent(os.homedir())}`, {
      method: "DELETE",
      headers: headers(),
    });
    assert.equal(response.status, 403);
    const homeBody = await response.json();
    assert.equal(homeBody.code, "FORBIDDEN_PATH");
    assert.match(homeBody.userText, /家目录/);

    if (process.platform === "win32") {
      response = await fetch(`${base}/api/fs?path=${encodeURIComponent("C:\\")}`, {
        method: "DELETE",
        headers: headers(),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "FORBIDDEN_PATH");
    } else {
      response = await fetch(`${base}/api/fs?path=${encodeURIComponent("/")}`, {
        method: "DELETE",
        headers: headers(),
      });
      assert.equal(response.status, 403);
    }

    // 上传缺 x-filename → 400
    response = await fetch(`${base}/api/fs/upload?path=${encodeURIComponent(workDir)}`, {
      method: "POST",
      headers: headers(),
      body: "x",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "MISSING_FILENAME");

    // 上传文件名带分隔符 → 400
    response = await fetch(`${base}/api/fs/upload?path=${encodeURIComponent(workDir)}`, {
      method: "POST",
      headers: headers({ "x-filename": encodeURIComponent("../evil.txt") }),
      body: "x",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_PATH");

    // 未知 /api/fs 子路径 → 404
    response = await fetch(`${base}/api/fs/nope`, { headers: headers() });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "NOT_FOUND");
  });
});

// TASK-FIX-ACCEPT A：客户端 del() 现在接受任何 2xx；这条锁住服务端契约
// —— DELETE /api/fs 成功时是 200 + JSON（不是 204 空 body）。
test("DELETE 契约组", async (t) => {
  await t.test("DELETE 成功 → 200 + {path,type} JSON，磁盘文件消失", async () => {
    await withServer(async ({ base, headers, workDir }) => {
      const target = path.join(workDir, "delete-contract.txt");
      await writeFile(target, "bye");
      const response = await fetch(`${base}/api/fs?path=${encodeURIComponent(target)}`, {
        method: "DELETE",
        headers: headers(),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") || "", /application\/json/);
      const body = await response.json();
      assert.equal(body.path, target);
      assert.equal(body.type, "file");
      await assert.rejects(stat(target), (err) => err.code === "ENOENT");
    });
  });
});

test("远程路由组（不建真连，只验守卫）", async (t) => {
  await t.test("未知主机 → 404 HOST_NOT_FOUND", async () => {
    await withServer(async ({ base, headers }) => {
      const response = await fetch(`${base}/api/hosts/nope-id/fs/list?path=/tmp`, { headers: headers() });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "HOST_NOT_FOUND");
    });
  });

  await t.test("远程删除带 recursive=1 → 400（远程不递归）", async () => {
    await withServer(async ({ base, headers }) => {
      const response = await fetch(
        `${base}/api/hosts/x/fs?path=/tmp/a&recursive=1`,
        { method: "DELETE", headers: headers() },
      );
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "INVALID_PATH");
      assert.match(body.userText, /不递归/);
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
    assert.equal(statusOf("NOT_FOUND"), 404);
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
    assert.equal(contentDisposition("plain.txt").includes("filename=\""), false);
  });

  await t.test("Readable 流能被 writeStreamAtomic 消费（上传路径的底层）", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mt-fs-stream-"));
    try {
      const { writeStreamAtomic } = await import("../../src/fs/local.mjs");
      const target = path.join(dir, "s.bin");
      await writeStreamAtomic(target, Readable.from([Buffer.from("abc")]));
      assert.equal(await readFile(target, "utf8"), "abc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
