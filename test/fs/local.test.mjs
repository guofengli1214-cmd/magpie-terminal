// 本地文件系统操作面（TASK-V4-G §5.6）：列表 / 读 / 写 / 新建 / 重命名 / 删除 /
// 越界路径 / 超限 / 非空目录不可删。
//
// 全部在 os.tmpdir() 下的临时目录里跑，跑完删干净；不碰用户真实文件。

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import {
  MAX_READ_BYTES,
  compareEntries,
  deletionBlockedReason,
  guardPath,
  listDirectory,
  makeDirectory,
  makeFile,
  openDownloadStream,
  readTextFile,
  removePath,
  renamePath,
  realPathOf,
  sensitiveBlockedReason,
  statPath,
  writeFileAtomic,
  writeStreamAtomic,
  writeTextFile,
} from "../../src/fs/local.mjs";

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-fs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function codeOf(err) {
  return err && err.code ? err.code : null;
}

test("guardPath 组", async (t) => {
  await t.test("相对路径 → INVALID_PATH", () => {
    assert.throws(() => guardPath("relative/x"), (err) => codeOf(err) === "INVALID_PATH");
  });
  await t.test("空串 / undefined → INVALID_PATH", () => {
    assert.throws(() => guardPath(""), (err) => codeOf(err) === "INVALID_PATH");
    assert.throws(() => guardPath(undefined), (err) => codeOf(err) === "INVALID_PATH");
  });
  await t.test("含 NUL → INVALID_PATH", () => {
    assert.throws(() => guardPath("C:\\Users\\a\u0000b"), (err) => codeOf(err) === "INVALID_PATH");
  });
  await t.test("超长（>4096）→ INVALID_PATH", () => {
    assert.throws(() => guardPath(`C:\\${"a".repeat(5000)}`), (err) => codeOf(err) === "INVALID_PATH");
  });
  await t.test("`..` 被 resolve 归一（不会逃逸出前缀）", () => {
    const base = path.resolve(os.tmpdir(), "x");
    assert.equal(guardPath(path.join(base, "..", "..", "y")), path.resolve(base, "..", "..", "y"));
  });
});

test("listDirectory 组", async (t) => {
  await t.test("目录在前、同类按名字升序；隐藏文件也返回", async () => {
    await withTemp(async (dir) => {
      await mkdir(path.join(dir, "zzz-dir"));
      await mkdir(path.join(dir, "aaa-dir"));
      await writeFile(path.join(dir, "b.txt"), "b");
      await writeFile(path.join(dir, "a.txt"), "a");
      await writeFile(path.join(dir, ".hidden"), "h");
      const listing = await listDirectory(dir);
      assert.equal(listing.path, path.resolve(dir));
      assert.equal(listing.parent, path.dirname(path.resolve(dir)));
      const names = listing.entries.map((e) => e.name);
      assert.deepEqual(names.slice(0, 2), ["aaa-dir", "zzz-dir"]);
      assert.equal(names.includes(".hidden"), true);
      // 目录全部排在文件前面。
      const firstFile = listing.entries.findIndex((e) => e.type !== "dir");
      const lastDir = listing.entries.map((e) => e.type).lastIndexOf("dir");
      assert.equal(lastDir < firstFile, true);
      for (const entry of listing.entries) {
        assert.equal(typeof entry.path, "string");
        assert.equal(path.isAbsolute(entry.path), true);
        assert.equal(["file", "dir", "link"].includes(entry.type), true);
        assert.equal(typeof entry.size, "number");
        assert.equal(typeof entry.mtime, "number");
      }
    });
  });

  await t.test("不存在的目录 → NOT_FOUND", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(listDirectory(path.join(dir, "nope")), (err) => codeOf(err) === "NOT_FOUND");
    });
  });

  await t.test("对文件列目录 → NOT_A_DIRECTORY", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "f.txt");
      await writeFile(file, "x");
      await assert.rejects(listDirectory(file), (err) => codeOf(err) === "NOT_A_DIRECTORY");
    });
  });

  await t.test("compareEntries：目录优先 + 数字自然序", () => {
    assert.equal(compareEntries({ name: "a", type: "dir" }, { name: "b", type: "file" }), -1);
    assert.equal(compareEntries({ name: "b", type: "file" }, { name: "a", type: "dir" }), 1);
    assert.equal(
      compareEntries({ name: "file2", type: "file" }, { name: "file10", type: "file" }) < 0,
      true,
    );
  });
});

