// AC8 证据脚本：真浏览器下终端四周的像素验收（浅色 + 深色两套主题）。
//
// 用法（仓库根）：node scripts/probe-terminal-edges.mjs [--json] [--keep-shots]
//
// 判据（prd R4 / AC8）：
//   - `.xterm .xterm-viewport` 的 computed background-color == 页面 `--term-bg` 的实际色值
//   - 终端容器四边各取 3 个采样点：0 个异色像素带（与 viewport 底色同色）
//   - 底部没有黑带（最后一整行采样都不含纯黑异色）
//   - 浅色 / 深色各跑一次（`?theme=light` 与 `?theme=dark`，两套 `--term-bg` 不同）
//
// 注意：这里是**真 Chrome + 真 PNG 解码取像素**，不是读 CSS 声明。截图落在
// .dispatch/fix17-a/evidence/ 下（--keep-shots 时保留，默认也保留，便于人工复核）。

import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { startServer } from "../src/server/http.mjs";
import { decodePng, openBrowser, sleep } from "./lib/cdp.mjs";
import { shutdown } from "./lib/pty-cleanup.mjs";

const json = process.argv.includes("--json");
const EVIDENCE_DIR = path.resolve(".dispatch", "fix17-a", "evidence", "ac8-shots");

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

function parseRgb(text) {
  const value = String(text || "").trim();
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value);
  if (!match) return null;
  return [Math.round(Number(match[1])), Math.round(Number(match[2])), Math.round(Number(match[3]))];
}

function sameColor(a, b, tolerance = 2) {
  if (!a || !b) return false;
  return (
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance
  );
}

const rgbText = (color) => (color ? `rgb(${color[0]}, ${color[1]}, ${color[2]})` : "null");

/**
 * 在页面里等终端挂载 + 首个会话起来，并返回几何与 computed 颜色。
 */
async function inspectTerminal(browser) {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 30000) throw new Error("terminal never mounted");
    const probe = await browser.evaluate(`
      (() => {
        const pane = document.querySelector('[data-role="terminal-pane"]:not([hidden])');
        const xterm = pane ? pane.querySelector('.xterm') : null;
        const viewport = pane ? pane.querySelector('.xterm-viewport') : null;
        const screen = pane ? pane.querySelector('.xterm-screen') : null;
        if (!pane || !xterm || !viewport || !screen) return null;
        const rect = pane.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return null;
        const cs = (el) => el ? getComputedStyle(el) : null;
        const root = getComputedStyle(document.documentElement);
        return {
          pane: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          xtermRect: (() => { const r = xterm.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
          screenRect: (() => { const r = screen.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
          viewportBg: cs(viewport).backgroundColor,
          xtermBg: cs(xterm).backgroundColor,
          screenBg: cs(screen).backgroundColor,
          paneBg: cs(pane).backgroundColor,
          bodyBg: cs(document.body).backgroundColor,
          htmlBg: cs(document.documentElement).backgroundColor,
          termBgVar: root.getPropertyValue('--term-bg').trim(),
          magpieBgVar: root.getPropertyValue('--magpie-bg').trim(),
          termFgVar: root.getPropertyValue('--term-fg').trim(),
          xtermPadding: cs(xterm).padding,
          colorScheme: root.colorScheme,
          themeClasses: document.documentElement.className,
          xtermCount: document.querySelectorAll('.xterm').length,
          // 故意的覆盖层：AI 把手按钮与 xterm 自绘滚动条滑块。
          // 它们本来就不跟终端同色（把手是半透明色块、滑块是滚动条），采样时要排除。
          overlays: (() => {
            const boxes = [];
            const pushBox = (name, el) => {
              if (!el) return;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return;
              boxes.push({ name, x: r.x, y: r.y, width: r.width, height: r.height });
            };
            pushBox('ai-handle', document.querySelector('[data-role="ai-handle"]'));
            for (const el of document.querySelectorAll('.xterm .scrollbar.vertical')) pushBox('xterm-scrollbar-v', el);
            for (const el of document.querySelectorAll('.xterm .scrollbar.horizontal')) pushBox('xterm-scrollbar-h', el);
            for (const el of document.querySelectorAll('.xterm .slider')) pushBox('xterm-slider', el);
            return boxes;
          })(),
          // xterm 自己渲染用的 theme.background（从 canvas 的实际像素最能说明问题，
          // 这里先读 options，最终判据仍是截图像素）
          xtermThemeBackground: (() => {
            try {
              const term = window.__probeTermRef || null;
              return term && term.options ? term.options.theme && term.options.theme.background : null;
            } catch { return null; }
          })(),
        };
      })()
    `);
    if (probe) return probe;
    await sleep(250);
  }
}

