// src/fs/reveal.mjs 的行为锁（TASK-FIX17-L1 R6 / AC8）。
//
// 这里**只**断言 argv 与 spawn 参数：注入的 spawnImpl 什么都不开，
// 所以跑一遍单测不会弹出任何资源管理器窗口。

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isPathInside, revealArgv, revealPath } from "../../src/fs/reveal.mjs";

const DL = "C:\\Users\\x\\Downloads\\magpie-terminal";

test("AC8：isPathInside —— 目录内 / 目录本身算在内；外面 / 前缀相似不算", () => {
  assert.equal(isPathInside(DL, path.join(DL, "a.txt")), true);
  assert.equal(isPathInside(DL, DL), true);
  assert.equal(isPathInside(DL, path.join(DL, "sub", "b.txt")), true);
  assert.equal(isPathInside(DL, "C:\\Users\\x\\Downloads\\magpie-terminal2\\a.txt"), false);
  assert.equal(isPathInside(DL, "C:\\Users\\x\\Downloads\\a.txt"), false);
  assert.equal(isPathInside(DL, "C:\\Windows\\System32\\cmd.exe"), false);
  assert.equal(isPathInside(DL, "relative\\a.txt"), false);
  assert.equal(isPathInside(null, "C:\\x"), false);
  assert.equal(isPathInside(DL, ""), false);
  // `..` 还原后落在外面 → 不算在内。
  assert.equal(isPathInside(DL, path.join(DL, "..", "escape.txt")), false);
});

test("AC8：Windows 文件用 explorer.exe + `/select,<path>`（单个 argv）", () => {
  const file = path.join(DL, "下载 报告.txt");
  const { command, args } = revealArgv(file, { platform: "win32", isDirectory: false });
  assert.equal(command, "explorer.exe");
  assert.deepEqual(args, [`/select,${file}`]);
});

test("AC8：Windows 目录用目录本身（不能加 /select,）", () => {
  const { command, args } = revealArgv(DL, { platform: "win32", isDirectory: true });
  assert.equal(command, "explorer.exe");
  assert.deepEqual(args, [DL]);
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
  const target = path.join(DL, "a.txt");
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