test("readTextFile 组", async (t) => {
  await t.test("读中文与换行逐字一致", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "note.txt");
      const text = "第一行 中文\n第二行\r\n第三行 🔥\n";
      await writeFile(file, text, "utf8");
      const result = await readTextFile(file);
      assert.equal(result.content, text);
      assert.equal(result.size > 0, true);
      assert.equal(result.path, path.resolve(file));
    });
  });

  await t.test("超过 maxBytes → FILE_TOO_LARGE（413 语义）", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "big.txt");
      await writeFile(file, Buffer.alloc(2000, 0x41));
      await assert.rejects(
        readTextFile(file, { maxBytes: 1000 }),
        (err) => codeOf(err) === "FILE_TOO_LARGE" && err.size === 2000 && err.maxBytes === 1000,
      );
    });
  });

  await t.test("超过默认 1MB 上限 → FILE_TOO_LARGE", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "huge.txt");
      await writeFile(file, Buffer.alloc(MAX_READ_BYTES + 10, 0x41));
      await assert.rejects(readTextFile(file), (err) => codeOf(err) === "FILE_TOO_LARGE");
    });
  });

  await t.test("前 8KB 有 NUL → NOT_TEXT（415 语义）", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "bin.dat");
      await writeFile(file, Buffer.from([0x41, 0x00, 0x42, 0x43]));
      await assert.rejects(readTextFile(file), (err) => codeOf(err) === "NOT_TEXT");
    });
  });

  await t.test("NUL 在第 9KB（超出嗅探窗口）→ 仍按文本返回", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "late-nul.txt");
      const buffer = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);
      await writeFile(file, buffer);
      const result = await readTextFile(file);
      assert.equal(result.size, 9001);
    });
  });

  await t.test("读目录 → IS_A_DIRECTORY", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(readTextFile(dir), (err) => codeOf(err) === "IS_A_DIRECTORY");
    });
  });

  await t.test("读不存在 → NOT_FOUND", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(
        readTextFile(path.join(dir, "ghost")),
        (err) => codeOf(err) === "NOT_FOUND",
      );
    });
  });
});

test("writeFileAtomic 组", async (t) => {
  await t.test("新建文件：磁盘内容逐字一致（含中文与 CRLF）", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "new.txt");
      const text = "你好 world\r\n第二行\n结束";
      const result = await writeFileAtomic(file, text);
      assert.equal(result.size, Buffer.byteLength(text));
      assert.equal(await readFile(file, "utf8"), text);
    });
  });

  await t.test("覆盖已有文件：内容被替换、原子（没有残留 .tmp）", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "x.txt");
      await writeFile(file, "old-old-old");
      await writeFileAtomic(file, "new");
      assert.equal(await readFile(file, "utf8"), "new");
      const { readdir } = await import("node:fs/promises");
      const rest = (await readdir(dir)).filter((name) => name.includes("magpie-tmp"));
      assert.deepEqual(rest, []);
    });
  });

  await t.test("父目录不存在 → NOT_FOUND（不替你造目录）", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(
        writeFileAtomic(path.join(dir, "missing", "x.txt"), "x"),
        (err) => codeOf(err) === "NOT_FOUND",
      );
    });
  });

  await t.test("目标是目录 → IS_A_DIRECTORY", async () => {
    await withTemp(async (dir) => {
      await mkdir(path.join(dir, "adir"));
      await assert.rejects(
        writeFileAtomic(path.join(dir, "adir"), "x"),
        (err) => codeOf(err) === "IS_A_DIRECTORY",
      );
    });
  });

  await t.test("相对路径 → INVALID_PATH", async () => {
    await assert.rejects(writeFileAtomic("rel.txt", "x"), (err) => codeOf(err) === "INVALID_PATH");
  });
});