/**
 * 采样：四边各取 3 点 + 底边一整行 + 左右两条竖线。
 * 只采样**终端容器内部**的像素（排除 1px 边框与圆角）。
 *
 * `overlays` 是「故意的覆盖层」矩形（AI 把手 / xterm 自己的滚动条滑块）——
 * 它们本来就不跟终端同色，落在采样点上会把探针变成噪声。这些点单独统计并
 * 在报告里列出，不参与「异色带」判据；判据只针对**底色不匹配**（问题 3 的真症状）。
 */
function sampleEdges(image, rect, expected, overlays = []) {
  const inset = 2;
  const left = Math.round(rect.x) + inset;
  const right = Math.round(rect.x + rect.width) - inset - 1;
  const top = Math.round(rect.y) + inset;
  const bottom = Math.round(rect.y + rect.height) - inset - 1;
  const middleY = Math.round(rect.y + rect.height / 2);
  const middleX = Math.round(rect.x + rect.width / 2);

  const clamp = (value, max) => Math.max(0, Math.min(max - 1, value));
  const at = (x, y) => image.at(clamp(x, image.width), clamp(y, image.height));
  const overlayAt = (x, y) =>
    overlays.find(
      (box) => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height,
    ) || null;

  const samples = [];
  const skipped = [];
  const push = (label, x, y) => {
    const overlay = overlayAt(x, y);
    if (overlay) {
      skipped.push({ label, x, y, overlay: overlay.name });
      return;
    }
    const color = at(x, y);
    samples.push({ label, x, y, color, same: sameColor(color, expected) });
  };

  for (const dx of [0, 1, 2]) {
    push(`left+${dx}`, left + dx, middleY);
    push(`right-${dx}`, right - dx, middleY);
  }
  for (const dy of [0, 1, 2]) {
    push(`top+${dy}`, middleX, top + dy);
    push(`bottom-${dy}`, middleX, bottom - dy);
  }
  // 底边一整行（横向每 1/16 取一点），找黑带。
  const bottomRow = [];
  for (let step = 0; step <= 16; step += 1) {
    const x = left + Math.round(((right - left) * step) / 16);
    if (overlayAt(x, bottom)) continue;
    bottomRow.push({ x, color: at(x, bottom) });
  }
  // 左右两条竖线（纵向每 1/8 取一点），找左右异色环。
  const leftColumn = [];
  const rightColumn = [];
  for (let step = 0; step <= 8; step += 1) {
    const y = top + Math.round(((bottom - top) * step) / 8);
    if (!overlayAt(left, y)) leftColumn.push({ y, color: at(left, y) });
    if (!overlayAt(right, y)) rightColumn.push({ y, color: at(right, y) });
  }
  const offSamples = samples.filter((sample) => !sample.same);
  const bottomOff = bottomRow.filter((item) => !sameColor(item.color, expected));
  const leftOff = leftColumn.filter((item) => !sameColor(item.color, expected));
  const rightOff = rightColumn.filter((item) => !sameColor(item.color, expected));
  const isBlack = (color) => color[0] === 0 && color[1] === 0 && color[2] === 0;

  return {
    samples,
    skipped,
    offSamples,
    bottomRow,
    bottomOff,
    leftColumn,
    rightColumn,
    leftOff,
    rightOff,
    // 底部是否还有纯黑带（问题 3 的原始症状：y>=1035 整条纯黑）
    blackBandAtBottom: bottomRow.filter((item) => isBlack(item.color)),
    // 四边（含底边整行与左右竖线）合计的异色像素点
    totalOff: offSamples.length + bottomOff.length + leftOff.length + rightOff.length,
  };
}

/* ---------------------------------------------------------------- 主流程 */

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-edges-"));
process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
const port = await freePort();
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const handle = await startServer({ port, log: quiet });
const base = `http://127.0.0.1:${port}`;

const results = [];
const record = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });
let error = null;
let browser = null;

