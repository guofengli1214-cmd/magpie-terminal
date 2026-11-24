// TASK-FIX17-B 主题验收探针（真 Chrome + 真服务 + 真 xterm）。
//
// 用法（仓库根）：
//   node scripts/probe-theme.mjs            # 跑全部断言，输出 JSON 行 + 结尾 summary
//   node scripts/probe-theme.mjs --json     # 只输出一行 JSON
//   node scripts/probe-theme.mjs --keep-shots
//
// 覆盖 AC1 / AC2 / AC3 / AC5 / AC6 / AC7 / AC8 / AC10。AC4 是源码 grep（在报告里给命令），
// AC9 是 `node --test` + `scripts/doctor.mjs`（不在这里跑，避免嵌套起服务）。
//
// 设计要点：
//   * **真浏览器**：AC3「改主题后不刷新页面颜色就变」只有在真 Chrome 里才有意义
//     （要的就是 CDP 观测到的计算样式改变，而不是我们自己调了个函数）。
//   * **真色板**：AC5 要打 16 色，用真 xterm 回放真 ANSI 字节流，再从 xterm
//     **计算出来的 theme 对象**取 16 个值判对比度 —— 不是在 CSS 里 grep 色值。
//   * **不碰真实配置**：`MAGPIE_TERMINAL_CONFIG_PATH` 与 `MAGPIE_SETTINGS_PATH`
//     都指到临时目录，所以不会动用户的 `~/.config/magpie/settings.json`。
//
// 退出码：全过 0，否则 1。

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/http.mjs";
import { openBrowser, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const jsonOnly = argv.includes("--json");
const evidenceDir = path.resolve(".dispatch", "fix17-b", "evidence");

/* ---------------------------------------------------------------- 小工具 */

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const results = [];
function record(name, pass, detail, expected) {
  results.push({ name, pass: Boolean(pass), detail, expected });
  if (!jsonOnly) {
    const mark = pass ? "PASS" : "FAIL";
    console.error(`[${mark}] ${name} ${pass ? "" : JSON.stringify(detail)}`);
  }
}

/** 解析 CSS 色值（含 `color(srgb r g b / a)`，color-mix() 算出来就是它）。 */
function parseColor(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(value);
  if (hex) {
    const b = hex[1];
    const ex = (s) => Number.parseInt(s.length === 1 ? s + s : s, 16);
    if (b.length === 3 || b.length === 4) return [ex(b[0]), ex(b[1]), ex(b[2]), 1];
    if (b.length === 6 || b.length === 8) {
      return [
        Number.parseInt(b.slice(0, 2), 16),
        Number.parseInt(b.slice(2, 4), 16),
        Number.parseInt(b.slice(4, 6), 16),
        b.length === 8 ? Number.parseInt(b.slice(6, 8), 16) / 255 : 1,
      ];
    }
    return null;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = fn[1].split(/[,/]/).map((s) => s.trim());
    return [
      Math.round(Number(parts[0])),
      Math.round(Number(parts[1])),
      Math.round(Number(parts[2])),
      parts.length > 3 ? Number(parts[3]) : 1,
    ];
  }
  const sc = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  if (sc) {
    return [
      Math.round(Number(sc[1]) * 255),
      Math.round(Number(sc[2]) * 255),
      Math.round(Number(sc[3]) * 255),
      sc[4] === undefined ? 1 : Number(sc[4]),
    ];
  }
  return null;
}

/** WCAG 相对亮度。 */
function luminance(rgb) {
  const ch = (v) => {
    const c = Math.min(255, Math.max(0, v)) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
}

/** WCAG 对比度（1…21）。 */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const hex = (rgb) =>
  rgb ? `#${rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}` : "null";

/** 16 色 ANSI 名称（xterm theme 的键）。 */
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/* ---------------------------------------------------------------- 主流程 */

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-theme-"));
process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
const settingsPath = path.join(dir, "magpie-settings.json");
process.env.MAGPIE_SETTINGS_PATH = settingsPath;

async function writeSettings(patch) {
  await writeFile(settingsPath, JSON.stringify(patch, null, 2));
}

await writeSettings({ theme: "light", accent: "#2563eb", textSize: 100, lang: "zh-CN" });

const port = await freePort();
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const handle = await startServer({ port, log: quiet });
const base = `http://127.0.0.1:${port}`;
const token = handle.token;

let browser = null;
let fatal = null;

try {
  await mkdir(evidenceDir, { recursive: true });

  /* ---------------- AC1：GET /api/theme ---------------- */
  {
    const response = await fetch(`${base}/api/theme?token=${token}`);
    const body = await response.json();
    const names = Object.keys(body.tokens || {});
    const badNames = names.filter((name) => !/^--magpie-[a-z0-9-]+$/.test(name));
    record("AC1.1 GET /api/theme 返回 200 + 非空 tokens", response.status === 200 && names.length > 0, {
      status: response.status,
      tokenCount: names.length,
    });
    record(
      "AC1.2 所有变量名都是 --magpie-* 形态",
      names.length > 0 && badNames.length === 0,
      { names, badNames },
    );
    record(
      "AC1.3 值来自 magpie（accent 跟随 settings.json 的 #2563eb）",
      body.tokens["--magpie-accent"] === "#2563eb",
      { accent: body.tokens["--magpie-accent"] },
    );
    record("AC1.4 报告当前深浅色与字号", body.scheme === "light" && body.textSize === 100, {
      scheme: body.scheme,
      textSize: body.textSize,
      source: body.source,
    });
    await writeFile(
      path.join(evidenceDir, "AC1-api-theme.json"),
      `${JSON.stringify(body, null, 2)}\n`,
    );
  }

  /* ---------------- AC2：首屏注入 ---------------- */
  {
    const html = await fetch(`${base}/?token=${token}`).then((r) => r.text());
    const match = /<style>html:root \{([\s\S]*?)\}<\/style>/.exec(html);
    const lines = match
      ? match[1]
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
    record(
      "AC2.1 注入的 <style> 用 html:root 且变量数 > 5",
      Boolean(match) && lines.length > 5,
      { selector: match ? "html:root" : null, count: lines.length },
    );
    record(
      "AC2.2 注入的键全部是 --magpie-*",
      lines.length > 0 && lines.every((line) => /^\s*--magpie-[a-z0-9-]+:/.test(line)),
      { lines },
    );
    record("AC2.3 注入含 --magpie-bg 且是真实色值", /--magpie-bg:\s*#[0-9a-fA-F]{3,8};/.test(match ? match[1] : ""), {
      bg: (match && /--magpie-bg:\s*([^;]+);/.exec(match[1])?.[1]) || null,
    });
    await writeFile(path.join(evidenceDir, "AC2-injected.html"), html);
  }

  /* ---------------- AC10：注入安全 ---------------- */
  {
    const evil = Buffer.from(
      JSON.stringify({
        bg: "</style><script>alert(1)</script>",
        fg: "</style><script>window.__pwned=1</script>",
        card: "red; } body { display: none }",
        line: "url(javascript:alert(1))",
      }),
    ).toString("base64");
    const html = await fetch(`${base}/?token=${token}&tokens=${encodeURIComponent(evil)}`).then((r) => r.text());
    record(
      "AC10.1 服务端丢弃注入串：页面不含 </style><script>",
      !html.includes("</style><script>") && !html.includes("<script>alert(1)"),
      {
        hasClosingStyleScript: html.includes("</style><script>"),
        hasAlert: html.includes("alert(1)"),
      },
    );
    record(
      "AC10.2 注入串里的其它法（分号逃逸 / javascript:）也被丢",
      !html.includes("display: none") && !html.includes("javascript:alert"),
      {
        hasSemicolonEscape: html.includes("display: none"),
        hasJavascriptUrl: html.includes("javascript:alert"),
      },
    );
    // 合法键必须仍然进得去（否则「全丢弃」也能让上面两条变绿）。
    // 注意：同一批里 `bg` 是注入串就被丢，所以另开一个只含合法键的请求。
    const good = Buffer.from(JSON.stringify({ bg: "#123456", fg: "#abcdef" })).toString("base64");
    const htmlGood = await fetch(`${base}/?token=${token}&theme=dark&tokens=${encodeURIComponent(good)}`)
      .then((r) => r.text());
    record(
      "AC10.3 同一批请求里合法的裸键 bg / fg 仍然被归一后注入",
      htmlGood.includes("--magpie-bg: #123456;") && htmlGood.includes("--magpie-fg: #abcdef;"),
      {
        injectedBg: /--magpie-bg:\s*([^;]+);/.exec(htmlGood)?.[1] || null,
        injectedFg: /--magpie-fg:\s*([^;]+);/.exec(htmlGood)?.[1] || null,
      },
    );
    await writeFile(path.join(evidenceDir, "AC10-injection.html"), html);
  }

  /* ---------------- 真浏览器：AC3 / AC5 / AC6 / AC7 / AC8 ---------------- */
  browser = await openBrowser({ width: 1400, height: 900 });

  /** 读页面当前主题状态（含真实 xterm 实例的 theme 与字号）。 */
  const probe = () =>
    browser.evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const viewport = document.querySelector('.xterm-viewport');
      // 把 --term-panel-2 落到真元素上读**算出来的** backgroundColor：
      // 这是判断「是不是不透明实色」最硬的方式（AC8）。
      const d = document.createElement('div');
      d.style.background = 'var(--term-panel-2)';
      document.body.appendChild(d);
      const panel2 = getComputedStyle(d).backgroundColor;
      d.remove();
      return {
        className: document.documentElement.className,
        dataServed: document.documentElement.getAttribute('data-mt-served'),
        rootFontSize: cs.fontSize,
        bodyBg: body.backgroundColor,
        magpieBg: cs.getPropertyValue('--magpie-bg').trim(),
        magpieFg: cs.getPropertyValue('--magpie-fg').trim(),
        termBg: cs.getPropertyValue('--term-bg').trim(),
        panel2,
        ansiWhite: cs.getPropertyValue('--term-ansi-white').trim(),
        viewportBg: viewport ? getComputedStyle(viewport).backgroundColor : null,
        xtermCount: document.querySelectorAll('.xterm').length,
        termInst: typeof window.__termDebugTheme === 'function' ? window.__termDebugTheme() : null,
      };
    })()`);

  /** 等页面上的终端实例起来（首个标签自动创建）。 */
  async function waitForTerminal(label) {
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > 30000) throw new Error(`${label}: terminal never mounted`);
      await sleep(250);
      try {
        const state = await probe();
        if (state.termInst && state.termInst.id) return state;
      } catch {
        // 页面还在导航。
      }
    }
  }

  await browser.navigate(`${base}/?token=${token}`);
  let state = await waitForTerminal("boot");

  /* AC6：<html> 上有 is-dark / is-light 之一，且有对应 CSS 规则生效 */
  {
    const boot = await probe();
    record(
      "AC6.1 <html> 带 is-light（浅色设置）",
      /\bis-light\b/.test(boot.className) && !/\bis-dark\b/.test(boot.className),
      { className: boot.className },
    );
    // 换到深色，读同一个元素的背景，证明「类有对应 CSS 规则」而不是空声明。
    await writeSettings({ theme: "dark", accent: "#2563eb", textSize: 100, lang: "zh-CN" });
    await sleep(2200);
    const dark = await probe();
    record(
      "AC6.2 <html> 换成 is-dark，并且 getComputedStyle 证明背景确实不同",
      /\bis-dark\b/.test(dark.className) &&
        parseColor(dark.bodyBg) &&
        parseColor(boot.bodyBg) &&
        Math.abs(luminance(parseColor(dark.bodyBg)) - luminance(parseColor(boot.bodyBg))) > 0.1,
      {
        lightClass: boot.className,
        lightBg: boot.bodyBg,
        lightLuminance: parseColor(boot.bodyBg) ? Number(luminance(parseColor(boot.bodyBg)).toFixed(4)) : null,
        darkClass: dark.className,
        darkBg: dark.bodyBg,
        darkLuminance: parseColor(dark.bodyBg) ? Number(luminance(parseColor(dark.bodyBg)).toFixed(4)) : null,
      },
    );
  }

  /* ---------------- AC3：改主题不刷新就变色 ---------------- */
  {
    await writeSettings({ theme: "light", accent: "#2563eb", textSize: 100, lang: "zh-CN" });
    await sleep(2200);
    const light = await probe();

    await writeSettings({ theme: "dark", accent: "#2563eb", textSize: 100, lang: "zh-CN" });
    await sleep(2200);
    const dark = await probe();

    const lightBg = parseColor(light.bodyBg);
    const darkBg = parseColor(dark.bodyBg);
    const lightMagpie = parseColor(light.magpieBg);
    const darkMagpie = parseColor(dark.magpieBg);

    record(
      "AC3.1 不刷新页面，body 背景从浅色变成深色",
      lightBg && darkBg && luminance(lightBg) > 0.6 && luminance(darkBg) < 0.1,
      {
        lightBg: light.bodyBg,
        lightLuminance: lightBg ? Number(luminance(lightBg).toFixed(4)) : null,
        darkBg: dark.bodyBg,
        darkLuminance: darkBg ? Number(luminance(darkBg).toFixed(4)) : null,
      },
    );
    record(
      "AC3.2 body 背景与 --magpie-bg 一致（两个主题各自）",
      lightBg &&
        darkBg &&
        lightMagpie &&
        darkMagpie &&
        Math.abs(lightBg[0] - lightMagpie[0]) <= 2 &&
        Math.abs(darkBg[0] - darkMagpie[0]) <= 2,
      { light: { body: light.bodyBg, var: light.magpieBg }, dark: { body: dark.bodyBg, var: dark.magpieBg } },
    );
    record(
      "AC3.3 终端实例的 theme.background 也跟着变了（不是只改 CSS）",
      dark.termInst &&
        light.termInst &&
        dark.termInst.background !== light.termInst.background &&
        parseColor(dark.termInst.background) &&
        luminance(parseColor(dark.termInst.background)) < 0.1,
      {
        lightTermBg: light.termInst ? light.termInst.background : null,
        darkTermBg: dark.termInst ? dark.termInst.background : null,
      },
    );
    record(
      "AC3.4 xterm-viewport 的实际底色跟着主题（无刷新）",
      parseColor(dark.viewportBg) && luminance(parseColor(dark.viewportBg)) < 0.1,
      { lightViewport: light.viewportBg, darkViewport: dark.viewportBg },
    );

    // 再切回 light，证明是「跟随」而不是「单向变黑」。
    await writeSettings({ theme: "light", accent: "#2563eb", textSize: 100, lang: "zh-CN" });
    await sleep(2200);
    const back = await probe();
    record(
      "AC3.5 再切回 light 也立即生效（双向）",
      parseColor(back.bodyBg) && luminance(parseColor(back.bodyBg)) > 0.6,
      { backBg: back.bodyBg, backClass: back.className },
    );
    await writeFile(path.join(evidenceDir, "AC3-theme-switch.json"), `${JSON.stringify({ light, dark, back }, null, 2)}\n`);
  }

  /* ---------------- AC8：--term-panel-2 两个主题都是不透明实色 ---------------- */
  {
    const seen = [];
    for (const theme of ["light", "dark"]) {
      await writeSettings({ theme, accent: "#2563eb", textSize: 100, lang: "zh-CN" });
      await sleep(2200);
      const s = await probe();
      const parsed = parseColor(s.panel2);
      seen.push({ theme, panel2: s.panel2, alpha: parsed ? parsed[3] : null, className: s.className });
    }
    record(
      "AC8.1 浅色主题下 --term-panel-2 是不透明实色（alpha == 1）",
      seen[0].alpha === 1 && !/rgba\([^)]*,\s*0?\.\d+\)/.test(seen[0].panel2),
      seen[0],
    );
    record(
      "AC8.2 深色主题下 --term-panel-2 也是不透明实色（alpha == 1）",
      seen[1].alpha === 1 && !/rgba\([^)]*,\s*0?\.\d+\)/.test(seen[1].panel2),
      seen[1],
    );
    // 修之前的形态：rgba(120,120,120,0.12) → 88% 透明。明确断言不再出现。
    record(
      "AC8.3 两个主题里都没有 rgba(120,120,120,…) 这种 88% 透明的面板底色",
      seen.every((row) => !/120\s*,\s*120\s*,\s*120/.test(row.panel2)),
      seen,
    );
    await writeFile(path.join(evidenceDir, "AC8-panel2.json"), `${JSON.stringify(seen, null, 2)}\n`);
  }

  /* ---------------- AC7：字号跟随 textSize ---------------- */
  {
    await writeSettings({ theme: "light", accent: "#2563eb", textSize: 110, lang: "zh-CN" });
    await sleep(2200);
    const before = await probe();
    await writeSettings({ theme: "light", accent: "#2563eb", textSize: 130, lang: "zh-CN" });
    await sleep(2200);
    const after = await probe();
    const beforePx = Number.parseFloat(before.rootFontSize);
    const afterPx = Number.parseFloat(after.rootFontSize);
    record(
      "AC7.1 textSize 110 → 130，根字号变大（不刷新）",
      Number.isFinite(beforePx) && Number.isFinite(afterPx) && afterPx > beforePx,
      { before: before.rootFontSize, after: after.rootFontSize },
    );
    record(
      "AC7.2 终端实例的 fontSize 也跟着变大",
      before.termInst &&
        after.termInst &&
        Number.isFinite(before.termInst.fontSize) &&
        Number.isFinite(after.termInst.fontSize) &&
        after.termInst.fontSize > before.termInst.fontSize,
      {
        before: before.termInst ? before.termInst.fontSize : null,
        after: after.termInst ? after.termInst.fontSize : null,
      },
    );
    await writeFile(path.join(evidenceDir, "AC7-font-size.json"), `${JSON.stringify({ before, after }, null, 2)}\n`);
  }

  /* ---------------- AC5：ANSI 16 色在浅色主题下可读 ---------------- */
  {
    const detail = [];
    for (const theme of ["light", "dark"]) {
      await writeSettings({ theme, accent: "#2563eb", textSize: 100, lang: "zh-CN" });
      await sleep(2400);
      // 两个来源要交叉校验：
      //   ① CSS 变量的值（构建 theme 的原料）
      //   ② 真 xterm 实例的 theme 对象（用户屏幕上真正用的那一套）
      // 只读①会漏掉「变量改了但实例没同步」这个本卡最核心的 bug。
      const live = await browser.evaluate(`(() => {
        const cs = getComputedStyle(document.documentElement);
        const keys = ${JSON.stringify(ANSI_KEYS)};
        const kebab = (k) => '--term-ansi-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        const vars = {};
        for (const k of keys) vars[k] = cs.getPropertyValue(kebab(k)).trim();
        const inst = typeof window.__termDebugTheme === 'function' ? window.__termDebugTheme() : null;
        return {
          vars,
          instancePalette: inst ? inst.palette : null,
          instanceBg: inst ? inst.background : null,
          termBg: cs.getPropertyValue('--term-bg').trim(),
          className: document.documentElement.className,
        };
      })()`);

      const bg = parseColor(live.instanceBg || live.termBg);
      const contrasts = {};
      const instanceMatchesVars = [];
      for (const key of ANSI_KEYS) {
        const fromInstance = live.instancePalette ? live.instancePalette[key] : null;
        const fromVars = live.vars[key];
        // 实例里的色值应与变量一致（变量是原料，实例是成品）。
        const a = parseColor(fromInstance);
        const b = parseColor(fromVars);
        instanceMatchesVars.push({
          key,
          fromInstance,
          fromVars,
          equal: Boolean(a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]),
        });
        if (a && bg) contrasts[key] = Number(contrast(a, bg).toFixed(2));
      }
      detail.push({ ...live, contrasts, instanceMatchesVars });
    }

    record(
      "AC5.1 16 个 ANSI 键在浅/深两套里都取到了色值（变量 + 实例）",
      detail.every(
        (row) =>
          ANSI_KEYS.every((key) => Boolean(row.vars[key])) &&
          row.instancePalette &&
          ANSI_KEYS.every((key) => Boolean(row.instancePalette[key])),
      ),
      detail.map((row) => ({
        theme: row.className,
        varsCount: ANSI_KEYS.filter((k) => row.vars[k]).length,
        instanceCount: row.instancePalette ? ANSI_KEYS.filter((k) => row.instancePalette[k]).length : 0,
      })),
    );

    record(
      "AC5.2 终端实例用到的 16 色与 CSS 变量逐个相等（变化真的传到 xterm 了）",
      detail.every((row) => row.instanceMatchesVars.every((item) => item.equal)),
      detail.map((row) => ({
        theme: row.className,
        mismatched: row.instanceMatchesVars.filter((i) => !i.equal),
      })),
    );

    // 「可读」的判据分两种，因为 ANSI black 在深色底上本来就应该偏暗
    // （那是终端惯例：`\e[30m` 在深底上就是「隐身」的，用户要看的是
    //  brightBlack / 默认前景，不是 black 本身）。所以：
    //   ① 亮色档（7 个彩色 + 两个 white）必须与底色有足够对比度 —— 这才是「看得清」
    //   ② 两个 black 只要求在浅色主题下不与底色过近（浅底上 black 就是细字）
    const BRIGHT_KEYS = ANSI_KEYS.filter((key) => key !== "black" && key !== "brightBlack");
    const safeguard = 2.0;

    const belowIn = (row) =>
      BRIGHT_KEYS.filter((key) => Number.isFinite(row.contrasts[key]) && row.contrasts[key] < safeguard).map((key) => ({
        key,
        value: row.vars[key],
        ratio: row.contrasts[key],
      }));

    record(
      "AC5.3 浅色主题：14 个可见 ANSI 色与终端底色的对比度都 ≥ 2.0",
      belowIn(detail[0]).length === 0,
      { below: belowIn(detail[0]), contrasts: detail[0].contrasts },
    );
    record(
      "AC5.4 深色主题：同样 14 个可见色对比度 ≥ 2.0",
      belowIn(detail[1]).length === 0,
      { below: belowIn(detail[1]), contrasts: detail[1].contrasts },
    );

    // 「深底白字的反色」的具体判据：浅色主题下 ansi-white 必须比底色暗，
    // 深色主题下必须比底色亮。这是方向，不是绝对亮度 —— 方向错了就是反色。
    const lightWhite = parseColor(detail[0].vars.white);
    const lightBg = parseColor(detail[0].instanceBg || detail[0].termBg);
    record(
      "AC5.5 浅色主题下 ansi-white 比终端底色暗（没有深底白字的反色）",
      Boolean(lightWhite && lightBg) && luminance(lightWhite) < luminance(lightBg),
      {
        white: detail[0].vars.white,
        whiteLuminance: lightWhite ? Number(luminance(lightWhite).toFixed(4)) : null,
        bg: detail[0].instanceBg || detail[0].termBg,
        bgLuminance: lightBg ? Number(luminance(lightBg).toFixed(4)) : null,
      },
    );
    const darkWhite = parseColor(detail[1].vars.white);
    const darkBg = parseColor(detail[1].instanceBg || detail[1].termBg);
    record(
      "AC5.6 深色主题下 ansi-white 比终端底色亮（正常深底浅字）",
      Boolean(darkWhite && darkBg) && luminance(darkWhite) > luminance(darkBg),
      {
        white: detail[1].vars.white,
        whiteLuminance: darkWhite ? Number(luminance(darkWhite).toFixed(4)) : null,
        bg: detail[1].instanceBg || detail[1].termBg,
        bgLuminance: darkBg ? Number(luminance(darkBg).toFixed(4)) : null,
      },
    );

    // 浅色与深色必须是**两套不同**的 ANSI（R3 要求两套，不是一套）。
    const differing = ANSI_KEYS.filter((key) => detail[0].vars[key] !== detail[1].vars[key]);
    record(
      "AC5.7 浅/深两套 ANSI 至少 12 个色值不同（真的是两套色板）",
      differing.length >= 12,
      { differing: differing.length, total: ANSI_KEYS.length },
    );

    await writeFile(path.join(evidenceDir, "AC5-ansi.json"), `${JSON.stringify(detail, null, 2)}\n`);

    // 最后一步：在**真终端里**打 16 色（CDP 打字 → WS → 真 PTY → 真 bash），
    // 截图并核对输出落地。读变量只能证明「值对」，不能证明「画上去了」；
    // AC5 的读者是用户的眼睛，所以判据要落到真终端输出 + 截图。
    const printScript = [
      "printf '@ESC@# 16-color ANSI blocks@ESC@\n'",
      "for i in $(seq 0 15); do",
      "  if [ $i -lt 8 ]; then b=$((40+i)); else b=$((100+i-8)); fi",
      "  printf '@ESC@[%dm %02d @ESC@[0m' $b $i",
      "done",
      "printf '\n'",
      "",
    ]
      .join(String.fromCharCode(10))
      .split("@ESC@")
      .join(String.fromCharCode(27));
    const shPath = path.join(dir, "ansi-print.sh");
    await writeFile(shPath, printScript, "utf8");
    // Git Bash 看 Windows 盘符要换成 /c/... 形态。
    const shPosix = shPath.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(new RegExp(String.fromCharCode(92,92), "g"), "/");

    for (const [index, theme] of ["light", "dark"].entries()) {
      await writeSettings({ theme, accent: "#2563eb", textSize: 100, lang: "zh-CN" });
      await sleep(2400);
      // 让终端拿到焦点，再用真键盘路径把命令敲进去。
      await browser.evaluate(`(() => { const ta = document.querySelector('.xterm-helper-textarea'); if (ta) ta.focus(); return true; })()`);
      await browser.raw.send("Input.insertText", { text: `. ${shPosix}` });
      await sleep(400);
      await browser.raw.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
      await browser.raw.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
      await sleep(3000);
      const shot = await browser.screenshot();
      if (shot) await writeFile(path.join(evidenceDir, `AC5-ansi-print-${theme}.png`), shot);
      const tail = await browser.evaluate(`(() => {
        const lines = typeof window.__termDebugBuffer === 'function' ? window.__termDebugBuffer().lines : [];
        return lines.filter((l) => l.trim().length > 0).slice(-6);
      })()`);
      record(
        `AC5.${index === 0 ? 8 : 9} 真终端里跑 16 色打印命令（${theme}），输出落地`,
        Array.isArray(tail) && tail.some((line) => /00\s+01\s+02/.test(line)),
        { theme, tail },
      );
    }
  }

  /* ---------------- 收尾：宿主的 memory（供报告） ---------------- */
  {
    const final = await probe();
    await writeFile(path.join(evidenceDir, "final-state.json"), `${JSON.stringify(final, null, 2)}\n`);
  }
} catch (err) {
  fatal = err && err.message ? err.message : String(err);
  record("FATAL 探针自身失败", false, { error: fatal });
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // 忽略。
    }
  }
  try {
    await handle.close();
  } catch {
    // 忽略。
  }
}

const failed = results.filter((row) => !row.pass);
const summary = {
  pass: results.length - failed.length,
  fail: failed.length,
  total: results.length,
  failed: failed.map((row) => row.name),
  fatal,
};
if (jsonOnly) {
  console.log(JSON.stringify({ summary, results }));
} else {
  console.log(JSON.stringify({ summary, results }, null, 2));
}
process.exit(failed.length === 0 && !fatal ? 0 : 1);