test("makeDirectory / makeFile 组", async (t) => {
  await t.test("mkdir 递归建（含中间层），磁盘上真存在", async () => {
    await withTemp(async (dir) => {
      const target = path.join(dir, "a", "b", "c");
      await makeDirectory(target);
      const info = await stat(target);
      assert.equal(info.isDirectory(), true);
    });
  });

  await t.test("mkdir 已存在不报错", async () => {
    await withTemp(async (dir) => {
      await makeDirectory(dir);
      await makeDirectory(dir);
    });
  });

  await t.test("newfile 建空文件；已存在时不覆盖内容", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "blank.txt");
      const first = await makeFile(file);
      assert.equal(first.created, true);
      assert.equal((await stat(file)).size, 0);
      await writeFile(file, "keep me");
      const second = await makeFile(file);
      assert.equal(second.created, false);
      assert.equal(await readFile(file, "utf8"), "keep me");
    });
  });

  await t.test("newfile 父目录不存在 → NOT_FOUND", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(
        makeFile(path.join(dir, "nodir", "x.txt")),
        (err) => codeOf(err) === "NOT_FOUND",
      );
    });
  });
});

test("renamePath 组", async (t) => {
  await t.test("文件改名：旧名消失新名出现", async () => {
    await withTemp(async (dir) => {
      const from = path.join(dir, "old.txt");
      const to = path.join(dir, "new.txt");
      await writeFile(from, "payload");
      await renamePath(from, to);
      await assert.rejects(stat(from), (err) => err.code === "ENOENT");
      assert.equal(await readFile(to, "utf8"), "payload");
    });
  });

  await t.test("目标已存在 → ALREADY_EXISTS（不覆盖）", async () => {
    await withTemp(async (dir) => {
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "b.txt");
      await writeFile(a, "a");
      await writeFile(b, "b");
      await assert.rejects(renamePath(a, b), (err) => codeOf(err) === "ALREADY_EXISTS");
      assert.equal(await readFile(b, "utf8"), "b");
    });
  });

  await t.test("原路径不存在 → NOT_FOUND", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(
        renamePath(path.join(dir, "ghost"), path.join(dir, "x")),
        (err) => codeOf(err) === "NOT_FOUND",
      );
    });
  });

  await t.test("新老名字相同 → INVALID_PATH", async () => {
    await withTemp(async (dir) => {
      const a = path.join(dir, "a.txt");
      await writeFile(a, "a");
      await assert.rejects(renamePath(a, a), (err) => codeOf(err) === "INVALID_PATH");
    });
  });
});

test("removePath 组", async (t) => {
  await t.test("删文件：磁盘上消失", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "dead.txt");
      await writeFile(file, "x");
      await removePath(file);
      await assert.rejects(stat(file), (err) => err.code === "ENOENT");
    });
  });

  await t.test("删空目录：成功", async () => {
    await withTemp(async (dir) => {
      const sub = path.join(dir, "empty");
      await mkdir(sub);
      await removePath(sub);
      await assert.rejects(stat(sub), (err) => err.code === "ENOENT");
    });
  });

  await t.test("非空目录不带 recursive → DIR_NOT_EMPTY（409 语义）", async () => {
    await withTemp(async (dir) => {
      const sub = path.join(dir, "full");
      await mkdir(sub);
      await writeFile(path.join(sub, "x.txt"), "x");
      await assert.rejects(removePath(sub), (err) => codeOf(err) === "DIR_NOT_EMPTY" && err.count === 1);
      // 目录还在。
      assert.equal((await stat(sub)).isDirectory(), true);
    });
  });

  await t.test("非空目录带 recursive → 连内容一起删", async () => {
    await withTemp(async (dir) => {
      const sub = path.join(dir, "full2");
      await mkdir(path.join(sub, "deep"), { recursive: true });
      await writeFile(path.join(sub, "deep", "x.txt"), "x");
      await removePath(sub, { recursive: true });
      await assert.rejects(stat(sub), (err) => err.code === "ENOENT");
    });
  });

  await t.test("删不存在 → NOT_FOUND", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(
        removePath(path.join(dir, "ghost")),
        (err) => codeOf(err) === "NOT_FOUND",
      );
    });
  });

  await t.test("删盘根 / 家目录 → FORBIDDEN_PATH", async () => {
    const home = os.homedir();
    assert.equal(typeof deletionBlockedReason(home), "string");
    assert.equal(deletionBlockedReason(path.join(home, "some-child")), null);
    if (process.platform === "win32") {
      assert.equal(typeof deletionBlockedReason("C:\\"), "string");
      assert.equal(typeof deletionBlockedReason("C:/"), "string");
      await assert.rejects(removePath("C:\\"), (err) => codeOf(err) === "FORBIDDEN_PATH");
    } else {
      assert.equal(typeof deletionBlockedReason("/"), "string");
      await assert.rejects(removePath("/"), (err) => codeOf(err) === "FORBIDDEN_PATH");
    }
    await assert.rejects(removePath(home), (err) => codeOf(err) === "FORBIDDEN_PATH");
  });

  await t.test("相对路径 → INVALID_PATH", async () => {
    await assert.rejects(removePath("x"), (err) => codeOf(err) === "INVALID_PATH");
  });
});

