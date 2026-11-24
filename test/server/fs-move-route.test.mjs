// TASK-FIX17-C R3：`POST /api/fs/move` 的 HTTP 契约（真服务 + 真磁盘）。
//
// 锁住四件事：
//   1. `{moved, failed}` 的形状与「逐项独立、单项失败不影响其它项」的语义；
//   2. 目标已存在 → failed 里 `code: "TARGET_EXISTS"`，源文件仍在（不覆盖）；
//   3. 请求体校验（BAD_BODY / TOO_MANY_ITEMS）与 token 门；
//   4. 远程分支明确 `NOT_SUPPORTED`，不假装成功。
//
// 跨盘 EXDEV 的降级在 test/fs/local-move.test.mjs 里真跑（这里不重复搬大文件）。
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { startServer } from "../../src/server/http.mjs";
import { CONFIG_PATH_ENV } from "../../src/config/store.mjs";
import { MAX_MOVE_ITEMS, parseMoveBody, runMoveItems, statusOf } from "../../src/server/routes/fs.mjs";

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
  const configDir = await mkdtemp(path.join(os.tmpdir(), "mt-move-route-"));
  const workDir = await mkdtemp(path.join(os.tmpdir(), "mt-move-work-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(configDir, "config.json");
  const port = await freePort();
  const handle = await startServer({ port, log: () => {} });
  const base = `http://127.0.0.1:${port}`;
  const headers = (extra = {}) => ({ "x-magpie-term-token": handle.token, ...extra });
  try {
    return await fn({ base, headers, workDir, handle });
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
    await rm(configDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

async function postMove(base, headers, payload, url = "/api/fs/move") {
  const response = await fetch(`${base}${url}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

test("POST /api/fs/move 正常组", async (t) => {
  await t.test("三项全部移动成功：moved.length===3、failed.length===0", async () => {
    await withServer(async ({ base, headers, workDir }) => {
      const dest = path.join(workDir, "dest");
      await mkdir(dest);
      const names = ["one.txt", "two.txt", "three.txt"];
      const items = [];
      for (const name of names) {
        const from = path.join(workDir, "src", name);
        await mkdir(path.dirname(from), { recursive: true });
        await writeFile(from, `内容-${name}`);
        items.push({ from, to: path.join(dest, name) });
      }
      const { response, body } = await postMove(base, headers, { items });
      assert.equal(response.status, 200);
      assert.equal(body.moved.length, 3);
      assert.equal(body.failed.length, 0);
      for (const name of names) {
        assert.equal(await readFile(path.join(dest, name), "utf8"), `内容-${name}`);
        await assert.rejects(stat(path.join(workDir, "src", name)), (err) => err.code === "ENOENT");
      }
      // via 由服务端给出，前端不依赖它，但它是「是否走了跨盘降级」的唯一证据。
      for (const item of body.moved) assert.ok(["rename", "copy"].includes(item.via), item.via);
    });
  });

  await t.test("目录也能移动（moved 里带上结果）", async () => {
    await withServer(async ({ base, headers, workDir }) => {
      const from = path.join(workDir, "pkg");
      const dest = path.join(workDir, "target");
      await mkdir(from, { recursive: true });
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(from, "a.txt"), "a");
      const { response, body } = await postMove(base, headers, {
        items: [{ from, to: path.join(dest, "pkg") }],
      });
      assert.equal(response.status, 200);
      assert.equal(body.moved.length, 1);
      assert.equal(await readFile(path.join(dest, "pkg", "a.txt"), "utf8"), "a");
    });
  });
});

test("POST /api/fs/move 冲突组", async (t) => {
  await t.test("目标已存在 → failed 里的那条 code 是 TARGET_EXISTS，源文件仍在", async () => {
    await withServer(async ({ base, headers, workDir }) => {
      const free = path.join(workDir, "free.txt");
      const from = path.join(workDir, "dup.txt");
      const to = path.join(workDir, "target.txt");
      await writeFile(free, "可以走");
      await writeFile(from, "源内容");
      await writeFile(to, "目标内容");
      const { response, body } = await postMove(base, headers, {
        items: [
          { from, to },
          { from: free, to: path.join(workDir, "free-moved.txt") },
        ],
      });
      assert.equal(response.status, 200, "批量接口本身是 200，失败明细在 failed 里");
      assert.equal(body.moved.length, 1, "撞名的那条不能拖累另一条");
      assert.equal(body.failed.length, 1);
      assert.equal(body.failed[0].code, "TARGET_EXISTS");
      assert.equal(body.failed[0].from, from);
      assert.match(body.failed[0].userText, /已存在|未覆盖/);
      // 源文件毫发无损，目标也没被覆盖。
      assert.equal(await readFile(from, "utf8"), "源内容");
      assert.equal(await readFile(to, "utf8"), "目标内容");
    });
  });

  await t.test("源不存在 → failed 里是 NOT_FOUND，其余项照常成功", async () => {
    await withServer(async ({ base, headers, workDir }) => {
      const ok = path.join(workDir, "ok.txt");
      await writeFile(ok, "ok");
      const { body } = await postMove(base, headers, {
        items: [
          { from: path.join(workDir, "ghost.txt"), to: path.join(workDir, "ghost-2.txt") },
          { from: ok, to: path.join(workDir, "ok-2.txt") },
        ],
      });
      assert.equal(body.moved.length, 1);
      assert.equal(body.failed.length, 1);
      assert.equal(body.failed[0].code, "NOT_FOUND");
    });
  });

  await t.test("越权路径（家目录）→ failed 里是 FORBIDDEN_PATH，directory 没被搬走", async () => {
    await withServer(async ({ base, headers, workDir }) => {
      const { body } = await postMove(base, headers, {
        items: [{ from: os.homedir(), to: path.join(workDir, "stolen-home") }],
      });
      assert.equal(body.moved.length, 0);
      assert.equal(body.failed.length, 1);
      assert.equal(body.failed[0].code, "FORBIDDEN_PATH");
      assert.equal((await stat(os.homedir())).isDirectory(), true);
    });
  });
});

test("POST /api/fs/move 校验组", async (t) => {
  await t.test("非 JSON body → 400 BAD_BODY", async () => {
    await withServer(async ({ base, headers }) => {
      const { response, body } = await postMove(base, headers, "not json");
      assert.equal(response.status, 400);
      assert.equal(body.code, "BAD_BODY");
    });
  });

  await t.test("items 为空 / 不是数组 → 400 BAD_BODY", async () => {
    await withServer(async ({ base, headers }) => {
      for (const payload of [{}, { items: [] }, { items: "x" }, { items: [null] }, { items: [{ from: 1, to: 2 }] }]) {
        const { response, body } = await postMove(base, headers, payload);
        assert.equal(response.status, 400, JSON.stringify(payload));
        assert.equal(body.code, "BAD_BODY", JSON.stringify(payload));
      }
    });
  });

  await t.test(`items 超过 ${MAX_MOVE_ITEMS} 项 → 400 TOO_MANY_ITEMS`, async () => {
    await withServer(async ({ base, headers }) => {
      // 路径要短：http.mjs 的 JSON body 上限是 64KB，超了会先得 413（见下一个用例）。
      const items = Array.from({ length: MAX_MOVE_ITEMS + 1 }, (_, i) => ({
        from: `C:\\a${i}`,
        to: `C:\\b${i}`,
      }));
      const { response, body } = await postMove(base, headers, { items });
      assert.equal(response.status, 400);
      assert.equal(body.code, "TOO_MANY_ITEMS");
      assert.match(body.userText, new RegExp(String(MAX_MOVE_ITEMS)));
    });
  });

  await t.test("超 64KB 的 body → 413 BODY_TOO_LARGE（已知上限，不是 move 特有）", async () => {
    await withServer(async ({ base, headers }) => {
      const items = Array.from({ length: 400 }, (_, i) => ({
        from: `C:\\${`a`.repeat(80)}${i}`,
        to: `C:\\${`b`.repeat(80)}${i}`,
      }));
      const { response, body } = await postMove(base, headers, { items });
      assert.equal(response.status, 413);
      assert.equal(body.code, "BODY_TOO_LARGE");
    });
  });

  await t.test("正好 MAX_MOVE_ITEMS 项不被上限拦（边界是闭区间）", () => {
    const items = Array.from({ length: MAX_MOVE_ITEMS }, (_, i) => ({ from: `C:\\a${i}`, to: `C:\\b${i}` }));
    assert.equal(parseMoveBody({ items }).ok, true);
    assert.equal(parseMoveBody({ items: [...items, items[0]] }).code, "TOO_MANY_ITEMS");
  });

  await t.test("不带 token → 403（与其它 /api/fs 分支同一道门）", async () => {
    await withServer(async ({ base, workDir }) => {
      const response = await fetch(`${base}/api/fs/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ from: path.join(workDir, "a"), to: path.join(workDir, "b") }] }),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "FORBIDDEN");
    });
  });
});

