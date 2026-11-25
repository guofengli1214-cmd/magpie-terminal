// downloadDir 配置字段的行为锁（TASK-FIX17-L1 R1 / AC1 / AC2）。
//
// 全部用 MAGPIE_TERMINAL_CONFIG_PATH 指到临时目录，绝不碰真的
// ~/.config/magpie-terminal/config.json。

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import {
  CONFIG_PATH_ENV,
  DEFAULT_CONFIG,
  DOWNLOAD_DIR_MAX,
  configPath,
  defaultDownloadDir,
  normalizeDownloadDir,
  publicConfig,
  readConfig,
  updateConfig,
  validateConfigPatch,
} from "../../src/config/store.mjs";

async function withPath(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-dl-dir-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(dir, "config.json");
  try {
    return await fn({ file: configPath(), dir });
  } finally {
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
  }
}

/* ------------------------------- 默认值 ------------------------------- */

test("R1：DEFAULT_CONFIG.downloadDir 是 null（= 未设置，回落浏览器下载）", () => {
  assert.equal(DEFAULT_CONFIG.downloadDir, null);
  assert.equal(DOWNLOAD_DIR_MAX, 512);
});

test("R1：publicConfig 总是带上 downloadDir，非法值归一成 null", () => {
  assert.equal(publicConfig({}).downloadDir, null);
  assert.equal(publicConfig({ downloadDir: "relative\\dir" }).downloadDir, null);
  assert.equal(publicConfig({ downloadDir: 123 }).downloadDir, null);
  assert.equal(
    publicConfig({ downloadDir: "C:\\Users\\x\\Downloads\\magpie-terminal\\" }).downloadDir,
    "C:\\Users\\x\\Downloads\\magpie-terminal",
  );
});

test("R1：defaultDownloadDir 用 os.homedir() 现算，不写死用户名", () => {
  const value = defaultDownloadDir();
  assert.equal(value, path.join(os.homedir(), "Downloads", "magpie-terminal"));
  assert.ok(value.startsWith(os.homedir()), "必须在当前用户家目录下");
});

/* ------------------------------ 校验补丁 ------------------------------ */

test("R1/AC2：相对路径 → INVALID_DOWNLOAD_DIR", () => {
  const invalid = validateConfigPatch({ downloadDir: "relative\\dir" });
  assert.equal(invalid.code, "INVALID_DOWNLOAD_DIR");
  assert.match(invalid.userText, /绝对路径|留空/);
  assert.equal(validateConfigPatch({ downloadDir: "./x" }).code, "INVALID_DOWNLOAD_DIR");
});

test("R1/AC2：非 string|null → INVALID_DOWNLOAD_DIR", () => {
  for (const value of [123, {}, [], true]) {
    assert.equal(
      validateConfigPatch({ downloadDir: value }).code,
      "INVALID_DOWNLOAD_DIR",
      `${JSON.stringify(value)} 必须被拒`,
    );
  }
});

test("R1/AC2：超过 512 字符 → INVALID_DOWNLOAD_DIR", () => {
  const tooLong = `C:\\${"a".repeat(DOWNLOAD_DIR_MAX)}`;
  assert.ok(tooLong.length > DOWNLOAD_DIR_MAX);
  const invalid = validateConfigPatch({ downloadDir: tooLong });
  assert.equal(invalid.code, "INVALID_DOWNLOAD_DIR");
  assert.match(invalid.userText, new RegExp(String(DOWNLOAD_DIR_MAX)));
});

test("R1/AC2：空串与纯空白不是错误（会归一成 null）", () => {
  assert.equal(validateConfigPatch({ downloadDir: "" }), null);
  assert.equal(validateConfigPatch({ downloadDir: "   " }), null);
  assert.equal(validateConfigPatch({ downloadDir: null }), null);
});

test("R1：绝对路径（Windows / POSIX）都通过校验", () => {
  assert.equal(validateConfigPatch({ downloadDir: "C:\\Users\\x\\dl" }), null);
  assert.equal(validateConfigPatch({ downloadDir: path.resolve("/tmp/downloads") }), null);
});

/* ----------------------------- 归一化函数 ----------------------------- */

test("R1：normalizeDownloadDir 去尾随分隔符，盘根与 POSIX 根保留", () => {
  assert.equal(normalizeDownloadDir("  C:\\Users\\x\\dl\\  "), "C:\\Users\\x\\dl");
  assert.equal(normalizeDownloadDir("/home/x/dl///"), "/home/x/dl");
  assert.equal(normalizeDownloadDir("C:\\"), "C:\\", "盘根不能变成 C:（那是当前盘当前目录）");
  assert.equal(normalizeDownloadDir("D:/"), "D:/");
  assert.equal(normalizeDownloadDir("/"), "/");
  assert.equal(normalizeDownloadDir("   "), null);
  assert.equal(normalizeDownloadDir("relative\\dir"), null);
  assert.equal(normalizeDownloadDir(`C:\\${"a".repeat(DOWNLOAD_DIR_MAX)}`), null);
});

/* ------------------------------ 落盘往返 ------------------------------ */

test("AC2：PUT 形状的空白值最终落成 null（配置文件里也是 null）", async () => {
  await withPath(async ({ file }) => {
    const saved = await updateConfig({ downloadDir: "   " });
    assert.equal(saved.downloadDir, null);
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.downloadDir, null);
    const { config } = await readConfig();
    assert.equal(publicConfig(config).downloadDir, null);
  });
});

test("R1：绝对路径落盘后尾随分隔符被去掉，读回来还是同一个目录", async () => {
  await withPath(async ({ file }) => {
    const wanted = "C:\\Users\\x\\Downloads\\magpie-terminal";
    await updateConfig({ downloadDir: `${wanted}\\\\` });
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.downloadDir, wanted);
    const { config } = await readConfig();
    assert.equal(publicConfig(config).downloadDir, wanted);
  });
});

test("R1：手改 config.json 写进相对路径 → 读出来按未设置处理（不把 cwd 当下载目录）", async () => {
  await withPath(async ({ file, dir }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ downloadDir: "relative\\dir" }), "utf8");
    const { config } = await readConfig();
    assert.equal(publicConfig(config).downloadDir, null);
    // 写回时也不能留下相对路径。
    await updateConfig({ autonomy: "strict" });
    const raw = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));
    assert.equal(raw.downloadDir, null);
  });
});
