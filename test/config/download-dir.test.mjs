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

/* -------------------------------- 夹具 -------------------------------- */
// downloadDir 是**本机**路径，语义跟宿主平台绑定，夹具也必须跟着平台走：
// Windows 用盘符，POSIX 用 / 开头。写死 C:\... 的断言只能在 Windows 上成立。

const IS_WIN = process.platform === "win32";
// 「宿主自己的绝对路径」：Windows 用盘符，POSIX 用 / 开头。
const ABS_DIR = IS_WIN ? "C:\\Users\\x\\Downloads\\magpie-terminal" : "/home/x/Downloads/magpie-terminal";
const ABS_DIR_TRAILING = `${ABS_DIR}${IS_WIN ? "\\\\" : "/"}`;

/* ------------------------------- 默认值 ------------------------------- */

test("R1：DEFAULT_CONFIG.downloadDir 是 null（= 未设置，回落浏览器下载）", () => {
  assert.equal(DEFAULT_CONFIG.downloadDir, null);
  assert.equal(DOWNLOAD_DIR_MAX, 512);
});

test("R1：publicConfig 总是带上 downloadDir，非法值归一成 null", () => {
  assert.equal(publicConfig({}).downloadDir, null);
  assert.equal(publicConfig({ downloadDir: "relative\\dir" }).downloadDir, null);
  assert.equal(publicConfig({ downloadDir: 123 }).downloadDir, null);
  assert.equal(publicConfig({ downloadDir: ABS_DIR_TRAILING }).downloadDir, ABS_DIR);
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

test("R1：宿主平台的绝对路径通过校验（跨平台的绝对路径按宿主语义拒绝）", () => {
  assert.equal(validateConfigPatch({ downloadDir: ABS_DIR }), null);
  // POSIX 绝对路径在 POSIX 宿主上也必须通过（Windows 宿主上 path.isAbsolute("/tmp/x") 也 true）。
  assert.equal(validateConfigPatch({ downloadDir: path.resolve("/tmp/downloads") }), null);
  if (!IS_WIN) {
    // 行为锁：下载目录是**本机**路径，服务不会去操作别的平台的路径。
    // POSIX 宿主上 C:\Users\x\dl 不是绝对路径（path.isAbsolute 为 false）→ 必须拒。
    assert.equal(
      validateConfigPatch({ downloadDir: "C:\\Users\\x\\dl" }).code,
      "INVALID_DOWNLOAD_DIR",
      "POSIX 宿主上 Windows 盘符路径不是本机绝对路径，必须拒",
    );
  }
});

/* ----------------------------- 归一化函数 ----------------------------- */

test("R1：normalizeDownloadDir 去尾随分隔符，盘根与 POSIX 根保留", () => {
  // 通用部分：所有平台都跑。
  assert.equal(normalizeDownloadDir(`  ${ABS_DIR_TRAILING}  `), ABS_DIR);
  assert.equal(normalizeDownloadDir("/home/x/dl///"), "/home/x/dl");
  assert.equal(normalizeDownloadDir("/"), "/");
  assert.equal(normalizeDownloadDir("   "), null);
  assert.equal(normalizeDownloadDir("relative\\dir"), null);
  assert.equal(normalizeDownloadDir(`${ABS_DIR}${"a".repeat(DOWNLOAD_DIR_MAX)}`), null);
  if (IS_WIN) {
    // 盘根保留：只有 Windows 宿主才认盘符（POSIX 上 `C:\` 本来就不是绝对路径，按 null 处理）。
    assert.equal(normalizeDownloadDir("C:\\"), "C:\\", "盘根不能变成 C:（那是当前盘当前目录）");
    assert.equal(normalizeDownloadDir("D:/"), "D:/");
  }
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
    const wanted = ABS_DIR;
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
