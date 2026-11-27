// src/fs/reveal.mjs 的行为锁（TASK-FIX17-L1 R6 / AC8）。
//
// 这里**只**断言 argv 与 spawn 参数：注入的 spawnImpl 什么都不开，
// 所以跑一遍单测不会弹出任何资源管理器窗口。
//
// 路径夹具必须按**目标平台**的语义构造（path.win32 / path.posix 显式挑），
// 不能用宿主 `path.join` 拼 Windows 路径：在 Linux 上会拼出
// `C:\Users\x\Downloads\magpie-terminal/a.txt` 这种混合分隔符，isPathInside 会误判。

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isPathInside, revealArgv, revealPath } from "../../src/fs/reveal.mjs";

const DL_WIN = "C:\\Users\\x\\Downloads\\magpie-terminal";
const DL_POSIX = "/home/x/dl";

test("AC8：isPathInside —— 目录内 / 目录本身算在内；外面 / 前缀相似不算", () => {
  const opts = { platform: "win32" };
  assert.equal(isPathInside(DL_WIN, path.win32.join(DL_WIN, "a.txt"), opts), true);
  assert.equal(isPathInside(DL_WIN, DL_WIN, opts), true);
  assert.equal(isPathInside(DL_WIN, path.win32.join(DL_WIN, "sub", "b.txt"), opts), true);
  assert.equal(
    isPathInside(DL_WIN, "C:\\Users\\x\\Downloads\\magpie-terminal2\\a.txt", opts),
    false,
  );
  assert.equal(isPathInside(DL_WIN, "C:\\Users\\x\\Downloads\\a.txt", opts), false);
  assert.equal(isPathInside(DL_WIN, "C:\\Windows\\System32\\cmd.exe", opts), false);
  assert.equal(isPathInside(DL_WIN, "relative\\a.txt", opts), false);
  assert.equal(isPathInside(null, "C:\\x", opts), false);
  assert.equal(isPathInside(DL_WIN, "", opts), false);
  // `..` 还原后落在外面 → 不算在内。
  assert.equal(isPathInside(DL_WIN, path.win32.join(DL_WIN, "..", "escape.txt"), opts), false);
});

test("AC8：isPathInside POSIX 语义 —— 目录内算在内，前缀相似 / 外部 / 相对路径不算", () => {
  const opts = { platform: "linux" };
  assert.equal(isPathInside(DL_POSIX, path.posix.join(DL_POSIX, "a.txt"), opts), true);
  // 目录本身算在内。
  assert.equal(isPathInside(DL_POSIX, DL_POSIX, opts), true);
  assert.equal(isPathInside(DL_POSIX, path.posix.join(DL_POSIX, "sub", "b.txt"), opts), true);
  // 前缀相似但不是子路径。
  assert.equal(isPathInside(DL_POSIX, "/home/x/dl2/a.txt", opts), false);
  // 完全在外面的系统文件。
  assert.equal(isPathInside(DL_POSIX, "/etc/passwd", opts), false);
  // 相对路径一律不合法。
  assert.equal(isPathInside(DL_POSIX, "a.txt", opts), false);
  assert.equal(isPathInside(DL_POSIX, "relative/a.txt", opts), false);
  // `..` 逃逸后落在外面。
  assert.equal(isPathInside(DL_POSIX, path.posix.join(DL_POSIX, "..", "escape.txt"), opts), false);
  // 空值。
  assert.equal(isPathInside(null, "/home/x/dl/a.txt", opts), false);
  assert.equal(isPathInside(DL_POSIX, "", opts), false);
});

test("AC8：Windows 文件用 explorer.exe + `/select,<path>`（单个 argv）", () => {
  const file = path.win32.join(DL_WIN, "下载 报告.txt");
  const { command, args } = revealArgv(file, { platform: "win32", isDirectory: false });
  assert.equal(command, "explorer.exe");
  assert.deepEqual(args, [`/select,${file}`]);
});

test("AC8：Windows 目录用目录本身（不能加 /select,）", () => {
  const { command, args } = revealArgv(DL_WIN, { platform: "win32", isDirectory: true });
  assert.equal(command, "explorer.exe");
  assert.deepEqual(args, [DL_WIN]);
});

test("R6：非 Windows 平台用 open / xdg-open 打开所在目录", () => {
  assert.deepEqual(revealArgv("/home/x/dl/a.txt", { platform: "darwin", isDirectory: false }), {
    command: "open",
    args: ["-R", "/home/x/dl/a.txt"],
  });
  assert.deepEqual(revealArgv("/home/x/dl", { platform: "darwin", isDirectory: true }), {
    command: "open",
    args: ["/home/x/dl"],
  });
  assert.deepEqual(revealArgv("/home/x/dl/a.txt", { platform: "linux", isDirectory: false }), {
    command: "xdg-open",
    args: ["/home/x/dl"],
  });
});

test("AC8：revealPath 把 argv 原样交给注入的 spawn，并 detached/unref 不拖住服务", () => {
  const calls = [];
  let unrefCalled = false;
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      unref() {
        unrefCalled = true;
      },
    };
  };
  const target = path.win32.join(DL_WIN, "a.txt");
  const result = revealPath(target, { spawnImpl: fakeSpawn, platform: "win32", isDirectory: false });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "explorer.exe");
  assert.deepEqual(calls[0].args, [`/select,${target}`]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(unrefCalled, true, "必须 unref：文件管理器窗口不能拦住进程退出");
});
