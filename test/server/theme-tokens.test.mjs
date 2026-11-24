// TASK-FIX17-B 服务端：decodeTokens 裸键归一 / 注入过滤 / 主题合成。
//
// 为什么要单测这层：`decodeTokens` 是「用户可控字符串 → 拼进 <style>」的唯一入口，
// 也是本卡最核心的 bug 所在地（修之前它只收 `--` 开头的键，bridge 给的裸键
// `bg` / `fg` / `card` 全被丢掉，实测注入是空 `{}`）。这两件事都必须能表驱动验证，
// 不能只靠真浏览器探针。
import test from "node:test";
import assert from "node:assert/strict";
import {
  DARK_LUMINANCE_THRESHOLD,
  MAGPIE_PALETTE,
  buildFontStyle,
  buildRootStyle,
  composeTheme,
  decodeTokens,
  fontPxForTextSize,
  isSafeTokenValue,
  normalizeTokenKey,
  parseColor,
  relativeLuminance,
  resolveScheme,
  sanitizeTokens,
} from "../../src/server/http.mjs";

/** 把对象编码成 query 里 `tokens` 的形态（与 page/boot.js 一致）。 */
const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

/* ========================================================================
 * decodeTokens：裸键归一（R1 的核心）
 * ====================================================================== */

test("decodeTokens：bridge 的裸键（bg/fg/card…）归一成 --magpie-*", () => {
  const tokens = decodeTokens(encode({ bg: "#123456", fg: "#abcdef", card: "#111111", line: "#222222" }));
  assert.deepEqual(tokens, {
    "--magpie-bg": "#123456",
    "--magpie-fg": "#abcdef",
    "--magpie-card": "#111111",
    "--magpie-line": "#222222",
  });
});

test("decodeTokens：修之前的形态（-- 开头的键）仍然接受，不破坏现有调用", () => {
  const tokens = decodeTokens(encode({ "--magpie-bg": "#1e1e2e" }));
  assert.deepEqual(tokens, { "--magpie-bg": "#1e1e2e" });
});

test("decodeTokens：`--bg` 这种「只带前缀的裸键」也归一（幂等，不重复加前缀）", () => {
  assert.deepEqual(decodeTokens(encode({ "--bg": "#654321" })), { "--magpie-bg": "#654321" });
  // 三种形态归一后是同一个键，重复出现时后写的赢（不产生 --magpie---magpie-bg）。
  const tokens = decodeTokens(encode({ bg: "#111111", "--bg": "#222222", "--magpie-bg": "#333333" }));
  assert.deepEqual(tokens, { "--magpie-bg": "#333333" });
  assert.equal(Object.keys(tokens).length, 1);
});

test("decodeTokens：`--font` 这类 magpie 自有键也归一成 --magpie-font", () => {
  // bridge 的 paint() 给每个 token 都加 `--magpie-` 前缀（宿主二进制里的原文），
  // 所以页面上的真名永远是 `--magpie-<裸键>`；`--font` 的真意就是 `font`。
  assert.deepEqual(decodeTokens(encode({ "--font": "Inter" })), { "--magpie-font": "Inter" });
  assert.deepEqual(decodeTokens(encode({ font: "Inter" })), { "--magpie-font": "Inter" });
});

test("decodeTokens：空 / 非 base64 / 非对象 / 数组 → null（不是空对象）", () => {
  assert.equal(decodeTokens(""), null);
  assert.equal(decodeTokens(null), null);
  assert.equal(decodeTokens(undefined), null);
  assert.equal(decodeTokens("!!!not-base64!!!"), null);
  // base64 解出来不是 JSON。
  assert.equal(decodeTokens(Buffer.from("hello").toString("base64")), null);
  // JSON 但不是对象。
  assert.equal(decodeTokens(encode([1, 2, 3])), null);
  assert.equal(decodeTokens(encode("string")), null);
  // 合法但所有键都非法 → 空对象（调用方据此知道「解开了但没用」）。
  assert.deepEqual(decodeTokens(encode({ "bad key": "#fff" })), {});
});

/* ========================================================================
 * 注入过滤（AC10）
 * ====================================================================== */

test("decodeTokens：`bg=</style><script>` 这类注入整键丢弃", () => {
  const tokens = decodeTokens(encode({ bg: "</style><script>alert(1)</script>" }));
  assert.deepEqual(tokens, {});
});

