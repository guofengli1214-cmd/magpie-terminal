// TASK-FIX17-C R3：`movePath` 的五种情形 —— 正常移动 / 目标已存在 / 跨盘降级 /
// 源不存在 / 越权路径被拒。
//
// 跨盘用例不是 mock：本机 C: 与 D: 都存在，真的在两个盘符下各建一个临时目录，
// 真的触发 `rename` 的 EXDEV，再真的比对「大小 + 首尾 1KB 的 sha256」。
// 找不到第二个可写盘符时**明确 skip 并打印原因**，不静默通过。
//
// 所有临时目录跑完都删干净；不碰用户的真实文件。
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { movePath } from "../../src/fs/local.mjs";

const codeOf = (err) => (err && err.code ? err.code : null);

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-fs-move-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 找一个与 `os.tmpdir()` **不同盘符**且可写的目录。
 *
 * Windows 上枚举 C:–Z:，跳过当前盘与不存在/只读的盘。非 Windows 上只认
 * `/dev/shm`（tmpfs 与常规根文件系统通常不同设备）。
 *
 * @returns {Promise<{dir: string, reason: string|null}>} `dir` 为 null 时 reason 说明原因
 */
async function findOtherVolume() {
  const base = path.resolve(os.tmpdir());
  const baseRoot = path.parse(base).root.toUpperCase();

  const candidates = [];
  if (process.platform === "win32") {
    for (let i = "C".charCodeAt(0); i <= "Z".charCodeAt(0); i += 1) {
      const letter = String.fromCharCode(i);
      const root = `${letter}:\\`;
      if (root.toUpperCase() === baseRoot) continue;
      if (!existsSync(root)) continue;
      candidates.push(root);
    }
  } else {
    for (const dir of ["/dev/shm", "/tmp", "/var/tmp"]) {
      if (existsSync(dir) && path.resolve(dir) !== base && !base.startsWith(`${path.resolve(dir)}${path.sep}`)) {
        candidates.push(dir);
      }
    }
  }

  for (const root of candidates) {
    try {
      const probe = await mkdtemp(path.join(root, "mt-move-probe-"));
      await rm(probe, { recursive: true, force: true });
      return { dir: root, reason: null };
    } catch (err) {
      // 只读 / 没权限：换下一个候选。
    }
  }
  return {
    dir: null,
    reason:
      candidates.length === 0
        ? `没有第二个已挂载的卷（当前 ${baseRoot}）`
        : `第二个卷不可写：${candidates.join(", ")}`,
  };
}

/** 首尾各 1KB 的 sha256（大文件不整份哈希，仍能证明首尾一致）。 */
async function headTailSha(filePath, chunk = 1024) {
  const info = await stat(filePath);
  const size = info.size;
  const hash = crypto.createHash("sha256");
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(chunk, size));
    await handle.read(head, 0, head.length, 0);
    hash.update(`head:${head.length}:`);
    hash.update(head);
    const tailLength = Math.min(chunk, size);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, Math.max(0, size - tailLength));
    hash.update(`tail:${tailLength}:`);
    hash.update(tail);
  } finally {
    await handle.close();
  }
  return { size, digest: hash.digest("hex") };
}

/** 造一个「首尾不同、中间有内容」的文件，首尾相同会被误判成「只搬了头尾」也看不出来。 */
function makePayload(bytes) {
  const buffer = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) buffer[i] = (i * 31 + 7) % 251;
  // 首尾写明显的哨兵，哈希不同就说明没搬对。
  buffer.write("HEAD-SENTINEL-", 0, "utf8");
  buffer.write("-TAIL-SENTINEL", Math.max(0, bytes - 14), "utf8");
  return buffer;
}

