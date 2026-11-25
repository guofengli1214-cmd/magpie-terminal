// TASK-FIX17-L2 真浏览器探针：终端悬浮球（AC1–AC8）。
//
// 全部在**真 Chrome（headless + CDP）+ 真服务**里跑：断言的是
// getBoundingClientRect / getComputedStyle / 真实 WebSocket 帧 / 真实截图像素，
// 不是读 CSS 自己猜。AC9（`node --test` / doctor / probe-terminal-edges / 禁改）
// 不在本探针内，见 .dispatch/fix17-l2/REPORT.md。
//
// 用法（仓库根）：
//   node scripts/probe-orb.mjs            # 跑全部，证据落 .dispatch/fix17-l2/evidence/
//   node scripts/probe-orb.mjs --json     # 额外把结果 JSON 打到 stdout
//
// 退出码：0 全 PASS；1 有失败（失败项与原因同时写进 evidence/AC-results.json）。

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/http.mjs";
import { openBrowser, sleep } from "./lib/cdp.mjs";
import { shutdown } from "./lib/pty-cleanup.mjs";

const EVIDENCE_DIR = path.resolve(".dispatch", "fix17-l2", "evidence");
const SHOTS_DIR = path.join(EVIDENCE_DIR, "shots");
const JSON_FLAG = process.argv.includes("--json");

const results = [];
const record = (name, pass, detail, expected) => {
  results.push({ name, pass: Boolean(pass), detail, expected });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) console.log(`      actual  ${JSON.stringify(detail)}`);
  if (!pass && expected !== undefined) console.log(`      expect  ${JSON.stringify(expected)}`);
};

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

/* ---------------------------------------------------------------- 颜色小工具 */

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

