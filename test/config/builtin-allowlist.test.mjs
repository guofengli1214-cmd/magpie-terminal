// TASK-FIX17-I R1：`builtinAllowlist` 配置字段的校验 / 归一 / 落盘。
//
// 口径：非法值**不许静默丢弃** —— PUT 走 `validateConfigPatch` 一律 400 +
// `INVALID_BUILTIN_ALLOWLIST` + 人话 userText；手改 config.json 的非法值在
// `normalize()` 里按 fail-closed 丢掉（少一条放行只会多一次确认）。

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CONFIG_PATH_ENV } from "../../src/config/store.mjs";
import {
  BUILTIN_ALLOWLIST_ENTRY_MAX,
  BUILTIN_ALLOWLIST_MAX_ENTRIES,
  DEFAULT_CONFIG,
  checkBuiltinAllowlistEntry,
  normalizeBuiltinAllowlist,
  publicConfig,
  readConfig,
  updateConfig,
  validateBuiltinAllowlist,
  validateConfigPatch,
} from "../../src/config/store.mjs";
import { DEFAULT_BUILTIN_ALLOWLIST } from "../../src/policy/allowlist.mjs";

async function tempFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "magpie-i-store-"));
  return { dir, file: path.join(dir, "config.json") };
}

async function withPath(file, fn) {
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = file;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
  }
}

/* ---------------------------- 默认值 ---------------------------- */

test("I-R1 DEFAULT_CONFIG.builtinAllowlist 就是 DEFAULT_BUILTIN_ALLOWLIST（不是第二份清单）", () => {
  assert.deepEqual([...DEFAULT_CONFIG.builtinAllowlist], [...DEFAULT_BUILTIN_ALLOWLIST]);
  assert.equal(BUILTIN_ALLOWLIST_MAX_ENTRIES, 300);
  assert.equal(BUILTIN_ALLOWLIST_ENTRY_MAX, 64);
});

test("I-R5 老配置缺该字段 → publicConfig 用默认清单（自然升级，不写版本迁移）", () => {
  const view = publicConfig({ autonomy: "balanced" });
  assert.deepEqual(view.builtinAllowlist, [...DEFAULT_BUILTIN_ALLOWLIST]);
});