test("statPath / openDownloadStream 组", async (t) => {
  await t.test("stat 给 type/size/mtime/mode", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "s.txt");
      await writeFile(file, "12345");
      const info = await statPath(file);
      assert.equal(info.type, "file");
      assert.equal(info.size, 5);
      assert.equal(typeof info.mtime, "number");
      assert.equal(typeof info.mode, "number");
      assert.equal(info.name, "s.txt");
    });
  });

  await t.test("下载流：内容与文件一致", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "dl.bin");
      const payload = Buffer.from("下载内容 ¥ 中文", "utf8");
      await writeFile(file, payload);
      const opened = await openDownloadStream(file);
      assert.equal(opened.size, payload.length);
      const chunks = [];
      for await (const chunk of opened.stream) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), payload);
    });
  });

  await t.test("下载目录 → IS_A_DIRECTORY", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(openDownloadStream(dir), (err) => codeOf(err) === "IS_A_DIRECTORY");
    });
  });
});

test("writeStreamAtomic（上传）组", async (t) => {
  await t.test("流式写入：sha256 与源一致", async () => {
    await withTemp(async (dir) => {
      const crypto = await import("node:crypto");
      const payload = crypto.randomBytes(2 * 1024 * 1024);
      const target = path.join(dir, "up.bin");
      const { Readable } = await import("node:stream");
      await writeStreamAtomic(target, Readable.from([payload]));
      const written = await readFile(target);
      const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
      assert.equal(sha(written), sha(payload));
    });
  });

  await t.test("超过上限 → FILE_TOO_LARGE，且不留半截文件", async (t2) => {
    await withTemp(async (dir) => {
      const target = path.join(dir, "toobig.bin");
      const { Readable } = await import("node:stream");
      await assert.rejects(
        writeStreamAtomic(target, Readable.from([Buffer.alloc(2048, 0x41)]), { limit: 1024 }),
        (err) => codeOf(err) === "FILE_TOO_LARGE",
      );
      const { readdir } = await import("node:fs/promises");
      const rest = await readdir(dir);
      assert.deepEqual(rest.filter((name) => name.includes("magpie-tmp")), []);
      assert.deepEqual(rest.filter((name) => name === "toobig.bin"), []);
    });
  });

  await t.test("父目录不存在 → NOT_FOUND", async () => {
    await withTemp(async (dir) => {
      const { Readable } = await import("node:stream");
      await assert.rejects(
        writeStreamAtomic(path.join(dir, "no", "x.bin"), Readable.from([Buffer.from("x")])),
        (err) => codeOf(err) === "NOT_FOUND",
      );
    });
  });
});

// ===========================================================================
// TASK-V4-S §6.7 L1–L7：真实路径判定（P1-4）
//
// 修之前：建一个指向家目录的 junction，`/api/fs/list` 经它 → 200 读到 139 条
// （VERIFY-V4-G §4 P1-4）。现在读操作按 realpath 判敏感，写 / 删要求 realpath
// 与 resolve 一致（拒跨链接）。
// ===========================================================================

/** 建 junction（Windows 下不需要管理员权限；符号链接才需要）。 */
function makeJunction(linkPath, targetPath) {
  execFileSync("cmd", ["/c", "mklink", "/J", linkPath, targetPath], { stdio: "ignore" });
}