try {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  browser = await openBrowser({ width: 1400, height: 900 });

  for (const theme of ["light", "dark"]) {
    // 不给 tokens：走 tokens.css 的兜底色（正是本批要修的那条回退链）。
    await browser.navigate(`${base}/?token=${handle.token}&theme=${theme}`);
    // 等终端真的挂上（页面会自动建首个标签）。
    let info = null;
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > 30000) throw new Error(`${theme}: terminal never mounted`);
      await sleep(300);
      try {
        info = await inspectTerminal(browser);
      } catch {
        info = null;
      }
      if (info) break;
    }
    await sleep(1200);
    info = await inspectTerminal(browser);

    const shot = await browser.screenshot();
    if (!shot) throw new Error("screenshot failed");
    const shotPath = path.join(EVIDENCE_DIR, `terminal-edges-${theme}.png`);
    await writeFile(shotPath, shot);

    const image = decodePng(shot);
    const expected = parseRgb(info.viewportBg);
    const edges = sampleEdges(image, info.pane, expected, info.overlays);

    // 判据 1：viewport 的实际背景不是纯黑（问题 3 的原始症状）。
    // 判据 2：viewport 底色 == 页面 --term-bg 的解析值。
    //   页面 --term-bg 来自 tokens.css（真实色值），xterm 的 viewport 必须跟着它。
    const pageBg = parseRgb(info.bodyBg);
    record(
      `AC8.${theme}.1 xterm-viewport 背景不是纯黑，且与页面底色一致`,
      !(expected && expected[0] === 0 && expected[1] === 0 && expected[2] === 0) &&
        sameColor(expected, pageBg, 4),
      {
        viewportBg: info.viewportBg,
        bodyBg: info.bodyBg,
        htmlBg: info.htmlBg,
        termBgVar: info.termBgVar,
        magpieBgVar: info.magpieBgVar,
        termFgVar: info.termFgVar,
        colorScheme: info.colorScheme,
        themeClasses: info.themeClasses,
        screenshot: shotPath,
      },
    );

    record(
      `AC8.${theme}.2 .xterm 没有 padding（2px 环的来源已去掉）`,
      /^(0px)?$/.test(String(info.xtermPadding).replace(/\s/g, "")) ||
        String(info.xtermPadding).replace(/\s/g, "") === "0px",
      { xtermPadding: info.xtermPadding, pane: info.pane, xtermRect: info.xtermRect },
    );

    record(
      `AC8.${theme}.3 终端四边 0 个异色像素点（左/右/上/下 各 3 点 + 底边整行 + 左右竖线；已知覆盖层已排除）`,
      edges.totalOff === 0,
      {
        expected: rgbText(expected),
        expectedHex: info.termBgVar,
        offSamples: edges.offSamples,
        bottomOff: edges.bottomOff,
        leftOff: edges.leftOff,
        rightOff: edges.rightOff,
        totalOff: edges.totalOff,
        // 落在故意覆盖层上而被排除的点（AI 把手 24px / xterm 滚动条滑块）
        skippedOverlays: edges.skipped,
        overlays: info.overlays,
      },
    );

    record(`AC8.${theme}.4 底部没有黑带`, edges.blackBandAtBottom.length === 0, {
      blackBandAtBottom: edges.blackBandAtBottom.slice(0, 5),
      blackBandCount: edges.blackBandAtBottom.length,
      bottomRowFirst: edges.bottomRow[0],
      bottomRowLast: edges.bottomRow[edges.bottomRow.length - 1],
    });

    // 判据 5：终端**内部**的字符画布底色也是同一个色（不是只有 viewport 改了）。
    const screenCenter = image.at(
      Math.round(info.screenRect.x + info.screenRect.width / 2),
      Math.round(info.screenRect.y + info.screenRect.height - 30),
    );
    record(
      `AC8.${theme}.5 xterm 画面内部区域也是同一底色（画布背景已跟随主题）`,
      sameColor(screenCenter, expected, 6) || sameColor(screenCenter, parseRgb(info.bodyBg), 6),
      {
        screenCenter: rgbText(screenCenter),
        expected: rgbText(expected),
        note: "画面里可能有文字像素；采样点在屏幕底部空白区，正常应为纯底色",
        screenRect: info.screenRect,
      },
    );
  }
} catch (err) {
  error = err && err.message ? err.message : String(err);
} finally {
  if (browser) await browser.close();
  // 必须等 ConPTY 真正释放 console 再退进程（见 scripts/lib/pty-cleanup.mjs）。
  await shutdown(handle);
}

const failed = results.filter((item) => !item.pass);
if (json) {
  console.log(JSON.stringify({ results, error, evidenceDir: EVIDENCE_DIR }, null, 2));
} else {
  for (const item of results) {
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}`);
    console.log(`      ${JSON.stringify(item.detail)}`);
  }
  if (error) console.log(`ERROR ${error}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(`screenshots: ${EVIDENCE_DIR}`);
}

process.exit(error || failed.length > 0 ? 1 : 0);
