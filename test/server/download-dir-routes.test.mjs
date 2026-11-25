// TASK-FIX17-L1 的「真 HTTP」行为锁：AC1–AC4 / AC7 / AC8 的服务端一半。
//
// 隔离手段（与 test/server/logs-route.test.mjs 同一套）：
//   - `MAGPIE_TERMINAL_CONFIG_PATH` → 临时 config.json（绝不碰用户真配置）；
//   - `MAGPIE_TERMINAL_LOG_DIR`     → 临时日志目录（绝不碰用户真日志）；
//   - 端口用随机空闲端口；token 用 startServer 进程内句柄给的（`x-magpie-term-token`）。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { CONFIG_PATH_ENV, defaultDownloadDir } from "../../src/config/store.mjs";
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

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/**
 * 起一个隔离服务。`log` 用静默 sink + 真 writer（日志文件落在临时目录）。
 * @param {{revealSpawn?:Function}} [extra]
 */
async function withService(fn, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mt-l1-"));
  const configFile = path.join(root, "config", "config.json");
  const logDir = path.join(root, "logs");
  const workDir = path.join(root, "work");
  const downloadDir = path.join(root, "downloads");
  await mkdir(workDir, { recursive: true });
  const previousConfig = process.env[CONFIG_PATH_ENV];
  const previousLog = process.env[LOG_DIR_ENV];
  process.env[CONFIG_PATH_ENV] = configFile;
  process.env[LOG_DIR_ENV] = logDir;
  const port = await freePort();
  const log = makeLogger({ log() {}, warn() {} }, { file: true, dedupeWindowMs: 0 });
  const handle = await startServer({ port, log, ...extra });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-magpie-term-token": handle.token };
  const api = async (pathname, init = {}) =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
    });
  const putConfig = (patch) => api("/api/config", { method: "PUT", body: JSON.stringify(patch) });
  try {
    return await fn({
      handle,
      base,
      headers,
      api,
      putConfig,
      root,
      workDir,
      downloadDir,
      logDir,
      logFile: path.join(logDir, "show-terminal.log"),
    });
  } finally {
    await handle.close();
    if (previousConfig === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previousConfig;
    if (previousLog === undefined) delete process.env[LOG_DIR_ENV];
    else process.env[LOG_DIR_ENV] = previousLog;
    await rm(root, { recursive: true, force: true });
  }
}

/* ================================ AC1 ================================ */

test("AC1：GET /api/config 返回 downloadDir:null + downloadDirDefault（本机真实路径）", async () => {
  await withService(async ({ api }) => {
    const response = await api("/api/config");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.downloadDir, null);
    assert.equal(body.downloadDirDefault, defaultDownloadDir());
    assert.ok(
      body.downloadDirDefault.startsWith(os.homedir()),
      `downloadDirDefault 必须在当前用户家目录下（实际 ${body.downloadDirDefault}）`,
    );
    // 不写死用户名：路径里不能出现「41807」这种家目录尾段之外的硬编码。
    assert.equal(body.downloadDirDefault, path.join(os.homedir(), "Downloads", "magpie-terminal"));
  });
});

/* ============================== AC2 ================================= */

test("AC2：PUT downloadDir 相对路径 → 400 INVALID_DOWNLOAD_DIR", async () => {
  await withService(async ({ api, putConfig }) => {
    const response = await putConfig({ downloadDir: "relative\\dir" });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "INVALID_DOWNLOAD_DIR");
    assert.match(body.userText, /绝对路径|留空/);
    // 失败不能顺手写进去。
    const view = await (await api("/api/config")).json();
    assert.equal(view.downloadDir, null);
  });
});

test("AC2：PUT downloadDir 超过 512 字符 → 400", async () => {
  await withService(async ({ putConfig }) => {
    const response = await putConfig({ downloadDir: `C:\\${"a".repeat(600)}` });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "INVALID_DOWNLOAD_DIR");
  });
});