test("POST /api/hosts/:id/fs/move 远程组", async (t) => {
  await t.test("远程批量移动 → 每项 NOT_SUPPORTED（不假装成功）", async () => {
    await withServer(async ({ base, headers }) => {
      // 未知主机：走的是「未实现」这条路（不是真连 SFTP），
      // 所以断言只针对形状与 code —— 这正是前端要显示「远程暂不支持」的来源。
      const response = await fetch(`${base}/api/hosts/h-nope/fs/move`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ items: [{ from: "/tmp/a", to: "/tmp/b" }] }),
      });
      // 未知主机会先被 handleRemoteFs 的 move 分支处理（不查主机表），
      // 但若上层先做了主机校验就是 404；两种都可接受，这里锁「不是 200 假成功」。
      const body = await response.json();
      if (response.status === 200) {
        assert.equal(body.moved.length, 0);
        assert.equal(body.failed.length, 1);
        assert.equal(body.failed[0].code, "NOT_SUPPORTED");
        assert.match(body.failed[0].userText, /远程/);
      } else {
        assert.equal(body.code, "HOST_NOT_FOUND");
      }
    });
  });
});

test("move 的纯函数组", async (t) => {
  await t.test("statusOf(TARGET_EXISTS) === 409", () => {
    assert.equal(statusOf("TARGET_EXISTS"), 409);
    assert.equal(statusOf("COPY_VERIFY_FAILED"), 400);
  });

  await t.test("parseMoveBody：合法输入原样带上 overwrite", () => {
    const parsed = parseMoveBody({ items: [{ from: "C:\\a", to: "C:\\b" }], overwrite: true });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.items, [{ from: "C:\\a", to: "C:\\b" }]);
    assert.equal(parsed.overwrite, true);
    // 不传 / 传非 true 一律按 false（默认不覆盖）。
    assert.equal(parseMoveBody({ items: [{ from: "a", to: "b" }] }).overwrite, false);
    assert.equal(parseMoveBody({ items: [{ from: "a", to: "b" }], overwrite: "yes" }).overwrite, false);
  });

  await t.test("runMoveItems：单项抛错不中断其它项", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mt-move-run-"));
    try {
      const a = path.join(dir, "a.txt");
      await writeFile(a, "a");
      const result = await runMoveItems(
        [
          { from: path.join(dir, "missing.txt"), to: path.join(dir, "moved-missing.txt") },
          { from: a, to: path.join(dir, "a-moved.txt") },
        ],
        false,
      );
      assert.equal(result.moved.length, 1);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].code, "NOT_FOUND");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