test("movePath 组", async (t) => {
  await t.test("正常移动：文件从原处消失、目标出现、内容一致", async () => {
    await withTemp(async (dir) => {
      const from = path.join(dir, "a.txt");
      const to = path.join(dir, "b.txt");
      const payload = makePayload(64 * 1024);
      await writeFile(from, payload);

      const result = await movePath(from, to);
      assert.equal(result.via, "rename", "同盘必须是原子 rename，不走复制降级");
      assert.equal(result.from, from);
      assert.equal(result.to, to);
      await assert.rejects(stat(from), (err) => err.code === "ENOENT");
      assert.deepEqual(await readFile(to), payload);
    });
  });

  await t.test("正常移动：整个目录（含子目录）搬走", async () => {
    await withTemp(async (dir) => {
      const from = path.join(dir, "src", "pkg");
      const to = path.join(dir, "out", "pkg");
      await mkdir(path.join(from, "sub"), { recursive: true });
      await mkdir(path.join(dir, "out"), { recursive: true });
      await writeFile(path.join(from, "index.mjs"), "export default 1;\n");
      await writeFile(path.join(from, "sub", "note.txt"), "深层文件\n");

      const result = await movePath(from, to);
      assert.equal(result.via, "rename");
      await assert.rejects(stat(from), (err) => err.code === "ENOENT");
      assert.equal((await stat(to)).isDirectory(), true);
      assert.equal(await readFile(path.join(to, "index.mjs"), "utf8"), "export default 1;\n");
      assert.equal(await readFile(path.join(to, "sub", "note.txt"), "utf8"), "深层文件\n");
    });
  });

  await t.test("目标已存在 → TARGET_EXISTS，不覆盖，源文件毫发无损", async () => {
    await withTemp(async (dir) => {
      const from = path.join(dir, "keep.txt");
      const to = path.join(dir, "taken.txt");
      await writeFile(from, "源文件内容");
      await writeFile(to, "目标原有内容");

      await assert.rejects(movePath(from, to), (err) => codeOf(err) === "TARGET_EXISTS");
      // 源还在、内容没变；目标也没被覆盖。
      assert.equal(await readFile(from, "utf8"), "源文件内容");
      assert.equal(await readFile(to, "utf8"), "目标原有内容");
    });
  });

  await t.test("目标已存在 + overwrite:true → 覆盖成功（显式才覆盖）", async () => {
    await withTemp(async (dir) => {
      const from = path.join(dir, "over.txt");
      const to = path.join(dir, "over-target.txt");
      await writeFile(from, "新");
      await writeFile(to, "旧");
      await movePath(from, to, { overwrite: true });
      assert.equal(await readFile(to, "utf8"), "新");
      await assert.rejects(stat(from), (err) => err.code === "ENOENT");
    });
  });

  await t.test("源不存在 → NOT_FOUND", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(
        movePath(path.join(dir, "ghost.txt"), path.join(dir, "dest.txt")),
        (err) => codeOf(err) === "NOT_FOUND",
      );
    });
  });

  await t.test("相对路径 → INVALID_PATH（两端都要过 guardPath）", async () => {
    await withTemp(async (dir) => {
      await writeFile(path.join(dir, "rel.txt"), "x");
      await assert.rejects(movePath("relative/a.txt", path.join(dir, "b.txt")), (err) => codeOf(err) === "INVALID_PATH");
      await assert.rejects(movePath(path.join(dir, "rel.txt"), "relative/b.txt"), (err) => codeOf(err) === "INVALID_PATH");
    });
  });

  await t.test("越权路径被拒：家目录 / 盘根不能作为移动源", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(movePath(os.homedir(), path.join(dir, "home")), (err) => codeOf(err) === "FORBIDDEN_PATH");
      if (process.platform === "win32") {
        await assert.rejects(movePath("C:\\", path.join(dir, "root")), (err) => codeOf(err) === "FORBIDDEN_PATH");
      } else {
        await assert.rejects(movePath("/", path.join(dir, "root")), (err) => codeOf(err) === "FORBIDDEN_PATH");
      }
    });
  });

  await t.test("敏感路径（.ssh）不能作为移动源 → FORBIDDEN_PATH", async () => {
    await withTemp(async (dir) => {
      // 不自造 ~/.ssh，只验证「传进来的路径命中敏感表就被拒」，
      // 目标用临时目录，不会真的碰到用户的密钥目录。
      const fakeSsh = path.join(os.homedir(), ".ssh", "id_rsa");
      await assert.rejects(movePath(fakeSsh, path.join(dir, "stolen")), (err) =>
        ["FORBIDDEN_PATH", "NOT_FOUND"].includes(codeOf(err)),
      );
    });
  });

  await t.test("把目录移进自己的子目录 → INVALID_PATH（不许越搬越深）", async () => {
    await withTemp(async (dir) => {
      const parent = path.join(dir, "loop");
      await mkdir(parent, { recursive: true });
      await assert.rejects(movePath(parent, path.join(parent, "child")), (err) => codeOf(err) === "INVALID_PATH");
    });
  });

  await t.test("原路径与目标相同 → INVALID_PATH", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "same.txt");
      await writeFile(file, "x");
      await assert.rejects(movePath(file, file), (err) => codeOf(err) === "INVALID_PATH");
    });
  });

  await t.test("跨盘移动（真 EXDEV 降级）：源消失、目标存在、大小 + 首尾 1KB sha256 相同", async (t2) => {
    const other = await findOtherVolume();
    if (!other.dir) {
      // 硬要求：跳过必须带原因，不许静默通过。
      t2.diagnostic(`SKIP cross-volume move: ${other.reason}`);
      t2.skip(`跨盘用例跳过：${other.reason}`);
      return;
    }
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "mt-move-c-"));
    const targetRoot = await mkdtemp(path.join(other.dir, "mt-move-d-"));
    try {
      const from = path.join(sourceRoot, "big.bin");
      const to = path.join(targetRoot, "big.bin");
      const payload = makePayload(3 * 1024 * 1024);
      await writeFile(from, payload);
      const before = await headTailSha(from);

      const result = await movePath(from, to);
      assert.equal(result.via, "copy", `跨盘必须走复制降级（源 ${path.parse(from).root} → 目标 ${path.parse(to).root}）`);
      await assert.rejects(stat(from), (err) => err.code === "ENOENT");
      const after = await headTailSha(to);
      assert.equal(after.size, before.size, "大小必须相同");
      assert.equal(after.size, payload.length);
      assert.equal(after.digest, before.digest, "首尾 1KB 的 sha256 必须相同");
      // 整份内容也一致（3MB 不大，顺带证明中间段没被写坏）。
      assert.equal(crypto.createHash("sha256").update(await readFile(to)).digest("hex"),
        crypto.createHash("sha256").update(payload).digest("hex"));
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  await t.test("跨盘移动目录（真 EXDEV 降级）：文件数与总字节都一致", async (t2) => {
    const other = await findOtherVolume();
    if (!other.dir) {
      t2.diagnostic(`SKIP cross-volume dir move: ${other.reason}`);
      t2.skip(`跨盘目录用例跳过：${other.reason}`);
      return;
    }
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "mt-move-cd-"));
    const targetRoot = await mkdtemp(path.join(other.dir, "mt-move-dd-"));
    try {
      const from = path.join(sourceRoot, "tree");
      const to = path.join(targetRoot, "tree");
      await mkdir(path.join(from, "a", "b"), { recursive: true });
      await writeFile(path.join(from, "one.txt"), "one");
      await writeFile(path.join(from, "a", "two.txt"), "two-two");
      await writeFile(path.join(from, "a", "b", "three.txt"), "three-three-three");

      const result = await movePath(from, to);
      assert.equal(result.via, "copy");
      await assert.rejects(stat(from), (err) => err.code === "ENOENT");
      assert.equal(await readFile(path.join(to, "a", "b", "three.txt"), "utf8"), "three-three-three");
      assert.equal(await readFile(path.join(to, "one.txt"), "utf8"), "one");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  await t.test("跨盘目标已存在 → TARGET_EXISTS，源原封不动（不降级覆盖）", async (t2) => {
    const other = await findOtherVolume();
    if (!other.dir) {
      t2.diagnostic(`SKIP cross-volume conflict: ${other.reason}`);
      t2.skip(`跨盘冲突用例跳过：${other.reason}`);
      return;
    }
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "mt-move-cc-"));
    const targetRoot = await mkdtemp(path.join(other.dir, "mt-move-dc-"));
    try {
      const from = path.join(sourceRoot, "dup.txt");
      const to = path.join(targetRoot, "dup.txt");
      await writeFile(from, "源");
      await writeFile(to, "目标旧");
      await assert.rejects(movePath(from, to), (err) => codeOf(err) === "TARGET_EXISTS");
      assert.equal(await readFile(from, "utf8"), "源");
      await rm(from, { force: true });
      assert.equal(await readFile(to, "utf8"), "目标旧");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
});