test("decodeTokens：分号逃逸 / 花括号 / 反引号 / 引号 / 反斜杠 / 换行都被丢", () => {
  const attacks = [
    "#fff; } body { display: none }",
    "#fff}",
    "red<script>",
    "url(javascript:alert(1))",
    "#fff\"><script>",
    "#fff\\",
    "#fff'",
    "#fff\n<html>",
  ];
  for (const bad of attacks) {
    const tokens = decodeTokens(encode({ bg: bad }));
    assert.deepEqual(tokens, {}, `必须丢弃：${JSON.stringify(bad)}`);
  }
  // `expression(...)` 不含任何危险字符（无冒号/分号/尖括号/引号），按允许集会被放行。
  // 这不是漏洞：现代 Chromium 已不支持 expression()，且它本身是合法的 CSS
  // 值形状。真正能造成注入的是 `<` / `;` / `}`，上面已逐个覆盖。
  // 这里显式记下来，避免下一个人误以为漏了检查。
  assert.deepEqual(decodeTokens(encode({ bg: "expression(alert(1))" })), {
    "--magpie-bg": "expression(alert(1))",
  });
});

test("decodeTokens：合法与非法的键混在一起时，只丢非法的那些", () => {
  const tokens = decodeTokens(
    encode({
      bg: "#123456",
      fg: "</style><script>alert(1)</script>",
      "bad key": "#000",
      line: "#e3e3e8",
    }),
  );
  assert.deepEqual(tokens, { "--magpie-bg": "#123456", "--magpie-line": "#e3e3e8" });
});

test("decodeTokens：超大 / 超长 / 非字符串值被丢", () => {
  assert.deepEqual(decodeTokens(encode({ bg: true, fg: {}, card: [], line: null })), {});
  assert.deepEqual(decodeTokens(encode({ bg: `#${"a".repeat(70)}` })), {});
  assert.deepEqual(decodeTokens(encode({ bg: " ".repeat(5) })), {});
  // 数字是可以的（CSS 变量可能是 6 这种裸数字，例如圆角）。
  assert.deepEqual(decodeTokens(encode({ radius: 6 })), { "--magpie-radius": "6" });
});

test("normalizeTokenKey：合法 / 非法键的归一表", () => {
  assert.equal(normalizeTokenKey("bg"), "--magpie-bg");
  assert.equal(normalizeTokenKey("--bg"), "--magpie-bg");
  assert.equal(normalizeTokenKey("--magpie-bg"), "--magpie-bg");
  assert.equal(normalizeTokenKey("accent-fg"), "--magpie-accent-fg");
  assert.equal(normalizeTokenKey("surface-2"), "--magpie-surface-2");
  assert.equal(normalizeTokenKey("--font"), "--magpie-font");
  assert.equal(normalizeTokenKey("--code"), "--magpie-code");
  // 非法。
  assert.equal(normalizeTokenKey(""), null);
  assert.equal(normalizeTokenKey("BG"), null, "大写不许（CSS 变量名大小写敏感，混用会静默失效）");
  assert.equal(normalizeTokenKey("-bg"), null);
  assert.equal(normalizeTokenKey("--"), null);
  assert.equal(normalizeTokenKey("bg fg"), null);
  assert.equal(normalizeTokenKey("bg;"), null);
  assert.equal(normalizeTokenKey("a".repeat(50)), null, "超长键拒绝");
  assert.equal(normalizeTokenKey(123), null);
  assert.equal(normalizeTokenKey(null), null);
});

