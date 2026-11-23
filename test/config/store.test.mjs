// src/config/store.mjs 的行为锁（TASK-V2-A §2.3）。
//
// 全部用 MAGPIE_TERMINAL_CONFIG_PATH 指到临时目录，绝不碰真的
// ~/.config/magpie-terminal/config.json。

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import {
  CONFIG_PATH_ENV,
  DEFAULT_CONFIG,
  KNOWN_FIELDS,
  configPath,
  readConfig,
  updateConfig,
  writeConfig,
} from "../../src/config/store.mjs";

const ENV = CONFIG_PATH_ENV;

async function tempFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-config-"));
  return path.join(dir, "config.json");
}

async function withPath(file, fn) {
  const previous = process.env[ENV];
  process.env[ENV] = file;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

test("configPath 默认落在 ~/.config/magpie-terminal/config.json", () => {
  const previous = process.env[ENV];
  delete process.env[ENV];
  try {
    assert.equal(
      configPath(),
      path.join(os.homedir(), ".config", "magpie-terminal", "config.json"),
    );
  } finally {
    if (previous !== undefined) process.env[ENV] = previous;
  }
});

test("KNOWN_FIELDS 本卡只有 model（下一张卡加 hosts）", () => {
  assert.deepEqual([...KNOWN_FIELDS], ["model"]);
});

test("文件不存在 → 默认值，不抛错（ok:false reason:missing）", async () => {
  const file = await tempFile();
  await withPath(file, async () => {
    const result = await readConfig();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing");
    assert.equal(result.config.model, DEFAULT_CONFIG.model);
  });
});

test("文件损坏（不是 JSON）→ 默认值，不抛错", async () => {
  const file = await tempFile();
  await writeFile(file, "{ this is not json", "utf8");
  await withPath(file, async () => {
    const result = await readConfig();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "corrupt");
    assert.equal(result.config.model, DEFAULT_CONFIG.model);
  });
});

test("文件是数组 → 视为损坏", async () => {
  const file = await tempFile();
  await writeFile(file, "[1,2,3]", "utf8");
  await withPath(file, async () => {
    const result = await readConfig();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "corrupt");
  });
});

test("updateConfig 落盘 + 读回；目录 700、文件 600", async () => {
  const file = await tempFile();
  await withPath(file, async () => {
    const saved = await updateConfig({ model: "commandcode/deepseek/deepseek-v4.1-flash" });
    assert.equal(saved.model, "commandcode/deepseek/deepseek-v4.1-flash");

    const readBack = await readConfig();
    assert.equal(readBack.ok, true);
    assert.equal(readBack.config.model, "commandcode/deepseek/deepseek-v4.1-flash");

    const raw = await readFile(file, "utf8");
    assert.equal(JSON.parse(raw).model, "commandcode/deepseek/deepseek-v4.1-flash");

    // Windows 上 chmod 语义有限，只在 POSIX 断言 mode。
    if (process.platform !== "win32") {
      const dirStat = await stat(path.dirname(file));
      const fileStat = await stat(file);
      assert.equal(dirStat.mode & 0o777, 0o700);
      assert.equal(fileStat.mode & 0o777, 0o600);
    }
  });
});

test("未知字段原样保留（读-改-写）", async () => {
  const file = await tempFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ model: "a/b", hosts: [{ id: "h1", host: "10.0.0.1" }], theme: "dark" }),
    "utf8",
  );
  await withPath(file, async () => {
    const saved = await updateConfig({ model: "c/d" });
    assert.equal(saved.model, "c/d");
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.model, "c/d");
    // 下一张卡的字段必须活着。
    assert.deepEqual(raw.hosts, [{ id: "h1", host: "10.0.0.1" }]);
    assert.equal(raw.theme, "dark");
  });
});

test("updateConfig 忽略不认识的 patch 字段（不报错、不落盘）", async () => {
  const file = await tempFile();
  await withPath(file, async () => {
    await updateConfig({ model: "a/b" });
    const saved = await updateConfig({ model: "a/b", nonsense: 1 });
    assert.equal(saved.model, "a/b");
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(raw, "nonsense"), false);
  });
});

test("writeConfig 是原子替换：目录里不留下临时文件", async () => {
  const file = await tempFile();
  await withPath(file, async () => {
    await writeConfig({ model: "a/b" });
    await writeConfig({ model: "c/d" });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.dirname(file));
    assert.deepEqual(entries, ["config.json"]);
  });
});

test("model 为空串 → 归一为 null，仍然落盘", async () => {
  const file = await tempFile();
  await withPath(file, async () => {
    const saved = await updateConfig({ model: "   " });
    assert.equal(saved.model, null);
    assert.equal(JSON.parse(await readFile(file, "utf8")).model, null);
  });
});
