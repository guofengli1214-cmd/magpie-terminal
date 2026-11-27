// src/fs/export.mjs 的行为锁（TASK-FIX17-L1 R2 / R3 / R4 的重名策略 / R5）。
//
// 全部在 os.tmpdir() 下的临时目录里跑；远程分支靠注入 `downloadRemote` 假装
// 拿到一条流 —— 不连 SSH、不建真实主机。

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import {
  UNIQUE_MAX_TRIES,
  candidateName,
  resolveUniqueTarget,
  saveRemoteFile,
  saveTextToDir,
  splitFileName,
} from "../../src/fs/export.mjs";

async function tempDir(prefix = "mt-export-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/* ------------------------------ 命名规则 ------------------------------ */

test("splitFileName：a.tar.gz 只切最后一个点；点文件不当扩展名", () => {
  assert.deepEqual(splitFileName("a.tar.gz"), { stem: "a.tar", ext: ".gz" });
  assert.deepEqual(splitFileName("x.txt"), { stem: "x", ext: ".txt" });
  assert.deepEqual(splitFileName(".bashrc"), { stem: ".bashrc", ext: "" });
  assert.deepEqual(splitFileName("noext"), { stem: "noext", ext: "" });
});

test("AC4：candidateName → name、name (1).ext、name (2).ext", () => {
  assert.equal(candidateName("x.txt", 0), "x.txt");
  assert.equal(candidateName("x.txt", 1), "x (1).txt");
  assert.equal(candidateName("x.txt", 2), "x (2).txt");
  assert.equal(candidateName("a.tar.gz", 3), "a.tar (3).gz");
});

test("AC4：resolveUniqueTarget 跳过已存在的名字（exists 注入，不落盘）", async () => {
  const dir = path.resolve(os.tmpdir(), "fake-dir");
  const taken = new Set([path.join(dir, "x.txt"), path.join(dir, "x (1).txt")]);
  const got = await resolveUniqueTarget(dir, "x.txt", { exists: async (p) => taken.has(p) });
  assert.equal(got.name, "x (2).txt");
  assert.equal(got.target, path.join(dir, "x (2).txt"));
});

test("resolveUniqueTarget：撞满 maxTries 次就报 TOO_MANY_DUPLICATES，不无限循环", async () => {
  const dir = path.resolve(os.tmpdir(), "fake-dir");
  await assert.rejects(
    () => resolveUniqueTarget(dir, "x.txt", { exists: async () => true, maxTries: 3 }),
    (err) => {
      assert.equal(err.code, "TOO_MANY_DUPLICATES");
      assert.match(err.userText, /同名/);
      return true;
    },
  );
  assert.equal(UNIQUE_MAX_TRIES, 999);
});

/* ------------------------------ 日志文本 ------------------------------ */

test("R5：saveTextToDir 写日志文本，重名自动加序号", async (t) => {
  const out = await tempDir("mt-export-out-");
  t.after(() => rm(out, { recursive: true, force: true }));
  const first = await saveTextToDir("line1\nline2\n", out, "show-terminal-logs-20260101-000000.log");
  const second = await saveTextToDir("x", out, "show-terminal-logs-20260101-000000.log");
  assert.equal(first.name, "show-terminal-logs-20260101-000000.log");
  assert.equal(second.name, "show-terminal-logs-20260101-000000 (1).log");
  assert.equal(first.bytes, Buffer.byteLength("line1\nline2\n"));
  assert.equal(await readFile(first.savedPath, "utf8"), "line1\nline2\n");
});

/* ------------------------------ 远程保存 ------------------------------ */

function fakeRemote(body, size) {
  return async () => ({ path: "/remote/a.txt", size: size ?? Buffer.byteLength(body), stream: Readable.from([Buffer.from(body, "utf8")]) });
}

test("R3：saveRemoteFile 先写 .part 再 rename 成最终名，成功后不留下 .part", async (t) => {
  const out = await tempDir("mt-export-out-");
  const work = await tempDir();
  t.after(async () => {
    await rm(out, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });
  const body = "remote payload";
  const result = await saveRemoteFile("h-1", "/remote/a.txt", out, {
    downloadRemote: fakeRemote(body),
  });
  assert.equal(result.name, "a.txt");
  assert.equal(result.path ?? result.savedPath, path.join(out, "a.txt"));
  assert.equal(await readFile(result.savedPath, "utf8"), body);
  const left = await readdir(out);
  assert.deepEqual(left, ["a.txt"], ".part 必须被 rename 掉，不留垃圾");
  // 第二次同源 → a (1).txt
  const again = await saveRemoteFile("h-1", "/remote/a.txt", out, { downloadRemote: fakeRemote(body) });
  assert.equal(again.name, "a (1).txt");
});

test("R3：跨设备 rename 失败（EXDEV）→ 复制成最终名并清掉 .part", async (t) => {
  const out = await tempDir("mt-export-out-");
  t.after(() => rm(out, { recursive: true, force: true }));
  const result = await saveRemoteFile("h-1", "/remote/b.txt", out, {
    downloadRemote: fakeRemote("payload"),
    rename: async () => {
      const err = new Error("cross-device");
      err.code = "EXDEV";
      throw err;
    },
  });
  assert.equal(result.name, "b.txt");
  assert.equal(await readFile(result.savedPath, "utf8"), "payload");
  assert.deepEqual(await readdir(out), ["b.txt"]);
});

test("R3：传输中断 → .part 清掉 + TRANSFER_FAILED（不留半截文件）", async (t) => {
  const out = await tempDir("mt-export-out-");
  t.after(() => rm(out, { recursive: true, force: true }));
  const broken = Readable.from(
    (async function* () {
      yield Buffer.from("half", "utf8");
      throw new Error("socket hangup");
    })(),
  );
  await assert.rejects(
    () =>
      saveRemoteFile("h-1", "/remote/c.txt", out, {
        downloadRemote: async () => ({ path: "/remote/c.txt", size: 10, stream: broken }),
      }),
    (err) => {
      assert.equal(err.code, "TRANSFER_FAILED");
      return true;
    },
  );
  assert.deepEqual(await readdir(out), []);
});

test("R3：连接失败 → HOST_UNREACHABLE；主机不存在 → 原样 HOST_NOT_FOUND", async (t) => {
  const out = await tempDir("mt-export-out-");
  t.after(() => rm(out, { recursive: true, force: true }));
  const withCode = (code) => {
    const err = new Error(code);
    err.code = code;
    err.userText = code;
    return err;
  };
  await assert.rejects(
    () =>
      saveRemoteFile("h-1", "/remote/a.txt", out, {
        downloadRemote: async () => {
          throw withCode("SSH_CONNECT_REFUSED");
        },
      }),
    (err) => {
      assert.equal(err.code, "HOST_UNREACHABLE");
      return true;
    },
  );
  await assert.rejects(
    () =>
      saveRemoteFile("h-1", "/remote/a.txt", out, {
        downloadRemote: async () => {
          throw withCode("HOST_NOT_FOUND");
        },
      }),
    (err) => {
      assert.equal(err.code, "HOST_NOT_FOUND");
      return true;
    },
  );
});

test("R3：远程没设下载目录 → NO_DOWNLOAD_DIR（不白跑一次 SSH）", async (t) => {
  let called = false;
  await assert.rejects(
    () =>
      saveRemoteFile("h-1", "/remote/a.txt", "", {
        downloadRemote: async () => {
          called = true;
          return fakeRemote("x")();
        },
      }),
    (err) => {
      assert.equal(err.code, "NO_DOWNLOAD_DIR");
      return true;
    },
  );
  assert.equal(called, false);
});

test("R3：远端「没有这个路径」→ NOT_FOUND（sftp 的 wrapErr 会把 code 改成 NOT_FOUND）", async (t) => {
  const out = await tempDir("mt-export-out-");
  t.after(() => rm(out, { recursive: true, force: true }));
  const withCode = (code) => {
    const err = new Error(code);
    err.code = code;
    err.userText = code;
    return err;
  };
  for (const code of ["NOT_FOUND", "NO_PERMISSION"]) {
    await assert.rejects(
      () =>
        saveRemoteFile("h-1", "/remote/a.txt", out, {
          downloadRemote: async () => {
            throw withCode(code);
          },
        }),
      (err) => {
        assert.equal(err.code, code, `${code} 必须原样透出，不能翻成 HOST_UNREACHABLE`);
        return true;
      },
    );
  }
});