test("AC2：PUT downloadDir 纯空白 → 存成 null（200）", async () => {
  await withService(async ({ api, putConfig }) => {
    const response = await putConfig({ downloadDir: "   " });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.downloadDir, null);
    assert.equal(body.downloadDirDefault, defaultDownloadDir());
    const view = await (await api("/api/config")).json();
    assert.equal(view.downloadDir, null);
  });
});

test("AC2：PUT 一个绝对路径 → 200，读回来是同一个目录（尾随分隔符被去掉）", async () => {
  await withService(async ({ api, putConfig, downloadDir }) => {
    const response = await putConfig({ downloadDir: `${downloadDir}\\` });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.downloadDir, downloadDir);
    const view = await (await api("/api/config")).json();
    assert.equal(view.downloadDir, downloadDir);
  });
});

/* ============================== AC3 ================================= */

test("AC3：设置目录后 POST /api/fs/save 真落盘，字节数与 sha256 与源文件相同", async () => {
  await withService(async ({ api, putConfig, workDir, downloadDir }) => {
    const src = path.join(workDir, "报告.txt");
    const payload = Buffer.from("第一行\n第二行\n".repeat(50), "utf8");
    await writeFile(src, payload);
    assert.equal((await putConfig({ downloadDir })).status, 200);

    const response = await api("/api/fs/save", { method: "POST", body: JSON.stringify({ path: src }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.ok === true && body.name, "报告.txt");
    assert.equal(body.savedPath, path.join(downloadDir, "报告.txt"));
    const written = await readFile(body.savedPath);
    assert.equal(body.bytes, payload.length);
    assert.equal(written.length, payload.length);
    assert.equal(sha256(written), sha256(payload));
  });
});

/* ============================== AC4 ================================= */

test("AC4：同名连续保存三次 → x.txt / x (1).txt / x (2).txt（真 HTTP）", async () => {
  await withService(async ({ api, putConfig, workDir, downloadDir }) => {
    const src = path.join(workDir, "x.txt");
    await writeFile(src, "same", "utf8");
    await putConfig({ downloadDir });
    const names = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await api("/api/fs/save", { method: "POST", body: JSON.stringify({ path: src }) });
      assert.equal(response.status, 200);
      names.push((await response.json()).name);
    }
    assert.deepEqual(names, ["x.txt", "x (1).txt", "x (2).txt"]);
    assert.deepEqual((await readdir(downloadDir)).sort(), ["x (1).txt", "x (2).txt", "x.txt"]);
  });
});

/* =========================== NO_DOWNLOAD_DIR ========================= */

test("AC5（服务端）：未设置目录时 POST /api/fs/save → 200 {ok:false, code:NO_DOWNLOAD_DIR}", async () => {
  await withService(async ({ api, workDir }) => {
    const src = path.join(workDir, "a.txt");
    await writeFile(src, "a", "utf8");
    const response = await api("/api/fs/save", { method: "POST", body: JSON.stringify({ path: src }) });
    assert.equal(response.status, 200, "200 不是错误：前端据此回落浏览器下载");
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "NO_DOWNLOAD_DIR");
    assert.match(body.userText, /下载目录/);
  });
});

