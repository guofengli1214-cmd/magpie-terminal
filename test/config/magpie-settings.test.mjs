// TASK-FIX17-B：只读读取 magpie 设置（~/.config/magpie/settings.json）。
//
// 这份模块是「magpie 改主题后插件页面不刷新也能跟」的唯一冷态通道：带路页跳转后
// `window.magpie` 在应用页 origin 是 undefined（bridge 只注入到带路页），所以
// 服务端只能自己去读 magpie 的落盘设置。
//
// 三个必须锁住的点：缺失 / 损坏 / 字段类型不对 → 都回落默认值且不抛；
// accent 走允许集（它会拼进 CSS 变量）；缓存按 mtime+size 失效。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MAGPIE_SETTINGS,
  SETTINGS_PATH_ENV,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  THEME_MODES,
  clearMagpieSettingsCache,
  magpieSettingsPath,
  normalizeAccent,
  normalizeMagpieSettings,
  readMagpieSettings,
} from "../../src/config/magpie-settings.mjs";

const originalEnv = process.env[SETTINGS_PATH_ENV];

/** 建一个临时目录 + 设置文件，返回 {dir, file, write()}。 */
async function withSettings(contents) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-magpie-settings-"));
  const file = path.join(dir, "magpie-settings.json");
  if (contents !== undefined) {
    await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  }
  process.env[SETTINGS_PATH_ENV] = file;
  clearMagpieSettingsCache();
  return {
    dir,
    file,
    async write(next) {
      await writeFile(file, typeof next === "string" ? next : JSON.stringify(next), "utf8");
      // 保证 mtime 一定变（Windows 的 mtime 分辨率可能到不了毫秒）。
      const future = new Date(Date.now() + 2000);
      await utimes(file, future, future);
    },
    async cleanup() {
      if (originalEnv === undefined) delete process.env[SETTINGS_PATH_ENV];
      else process.env[SETTINGS_PATH_ENV] = originalEnv;
      clearMagpieSettingsCache();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test.afterEach(() => {
  clearMagpieSettingsCache();
  if (originalEnv === undefined) delete process.env[SETTINGS_PATH_ENV];
  else process.env[SETTINGS_PATH_ENV] = originalEnv;
});

/* ---------------------------------------------------------------- 路径 */

test("magpieSettingsPath：默认 ~/.config/magpie/settings.json", () => {
  delete process.env[SETTINGS_PATH_ENV];
  assert.equal(
    magpieSettingsPath(),
    path.join(os.homedir(), ".config", "magpie", "settings.json"),
  );
});

test("magpieSettingsPath：环境变量覆盖（测试与探针靠它隔离真实配置）", () => {
  process.env[SETTINGS_PATH_ENV] = "C:\\tmp\\custom\\settings.json";
  assert.equal(magpieSettingsPath(), path.resolve("C:\\tmp\\custom\\settings.json"));
});

/* ---------------------------------------------------------------- 缺失 / 损坏 */

test("文件不存在 → ok:false reason:missing，settings 是可用默认值，不抛", async () => {
  const ctx = await withSettings(undefined);
  try {
    const result = await readMagpieSettings();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing");
    assert.deepEqual(result.settings, { ...DEFAULT_MAGPIE_SETTINGS });
  } finally {
    await ctx.cleanup();
  }
});

test("文件不是 JSON → ok:false reason:corrupt，回落默认值", async () => {
  const ctx = await withSettings("{ this is not json");
  try {
    const result = await readMagpieSettings();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "corrupt");
    assert.deepEqual(result.settings, { ...DEFAULT_MAGPIE_SETTINGS });
  } finally {
    await ctx.cleanup();
  }
});

test("文件是数组 / null → 视为损坏，回落默认值", async () => {
  for (const body of ["[1,2,3]", "null", '"string"', "42"]) {
    const ctx = await withSettings(body);
    try {
      const result = await readMagpieSettings();
      assert.equal(result.ok, true, `${body} 能被 JSON.parse，所以 ok 是 true`);
      assert.deepEqual(result.settings, { ...DEFAULT_MAGPIE_SETTINGS }, `${body} 应回落默认值`);
    } finally {
      await ctx.cleanup();
    }
  }
});

/* ---------------------------------------------------------------- 正常读取 */

test("完整设置：theme / accent / textSize / lang 原样读出", async () => {
  const ctx = await withSettings({ theme: "dark", accent: "#2563eb", textSize: 110, lang: "ja" });
  try {
    const result = await readMagpieSettings();
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    assert.deepEqual(result.settings, { theme: "dark", accent: "#2563eb", textSize: 110, lang: "ja" });
  } finally {
    await ctx.cleanup();
  }
});

test("theme 只认 system / light / dark（大小写与空白先归一），无法识别回落 system", () => {
  for (const theme of THEME_MODES) {
    assert.equal(normalizeMagpieSettings({ theme }).theme, theme);
  }
  // 大小写 + 空白先归一：magpie 写的是什么形态都要认。
  assert.equal(normalizeMagpieSettings({ theme: "DARK" }).theme, "dark");
  assert.equal(normalizeMagpieSettings({ theme: "  Dark  " }).theme, "dark");
  assert.equal(normalizeMagpieSettings({ theme: " Light " }).theme, "light");
  // 无法识别的值回落 system。
  for (const bad of ["auto", "", "  ", "blue", 1, null, {}]) {
    assert.equal(normalizeMagpieSettings({ theme: bad }).theme, "system", `应回落 system：${JSON.stringify(bad)}`);
  }
});

test("textSize：非数字回落 100，超出 80…160 按边界夹住", () => {
  assert.equal(normalizeMagpieSettings({ textSize: 110 }).textSize, 110);
  assert.equal(normalizeMagpieSettings({ textSize: 130 }).textSize, 130);
  assert.equal(normalizeMagpieSettings({ textSize: 50 }).textSize, TEXT_SIZE_MIN);
  assert.equal(normalizeMagpieSettings({ textSize: 900 }).textSize, TEXT_SIZE_MAX);
  for (const bad of [undefined, null, "abc", NaN, Infinity, {}]) {
    assert.equal(normalizeMagpieSettings({ textSize: bad }).textSize, 100);
  }
  // 小数四舍五入成整数（magpie 的面板只给整数）。
  assert.equal(normalizeMagpieSettings({ textSize: 110.6 }).textSize, 111);
});

test("lang：字符串保留（截到 32 字符），非字符串回落 system", () => {
  assert.equal(normalizeMagpieSettings({ lang: "zh-CN" }).lang, "zh-CN");
  assert.equal(normalizeMagpieSettings({ lang: "x".repeat(60) }).lang.length, 32);
  for (const bad of [undefined, null, "", "   ", 1, {}]) {
    assert.equal(normalizeMagpieSettings({ lang: bad }).lang, "system");
  }
});

/* ---------------------------------------------------------------- accent 白名单 */

test("normalizeAccent：hex（3/4/6/8 位）与 rgb()/hsl() 放行", () => {
  for (const ok of ["#fff", "#ffff", "#2563eb", "#2563ebcc", "#ABC", "rgb(1,2,3)", "rgba(1, 2, 3, 0.5)", "hsl(210 50% 40%)"]) {
    assert.equal(normalizeAccent(ok), ok.trim(), `应放行：${ok}`);
  }
});

test("normalizeAccent：注入串 / 关键字 / 空白 / 过长一律 null（调用方用兜底色）", () => {
  const bad = [
    "</style><script>alert(1)</script>",
    "red;background:url(x)",
    "red",
    "currentColor",
    "",
    "   ",
    "#" + "a".repeat(80),
    "rgb(1,2,3); x",
    null,
    undefined,
    123,
    {},
  ];
  for (const value of bad) {
    assert.equal(normalizeAccent(value), null, `应拒绝：${JSON.stringify(value)}`);
  }
});

test("normalizeMagpieSettings：accent 非法时给 null（不是空串，变量层面才好判 undefined）", () => {
  assert.equal(normalizeMagpieSettings({ accent: "red" }).accent, null);
  assert.equal(normalizeMagpieSettings({ accent: "#2563eb" }).accent, "#2563eb");
  assert.equal(normalizeMagpieSettings({}).accent, null);
});

/* ---------------------------------------------------------------- 缓存 */

test("缓存：mtime 与文件大小都不变时命中缓存（不做无谓的读盘）", async () => {
  // 注意 Windows 的 `utimes` 只把 mtime 截到**整毫秒**，而 `stat` 报的是
  // 带小数的值。所以「恢复成完全相同的 mtime」必须用 `utimes` 写一遍之后
  // **重新 stat** 拿到的那个值 —— 直接复用改写前的 stat 会差一个小数位，
  // 缓存看起来就「莫名失效」了（本测试初版就踩了这个）。
  const ctx = await withSettings({ theme: "light", textSize: 100, lang: "aa" });
  try {
    assert.equal((await readMagpieSettings()).settings.lang, "aa");

    // 把 lang 改成等长的 `bb`（文件大小不变）→ 再 stat，拿截断后的 mtime 作为基准。
    await writeFile(ctx.file, JSON.stringify({ theme: "light", textSize: 100, lang: "bb" }), "utf8");
    const mid = new Date();
    await utimes(ctx.file, mid, mid);
    const frozen = await stat(ctx.file);

    // 现在读一次，让缓存记住这个 mtime+size。
    clearMagpieSettingsCache();
    assert.equal((await readMagpieSettings()).settings.lang, "bb");

    // 再写回等长的 `aa`，并把 mtime 恢复成刚 stat 到的那个值（同一整毫秒）。
    await writeFile(ctx.file, JSON.stringify({ theme: "light", textSize: 100, lang: "aa" }), "utf8");
    await utimes(ctx.file, frozen.atime, frozen.mtime);
    const after = await stat(ctx.file);
    assert.equal(after.size, frozen.size, "大小必须相同，否则测的不是缓存");
    assert.equal(after.mtimeMs, frozen.mtimeMs, "mtime 必须相同，否则测的不是缓存");
    const cached = await readMagpieSettings();
    assert.equal(cached.settings.lang, "bb", "mtime 与大小都没变，应命中缓存");

    // mtime 变了 → 重读（这才是生产路径：magpie 原子替换一定更新 mtime）。
    await ctx.write({ theme: "dark", textSize: 100, lang: "aa" });
    const fresh = await readMagpieSettings();
    assert.equal(fresh.settings.theme, "dark");
    assert.equal(fresh.settings.lang, "aa");
  } finally {
    await ctx.cleanup();
  }
});

test("缓存：大小变了（即使强改 mtime）也会重读", async () => {
  const ctx = await withSettings({ theme: "light", textSize: 100 });
  try {
    assert.equal((await readMagpieSettings()).settings.theme, "light");
    const statBefore = await stat(ctx.file);
    // theme 从 light（5）改成 dark（4）→ 文件短 1 字节。
    await writeFile(ctx.file, JSON.stringify({ theme: "dark", textSize: 100 }), "utf8");
    await utimes(ctx.file, statBefore.atime, statBefore.mtime);
    assert.equal((await readMagpieSettings()).settings.theme, "dark", "大小变了应重读");
  } finally {
    await ctx.cleanup();
  }
});

test("缓存：文件被删除后作废，回落 missing 默认值", async () => {
  const ctx = await withSettings({ theme: "dark", textSize: 100 });
  try {
    assert.equal((await readMagpieSettings()).settings.theme, "dark");
    await rm(ctx.file, { force: true });
    const after = await readMagpieSettings();
    assert.equal(after.ok, false);
    assert.equal(after.reason, "missing");
    assert.equal(after.settings.theme, "system");
  } finally {
    await ctx.cleanup();
  }
});

test("缓存：两个不同路径互不污染（测试之间不会串）", async () => {
  const a = await withSettings({ theme: "dark", textSize: 100 });
  const b = await withSettings({ theme: "light", textSize: 130 });
  try {
    process.env[SETTINGS_PATH_ENV] = a.file;
    assert.equal((await readMagpieSettings()).settings.theme, "dark");
    process.env[SETTINGS_PATH_ENV] = b.file;
    const second = await readMagpieSettings();
    assert.equal(second.settings.theme, "light");
    assert.equal(second.settings.textSize, 130);
  } finally {
    await a.cleanup();
    process.env[SETTINGS_PATH_ENV] = b.file;
    await b.cleanup();
  }
});