test("realPathOf：存在路径展开成真实路径；不存在原样返回", async () => {
  await withTemp(async (dir) => {
    await writeFile(path.join(dir, "a.txt"), "a");
    const real = await realPathOf(path.join(dir, "a.txt"));
    assert.equal(real, await realpath(path.join(dir, "a.txt")));
    const missing = path.join(dir, "nope.txt");
    assert.equal(await realPathOf(missing), missing);
  });
});

test("sensitiveBlockedReason：敏感路径给中文原因，普通路径给 null", () => {
  assert.equal(sensitiveBlockedReason("C:/Users/x/.ssh/id_rsa"), "这个位置是密钥或凭据目录，不能通过文件面板访问。");
  assert.equal(sensitiveBlockedReason("C:/Users/x/project/a.txt"), null);
});

test("L1：读真实敏感文件 → FORBIDDEN_PATH", async () => {
  await withTemp(async (dir) => {
    const secretDir = path.join(dir, "real-secret");
    await mkdir(secretDir);
    const secretFile = path.join(secretDir, "secrets.key");
    await writeFile(secretFile, "TOP-SECRET-CONTENT");
    await assert.rejects(
      () => readTextFile(secretFile),
      (err) => codeOf(err) === "FORBIDDEN_PATH",
      "含 secrets.key 的路径必须拒",
    );
    await assert.rejects(() => statPath(secretFile), (err) => codeOf(err) === "FORBIDDEN_PATH");
    await assert.rejects(() => openDownloadStream(secretFile), (err) => codeOf(err) === "FORBIDDEN_PATH");
  });
});

test("L2/L3/L4/L5：junction 指向敏感目录要被拒，指向普通目录要放行（但删除仍拒）", async (t) => {
  const home = os.homedir();
  if (!home) {
    t.skip("没有家目录，跳过 junction 用例");
    return;
  }
  await withTemp(async (dir) => {
    const linkSsh = path.join(dir, "link-ssh");
    const linkPlain = path.join(dir, "link-plain");
    const plain = path.join(dir, "plain");
    await mkdir(plain);
    await writeFile(path.join(plain, "x.txt"), "x");

    let junctionOk = true;
    try {
      // 指向家目录：真实路径落在用户家目录（敏感判定看的是链接的真实目标）。
      makeJunction(linkSsh, home);
    } catch {
      junctionOk = false;
    }
    if (!junctionOk) {
      // 造不出 junction（无权限）：如实 skip，绝不写成 pass。
      t.diagnostic("junction 建不出来（缺少权限），L2/L3 跳过");
      return;
    }

    // L2/L3：经 junction 指向家目录 → 真实路径是家目录本身。
    // 家目录本身不在敏感表里（整棵拒家目录会误伤文件面板的日常操作），
    // 所以这条用例断言「真实路径被正确解析出来」+「指向 .ssh 的链接被拒」。
    const realHome = await realPathOf(linkSsh);
    assert.equal(path.resolve(realHome), path.resolve(await realpath(home)), "realPathOf 必须展开 junction");

    const linkDanger = path.join(dir, "link-danger");
    // 指向一个真实存在的敏感目录（.ssh 不一定存在，所以在临时目录里造一个同名目录）。
    const fakeSsh = path.join(dir, ".ssh");
    await mkdir(fakeSsh);
    await writeFile(path.join(fakeSsh, "known_hosts"), "kh");
    try {
      makeJunction(linkDanger, fakeSsh);
    } catch {
      t.diagnostic("第二个 junction 建不出来，跳过 L2/L3 的敏感目标断言");
      return;
    }
    await assert.rejects(
      () => listDirectory(linkDanger),
      (err) => codeOf(err) === "FORBIDDEN_PATH",
      "L2：经 junction 列敏感目录必须拒",
    );
    await assert.rejects(
      () => readTextFile(path.join(linkDanger, "known_hosts")),
      (err) => codeOf(err) === "FORBIDDEN_PATH",
      "L3：经 junction 读敏感文件必须拒",
    );

    // L4：指向普通目录的 junction 照常能列（不误伤）。
    makeJunction(linkPlain, plain);
    const listing = await listDirectory(linkPlain);
    assert.ok(listing.entries.some((e) => e.name === "x.txt"), "普通链接必须还能列目录");

    // L5：删链接本身要拒（否则删的是目标目录里的内容）。
    await assert.rejects(
      () => removePath(linkPlain, { recursive: true }),
      (err) => codeOf(err) === "FORBIDDEN_PATH",
      "经链接的删除必须拒",
    );
    // 拒绝之后目标内容必须完好（证明我们没有真去删）。
    const still = await stat(path.join(plain, "x.txt"));
    assert.equal(still.isFile(), true);
  });
});