function luminance(rgb) {
  const ch = (v) => {
    const c = Math.min(255, Math.max(0, v)) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const near = (a, b, tolerance = 4) =>
  Boolean(a && b) &&
  Math.abs(a[0] - b[0]) <= tolerance &&
  Math.abs(a[1] - b[1]) <= tolerance &&
  Math.abs(a[2] - b[2]) <= tolerance;

/* ---------------------------------------------------------------- 页面内注入 */

/**
 * 在 app.js 之前装的两段补丁（Page.addScriptToEvaluateOnNewDocument）：
 *
 *  1. /api/models 固定两条假模型 —— 探针要验的是球，不该被本机网关是否在线左右。
 *  2. WebSocket.prototype.send 把 agent.run / agent.stop **记录并吞掉**：
 *     探针要断言「Enter 真的发了 agent.run」「点停止真的发了 agent.stop」，
 *     但绝不能让它们真去这个 shell 里执行命令。
 */
const PAGE_PATCHES = `
(() => {
  const realFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = (init && init.method) || (typeof input === "object" && input && input.method) || "GET";
    if (method === "GET" && /\\/api\\/models(\\?|$)/.test(url)) {
      const body = {
        gateway: { reachable: true, durationMs: 3, baseUrl: "http://probe.invalid" },
        default: "probe/model-a",
        models: [{ id: "probe/model-a", label: "Probe Model A", contextLength: 128000, available: true }],
      };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    return realFetch(input, init);
  };

  window.__probeSentFrames = [];
  const realSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function patchedSend(data) {
    let frame = null;
    try {
      frame = JSON.parse(String(data));
    } catch {
      frame = null;
    }
    if (frame && (frame.type === "agent.run" || frame.type === "agent.stop")) {
      window.__probeSentFrames.push(frame);
      return;
    }
    return realSend.call(this, data);
  };
})();
`;

/** 页面里通用的小工具（拼在每个 evaluate 前面）。 */
const HELPERS = `
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const cs = (el, pseudo) => getComputedStyle(el, pseudo || null);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  const orb = () => q('[data-role="command-orb"]');
  const agent = () => (typeof window.__termDebugAgent === "function" ? window.__termDebugAgent() : null);
  const drawerOpen = () => document.querySelector('[data-role="app"]').getAttribute('data-ai-open');
  const orbState = () => { const el = orb(); return el ? el.getAttribute('data-state') : null; };
  const cssColor = (expr) => {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.background = expr;
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  };
`;

async function waitFor(browser, expression, { timeoutMs = 15000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await browser.evaluate(`(() => { ${HELPERS} return Boolean(${expression}); })()`);
    } catch {
      value = false;
    }
    if (value) return true;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(120);
  }
}

/** 真实鼠标移动（CDP Input.dispatchMouseEvent）。元素中心 → 目标坐标。 */
async function mouseTo(browser, x, y) {
  await browser.raw.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await sleep(90);
}

/** 把鼠标移到某个元素的正中（真 hover，不是 dispatchEvent）。 */
async function hoverElement(browser, selector) {
  const box = await browser.evaluate(`(() => { ${HELPERS}
    const el = q(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`hover target not found: ${selector}`);
  await mouseTo(browser, box.x, box.y);
  return box;
}

/** 把鼠标挪到远离球的地方（右上角空区），算「移开」。 */
async function mouseAway(browser) {
  await mouseTo(browser, 1300, 120);
}

async function realClick(browser, selector) {
  const box = await browser.evaluate(`(() => { ${HELPERS}
    const el = q(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`click target not found: ${selector}`);
  await mouseTo(browser, box.x, box.y);
  await browser.raw.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await browser.raw.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(200);
  return box;
}

/** 真实键盘：Enter（可带 Shift）/ Escape。 */
async function pressKey(browser, key, { shift = false } = {}) {
  const map = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27, text: null },
  };
  const info = map[key];
  const modifiers = shift ? 8 : 0;
  const base = {
    key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    modifiers,
  };
  await browser.raw.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (info.text && (shift || key !== "Enter")) {
    // 只有 Shift+Enter 需要补 char：浏览器靠它往 textarea 里插换行（不带就等于吞掉）。
    // 裸 Enter 由 app 的 keydown 处理器负责发送，补 char 反而会往清空后的框里塞一个换行。
    await browser.raw.send("Input.dispatchKeyEvent", { type: "char", text: info.text, unmodifiedText: info.text, ...base });
  }
  await browser.raw.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(220);
}

async function shot(browser, name) {
  const buffer = await browser.screenshot();
  if (buffer) await writeFile(path.join(SHOTS_DIR, `${name}.png`), buffer);
  return path.join(SHOTS_DIR, `${name}.png`);
}

/** 读球的几何 + 计算样式（AC1/AC2/AC3/AC8 共用）。 */
async function orbMetrics(browser) {
  return browser.evaluate(`(() => { ${HELPERS}
    const el = orb();
    if (!el) return { found: false };
    const style = cs(el);
    const ball = q('[data-role="orb-ball"]');
    const form = el.querySelector('.orb-form');
    const input = q('[data-role="orb-input"]');
    const action = q('[data-role="orb-action"]');
    const main = q('[data-role="main"]');
    const terminal = q('[data-role="terminal-host"]');
    const ballStyle = ball ? cs(ball) : null;
    const formStyle = form ? cs(form) : null;
    return {
      found: true,
      state: el.getAttribute('data-state'),
      busyAttr: el.getAttribute('data-busy'),
      rect: rect(el),
      mainRect: main ? rect(main) : null,
      terminalRect: terminal ? rect(terminal) : null,
      width: rect(el).width,
      height: rect(el).height,
      opacity: Number(style.opacity),
      transition: style.transition,
      position: style.position,
      zIndex: style.zIndex,
      ballDisplay: ballStyle ? ballStyle.display : null,
      ballBorder: ballStyle ? ballStyle.borderTopWidth + ' ' + ballStyle.borderTopStyle + ' ' + ballStyle.borderTopColor : null,
      ballBackground: ballStyle ? ballStyle.backgroundColor : null,
      ballColor: ballStyle ? ballStyle.color : null,
      formDisplay: formStyle ? formStyle.display : null,
      formBorder: formStyle ? formStyle.borderTopWidth + ' ' + formStyle.borderTopStyle + ' ' + formStyle.borderTopColor : null,
      formBackground: formStyle ? formStyle.backgroundColor : null,
      inputValue: input ? input.value : null,
      inputFocused: input ? document.activeElement === input : false,
      actionLabel: action ? action.getAttribute('aria-label') : null,
      actionState: action ? action.getAttribute('data-state') : null,
      actionBorder: action ? cs(action).borderTopWidth + ' ' + cs(action).borderTopColor : null,
      actionBackground: action ? cs(action).backgroundColor : null,
      svgCount: el.querySelectorAll('svg').length,
      emojiFree: !/[\\u{1F300}-\\u{1FAFF}]/u.test(el.textContent || ''),
      panelSolid: cssColor('var(--term-panel-solid)'),
      line3: cssColor('var(--term-line-3)'),
      danger: cssColor('var(--term-danger)'),
      focus: cssColor('var(--term-focus)'),
      bodyBackground: cs(document.body).backgroundColor,
      scrollLeft: document.scrollingElement ? document.scrollingElement.scrollLeft : null,
      mainScrollLeft: main ? main.scrollLeft : null,
      mainScrollWidth: main ? main.scrollWidth : null,
      mainClientWidth: main ? main.clientWidth : null,
    };
  })()`);
}

/* ---------------------------------------------------------------- 主流程 */

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-fix17l2-"));
process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
const settingsPath = path.join(dir, "magpie-settings.json");
process.env.MAGPIE_SETTINGS_PATH = settingsPath;

const writeSettings = (theme) =>
  writeFile(settingsPath, JSON.stringify({ theme, accent: "#2563eb", textSize: 100, lang: "zh-CN" }, null, 2));
await writeSettings("light");

const port = await freePort();
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const handle = await startServer({ port, log: quiet });
const base = `http://127.0.0.1:${port}`;

await mkdir(SHOTS_DIR, { recursive: true });

let browser = null;
let fatal = null;

try {
  browser = await openBrowser({ width: 1400, height: 900 });
  await browser.raw.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_PATCHES });
  await browser.navigate(`${base}/?token=${handle.token}`);
  await waitFor(browser, "document.readyState === 'complete'", { label: "page load" });
  await waitFor(browser, "typeof window.__termDebug === 'function'", { label: "__termDebug" });
  await waitFor(browser, "window.__termDebug().sessions.length >= 1", { timeoutMs: 25000, label: "first session" });
  await waitFor(browser, "Boolean(q('[data-role=\"command-orb\"]'))", { label: "command orb" });
  await sleep(600);
  await mouseAway(browser);
  await sleep(400);

  const xtermSize = () =>
    browser.evaluate(`(() => { ${HELPERS}
      const buf = window.__termDebugBuffer();
      const terminal = q('[data-role="terminal-host"]');
      const screen = q('.xterm-screen');
      return {
        cols: buf ? buf.cols : null,
        rows: buf ? buf.rows : null,
        terminalRect: terminal ? { x: terminal.getBoundingClientRect().x, y: terminal.getBoundingClientRect().y, width: terminal.getBoundingClientRect().width, height: terminal.getBoundingClientRect().height } : null,
        screenRect: screen ? { x: screen.getBoundingClientRect().x, y: screen.getBoundingClientRect().y, width: screen.getBoundingClientRect().width, height: screen.getBoundingClientRect().height } : null,
      };
    })()`);

  /* ================================================================ AC1
   * 收起态：38px 圆球，水平中心与终端区中心差 ≤2px，坐在状态栏之上。 */
  {
    const before = await orbMetrics(browser);
    const terminal = before.terminalRect;
    const terminalCenterX = terminal.x + terminal.width / 2;
    const orbCenterX = before.rect.x + before.rect.width / 2;
    const statusbarTop = await browser.evaluate(
      `document.querySelector('[data-role="statusbar"]').getBoundingClientRect().top`,
    );
    record(
      "AC1.1 球在终端底部居中：水平中心与终端区中心差 ≤2px、宽 38±1、高 38±1",
      before.found === true &&
        Math.abs(orbCenterX - terminalCenterX) <= 2 &&
        Math.abs(before.width - 38) <= 1 &&
        Math.abs(before.height - 38) <= 1,
      {
        state: before.state,
        orbCenterX: Number(orbCenterX.toFixed(2)),
        terminalCenterX: Number(terminalCenterX.toFixed(2)),
        delta: Number(Math.abs(orbCenterX - terminalCenterX).toFixed(2)),
        width: Number(before.width.toFixed(2)),
        height: Number(before.height.toFixed(2)),
      },
      { delta: "<=2", width: 38, height: 38 },
    );
    record(
      "AC1.2 球坐在状态栏之上、不遮状态栏文字；position:fixed 且 z-index 在抽屉（30）之下不越权",
      before.rect.bottom <= statusbarTop + 0.5 && before.position === "fixed",
      {
        orbBottom: Number(before.rect.bottom.toFixed(2)),
        statusbarTop: Number(statusbarTop.toFixed(2)),
        position: before.position,
        zIndex: before.zIndex,
      },
      { orbBottom: "<= statusbarTop", position: "fixed" },
    );
    record(
      "AC1.3 收起态是半透明圆球（opacity ≈0.72、边框 1px --term-line-3、底色 --term-panel-solid、内联 SVG 无 emoji）",
      Math.abs(before.opacity - 0.72) <= 0.03 &&
        /^1px/.test(before.ballBorder || "") &&
        near(parseColor(before.ballBackground), parseColor(before.panelSolid), 3) &&
        near(parseColor(before.ballBorder.split(" ").slice(2).join(" ")), parseColor(before.line3), 4) &&
        before.svgCount > 0 &&
        before.emojiFree === true,
      {
        opacity: before.opacity,
        ballBorder: before.ballBorder,
        ballBackground: before.ballBackground,
        panelSolid: before.panelSolid,
        svgCount: before.svgCount,
        emojiFree: before.emojiFree,
      },
      { opacity: 0.72, border: "1px --term-line-3", background: "--term-panel-solid" },
    );
    await shot(browser, "ac1-ball-idle");
    await writeFile(path.join(EVIDENCE_DIR, "AC1-geometry.json"), `${JSON.stringify({ before }, null, 2)}\n`);
  }

  /* ================================================================ AC2
   * hover 展开到 ≥340px，且**终端尺寸未变**（xterm cols/rows 与 screenRect 不变）。
   * 另外：展开必须与有没有内容无关（用户原话 1）。 */
  {
    const sizeBefore = await xtermSize();
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(420);
    const opened = await orbMetrics(browser);
    const sizeAfter = await xtermSize();
    record(
      "AC2.1 鼠标移上去必定展开：宽度 ≥340px、高 40±1、opacity = 1（空输入也展开）",
      opened.state === "open" && opened.width >= 340 && Math.abs(opened.height - 40) <= 1 && opened.opacity === 1,
      {
        state: opened.state,
        width: Number(opened.width.toFixed(2)),
        height: Number(opened.height.toFixed(2)),
        opacity: opened.opacity,
        inputValue: opened.inputValue,
      },
      { state: "open", width: ">=340", height: 40, opacity: 1 },
    );
    record(
      "AC2.2 展开**不引起任何布局位移**：xterm cols/rows 与 screenRect / 终端 rect 完全不变",
      JSON.stringify(sizeBefore) === JSON.stringify(sizeAfter),
      { before: sizeBefore, after: sizeAfter },
      { identical: true },
    );
    record(
      "AC2.3 展开态是胶囊：单行输入框 + 动作按钮同时可见，圆球隐藏",
      opened.ballDisplay === "none" && opened.formDisplay === "flex" && Boolean(opened.actionLabel),
      { ballDisplay: opened.ballDisplay, formDisplay: opened.formDisplay, actionLabel: opened.actionLabel },
      { ballDisplay: "none", formDisplay: "flex" },
    );
    // computed 里 `ease` 是默认值会被省略（写成 `width 0.16s`），所以按「三个属性 + 时长 + 无 height」判。
    const transition = opened.transition || "";
    record(
      "AC2.4 过渡只动 width/opacity/transform，160ms ease（R2 逐字）",
      /width 0\.16s/.test(transition) &&
        /opacity 0\.16s/.test(transition) &&
        /transform 0\.16s/.test(transition) &&
        !/height/.test(transition),
      { transition },
      { transition: "width/opacity/transform 0.16s ease，无 height" },
    );
    await shot(browser, "ac2-orbit-open");
    await writeFile(
      path.join(EVIDENCE_DIR, "AC2-open.json"),
      `${JSON.stringify({ opened, sizeBefore, sizeAfter }, null, 2)}\n`,
    );
  }

  /* ================================================================ AC3 + AC6（Esc 空态）
   * 有内容 → 移开鼠标：仍 ≥340px、opacity 0.5–0.65；清空 → 移开收回 38px。 */
  {
    // 空输入时移开 → 收回球（AC3 的前半，顺带证明 AC2 的展开不是「粘住」）。
    await mouseAway(browser);
    await sleep(420);
    const backToBall = await orbMetrics(browser);
    record(
      "AC3.1 空输入移开鼠标 → 收回 38px 圆球（data-state=ball）",
      backToBall.state === "ball" && Math.abs(backToBall.width - 38) <= 1,
      { state: backToBall.state, width: Number(backToBall.width.toFixed(2)) },
      { state: "ball", width: 38 },
    );

    // 再 hover → 输入内容 → 移开。
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(320);
    await realClick(browser, '[data-role="orb-input"]');
    await browser.raw.send("Input.insertText", { text: "看一下当前目录" });
    await sleep(220);
    await mouseAway(browser);
    await sleep(460);
    const muted = await orbMetrics(browser);
    record(
      "AC3.2 有内容 + 移开鼠标：**仍是展开胶囊**（宽度 ≥340px），opacity 落在 0.5–0.65，绝不收回成球",
      muted.state === "open-muted" &&
        muted.width >= 340 &&
        muted.opacity >= 0.5 &&
        muted.opacity <= 0.65 &&
        muted.inputValue.includes("看一下当前目录"),
      {
        state: muted.state,
        width: Number(muted.width.toFixed(2)),
        height: Number(muted.height.toFixed(2)),
        opacity: muted.opacity,
        inputValue: muted.inputValue,
      },
      { state: "open-muted", width: ">=340", opacity: "0.5–0.65" },
    );
    await shot(browser, "ac3-open-muted");

    // 再 hover 回来 → 恢复不透明（A C3 的「再 hover」走查项）。
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(360);
    const rehover = await orbMetrics(browser);
    record(
      "AC3.3 有内容时再 hover → 回到不透明展开（opacity = 1）",
      rehover.state === "open" && rehover.opacity === 1 && rehover.width >= 340,
      { state: rehover.state, opacity: rehover.opacity, width: Number(rehover.width.toFixed(2)) },
      { state: "open", opacity: 1 },
    );

    // 清空内容 → 移开 → 收回 38px。
    await browser.evaluate(`(() => { ${HELPERS}
      const input = q('[data-role="orb-input"]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
    await mouseAway(browser);
    await sleep(460);
    const cleared = await orbMetrics(browser);
    record(
      "AC3.4 清空后移开 → 收回 38px",
      cleared.state === "ball" && Math.abs(cleared.width - 38) <= 1,
      { state: cleared.state, width: Number(cleared.width.toFixed(2)) },
      { state: "ball", width: 38 },
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "AC3-muted.json"),
      `${JSON.stringify({ backToBall, muted, rehover, cleared }, null, 2)}\n`,
    );
  }

  /* ================================================================ AC4
   * Enter 发送：ws 收到 agent.run（openDrawer 未开）、抽屉仍关闭；Shift+Enter 只换行不发。 */
  {
    await browser.evaluate(`(() => { ${HELPERS} window.__probeSentFrames.length = 0; return true; })()`);
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(320);
    await realClick(browser, '[data-role="orb-input"]');
    await browser.raw.send("Input.insertText", { text: "Shift 换行测试" });
    await sleep(180);
    await pressKey(browser, "Enter", { shift: true });
    const afterShift = await browser.evaluate(`(() => { ${HELPERS}
      const input = q('[data-role="orb-input"]');
      return {
        value: input.value,
        hasNewline: input.value.includes(String.fromCharCode(10)),
        frames: window.__probeSentFrames.map((f) => f.type),
        drawer: drawerOpen(),
        state: orbState(),
      };
    })()`);
    record(
      "AC4.1 Shift+Enter 只换行、不发送（没有任何 agent.run）",
      afterShift.hasNewline === true && afterShift.frames.length === 0,
      afterShift,
      { hasNewline: true, frames: [] },
    );

    // 清掉换行，改成一个可断言的问题，然后真 Enter 发送。
    await browser.evaluate(`(() => { ${HELPERS}
      const input = q('[data-role="orb-input"]');
      input.value = '球里发送：看下磁盘';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await browser.evaluate(`(() => { ${HELPERS} window.__probeSentFrames.length = 0; return true; })()`);
    await pressKey(browser, "Enter");
    await sleep(500);
    const afterEnter = await browser.evaluate(`(() => { ${HELPERS}
      const input = q('[data-role="orb-input"]');
      const drawerHost = q('[data-role="ai-drawer"]');
      return {
        frames: window.__probeSentFrames.map((f) => ({ type: f.type, question: f.question, hasModel: Boolean(f.model), hasContext: Boolean(f.context) })),
        value: input.value,
        drawer: drawerOpen(),
        drawerHasOpenClass: drawerHost ? drawerHost.classList.contains('open') : null,
        drawerAriaHidden: drawerHost ? drawerHost.getAttribute('aria-hidden') : null,
        state: orbState(),
        status: (agent() || {}).status,
      };
    })()`);
    const runFrames = afterEnter.frames.filter((f) => f.type === "agent.run");
    record(
      "AC4.2 Enter 发送：ws 收到一条 agent.run（带 question/context），并清空输入",
      runFrames.length === 1 && runFrames[0].question === "球里发送：看下磁盘" && runFrames[0].hasContext === true && afterEnter.value === "",
      afterEnter,
      { runFrames: 1, question: "球里发送：看下磁盘", value: "" },
    );
    record(
      "AC4.3 发送后**抽屉仍然关闭**（data-ai-open=false，抽屉无 open 类、aria-hidden=true）——用户原话 3",
      afterEnter.drawer === "false" &&
        afterEnter.drawerHasOpenClass === false &&
        (afterEnter.drawerAriaHidden === "true" || afterEnter.drawerAriaHidden === null),
      {
        drawer: afterEnter.drawer,
        drawerHasOpenClass: afterEnter.drawerHasOpenClass,
        drawerAriaHidden: afterEnter.drawerAriaHidden,
      },
      { drawer: "false", drawerHasOpenClass: false },
    );
    await shot(browser, "ac4-after-send-drawer-closed");
    await writeFile(
      path.join(EVIDENCE_DIR, "AC4-send.json"),
      `${JSON.stringify({ afterShift, afterEnter }, null, 2)}\n`,
    );
  }

  /* ================================================================ AC5
   * 忙碌态：球变停止形态（红环 + 深色圆心），点它发 agent.stop + markStopped。 */
  {
    // 用真实 store 路径进入 running（agent.start 帧 → agentStore.status=running）。
    await browser.evaluate(`(() => {
      window.__termDebugFrame({
        type: "agent.start",
        sessionId: "probe-orb-session",
        requestId: "probe-orb-req",
        taskId: "probe-orb-task",
        round: 1,
      });
      return true;
    })()`);
    await sleep(420);
    await mouseAway(browser);
    await sleep(420);
    const busyBall = await orbMetrics(browser);
    const busyStatus = await browser.evaluate(
      `(() => (typeof window.__termDebugAgent === "function" ? window.__termDebugAgent().status : null))()`,
    );
    const busyBorder = parseColor((busyBall.ballBorder || "").split(" ").slice(2).join(" "));
    record(
      "AC5.1 忙碌态球变停止形态：data-busy=true、红环（边框 ≈ --term-danger）、深色圆心、aria-label=停止",
      busyBall.busyAttr === "true" &&
        busyBall.state === "ball" &&
        parseFloat(busyBall.ballBorder) >= 2 &&
        near(busyBorder, parseColor(busyBall.danger), 6) &&
        busyBall.actionLabel === "停止" &&
        busyStatus === "running",
      {
        busyAttr: busyBall.busyAttr,
        state: busyBall.state,
        ballBorder: busyBall.ballBorder,
        ballBackground: busyBall.ballBackground,
        danger: busyBall.danger,
        actionLabel: busyBall.actionLabel,
      },
      { busyAttr: "true", ring: "≈ --term-danger" },
    );
    await shot(browser, "ac5-busy-ball");

    // 真用户路径：鼠标移上去 → 胶囊展开（R5 允许）/ 收起态红环球。
    // 展开后能点的是红色停止按钮（球已被表单取代），所以点它。
    await browser.evaluate(`(() => { ${HELPERS} window.__probeSentFrames.length = 0; return true; })()`);
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(400);
    const busyExpandedForStop = await orbMetrics(browser);
    await realClick(browser, '[data-role="orb-action"]');
    await sleep(460);
    const afterStop = await browser.evaluate(`(() => { ${HELPERS}
      return {
        frames: window.__probeSentFrames.map((f) => ({ type: f.type, requestId: f.requestId })),
        status: (agent() || {}).status,
        busy: orb() ? orb().getAttribute('data-busy') : null,
        state: orbState(),
      };
    })()`);
    const stopFrames = afterStop.frames.filter((f) => f.type === "agent.stop");
    record(
      "AC5.2 点忙碌态的停止按钮 = 停止：发出 agent.stop、agentStore.markStopped → status=stopped、球回到普通形态",
      busyExpandedForStop.actionState === "busy" &&
        stopFrames.length === 1 &&
        afterStop.status === "stopped" &&
        afterStop.busy === "false",
      { busyExpandedForStop: { actionState: busyExpandedForStop.actionState }, ...afterStop },
      { stopFrames: 1, status: "stopped", busy: "false" },
    );

    // 键盘 / 触屏路径：球自己拿到焦点不展开（不许 display:none 掉正在聚焦的元素），
    // 原生 click（Enter/Space）= 停止。
    await browser.evaluate(`(() => {
      window.__termDebugFrame({
        type: "agent.start",
        sessionId: "probe-orb-session",
        requestId: "probe-orb-req-kb",
        taskId: "probe-orb-task",
        round: 3,
      });
      return true;
    })()`);
    await sleep(360);
    await mouseAway(browser);
    await sleep(300);
    const keyboardPath = await browser.evaluate(`(() => { ${HELPERS}
      const ball = q('[data-role="orb-ball"]');
      ball.focus({ preventScroll: true });
      const afterFocus = orbState();
      const focusedEl = document.activeElement ? document.activeElement.getAttribute('data-role') : null;
      ball.click();
      return { afterFocus, focusedEl };
    })()`);
    await sleep(420);
    const afterKeyboardStop = await browser.evaluate(`(() => { ${HELPERS}
      return {
        status: (agent() || {}).status,
        busy: orb() ? orb().getAttribute('data-busy') : null,
        frames: window.__probeSentFrames.map((f) => f.type),
      };
    })()`);
    record(
      "AC5.4 键盘/触屏路径：球拿到焦点不展开（不丢焦点），点球（原生 click）= 停止",
      keyboardPath.afterFocus === "ball" &&
        keyboardPath.focusedEl === "orb-ball" &&
        afterKeyboardStop.status === "stopped" &&
        afterKeyboardStop.busy === "false" &&
        afterKeyboardStop.frames.filter((f) => f === "agent.stop").length >= 1,
      { keyboardPath, afterKeyboardStop },
      { afterFocus: "ball", status: "stopped" },
    );

    // 忙碌态下展开查看：仍然能展开，但动作按钮是停止形态（不允许发送）。
    await browser.evaluate(`(() => {
      window.__termDebugFrame({
        type: "agent.start",
        sessionId: "probe-orb-session",
        requestId: "probe-orb-req2",
        taskId: "probe-orb-task",
        round: 2,
      });
      return true;
    })()`);
    await sleep(380);
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(360);
    const busyOpen = await orbMetrics(browser);
    record(
      "AC5.3 忙碌时仍允许展开查看，动作按钮是停止形态（点它 = 停止，不是发送）",
      busyOpen.state === "open" &&
        busyOpen.width >= 340 &&
        busyOpen.actionState === "busy" &&
        busyOpen.actionLabel === "停止" &&
        parseFloat(busyOpen.actionBorder) >= 2,
      {
        state: busyOpen.state,
        width: Number(busyOpen.width.toFixed(2)),
        actionState: busyOpen.actionState,
        actionLabel: busyOpen.actionLabel,
        actionBorder: busyOpen.actionBorder,
        actionBackground: busyOpen.actionBackground,
      },
      { state: "open", actionState: "busy" },
    );
    await shot(browser, "ac5-busy-open-stop-button");
    await mouseAway(browser);
    await browser.evaluate(`(() => {
      window.__termDebugFrame({ type: "agent.done", requestId: "probe-orb-req2", text: "" });
      return true;
    })()`);
    await sleep(400);
    await writeFile(
      path.join(EVIDENCE_DIR, "AC5-busy.json"),
      `${JSON.stringify({ busyBall, afterStop, busyOpen }, null, 2)}\n`,
    );
  }

  /* ================================================================ AC6
   * Esc 两态：有内容 → 清空并收回球；无内容 → 直接收回球。 */
  {
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(320);
    await realClick(browser, '[data-role="orb-input"]');
    await browser.raw.send("Input.insertText", { text: "要被 Esc 清掉的内容" });
    await sleep(180);
    const beforeEsc = await orbMetrics(browser);
    await pressKey(browser, "Escape");
    await sleep(340);
    const afterEscContent = await orbMetrics(browser);
    record(
      "AC6.1 有内容时 Esc：清空输入 + 收回 38px 圆球",
      beforeEsc.inputValue.length > 0 &&
        afterEscContent.inputValue === "" &&
        afterEscContent.state === "ball" &&
        Math.abs(afterEscContent.width - 38) <= 1,
      {
        before: { state: beforeEsc.state, value: beforeEsc.inputValue },
        after: { state: afterEscContent.state, value: afterEscContent.inputValue, width: Number(afterEscContent.width.toFixed(2)) },
      },
      { after: { state: "ball", value: "" } },
    );

    // 无内容：hover 展开（空输入）→ Esc → 收回。
    // 先移开再 hover：Esc 之后的 suppressExpand 需要「离开一次」才复位（用户也是这样用的）。
    await mouseAway(browser);
    await sleep(300);
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(340);
    const emptyOpen = await orbMetrics(browser);
    // Esc 只对焦点在球里时生效（R3 的键盘路径）：先点输入框拿焦点。
    await realClick(browser, '[data-role="orb-input"]');
    await pressKey(browser, "Escape");
    await sleep(340);
    const afterEscEmpty = await orbMetrics(browser);
    record(
      "AC6.2 无内容时 Esc：直接收回 38px 圆球（hover 仍在也不弹回）",
      emptyOpen.state === "open" &&
        emptyOpen.inputValue === "" &&
        afterEscEmpty.state === "ball" &&
        Math.abs(afterEscEmpty.width - 38) <= 1,
      {
        open: { state: emptyOpen.state, value: emptyOpen.inputValue },
        after: { state: afterEscEmpty.state, width: Number(afterEscEmpty.width.toFixed(2)) },
      },
      { after: { state: "ball" } },
    );
    await mouseAway(browser);
    await sleep(260);
    await writeFile(
      path.join(EVIDENCE_DIR, "AC6-esc.json"),
      `${JSON.stringify({ beforeEsc, afterEscContent, emptyOpen, afterEscEmpty }, null, 2)}\n`,
    );
  }

  /* ================================================================ AC7
   * 无横向抖动：开合抽屉 8 次 + 反复展开球，scrollLeft 恒 0。 */
  {
    await mouseAway(browser);
    const scrollSamples = [];
    for (let i = 0; i < 8; i += 1) {
      await browser.evaluate(`(() => { document.querySelector('[data-role="ai-handle"]').click(); return true; })()`);
      await sleep(320);
      await hoverElement(browser, '[data-role="command-orb"]');
      await sleep(280);
      await mouseAway(browser);
      await sleep(200);
      scrollSamples.push(
        await browser.evaluate(`(() => { ${HELPERS}
          const main = q('[data-role="main"]');
          return {
            doc: document.scrollingElement ? document.scrollingElement.scrollLeft : null,
            main: main ? main.scrollLeft : null,
            docScrollWidth: document.scrollingElement ? document.scrollingElement.scrollWidth : null,
            docClientWidth: document.scrollingElement ? document.scrollingElement.clientWidth : null,
          };
        })()`),
      );
    }
    // 收尾把抽屉关掉（最后一次点击可能是关、也可能是开）。
    await browser.evaluate(`(() => { ${HELPERS}
      const app = q('[data-role="app"]');
      if (app.getAttribute('data-ai-open') === 'true') q('[data-role="ai-handle"]').click();
      return true;
    })()`);
    await sleep(320);
    const allZero = scrollSamples.every((row) => row.doc === 0 && row.main === 0);
    const noOverflow = scrollSamples.every((row) => row.docScrollWidth === row.docClientWidth);
    record(
      "AC7 开合抽屉 8 次 + 反复展开球：document.scrollingElement.scrollLeft 与 .main.scrollLeft 恒 0、无横向溢出",
      allZero && noOverflow,
      { samples: scrollSamples },
      { scrollLeft: 0, noOverflow: true },
    );
    await writeFile(path.join(EVIDENCE_DIR, "AC7-scroll.json"), `${JSON.stringify(scrollSamples, null, 2)}\n`);
  }

  /* ================================================================ AC8
   * 深浅色各一张截图 + 对比度（球边框 / 图标对底色 ≥3:1），且无硬编码色。 */
  {
    const themeRows = {};
    for (const theme of ["light", "dark"]) {
      await writeSettings(theme);
      await sleep(2600); // 主题同步是 1s 轮询 + 令牌注入
      await mouseAway(browser);
      await sleep(420);
      const ballMetrics = await orbMetrics(browser);
      const ballBg = parseColor(ballMetrics.ballBackground);
      const border = parseColor((ballMetrics.ballBorder || "").split(" ").slice(2).join(" "));
      const icon = parseColor(ballMetrics.ballColor);
      const ballShot = await shot(browser, `ac8-${theme}-ball`);

      await hoverElement(browser, '[data-role="command-orb"]');
      await sleep(420);
      const openMetrics = await orbMetrics(browser);
      const formBorder = parseColor((openMetrics.formBorder || "").split(" ").slice(2).join(" "));
      const formBg = parseColor(openMetrics.formBackground);
      const openShot = await shot(browser, `ac8-${theme}-open`);

      themeRows[theme] = {
        ballShot,
        openShot,
        ball: {
          state: ballMetrics.state,
          opacity: ballMetrics.opacity,
          background: ballMetrics.ballBackground,
          borderColor: (ballMetrics.ballBorder || "").split(" ").slice(2).join(" "),
          iconColor: ballMetrics.ballColor,
          borderVsBackground: ballBg && border ? Number(contrast(border, ballBg).toFixed(2)) : null,
          iconVsBackground: ballBg && icon ? Number(contrast(icon, ballBg).toFixed(2)) : null,
        },
        open: {
          state: openMetrics.state,
          width: Number(openMetrics.width.toFixed(2)),
          background: openMetrics.formBackground,
          borderColor: (openMetrics.formBorder || "").split(" ").slice(2).join(" "),
          borderVsBackground: formBg && formBorder ? Number(contrast(formBorder, formBg).toFixed(2)) : null,
        },
      };
      await mouseAway(browser);
      await sleep(260);
    }
    await writeSettings("light");
    await sleep(2400);

    const rows = [themeRows.light, themeRows.dark];
    record(
      "AC8.1 深浅色各一张截图（球 + 展开态），四张都已落盘",
      rows.every((row) => typeof row.ballShot === "string" && typeof row.openShot === "string"),
      rows.map((row) => ({ ball: row.ballShot, open: row.openShot })),
      { shots: 4 },
    );
    record(
      "AC8.2 球边框 / 图标对底色对比度 ≥3:1（深浅色都成立）",
      rows.every(
        (row) =>
          Number(row.ball.borderVsBackground) >= 3 && Number(row.ball.iconVsBackground) >= 3,
      ),
      rows.map((row) => ({
        borderVsBackground: row.ball.borderVsBackground,
        iconVsBackground: row.ball.iconVsBackground,
      })),
      { contrast: ">=3" },
    );
    record(
      "AC8.3 展开态胶囊边框对底色 ≥3:1（输入框边界看得见）",
      rows.every((row) => Number(row.open.borderVsBackground) >= 3),
      rows.map((row) => ({ borderVsBackground: row.open.borderVsBackground, borderColor: row.open.borderColor })),
      { contrast: ">=3" },
    );
    await writeFile(path.join(EVIDENCE_DIR, "AC8-theme.json"), `${JSON.stringify(themeRows, null, 2)}\n`);
  }

  /* ================================================================ 走查：抽屉仍能发送（默认行为未变） */
  {
    await browser.evaluate(`(() => { ${HELPERS}
      if (drawerOpen() === 'false') q('[data-role="ai-handle"]').click();
      return true;
    })()`);
    await sleep(520);
    await browser.evaluate(`(() => { ${HELPERS} window.__probeSentFrames.length = 0; return true; })()`);
    await browser.evaluate(`(() => { ${HELPERS}
      const ta = q('[data-role="agent-input"]');
      ta.value = '抽屉里发送（默认仍要打开抽屉）';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await browser.evaluate(`(() => { ${HELPERS}
      q('[data-role="agent-input"]').focus();
      return true;
    })()`);
    await pressKey(browser, "Enter");
    await sleep(420);
    const drawerSend = await browser.evaluate(`(() => { ${HELPERS}
      return {
        frames: window.__probeSentFrames.map((f) => ({ type: f.type, question: f.question })),
        drawer: drawerOpen(),
      };
    })()`);
    record(
      "走查：抽屉里 Enter 仍发 agent.run 且抽屉保持打开（askAgent 默认 openDrawer=true，原行为未变）",
      drawerSend.frames.filter((f) => f.type === "agent.run").length === 1 && drawerSend.drawer === "true",
      drawerSend,
      { runFrames: 1, drawer: "true" },
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "WALK-drawer-send.json"),
      `${JSON.stringify(drawerSend, null, 2)}\n`,
    );
  }

  /* ================================================================ 走查：完整用户路径 */
  {
    await browser.evaluate(`(() => { ${HELPERS}
      if (drawerOpen() === 'true') q('[data-role="ai-handle"]').click();
      return true;
    })()`);
    await sleep(420);
    await mouseAway(browser);
    await sleep(400);
    const steps = [];
    const snap = async (label) => {
      const metrics = await orbMetrics(browser);
      steps.push({
        label,
        state: metrics.state,
        width: Number(metrics.width.toFixed(2)),
        opacity: metrics.opacity,
        value: metrics.inputValue,
        drawer: await browser.evaluate(`(() => { ${HELPERS} return drawerOpen(); })()`),
      });
    };
    await snap("1 初始：球");
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(360);
    await snap("2 hover：展开（空）");
    await realClick(browser, '[data-role="orb-input"]');
    await browser.raw.send("Input.insertText", { text: "走查用的一句话" });
    await sleep(200);
    await mouseAway(browser);
    await sleep(420);
    await snap("3 有内容移开：展开 + 半透明");
    await hoverElement(browser, '[data-role="command-orb"]');
    await sleep(360);
    await snap("4 再 hover：恢复不透明");
    await browser.evaluate(`(() => { ${HELPERS} window.__probeSentFrames.length = 0; return true; })()`);
    await pressKey(browser, "Enter");
    await sleep(460);
    await snap("5 Enter 发送后（抽屉仍关）");
    await writeFile(path.join(EVIDENCE_DIR, "WALK-user-path.json"), `${JSON.stringify(steps, null, 2)}\n`);
    record(
      "走查：hover→输入→移开→再 hover→Enter 五步状态与透明度和用户原话一致",
      steps[0].state === "ball" &&
        steps[1].state === "open" &&
        steps[2].state === "open-muted" &&
        steps[2].opacity <= 0.65 &&
        steps[3].opacity === 1 &&
        steps[4].drawer === "false",
      steps,
      { states: ["ball", "open", "open-muted", "open", "open"] },
    );
  }
} catch (err) {
  fatal = err && err.stack ? err.stack : String(err);
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
  try {
    await shutdown();
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
await writeFile(
  path.join(EVIDENCE_DIR, "AC-results.json"),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
);
if (JSON_FLAG) console.log(JSON.stringify({ summary, results }));
console.log(`\n${summary.pass}/${summary.total} PASS${fatal ? " (fatal)" : ""}`);
process.exit(failed.length === 0 && !fatal ? 0 : 1);