test("isSafeTokenValue：色值 / 函数式色值放行，危险字符拒绝", () => {
  for (const ok of ["#fff", "#ffffff", "#ffffffcc", "rgb(1,2,3)", "rgba(1,2,3,0.5)", "hsl(1 2% 3%)", "Inter", "6", "1.2"]) {
    assert.equal(isSafeTokenValue(ok), true, `应放行：${ok}`);
  }
  for (const bad of ["", " ", "</style>", "a;b", "a{b", "a}b", 'a"b', "a'b", "a\\b", "a\nb", "a<b", "a>b", true, null, {}]) {
    assert.equal(isSafeTokenValue(bad), false, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test("sanitizeTokens：返回丢弃计数，且不回显原值", () => {
  const result = sanitizeTokens({ bg: "#fff", fg: "<script>", "bad key": "#000" });
  assert.deepEqual(result.tokens, { "--magpie-bg": "#fff" });
  assert.equal(result.dropped, 2);
  // 返回值里不能出现注入串（连报错都要小心：日志只记数量）。
  assert.equal(JSON.stringify(result).includes("script"), false);
});

/* ========================================================================
 * buildRootStyle：拼进 <style> 的最后一道关（AC2 / AC10）
 * ====================================================================== */

test("buildRootStyle：选择器是 html:root（特异性 0,1,1，能压过 tokens.css 的 :root）", () => {
  const html = buildRootStyle({ "--magpie-bg": "#1e1e2e" });
  assert.match(html, /^<style>html:root \{/);
  assert.ok(html.includes("--magpie-bg: #1e1e2e;"));
});

test("buildRootStyle：即使调用方绕过 decodeTokens 直接传脏数据，也会在拼接前丢掉", () => {
  const html = buildRootStyle({
    "--magpie-bg": "</style><script>alert(1)</script>",
    "--magpie-fg": "#fff",
    "bad key": "#000",
    "--magpie-line": "1;2",
  });
  assert.equal(html.includes("script"), false);
  assert.equal(html.includes("bad key"), false);
  assert.ok(html.includes("--magpie-fg: #fff;"));
  assert.equal(html.includes("--magpie-line"), false);
});

test("buildRootStyle：没有任何合法键时返回空串（不注入空 <style>）", () => {
  assert.equal(buildRootStyle(null), "");
  assert.equal(buildRootStyle(undefined), "");
  assert.equal(buildRootStyle({}), "");
  assert.equal(buildRootStyle({ "bad key": "#000" }), "");
});

test("buildFontStyle：textSize 100 时不注入（保持 tokens.css 的默认 13px）", () => {
  assert.equal(buildFontStyle(100), "");
  assert.equal(buildFontStyle(undefined), "");
});

test("buildFontStyle：textSize 130 → 根字号与 --mt-font-scale 一起注入", () => {
  const html = buildFontStyle(130);
  assert.match(html, /--mt-font-scale: 1\.3;/);
  assert.match(html, /font-size: 16\.9px;/);
});

/* ========================================================================
 * 色值解析 / 亮度 / 深浅判定
 * ====================================================================== */

test("parseColor：hex 三/四/六/八位与 rgb()/rgba() 都能解", () => {
  // 3 / 4 位形态返回 3 个通道（没有 alpha 可解），6 / 8 位返回 3 个；
  // rgb() 带 alpha 的返回 4 个。调用方只取前 3 个，所以形态差异无害。
  assert.deepEqual(parseColor("#fff"), [255, 255, 255]);
  assert.deepEqual(parseColor("#000000"), [0, 0, 0]);
  assert.deepEqual(parseColor("#1a1a1e"), [26, 26, 30]);
  assert.deepEqual(parseColor("#12345678").slice(0, 3), [18, 52, 86]);
  assert.deepEqual(parseColor("rgb(1, 2, 3)").slice(0, 3), [1, 2, 3]);
  assert.deepEqual(parseColor("rgba(1, 2, 3, 0.5)").slice(0, 3), [1, 2, 3]);
  // 解不了的返回 null（调用方据此保留旧判定，不默认深色）。
  assert.equal(parseColor("Canvas"), null);
  assert.equal(parseColor(""), null);
  assert.equal(parseColor(null), null);
});

test("relativeLuminance：白 ≈ 1、黑 = 0、magpie 浅色底 ≈ 0.9", () => {
  assert.ok(Math.abs(relativeLuminance([255, 255, 255]) - 1) < 1e-6);
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  assert.ok(relativeLuminance([244, 244, 246]) > 0.8);
  assert.ok(relativeLuminance([26, 26, 30]) < 0.02);
});

test("resolveScheme：theme 设置是唯一权威，压过背景亮度", () => {
  // 白底但设置说 dark → dark（magpie 的「深色主题」就可能配浅色卡片）。
  assert.equal(resolveScheme("#ffffff", { theme: "dark" }), "dark");
  assert.equal(resolveScheme("#000000", { theme: "light" }), "light");
});

test("resolveScheme：theme=system 时看背景亮度（阈值 0.45）", () => {
  assert.equal(DARK_LUMINANCE_THRESHOLD, 0.45);
  assert.equal(resolveScheme("#f4f4f6", { theme: "system" }), "light");
  assert.equal(resolveScheme("#1a1a1e", { theme: "system" }), "dark");
  // 阈值边界用实测值：灰阶要到 #b3（179）才达到 0.45，
  // 所以「中灰」在 WCAG 意义下是深色 —— 这正是用亮度而不是靠肉眼的关键。
  assert.equal(resolveScheme("#b2b2b2", {}), "dark", "#b2 的相对亮度约 0.44，低于阈值");
  assert.equal(resolveScheme("#b3b3b3", {}), "light", "#b3 的相对亮度约 0.45，高于阈值");
});

test("resolveScheme：解析不了的背景回落 light（不默认深色，避免闪黑）", () => {
  assert.equal(resolveScheme("Canvas", {}), "light");
  assert.equal(resolveScheme("", {}), "light");
  assert.equal(resolveScheme(undefined, {}), "light");
});

/* ========================================================================
 * composeTheme：三层数据来源的优先级（R1）
 * ====================================================================== */

test("composeTheme：settings.theme=dark + 无 bridge → 用 magpie 深色调色板", () => {
  const theme = composeTheme({ settings: { theme: "dark", textSize: 100 } });
  assert.equal(theme.scheme, "dark");
  assert.equal(theme.tokens["--magpie-bg"], MAGPIE_PALETTE.dark.bg);
  assert.equal(theme.source, "settings");
});

test("composeTheme：settings.theme=light → 浅色调色板", () => {
  const theme = composeTheme({ settings: { theme: "light", textSize: 100 } });
  assert.equal(theme.scheme, "light");
  assert.equal(theme.tokens["--magpie-bg"], MAGPIE_PALETTE.light.bg);
});

test("composeTheme：accent 从 magpie 设置里来（这是「色系跟随」）", () => {
  const theme = composeTheme({ settings: { theme: "light", accent: "#10b981", textSize: 100 } });
  assert.equal(theme.tokens["--magpie-accent"], "#10b981");
});

test("composeTheme：非法 accent 回落调色板兜底，不会把脏串塞进变量", () => {
  for (const bad of ["</style><script>", "red;background:url(x)", "", "not-a-color", "a".repeat(80)]) {
    const theme = composeTheme({ settings: { theme: "light", accent: bad, textSize: 100 } });
    assert.match(theme.tokens["--magpie-accent"], /^#[0-9a-f]{6}$|^#[0-9a-f]{3}$/i);
  }
});

test("composeTheme：bridge 令牌与当前深浅色一致时才采用（最准的来源）", () => {
  const bridgeTokens = { "--magpie-bg": "#101820", "--magpie-fg": "#eef2f7" };
  const theme = composeTheme({
    bridgeTokens,
    bridgeScheme: "dark",
    settings: { theme: "dark", textSize: 100 },
  });
  assert.equal(theme.tokens["--magpie-bg"], "#101820");
  assert.equal(theme.tokens["--magpie-fg"], "#eef2f7");
  assert.equal(theme.source, "bridge");
});

test("composeTheme：magpie 改了主题而 bridge 令牌还是旧的那一套 → 不用旧令牌", () => {
  // 场景：用户在 magpie 里从 dark 切成 light，但页面缓存里还留着 dark 的令牌。
  // 继续用旧令牌会得到「浅色设置 + 深色背景」的半套配色，正是本卡要修的怪样子。
  const theme = composeTheme({
    bridgeTokens: { "--magpie-bg": "#101820" },
    bridgeScheme: "dark",
    settings: { theme: "light", textSize: 100 },
  });
  assert.equal(theme.scheme, "light");
  assert.equal(theme.tokens["--magpie-bg"], MAGPIE_PALETTE.light.bg);
  assert.notEqual(theme.source, "bridge");
});

test("composeTheme：theme=system 时 bridge 报的 dark 优先于浏览器当前偏好", () => {
  // theme-tokens.md §4：窗口主题可能被用户手动覆盖过，prefers-color-scheme 只反映
  // 操作系统，二者常常不一致。magpie 报的 dark 是唯一权威。
  const theme = composeTheme({
    bridgeScheme: "dark",
    settings: { theme: "system", textSize: 100 },
    prefer: "light",
  });
  assert.equal(theme.scheme, "dark");
});

test("composeTheme：theme=system 且没有 bridge 时才用浏览器的 prefers-color-scheme", () => {
  assert.equal(
    composeTheme({ settings: { theme: "system", textSize: 100 }, prefer: "dark" }).scheme,
    "dark",
  );
  assert.equal(
    composeTheme({ settings: { theme: "system", textSize: 100 }, prefer: "light" }).scheme,
    "light",
  );
});

test("composeTheme：什么都不知道时回落浅色（不闪黑）", () => {
  const theme = composeTheme({});
  assert.equal(theme.scheme, "light");
  assert.equal(theme.tokens["--magpie-bg"], MAGPIE_PALETTE.light.bg);
});

test("composeTheme：--magpie-muted 两套都有值，且深色的比浅色的亮", () => {
  // `--term-muted` 是全仓用得最多的一档弱文字（60 处）。它必须有**两套**值：
  // 只给浅色一套的话，深色主题下会拿浅灰配深底，对比度实测只有 3.59:1，说明文字发虚。
  const light = composeTheme({ settings: { theme: "light", textSize: 100 } }).tokens["--magpie-muted"];
  const dark = composeTheme({ settings: { theme: "dark", textSize: 100 } }).tokens["--magpie-muted"];
  assert.ok(light, "浅色必须有 muted");
  assert.ok(dark, "深色必须有 muted");
  assert.notEqual(light, dark, "两套不能是同一个值");
  assert.ok(luminanceOf(dark) > luminanceOf(light), "深色主题的 muted 应该更亮（才能压在深底上）");
});

/** 测试内用的亮度（与服务端实现同源，但不依赖它的导出，避免「自己测自己」）。 */
function luminanceOf(hex) {
  const body = hex.replace("#", "");
  const channel = (v) => {
    const c = Number.parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(body.slice(0, 2)) +
    0.7152 * channel(body.slice(2, 4)) +
    0.0722 * channel(body.slice(4, 6))
  );
}

test("composeTheme：返回的每个变量名都是 --magpie-* 形态（AC1）", () => {
  const theme = composeTheme({ settings: { theme: "dark", textSize: 100 } });
  const names = Object.keys(theme.tokens);
  assert.ok(names.length > 5, `变量数应 > 5，实际 ${names.length}`);
  for (const name of names) {
    assert.match(name, /^--magpie-[a-z0-9-]+$/, `变量名必须是 --magpie-*：${name}`);
  }
});

test("composeTheme：bridge 里我们没枚举到的键也透传（不猜语义，也不丢）", () => {
  const theme = composeTheme({
    bridgeTokens: { "--magpie-bg": "#101820", "--magpie-surface-2": "#151c26" },
    bridgeScheme: "dark",
    settings: { theme: "dark", textSize: 100 },
  });
  assert.equal(theme.tokens["--magpie-surface-2"], "#151c26");
});

test("composeTheme：每个变量值都能安全拼进 <style>", () => {
  const theme = composeTheme({ settings: { theme: "dark", textSize: 100 } });
  for (const [name, value] of Object.entries(theme.tokens)) {
    assert.equal(isSafeTokenValue(value), true, `${name} 的值不安全：${value}`);
  }
});

test("composeTheme：textSize / lang 原样带出（AC7 的原料）", () => {
  const theme = composeTheme({ settings: { theme: "light", textSize: 130, lang: "ja" } });
  assert.equal(theme.textSize, 130);
  assert.equal(theme.lang, "ja");
});

test("fontPxForTextSize：夹在 80…160%，非法值回落 100%", () => {
  assert.equal(fontPxForTextSize(100), 13);
  assert.equal(fontPxForTextSize(110), 14.3);
  assert.equal(fontPxForTextSize(130), 16.9);
  assert.equal(fontPxForTextSize(50), fontPxForTextSize(80), "低于 80 按 80 算");
  assert.equal(fontPxForTextSize(500), fontPxForTextSize(160), "高于 160 按 160 算");
  assert.equal(fontPxForTextSize(undefined), 13);
  assert.equal(fontPxForTextSize("abc"), 13);
});

/* ========================================================================
 * 新鲜度：bridge 快照 vs settings.json mtime
 *
 * 这一组守的是「不刷新就不变色」本身：页面打开时 bridge 报深色，
 * 用户之后在 magpie 里改成浅色（写 settings.json，mtime 变新）——如果继续信
 * 那份旧快照，页面会永远停在深色，本卡最硬的那条 AC 就不成立。
 * ====================================================================== */

test("composeTheme：bridgeScheme 为 null（快照已过时）时不采用旧令牌", () => {
  const theme = composeTheme({
    bridgeTokens: { "--magpie-bg": "#0b0f14", "--magpie-fg": "#e6edf3" },
    // 服务端判定快照已过时 → 传 null，而不是传旧的 "dark"。
    bridgeScheme: null,
    settings: { theme: "light", textSize: 100 },
    prefer: "light",
  });
  assert.equal(theme.scheme, "light");
  assert.notEqual(theme.tokens["--magpie-bg"], "#0b0f14", "旧令牌里的背景不能再用（会得到半套色）");
  assert.equal(theme.tokens["--magpie-bg"], MAGPIE_PALETTE.light.bg);
  assert.notEqual(theme.source, "bridge");
});