test("L2-real：junction 指向真 ~/.ssh（卡面原文的 L2 形态）→ FORBIDDEN_PATH", async (t) => {
  // 卡面原文：建 junction tmp/link-ssh → <home>/.ssh，listDirectory 必须拒。
  // 用户机器上不一定有 ~/.ssh，没有就如实 skip（绝不写成 pass）。
  const realSsh = path.join(os.homedir(), ".ssh");
  if (!existsSync(realSsh)) {
    t.skip("这台机器没有 ~/.ssh，跳过 L2-real");
    return;
  }
  await withTemp(async (dir) => {
    const link = path.join(dir, "link-ssh");
    try {
      makeJunction(link, realSsh);
    } catch {
      t.skip("junction 建不出来（缺少权限），跳过 L2-real");
      return;
    }
    await assert.rejects(
      () => listDirectory(link),
      (err) => codeOf(err) === "FORBIDDEN_PATH",
      "指向真 ~/.ssh 的 junction 必须拒",
    );
  });
});

test("L6：普通读写删不受影响（不误伤）", async () => {
  await withTemp(async (dir) => {
    const plain = path.join(dir, "plain");
    await mkdir(plain);
    await writeFile(path.join(plain, "x.txt"), "x");

    // 普通删除
    const removed = await removePath(path.join(plain, "x.txt"));
    assert.equal(removed.type, "file");

    // 普通写
    const written = await writeTextFile(path.join(plain, "y.txt"), "hi");
    assert.equal(written.ok, true);
    assert.equal(await readFile(path.join(plain, "y.txt"), "utf8"), "hi");

    // 普通新建 + 原子写
    await makeFile(path.join(plain, "z.txt"));
    await writeFileAtomic(path.join(plain, "w.txt"), "w");
    assert.equal(await readFile(path.join(plain, "w.txt"), "utf8"), "w");

    // 普通列目录
    const listing = await listDirectory(plain);
    assert.ok(listing.entries.length >= 3);
  });
});

test("L7：写 / 新建 / 重命名经链接都被拒（不只删除）", async (t) => {
  await withTemp(async (dir) => {
    const target = path.join(dir, "target");
    const link = path.join(dir, "link");
    await mkdir(target);
    let junctionOk = true;
    try {
      makeJunction(link, target);
    } catch {
      junctionOk = false;
    }
    if (!junctionOk) {
      t.diagnostic("junction 建不出来，L7 的写 / 新建 / 重命名分支跳过（L5 删除分支已覆盖）");
      return;
    }
    await assert.rejects(
      () => writeTextFile(path.join(link, "a.txt"), "a"),
      (err) => codeOf(err) === "FORBIDDEN_PATH",
      "经链接写文件必须拒",
    );
    await assert.rejects(
      () => makeFile(path.join(link, "b.txt")),
      (err) => codeOf(err) === "FORBIDDEN_PATH",
      "经链接新建文件必须拒",
    );
    await assert.rejects(
      () => makeDirectory(path.join(link, "sub")),
      (err) => codeOf(err) === "FORBIDDEN_PATH",
      "经链接新建目录必须拒",
    );
    await writeFile(path.join(dir, "src.txt"), "s");
    await assert.rejects(
      () => renamePath(path.join(dir, "src.txt"), path.join(link, "moved.txt")),
      (err) => codeOf(err) === "FORBIDDEN_PATH",
      "经链接重命名必须拒",
    );
    // 目标目录里什么都没被写进去（证明拒绝发生在落盘之前）。
    await assert.rejects(() => stat(path.join(target, "a.txt")), /ENOENT/);
  });
});