test("R2：源不存在 → 404 NOT_FOUND；源是目录 → 400 IS_DIRECTORY；目录不可写 → 400 DOWNLOAD_DIR_UNWRITABLE", async () => {
  await withService(async ({ api, putConfig, workDir, downloadDir }) => {
    await putConfig({ downloadDir });
    const missing = await api("/api/fs/save", {
      method: "POST",
      body: JSON.stringify({ path: path.join(workDir, "nope.txt") }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "NOT_FOUND");

    await mkdir(path.join(workDir, "sub"));
    const isDir = await api("/api/fs/save", {
      method: "POST",
      body: JSON.stringify({ path: path.join(workDir, "sub") }),
    });
    assert.equal(isDir.status, 400);
    const isDirBody = await isDir.json();
    assert.equal(isDirBody.code, "IS_DIRECTORY");
    assert.match(isDirBody.userText, /批量下载/);

    // 下载目录指向一个**文件**：mkdir 必然失败 → DOWNLOAD_DIR_UNWRITABLE。
    const blocker = path.join(workDir, "not-a-dir");
    await writeFile(blocker, "x", "utf8");
    await putConfig({ downloadDir: blocker });
    const src = path.join(workDir, "a.txt");
    await writeFile(src, "a", "utf8");
    const unwritable = await api("/api/fs/save", { method: "POST", body: JSON.stringify({ path: src }) });
    assert.equal(unwritable.status, 400);
    const unwritableBody = await unwritable.json();
    assert.equal(unwritableBody.code, "DOWNLOAD_DIR_UNWRITABLE");
    assert.ok(unwritableBody.userText.includes(blocker), "提示里要有完整目录");
  });
});

test("R2：请求体不是 JSON 对象 → 400 BAD_BODY；路径是相对路径 → 400 INVALID_PATH", async () => {
  await withService(async ({ api, putConfig, downloadDir }) => {
    await putConfig({ downloadDir });
    const bad = await api("/api/fs/save", { method: "POST", body: "not-json" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "BAD_BODY");
    const relative = await api("/api/fs/save", { method: "POST", body: JSON.stringify({ path: "a.txt" }) });
    assert.equal(relative.status, 400);
    assert.equal((await relative.json()).code, "INVALID_PATH");
  });
});

/* ============================ R3（远程） ============================= */

test("R3：远程保存未设置目录 → 200 {ok:false, NO_DOWNLOAD_DIR}（不白连一次 SSH）", async () => {
  await withService(async ({ api }) => {
    const response = await api("/api/hosts/h-unknown/fs/save", {
      method: "POST",
      body: JSON.stringify({ path: "/remote/a.txt" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "NO_DOWNLOAD_DIR");
  });
});

test("R3：远程保存设了目录但主机不存在 → 404 HOST_NOT_FOUND", async () => {
  await withService(async ({ api, putConfig, downloadDir }) => {
    await putConfig({ downloadDir });
    const response = await api("/api/hosts/h-unknown/fs/save", {
      method: "POST",
      body: JSON.stringify({ path: "/remote/a.txt" }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "HOST_NOT_FOUND");
  });
});

/* ============================== AC7 ================================= */

test("AC7：POST /api/logs/export-to-dir 落盘，内容与 GET /api/logs/export 同源（脱敏后）", async () => {
  await withService(async ({ api, putConfig, downloadDir, handle, logFile }) => {
    // 造两行可识别的日志（其中一行带 token 形态的串，验证导出前二次脱敏）。
    handle.log({ level: "info", code: "SEEDED_LINE_1", msg: "hello download dir", marker: "A" });
    handle.log({
      level: "info",
      code: "SEEDED_LINE_2",
      msg: "token should be redacted",
      token: "deadbeef".repeat(8),
    });
    assert.equal((await putConfig({ downloadDir })).status, 200);

    const response = await api("/api/logs/export-to-dir", { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(body.bytes > 0, "文件大小必须 > 0");
    assert.match(body.name, /^show-terminal-logs-\d{8}-\d{6}\.log$/);
    assert.equal(body.savedPath, path.join(downloadDir, body.name));

    const written = await readFile(body.savedPath, "utf8");
    assert.ok(written.length > 0);
    assert.match(written, /SEEDED_LINE_1/);
    assert.match(written, /SEEDED_LINE_2/);
    assert.ok(!written.includes("deadbeef"), "导出前必须再脱敏一次");
    // 与 GET 导出同源：GET 的正文以我们刚落的那些行为前缀（GET 自己也会多记一行）。
    const exported = await (await api("/api/logs/export")).text();
    const writtenLines = written.split("\n").filter((line) => line.length > 0);
    const exportedLines = exported.split("\n").filter((line) => line.length > 0);
    for (const line of writtenLines) {
      assert.ok(exportedLines.includes(line), "导出文件里的每一行都必须能在 GET /api/logs/export 正文里找到");
    }
    assert.match(exported, /SEEDED_LINE_2/);
    assert.ok((await stat(logFile)).size > 0, "日志文件本身也要有内容");
  });
});

test("AC7：未设置目录时 POST /api/logs/export-to-dir → 400 NO_DOWNLOAD_DIR", async () => {
  await withService(async ({ api }) => {
    const response = await api("/api/logs/export-to-dir", { method: "POST", body: "{}" });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "NO_DOWNLOAD_DIR");
  });
});

test("AC7：目录写不进去 → 500 LOGS_EXPORT_FAILED（不带 stack）", async () => {
  await withService(async ({ api, putConfig, workDir }) => {
    const blocker = path.join(workDir, "not-a-dir");
    await writeFile(blocker, "x", "utf8");
    await putConfig({ downloadDir: blocker });
    const response = await api("/api/logs/export-to-dir", { method: "POST", body: "{}" });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, "LOGS_EXPORT_FAILED");
    assert.ok(!JSON.stringify(body).includes("at "), "错误响应不许带 stack");
  });
});

/* ============================== AC8 ================================= */

test("AC8：POST /api/fs/reveal —— 范围内交给注入的 spawn（`/select,<path>`），范围外 400", async () => {
  const calls = [];
  const revealSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {} };
  };
  await withService(
    async ({ api, putConfig, workDir, downloadDir }) => {
      const src = path.join(workDir, "r.txt");
      await writeFile(src, "r", "utf8");
      await putConfig({ downloadDir });
      const saved = await (await api("/api/fs/save", { method: "POST", body: JSON.stringify({ path: src }) })).json();

      const ok = await api("/api/fs/reveal", { method: "POST", body: JSON.stringify({ path: saved.savedPath }) });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, revealed: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, "explorer.exe");
      assert.deepEqual(calls[0].args, [`/select,${saved.savedPath}`], "文件要用 /select, 前缀");

      // 目录本身：用目录路径（不带 /select,）。
      const asDir = await api("/api/fs/reveal", { method: "POST", body: JSON.stringify({ path: downloadDir }) });
      assert.equal(asDir.status, 200);
      assert.deepEqual(calls[1].args, [downloadDir]);

      // 范围外：既不 200，也不 spawn。
      const outside = await api("/api/fs/reveal", {
        method: "POST",
        body: JSON.stringify({ path: path.join(workDir, "r.txt") }),
      });
      assert.equal(outside.status, 400);
      assert.equal((await outside.json()).code, "REVEAL_OUT_OF_SCOPE");
      assert.equal(calls.length, 2, "范围外的路径绝不能触发 spawn");

      // 前缀相似但不相干的兄弟目录也不能过。
      const sibling = await api("/api/fs/reveal", {
        method: "POST",
        body: JSON.stringify({ path: `${downloadDir}2\\x.txt` }),
      });
      assert.equal(sibling.status, 400);
    },
    { revealSpawn },
  );
});

test("AC8：未设置目录时 POST /api/fs/reveal 一律 400（不 spawn）", async () => {
  const calls = [];
  await withService(
    async ({ api, workDir }) => {
      const response = await api("/api/fs/reveal", {
        method: "POST",
        body: JSON.stringify({ path: path.join(workDir, "a.txt") }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "REVEAL_OUT_OF_SCOPE");
      assert.equal(calls.length, 0);
    },
    { revealSpawn: (...args) => (calls.push(args), { unref() {} }) },
  );
});

/* ============================== 鉴权 ================================ */

test("四个新路由都在 token 门之后（无 token → 403）", async () => {
  await withService(async ({ base }) => {
    for (const [pathname, method] of [
      ["/api/fs/save", "POST"],
      ["/api/fs/reveal", "POST"],
      ["/api/logs/export-to-dir", "POST"],
      ["/api/hosts/h-1/fs/save", "POST"],
    ]) {
      const response = await fetch(`${base}${pathname}`, {
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 403, `${pathname} 必须要求 token`);
    }
  });
});