test("I-R5 老配置缺该字段 → 落盘文件里不会凭空多出这个键", async () => {
  const { dir, file } = await tempFile();
  try {
    await withPath(file, async () => {
      await writeFile(file, '{"autonomy":"strict"}\n', "utf8");
      // 只改别的字段：读-改-写会把整个 normalize 结果写回去，所以这里刻意断言
      // 「PUT 只带 autonomy」时落盘的 builtinAllowlist 是默认值（normalize 的必然结果）。
      const saved = await updateConfig({ autonomy: "strict" });
      assert.deepEqual(saved.builtinAllowlist, [...DEFAULT_BUILTIN_ALLOWLIST]);
      const onDisk = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(onDisk.builtinAllowlist, [...DEFAULT_BUILTIN_ALLOWLIST]);
    });
  } finally {
    delete process.env[CONFIG_PATH_ENV];
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------------- 单条校验 ---------------------------- */

test("I-R1 单条合法值：整头 / 两段 / 三段都收", () => {
  for (const raw of ["free", "git status", "docker volume ls", "docker container ls", "npm -v", "/usr/bin/ls", "user@host"]) {
    const checked = checkBuiltinAllowlistEntry(raw);
    assert.equal(checked.ok, true, raw);
    assert.equal(checked.text, raw);
  }
});

test("I-R1 单条非法：超 64 字符被拒", () => {
  const tooLong = `a${"b".repeat(63)}`; // 64 字符 → 合法
  assert.equal(checkBuiltinAllowlistEntry(tooLong).ok, true);
  assert.equal(checkBuiltinAllowlistEntry(`${tooLong}c`).ok, false); // 65 → 拒
});

test("I-R1 单条非法：含 shell 元字符（; | & $ ` > < \\) 全部被拒", () => {
  for (const raw of ["ls; rm -rf /", "ls | sh", "ls && rm x", "ls $HOME", "ls `id`", "ls > out", "ls < in", "ls\nrm x", "ls\trm x"]) {
    assert.equal(checkBuiltinAllowlistEntry(raw).ok, false, JSON.stringify(raw));
  }
});

test("I-R1 单条非法：连续空格 / 4 段 / 空串 / 纯空白 / 非字符串", () => {
  assert.equal(checkBuiltinAllowlistEntry("git  status").ok, false);
  assert.equal(checkBuiltinAllowlistEntry("a b c d").ok, false);
  assert.equal(checkBuiltinAllowlistEntry("").ok, false);
  assert.equal(checkBuiltinAllowlistEntry("   ").ok, false);
  assert.equal(checkBuiltinAllowlistEntry(42).ok, false);
  assert.equal(checkBuiltinAllowlistEntry(null).ok, false);
});

test("I-R1 单条合法：带引号包裹的空白会被 trim 掉（首尾空格不算错）", () => {
  const checked = checkBuiltinAllowlistEntry("  free  ");
  assert.equal(checked.ok, true);
  assert.equal(checked.text, "free");
});

/* ---------------------------- 整份校验 ---------------------------- */

test("I-R1 validateBuiltinAllowlist：合法清单原样通过", () => {
  const checked = validateBuiltinAllowlist(["free", "git status"]);
  assert.deepEqual(checked, { ok: true, list: ["free", "git status"] });
});

test("I-R1 validateBuiltinAllowlist：空数组合法（= 所有命令都要确认）", () => {
  assert.deepEqual(validateBuiltinAllowlist([]), { ok: true, list: [] });
});

test("I-R1 validateBuiltinAllowlist：重复项去重，保留首次出现", () => {
  const checked = validateBuiltinAllowlist(["git status", "free", "git status", "free"]);
  assert.deepEqual(checked, { ok: true, list: ["git status", "free"] });
});

test("I-R1 validateBuiltinAllowlist：非数组 → INVALID_BUILTIN_ALLOWLIST", () => {
  for (const value of [undefined, null, "ls", 42, {}]) {
    const checked = validateBuiltinAllowlist(value);
    assert.equal(checked.ok, false, String(value));
    assert.equal(checked.code, "INVALID_BUILTIN_ALLOWLIST");
    assert.equal(typeof checked.userText, "string");
    assert.ok(checked.userText.length > 0);
  }
});

test("I-R1 validateBuiltinAllowlist：超 300 条 → INVALID_BUILTIN_ALLOWLIST", () => {
  const list = Array.from({ length: 301 }, (_, i) => `cmd${i}`);
  const checked = validateBuiltinAllowlist(list);
  assert.equal(checked.ok, false);
  assert.equal(checked.code, "INVALID_BUILTIN_ALLOWLIST");
  assert.match(checked.userText, /300/);
  // 300 条仍然合法。
  assert.equal(validateBuiltinAllowlist(list.slice(0, 300)).ok, true);
});

test("I-R1 validateBuiltinAllowlist：任一条非法 → 整份拒绞，userText 指出第几条", () => {
  const checked = validateBuiltinAllowlist(["free", "ls | sh"]);
  assert.equal(checked.ok, false);
  assert.equal(checked.code, "INVALID_BUILTIN_ALLOWLIST");
  assert.match(checked.userText, /第 2 条/);
});

test("I-R1 validateConfigPatch 走同一套：非法 builtinAllowlist → INVALID_BUILTIN_ALLOWLIST", () => {
  const invalid = validateConfigPatch({ builtinAllowlist: ["ls; rm"] });
  assert.equal(invalid.code, "INVALID_BUILTIN_ALLOWLIST");
  assert.equal(typeof invalid.userText, "string");
  // 合法 → null（无错误）。
  assert.equal(validateConfigPatch({ builtinAllowlist: ["free"] }), null);
  assert.equal(validateConfigPatch({ builtinAllowlist: [] }), null);
});

test("I-R1 validateConfigPatch：没出现的字段不参与校验（patch 只带 autonomy 时不报错）", () => {
  assert.equal(validateConfigPatch({ autonomy: "strict" }), null);
});

/* ---------------------------- 归一 ---------------------------- */

test("I-R1 normalizeBuiltinAllowlist：非数组回落默认清单，非法条目丢掉（fail-closed），去重", () => {
  assert.deepEqual(normalizeBuiltinAllowlist(undefined), [...DEFAULT_BUILTIN_ALLOWLIST]);
  assert.deepEqual(normalizeBuiltinAllowlist("ls"), [...DEFAULT_BUILTIN_ALLOWLIST]);
  assert.deepEqual(normalizeBuiltinAllowlist([]), []);
  assert.deepEqual(normalizeBuiltinAllowlist(["free", "ls; rm", "free", "git status"]), ["free", "git status"]);
});

test("I-R1 normalizeBuiltinAllowlist：超 300 条截断到 300", () => {
  const list = Array.from({ length: 400 }, (_, i) => `cmd${i}`);
  assert.equal(normalizeBuiltinAllowlist(list).length, 300);
});

test("I-R1 publicConfig 把手改坏的 builtinAllowlist 归一（读到内存里的也必须是合法值）", () => {
  const view = publicConfig({ builtinAllowlist: ["free", "ls | sh", "free"] });
  assert.deepEqual(view.builtinAllowlist, ["free"]);
});

/* ---------------------------- 落盘往返 ---------------------------- */

test("I-R1 updateConfig 落盘 + readConfig 读回：自定义清单保真", async () => {
  const { dir, file } = await tempFile();
  try {
    await withPath(file, async () => {
      await updateConfig({ builtinAllowlist: ["free", "docker volume ls"] });
      const { config } = await readConfig();
      assert.deepEqual(config.builtinAllowlist, ["free", "docker volume ls"]);
      // GET /api/config 的形态（publicConfig）也对齐。
      assert.deepEqual(publicConfig(config).builtinAllowlist, ["free", "docker volume ls"]);
    });
  } finally {
    delete process.env[CONFIG_PATH_ENV];
    await rm(dir, { recursive: true, force: true });
  }
});

test("I-R1 updateConfig：空清单落盘仍是空数组（不是回落默认）", async () => {
  const { dir, file } = await tempFile();
  try {
    await withPath(file, async () => {
      await updateConfig({ builtinAllowlist: [] });
      const { config } = await readConfig();
      assert.deepEqual(config.builtinAllowlist, []);
      assert.deepEqual(publicConfig(config).builtinAllowlist, []);
    });
  } finally {
    delete process.env[CONFIG_PATH_ENV];
    await rm(dir, { recursive: true, force: true });
  }
});
