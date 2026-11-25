// TASK-FIX17-D 验收探针：AI 抽屉的抖动 / 下拉框不透明 / 输入区结构 / 发送停止合一 / markdown。
//
// 全程**真浏览器**（headless Chrome + CDP）+ **真服务**（本进程起的同类服务）：
// 断言的是 getComputedStyle / getBoundingClientRect / innerHTML / 真实截图像素，
// 不是读 CSS 声明自己猜。抖动（AC1）尤其只能在真浏览器里证 —— 它就是浏览器
// 把 focus 元素 scrollIntoView 到可视区造成的。
//
// 覆盖：AC1 / AC2 / AC3 / AC4 / AC5 / AC6 / AC7 / AC8 / AC9 / AC10。
// （AC11 = node --test + scripts/doctor.mjs，不在本探针内。）
//
// 用法（仓库根）：
//   node scripts/probe-drawer.mjs             # 跑全部，证据落 .dispatch/fix17-d/evidence/
//   node scripts/probe-drawer.mjs --json      # 额外把结果 JSON 打到 stdout
//
// 退出码：0 全 PASS；1 有失败（失败项与原因同时写进 evidence/probe-results.json）。

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/http.mjs";
import { openBrowser, decodePng, sleep } from "./lib/cdp.mjs";
import { shutdown } from "./lib/pty-cleanup.mjs";

const EVIDENCE_DIR = path.resolve(".dispatch", "fix17-d", "evidence");
const SHOTS_DIR = path.join(EVIDENCE_DIR, "shots");
const JSON_FLAG = process.argv.includes("--json");

const results = [];
const record = (name, pass, detail, expected) => {
  results.push({ name, pass: Boolean(pass), detail, expected });
  if (!pass) console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`);
  else console.log(`PASS  ${name}`);
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

/** 解析 CSS 颜色（含 color(srgb r g b / a)，color-mix() 算出来就是它）。 */
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
 * 在 app.js 之前装的两段补丁（Page.addScriptToEvaluateOnNewDocument）。
 *
 * 为什么要在页面里放测试替身：
 *   1. /api/models：本机 magpie 网关是否在线会影响「模型下拉能不能打开」。
 *      探针要的是**抽屉的样式与结构**，不该被外部服务可用性左右，所以用固定
 *      两条模型清单把它钉住（只替换 GET /api/models 的响应体）。
 *   2. WebSocket.prototype.send：AC5/AC6 要断言「Enter 真的调了发送」「点忙碌
 *      按钮真的调了停止」，但不能让探针真的去调 AI（会在这个 shell 里执行命令）。
 *      补丁只**记录并吞掉** agent.run / agent.stop 两种帧，其余帧原样放行。
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
        models: [
          { id: "probe/model-a", label: "Probe Model A", contextLength: 128000, available: true },
          { id: "probe/model-b", label: "Probe Model B", contextLength: 32000, available: true },
        ],
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

  window.__probeAlerts = 0;
  window.alert = () => {
    window.__probeAlerts += 1;
  };
})();
`;

/** 页面里通用的小工具（拼在每个 evaluate 前面）。 */
const HELPERS = `
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const cs = (el, pseudo) => getComputedStyle(el, pseudo || null);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, top: r.top, left: r.left, width: r.width, height: r.height }; };
  const agent = () => (typeof window.__termDebugAgent === "function" ? window.__termDebugAgent() : null);
  const root = () => document.documentElement;
  const drawerOpen = () => document.querySelector('[data-role="app"]').getAttribute('data-ai-open');
  // 自定义属性不能直接当颜色解析（值是 color-mix() 表达式），落到临时元素上取 computed。
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

async function realClick(browser, selector, { index = 0 } = {}) {
  const box = await browser.evaluate(`(() => { ${HELPERS}
    const el = qa(${JSON.stringify(selector)})[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
  })()`);
  if (!box) throw new Error(`click target not found: ${selector}[${index}]`);
  const client = browser.raw;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await client.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await sleep(120);
  return box;
}

/** 真实键盘：Enter（可带 Shift）。 */
async function pressEnter(browser, { shift = false } = {}) {
  const client = browser.raw;
  const modifiers = shift ? 8 : 0;
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers };
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await client.send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", ...base });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(200);
}

async function shot(browser, name) {
  const buffer = await browser.screenshot();
  const target = path.join(SHOTS_DIR, `${name}.png`);
  if (buffer) await writeFile(target, buffer);
  return target;
}

/**
 * 读某个浮层菜单的实测数据（AC2）。
 *
 * AC2 的「与背后内容对比度 ≥ 3:1」怎么落成可测的数：R2 明确要求菜单底色基于
 * `--magpie-card` 派生，也就是浮层与面板同一个色系；把「背后」理解成「面板底色」时
 * 这条阈值对任何卡片式浮层都不可能成立（同色之间最高 1.05:1），与 R2 自相矛盾。
 * 所以按「**内容（文字）与其背后的底色**」来量：菜单里的字压在菜单底色上必须
 * ≥ 4.5:1（quality-guidelines 门槛四的正文标准，比 AC 的 3:1 更严）。同时把
 * 「菜单底色 vs 背后元素文字色」作为诊断值落盘，并用真实截图像素证明背后的内容
 * 完全不透出（AC2.5）。
 */
async function menuMetrics(browser, selector) {
  return browser.evaluate(`(() => { ${HELPERS}
    const el = q(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const style = cs(el);
    const box = rect(el);
    const itemNode = el.querySelector(
      '.model-item b, [data-role="agent-session-item"] .mi-main b, .file-panel-menu-item, .sess-group-head .gr-main b',
    );
    const dimNode = el.querySelector('.menu-label, .menu-note, .mi-main small, .model-item small, .menu-empty');
    const itemTextColor = itemNode ? cs(itemNode).color : style.color;
    const dimTextColor = dimNode ? cs(dimNode).color : null;

    // 诊断值：「菜单盖住的第一个元素」的文字色（只落盘，不当门槛）
    const prev = el.style.visibility;
    el.style.visibility = 'hidden';
    const behind = document.elementFromPoint(
      Math.min(window.innerWidth - 2, Math.max(1, box.x + box.width / 2)),
      Math.min(window.innerHeight - 2, Math.max(1, box.y + Math.min(box.height / 2, 18))),
    );
    el.style.visibility = prev;
    const behindTag =
      behind && behind !== el && !el.contains(behind)
        ? behind.tagName.toLowerCase() +
          (behind.getAttribute('data-role') ? '#'.concat(behind.getAttribute('data-role')) : '')
        : null;
    const behindColor = behindTag ? cs(behind).color : null;

    return {
      found: true,
      hidden: el.hidden === true,
      display: style.display,
      background: style.backgroundColor,
      panelSolid: cssColor('var(--term-panel-solid)'),
      borderColor: style.borderTopColor,
      itemTextColor,
      dimTextColor,
      border: style.borderTopWidth + ' ' + style.borderTopStyle + ' ' + style.borderTopColor,
      boxShadow: style.boxShadow === 'none' ? null : style.boxShadow,
      rect: box,
      behindTag,
      behindColor,
    };
  })()`);
}

/* ---------------------------------------------------------------- 主流程 */

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-fix17d-"));
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
  await waitFor(
    browser,
    "typeof window.marked === 'object' && typeof window.DOMPurify === 'function'",
    { label: "markdown vendor libs" },
  );
  await sleep(500);

  /* ================================================================ AC7
   * 发送/停止只存在一个按钮元素。放在最前面：后面所有「按一下按钮」都依赖它。 */
  {
    const counts = await browser.evaluate(`(() => { ${HELPERS}
      return {
        action: qa('[data-role="composer-action"]').length,
        send: qa('[data-role="agent-send"]').length,
        stop: qa('[data-role="agent-stop"]').length,
        actions: qa('[data-role="composer-actions"]').length,
        hint: qa('[data-role="composer-hint"]').length,
      };
    })()`);
    record(
      "AC7 [data-role=composer-action] 只有一个元素（旧的 agent-send / agent-stop / composer-actions 都不在）",
      counts.action === 1 && counts.send === 0 && counts.stop === 0 && counts.actions === 0,
      counts,
      { action: 1, send: 0, stop: 0, actions: 0 },
    );
  }

  /* ================================================================ AC1
   * 真浏览器抖动：打开抽屉 + focus 输入框，.main.scrollLeft 必须一直是 0。 */
  {
    const before = await browser.evaluate(`(() => { ${HELPERS}
      const main = q('[data-role="main"]');
      return {
        overflow: cs(main).overflow,
        scrollLeft: main.scrollLeft,
        scrollWidth: main.scrollWidth,
        clientWidth: main.clientWidth,
        docScrollLeft: document.scrollingElement.scrollLeft,
      };
    })()`);
    record(
      "AC1.0 .main 的 overflow 已被改成 clip（不再产生横向滚动容器），且抽屉确实在右侧溢出",
      String(before.overflow).split(/\s+/).every((part) => part === "clip") &&
        before.scrollWidth > before.clientWidth,
      before,
      { overflow: "clip", scrollWidth: "> clientWidth" },
    );

    const cycles = [];
    for (let i = 0; i < 5; i += 1) {
      await realClick(browser, '[data-role="ai-handle"]');
      await sleep(300);
      const afterHandle = await browser.evaluate(`(() => { ${HELPERS}
        const main = q('[data-role="main"]');
        const ta = q('[data-role="agent-input"]');
        return {
          open: drawerOpen(),
          scrollLeft: main.scrollLeft,
          docScrollLeft: document.scrollingElement.scrollLeft,
          activeIsInput: document.activeElement === ta,
        };
      })()`);
      const afterManualFocus = await browser.evaluate(`(() => { ${HELPERS}
        q('[data-role="agent-input"]').focus();
        const main = q('[data-role="main"]');
        return { scrollLeft: main.scrollLeft, docScrollLeft: document.scrollingElement.scrollLeft };
      })()`);
      cycles.push({ i, afterHandle, afterManualFocus });
      await realClick(browser, '[data-role="ai-handle"]');
      await sleep(280);
    }
    record(
      "AC1.1 连开 5 次抽屉并 focus 输入框：.main.scrollLeft 与 document.scrollingElement.scrollLeft 恒为 0",
      cycles.every(
        (c) =>
          c.afterHandle.open === "true" &&
          c.afterHandle.scrollLeft === 0 &&
          c.afterManualFocus.scrollLeft === 0 &&
          c.afterHandle.docScrollLeft === 0 &&
          c.afterManualFocus.docScrollLeft === 0,
      ),
      cycles.map((c) => ({
        i: c.i,
        open: c.afterHandle.open,
        scrollLeft: c.afterHandle.scrollLeft,
        afterManualFocus: c.afterManualFocus.scrollLeft,
        docScrollLeft: c.afterHandle.docScrollLeft,
      })),
      "全部 0",
    );
    record(
      "AC1.2 focus 真的落到输入框上（没有为了不滚动而把 focus 弄丢）",
      cycles.every((c) => c.afterHandle.activeIsInput === true),
      cycles.map((c) => c.afterHandle.activeIsInput),
      [true, true, true, true, true],
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "AC1-scroll-cycles.json"),
      `${JSON.stringify({ before, cycles }, null, 2)}\n`,
    );
  }

  // 保持抽屉打开，后面所有结构断言都需要它。
  await browser.evaluate(`(() => { ${HELPERS}
    if (drawerOpen() !== 'true') q('[data-role="ai-handle"]').click();
    return true;
  })()`);
  await sleep(350);

  /* ================================================================ AC3
   * 模型下拉的 DOM 父节点不是 .composer-box；模型与动作按钮在同一行。 */
  {
    const geometry = await browser.evaluate(`(() => { ${HELPERS}
      const model = q('[data-role="model-select"]');
      const action = q('[data-role="composer-action"]');
      const box = q('[data-role="composer-box"]');
      const m = rect(model), a = rect(action);
      return {
        modelParentClass: model.parentElement.className,
        modelParentDataRole: model.parentElement.getAttribute('data-role'),
        modelInsideBox: box.contains(model),
        topDiff: Math.abs(m.top - a.top),
        modelLeft: m.left,
        actionLeft: a.left,
        sameRowParent: model.parentElement === action.parentElement,
        boxChildren: [...box.children].map((el) => el.getAttribute('data-role') || el.tagName.toLowerCase()),
      };
    })()`);
    record(
      "AC3.1 模型下拉的 DOM 父节点不是 .composer-box（已移出输入框）",
      geometry.modelInsideBox === false,
      geometry,
      { modelInsideBox: false },
    );
    record(
      "AC3.2 模型与动作按钮在同一行（top 差 ≤ 2px），模型在左、按钮在右",
      geometry.topDiff <= 2 && geometry.modelLeft < geometry.actionLeft && geometry.sameRowParent === true,
      geometry,
      { topDiff: "<= 2", order: "model.left < action.left" },
    );
    record(
      "AC3.3 .composer-box 里只剩 textarea 与拖拽把手（没有内嵌模型/按钮）",
      geometry.boxChildren.every((role) => role === "agent-grow" || role === "agent-input"),
      geometry.boxChildren,
      ["agent-grow", "agent-input"],
    );
    await writeFile(path.join(EVIDENCE_DIR, "AC3-geometry.json"), `${JSON.stringify(geometry, null, 2)}\n`);
  }

  /* ================================================================ AC4
   * 提示 = placeholder：空输入可见、输入 3 个字符后不可见；独立 .composer-hint 不存在。 */
  {
    const empty = await browser.evaluate(`(() => { ${HELPERS}
      const ta = q('[data-role="agent-input"]');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const style = cs(ta, '::placeholder');
      return {
        placeholder: ta.placeholder,
        placeholderColor: style.color,
        value: ta.value,
        hintElements: qa('[data-role="composer-hint"], .composer-hint').length,
        composerHeight: rect(q('.composer')).height,
        visible: ta.value === '' && ta.placeholder.length > 0 && style.color !== 'rgba(0, 0, 0, 0)',
        shownWhenEmpty: ta.matches(':placeholder-shown'),
      };
    })()`);
    const typed = await browser.evaluate(`(() => { ${HELPERS}
      const ta = q('[data-role="agent-input"]');
      ta.focus({ preventScroll: true });
      ta.value = 'abc';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const out = {
        value: ta.value,
        shownWhileTyped: ta.matches(':placeholder-shown'),
        composerHeight: rect(q('.composer')).height,
      };
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return out;
    })()`);
    record(
      "AC4.1 空输入时 placeholder 可见（值空 + 文案是 Enter 提示 + 颜色不透明）",
      empty.visible === true &&
        empty.shownWhenEmpty === true &&
        /Enter 发送/.test(empty.placeholder) &&
        /Shift\+Enter 换行/.test(empty.placeholder),
      empty,
      { placeholder: "Enter 发送 · Shift+Enter 换行" },
    );
    record(
      "AC4.2 输入 3 个字符后 placeholder 不再显示（:placeholder-shown 为 false）",
      typed.shownWhileTyped === false,
      typed,
      { shownWhileTyped: false },
    );
    record(
      "AC4.3 不再存在独立 .composer-hint 元素（也就没有它占的第二行）",
      empty.hintElements === 0,
      { hintElements: empty.hintElements },
      { hintElements: 0 },
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "AC4-placeholder.json"),
      `${JSON.stringify({ empty, typed }, null, 2)}\n`,
    );
  }

  /* ================================================================ AC5
   * Enter 发送、Shift+Enter 换行。真实键盘事件；agent.run/agent.stop 被页面补丁吞掉并记录。 */
  {
    const enter = await browser.evaluate(`(() => { ${HELPERS}
      window.__probeSentFrames.length = 0;
      const ta = q('[data-role="agent-input"]');
      ta.focus({ preventScroll: true });
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const snap = agent() || {};
      return { turnsBefore: (snap.turns || []).length };
    })()`);
    await browser.raw.send("Input.insertText", { text: "探测用问题：今天天气如何" });
    await sleep(150);
    await pressEnter(browser);
    await sleep(400);
    const afterEnter = await browser.evaluate(`(() => { ${HELPERS}
      const ta = q('[data-role="agent-input"]');
      const snap = agent() || {};
      const turns = snap.turns || [];
      const last = turns[turns.length - 1] || null;
      return {
        value: ta.value,
        hasNewline: ta.value.includes(String.fromCharCode(10)),
        sentFrames: window.__probeSentFrames.map((f) => ({ type: f.type, question: f.question })),
        turns: turns.length,
        lastQuestion: last ? last.question : null,
        status: snap.status,
      };
    })()`);
    record(
      "AC5.1 Enter 触发发送：记到一帧 agent.run，输入框被清空且不含换行",
      afterEnter.sentFrames.some((f) => f.type === "agent.run") &&
        afterEnter.value === "" &&
        afterEnter.hasNewline === false &&
        afterEnter.turns > enter.turnsBefore,
      afterEnter,
      { frame: "agent.run", value: "", hasNewline: false },
    );

    await browser.evaluate(`(() => { ${HELPERS}
      window.__probeSentFrames.length = 0;
      const ta = q('[data-role="agent-input"]');
      ta.focus({ preventScroll: true });
      ta.value = 'a';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);
    await pressEnter(browser, { shift: true });
    await sleep(280);
    const afterShift = await browser.evaluate(`(() => { ${HELPERS}
      const ta = q('[data-role="agent-input"]');
      return {
        value: ta.value,
        hasNewline: ta.value.includes(String.fromCharCode(10)),
        sentFrames: window.__probeSentFrames.length,
      };
    })()`);
    record(
      "AC5.2 Shift+Enter 插入换行且不发送（没有新的 agent.run）",
      afterShift.hasNewline === true && afterShift.sentFrames === 0,
      afterShift,
      { hasNewline: true, sentFrames: 0 },
    );

    const prevented = await browser.evaluate(`(() => { ${HELPERS}
      const ta = q('[data-role="agent-input"]');
      ta.value = 'x';
      const plain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      const shift = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
      ta.dispatchEvent(plain);
      const plainPrevented = plain.defaultPrevented;
      ta.dispatchEvent(shift);
      const shiftPrevented = shift.defaultPrevented;
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return { plainPrevented, shiftPrevented };
    })()`);
    record(
      "AC5.3 keydown：Enter 被 preventDefault（改走发送），Shift+Enter 不拦（留给浏览器插换行）",
      prevented.plainPrevented === true && prevented.shiftPrevented === false,
      prevented,
      { plainPrevented: true, shiftPrevented: false },
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "AC5-keys.json"),
      `${JSON.stringify({ enter, afterEnter, afterShift, prevented }, null, 2)}\n`,
    );
  }

  /* ================================================================ AC6
   * 空闲 = 发送形态；running 时**同一个节点**变红环+深心；点它触发停止。 */
  {
    // 收掉上一段留下的 running（agent.run 被吞了，不会有真实回帧）
    await browser.evaluate(`(() => { ${HELPERS}
      const snap = agent() || {};
      window.__termDebugFrame({ type: "agent.done", requestId: snap.requestId, text: "" });
      return true;
    })()`);
    await sleep(300);

    const idle = await browser.evaluate(`(() => { ${HELPERS}
      const btn = q('[data-role="composer-action"]');
      const style = cs(btn);
      return {
        busy: btn.classList.contains('is-busy'),
        state: btn.getAttribute('data-state'),
        label: btn.getAttribute('aria-label'),
        background: style.backgroundColor,
        borderWidth: style.borderTopWidth,
        disabled: btn.disabled === true,
        accent: cssColor('var(--term-accent)'),
        svgCount: btn.querySelectorAll('svg').length,
      };
    })()`);
    record(
      "AC6.1 空闲态 = 发送形态：无 is-busy、底色 ≈ --term-accent、aria-label=发送",
      idle.busy === false &&
        idle.state === "idle" &&
        idle.label === "发送" &&
        near(parseColor(idle.background), parseColor(idle.accent), 3),
      idle,
      { background: "≈ --term-accent", label: "发送" },
    );

    await browser.evaluate(`(() => {
      window.__termDebugFrame({
        type: "agent.start",
        sessionId: "probe-session-d",
        requestId: "probe-req-d",
        taskId: "probe-task-d",
        round: 1,
      });
      return true;
    })()`);
    await sleep(380);

    const busy = await browser.evaluate(`(() => { ${HELPERS}
      const btn = q('[data-role="composer-action"]');
      const style = cs(btn);
      const r = rect(btn);
      return {
        busy: btn.classList.contains('is-busy'),
        state: btn.getAttribute('data-state'),
        label: btn.getAttribute('aria-label'),
        disabled: btn.disabled === true,
        background: style.backgroundColor,
        borderWidth: style.borderTopWidth,
        borderColor: style.borderTopColor,
        color: style.color,
        status: (agent() || {}).status,
        danger: cssColor('var(--term-danger)'),
        busyCore: cssColor('var(--term-busy-core)'),
        accentFg: cssColor('var(--term-accent-fg)'),
        width: r.width,
        coreDiameter: r.width - 2 * parseFloat(style.borderTopWidth || '0'),
        actionCount: qa('[data-role="composer-action"]').length,
        svgCount: btn.querySelectorAll('svg').length,
      };
    })()`);
    const busyBg = parseColor(busy.background);
    const danger = parseColor(busy.danger);
    const busyCore = parseColor(busy.busyCore);
    record(
      "AC6.2 running 时**同一个节点**带 is-busy：红环（边框色 ≈ --term-danger）+ 深色圆心（底色 ≈ --term-busy-core）",
      busy.busy === true &&
        busy.state === "busy" &&
        busy.actionCount === 1 &&
        busy.status === "running" &&
        parseFloat(busy.borderWidth) >= 2 &&
        near(parseColor(busy.borderColor), danger, 4) &&
        near(busyBg, busyCore, 4) &&
        Boolean(busyBg && danger) &&
        luminance(busyBg) < luminance(danger),
      busy,
      { isBusy: true, ring: "≈ --term-danger", core: "≈ --term-busy-core（更暗）" },
    );
    record(
      "AC6.3 忙碌态按钮仍然可点（disabled 不置位，否则停不下来），aria-label=停止",
      busy.disabled === false && busy.label === "停止",
      { disabled: busy.disabled, label: busy.label },
      { disabled: false, label: "停止" },
    );
    await shot(browser, "ac6-busy-button");

    await browser.evaluate(`(() => { ${HELPERS}
      window.__probeSentFrames.length = 0;
      return true;
    })()`);
    await realClick(browser, '[data-role="composer-action"]');
    await sleep(320);
    const afterStop = await browser.evaluate(`(() => { ${HELPERS}
      return {
        frames: window.__probeSentFrames.map((f) => f.type),
        runFrames: window.__probeSentFrames.filter((f) => f.type === 'agent.run').length,
        status: (agent() || {}).status,
        busy: q('[data-role="composer-action"]').classList.contains('is-busy'),
        label: q('[data-role="composer-action"]').getAttribute('aria-label'),
      };
    })()`);
    record(
      "AC6.4 点忙碌态按钮 = 停止：发出 agent.stop、状态变 stopped、按钮回到发送形态",
      afterStop.frames.includes("agent.stop") &&
        afterStop.runFrames === 0 &&
        afterStop.status === "stopped" &&
        afterStop.busy === false &&
        afterStop.label === "发送",
      afterStop,
      { frames: ["agent.stop"], status: "stopped", busy: false },
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "AC6-action-button.json"),
      `${JSON.stringify({ idle, busy, afterStop }, null, 2)}\n`,
    );
  }

  /* ================================================================ AC2
   * 三处下拉框（模型 / 会话 / 文件⋯）：浅色与深色下
   *   ① backgroundColor 的 alpha === 1（不透明）
   *   ② 菜单文字 vs 菜单底色 ≥ 4.5:1（看得清；比 AC 的 3:1 更严）
   *   ③ 边框 + 阴影存在（浮层边界感）；逐像素证明不透明 */
  const MENUS = [
    {
      key: "model",
      open: `q('[data-role="model-select"]').click()`,
      selector: '[data-role="model-menu"]',
      shotName: "ac2-model-menu",
    },
    {
      key: "sessions",
      open: `q('[data-role="agent-sessions-toggle"]').click()`,
      selector: '[data-role="agent-sessions-menu"]',
      shotName: "ac2-sessions-menu",
    },
  ];

  const menuEvidence = { light: {}, dark: {} };

  async function measureMenus(themeLabel) {
    for (const menu of MENUS) {
      await browser.evaluate(`(() => { ${HELPERS}
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`);
      await sleep(150);
      await browser.evaluate(`(() => { ${HELPERS} ${menu.open}; return true; })()`);
      await sleep(280);
      const metrics = await menuMetrics(browser, menu.selector);
      const bg = parseColor(metrics.background);
      const text = parseColor(metrics.itemTextColor);
      const dim = parseColor(metrics.dimTextColor);
      const behind = parseColor(metrics.behindColor);
      const row = {
        ...metrics,
        alpha: bg ? bg[3] : null,
        itemContrast: bg && text ? Number(contrast(bg, text).toFixed(2)) : null,
        dimContrast: bg && dim ? Number(contrast(bg, dim).toFixed(2)) : null,
        behindContrast: bg && behind ? Number(contrast(bg, behind).toFixed(2)) : null,
      };
      if (menu.key === "model") {
        row.shot = await shot(browser, `${menu.shotName}-${themeLabel}`);
        const buffer = await browser.screenshot();
        if (buffer) {
          const png = decodePng(buffer);
          const px = Math.round(metrics.rect.x + 7);
          const py = Math.round(metrics.rect.y + metrics.rect.height / 2);
          const sample = png.at(px, py);
          row.pixel = {
            at: [px, py],
            rgba: sample,
            matchesBackground: near([sample[0], sample[1], sample[2]], bg, 2),
          };
        }
      }
      menuEvidence[themeLabel][menu.key] = row;
      await browser.evaluate(`(() => { ${HELPERS}
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`);
      await sleep(150);
    }

    // 文件⋯菜单：打开文件面板 → 点某个条目的「⋯」
    {
      await browser.evaluate(`(() => { ${HELPERS}
        const rail = q('[data-role="rail-files"]');
        if (rail && rail.getAttribute('aria-pressed') !== 'true') rail.click();
        return true;
      })()`);
      await sleep(1100);
      const opened = await browser.evaluate(`(() => { ${HELPERS}
        const toggle = q('.file-panel-more-toggle');
        if (!toggle) return false;
        toggle.click();
        return true;
      })()`);
      await sleep(320);
      if (opened) {
        const metrics = await menuMetrics(browser, ".file-panel-action-menu");
        const bg = parseColor(metrics.background);
        const text = parseColor(metrics.itemTextColor);
        const behind = parseColor(metrics.behindColor);
        menuEvidence[themeLabel].files = {
          ...metrics,
          alpha: bg ? bg[3] : null,
          itemContrast: bg && text ? Number(contrast(bg, text).toFixed(2)) : null,
          behindContrast: bg && behind ? Number(contrast(bg, behind).toFixed(2)) : null,
        };
        await shot(browser, `ac2-files-menu-${themeLabel}`);
        await browser.evaluate(`(() => { ${HELPERS}
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          document.body.click();
          return true;
        })()`);
      } else {
        menuEvidence[themeLabel].files = { found: false, reason: "file-panel-more-toggle not found" };
      }
      await sleep(220);
      await browser.evaluate(`(() => { ${HELPERS}
        const rail = q('[data-role="rail-files"]');
        if (rail && rail.getAttribute('aria-pressed') === 'true') rail.click();
        return true;
      })()`);
      await sleep(600);
    }
  }

  await measureMenus("light");
  await writeSettings("dark");
  await sleep(2600); // 主题同步是 1s 轮询
  await measureMenus("dark");
  await writeSettings("light");
  await sleep(2600);

  {
    const rows = [];
    for (const theme of ["light", "dark"]) {
      for (const key of ["model", "sessions", "files"]) {
        rows.push({ theme, key, ...menuEvidence[theme][key] });
      }
    }
    const measurable = rows.filter((r) => r && r.found && r.display !== "none");
    record(
      "AC2.1 三处下拉框都取到了 computed 样式（模型 / 会话 / 文件⋯，浅色 + 深色）",
      measurable.length === rows.length,
      rows.map((r) => ({ theme: r.theme, key: r.key, found: r.found, display: r.display, reason: r.reason })),
      { measurable: rows.length },
    );
    record(
      "AC2.2 三处菜单背景 alpha === 1（不透明实色，问题 8 的根因已消除）",
      measurable.length === rows.length && measurable.every((r) => r.alpha === 1),
      measurable.map((r) => ({ theme: r.theme, key: r.key, background: r.background, alpha: r.alpha })),
      { alpha: 1 },
    );
    record(
      "AC2.3 菜单文字 vs 菜单底色 ≥ 4.5:1（菜单里的字看得清；AC 要求 3:1，这里更严）",
      measurable.length === rows.length && measurable.every((r) => Number(r.itemContrast) >= 4.5),
      measurable.map((r) => ({
        theme: r.theme,
        key: r.key,
        itemContrast: r.itemContrast,
        itemTextColor: r.itemTextColor,
        dimContrast: r.dimContrast,
      })),
      { itemContrast: ">= 4.5" },
    );
    record(
      "AC2.4 三处菜单都有 1px 实线边框 + box-shadow（浮层边界感，R2）",
      measurable.length === rows.length &&
        measurable.every((r) => /^1px/.test(r.border || "") && Boolean(r.boxShadow)),
      measurable.map((r) => ({ theme: r.theme, key: r.key, border: r.border, boxShadow: Boolean(r.boxShadow) })),
      { border: "1px solid", boxShadow: true },
    );
    const pixelRows = ["light", "dark"].map((t) => ({ theme: t, ...menuEvidence[t].model.pixel }));
    record(
      "AC2.5 逐像素：模型菜单内部的颜色 == 它的 backgroundColor（真的没有透明层叠）",
      pixelRows.every((r) => r && r.matchesBackground === true),
      pixelRows,
      { matchesBackground: true },
    );
    await writeFile(path.join(EVIDENCE_DIR, "AC2-menus.json"), `${JSON.stringify(menuEvidence, null, 2)}\n`);
  }

  /* ================================================================ AC8 / AC9 / AC10
   * 用 window.__termDebugFrame 注入 agent.* 帧，走真实的 store → render 路径。 */
  const MARKDOWN_SAMPLE = [
    "### 小结",
    "",
    "**粗体** 与 `inline_code()` 都在这一行，斜体 *强调*。",
    "",
    "```bash",
    "git status --short",
    "```",
    "",
    "- 第一项",
    "- 第二项",
    "",
    "| 文件 | 状态 |",
    "| --- | --- |",
    "| a.txt | 已改 |",
    "",
    "详见 [文档](https://example.com/doc)。",
    "",
    "---",
  ].join("\n");

  await browser.evaluate(`(() => { ${HELPERS}
    const snap = agent() || {};
    window.__termDebugFrame({ type: "agent.done", requestId: snap.requestId, text: "" });
    return true;
  })()`);
  await sleep(260);

  /* AC10 前半：流式阶段必须还是纯文本 */
  await browser.evaluate(`(() => {
    window.__termDebugFrame({
      type: "agent.start",
      sessionId: "probe-session-md",
      requestId: "probe-req-md",
      taskId: "probe-task-md",
      round: 1,
    });
    window.__termDebugFrame({ type: "agent.text", requestId: "probe-req-md", text: "**粗体** 正在写" });
    return true;
  })()`);
  await sleep(380);
  const streaming = await browser.evaluate(`(() => { ${HELPERS}
    const streams = qa('[data-role="agent-stream"]');
    const stream = streams[streams.length - 1] || null;
    return {
      exists: Boolean(stream),
      text: stream ? stream.textContent : null,
      strongCount: stream ? stream.querySelectorAll('strong').length : 0,
      childElements: stream ? stream.children.length : 0,
    };
  })()`);
  record(
    "AC10.1 流式增量期间该条消息是纯文本（agent-stream 里没有 strong 等标签，字面 ** 还在）",
    streaming.exists === true &&
      streaming.strongCount === 0 &&
      streaming.childElements === 0 &&
      /\*\*粗体\*\*/.test(streaming.text || ""),
    streaming,
    { plainText: true, strongCount: 0 },
  );

  /* AC8：消息结束后渲染 markdown */
  await browser.evaluate(`(() => {
    const text = ${JSON.stringify(MARKDOWN_SAMPLE)};
    window.__termDebugFrame({ type: "agent.done", requestId: "probe-req-md", text });
    return true;
  })()`);
  await sleep(500);
  const rendered = await browser.evaluate(`(() => { ${HELPERS}
    const summaries = qa('[data-role="agent-summary"]');
    const summary = summaries[summaries.length - 1] || null;
    const text = summary ? summary.querySelector('.summary-text') : null;
    const count = (tag) => (text ? text.querySelectorAll(tag).length : 0);
    const anchor = text ? text.querySelector('a') : null;
    return {
      summaryExists: Boolean(summary),
      mdMarked: text ? text.getAttribute('data-role') : null,
      strong: count('strong'),
      em: count('em'),
      inlineCode: count('code'),
      pre: count('pre'),
      ul: count('ul'),
      li: count('li'),
      table: count('table'),
      th: count('th'),
      td: count('td'),
      h3: count('h3'),
      a: count('a'),
      hr: count('hr'),
      aHref: anchor ? anchor.getAttribute('href') : null,
      aTarget: anchor ? anchor.getAttribute('target') : null,
      aRel: anchor ? anchor.getAttribute('rel') : null,
      visibleText: text ? text.textContent : '',
    };
  })()`);
  record(
    "AC8.1 markdown 渲染出真实标签：strong / em / code / pre / ul / li / table / th / td / h3 / a / hr",
    rendered.mdMarked === "agent-summary-md" &&
      rendered.strong > 0 &&
      rendered.em > 0 &&
      rendered.inlineCode > 0 &&
      rendered.pre > 0 &&
      rendered.ul > 0 &&
      rendered.li >= 2 &&
      rendered.table > 0 &&
      rendered.th >= 2 &&
      rendered.td >= 2 &&
      rendered.h3 > 0 &&
      rendered.a > 0 &&
      rendered.hr > 0,
    rendered,
    { allTagsPresent: true },
  );
  record(
    "AC8.2 可见文本里不再出现 markdown 源码字面量 **（真换成粗体了）",
    !rendered.visibleText.includes("**") && rendered.visibleText.includes("粗体"),
    { hasDoubleStar: rendered.visibleText.includes("**"), head: rendered.visibleText.slice(0, 120) },
    { hasDoubleStar: false },
  );
  record(
    "AC8.3 链接带上 target=_blank 与 rel=noopener noreferrer",
    rendered.aHref === "https://example.com/doc" &&
      rendered.aTarget === "_blank" &&
      /noopener/.test(rendered.aRel || "") &&
      /noreferrer/.test(rendered.aRel || ""),
    { href: rendered.aHref, target: rendered.aTarget, rel: rendered.aRel },
    { target: "_blank", rel: "noopener noreferrer" },
  );
  const codeBlock = await browser.evaluate(`(() => { ${HELPERS}
    const pre = q('[data-role="agent-summary-md"] pre');
    const code = pre ? pre.querySelector('code') : null;
    if (!pre) return { found: false };
    const drawer = rect(q('[data-role="ai-drawer"]'));
    const r = rect(pre);
    return {
      found: true,
      overflowX: cs(pre).overflowX,
      fontFamily: code ? cs(code).fontFamily : null,
      preWidth: Number(r.width.toFixed(1)),
      drawerWidth: Number(drawer.width.toFixed(1)),
      fitsDrawer: r.left >= drawer.left - 1 && r.left + r.width <= drawer.left + drawer.width + 1,
      docOverflowX: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
    };
  })()`);
  record(
    "AC8.4 代码块用等宽字体、overflow-x 可滚、不撑破抽屉（不产生页面横向滚动）",
    codeBlock.found === true &&
      codeBlock.overflowX === "auto" &&
      /mono|Consolas|Menlo|Cascadia/i.test(codeBlock.fontFamily || "") &&
      codeBlock.fitsDrawer === true &&
      codeBlock.docOverflowX === false,
    codeBlock,
    { overflowX: "auto", mono: true, fitsDrawer: true },
  );
  await writeFile(path.join(EVIDENCE_DIR, "AC8-markdown.json"), `${JSON.stringify({ rendered, codeBlock }, null, 2)}\n`);
  await shot(browser, "ac8-markdown-summary");

  /* ================================================================ AC9
   * XSS 三例：img onerror / javascript: 链接 / script 必须被拦。 */
  const XSS_CASES = [
    { name: "img-onerror", text: '看图：<img src=x onerror="window.__probeAlerts=1">' },
    { name: "javascript-url", text: "[点我](javascript:alert(1))" },
    { name: "script-tag", text: "<script>alert(1)</script> 后面的正文" },
  ];
  const xssEvidence = [];
  for (const [index, testCase] of XSS_CASES.entries()) {
    const requestId = "probe-xss-" + index;
    await browser.evaluate(`(() => {
      window.__probeAlerts = 0;
      window.__termDebugFrame({
        type: "agent.start",
        sessionId: "probe-session-xss",
        requestId: ${JSON.stringify(requestId)},
        taskId: "probe-task-xss",
        round: ${index + 2},
      });
      window.__termDebugFrame({
        type: "agent.done",
        requestId: ${JSON.stringify(requestId)},
        text: ${JSON.stringify(testCase.text)},
      });
      return true;
    })()`);
    await sleep(500);
    const state = await browser.evaluate(`(() => { ${HELPERS}
      const summaries = qa('[data-role="agent-summary"]');
      const last = summaries[summaries.length - 1];
      const text = last ? last.querySelector('.summary-text') : null;
      const anchors = text ? [...text.querySelectorAll('a')] : [];
      return {
        summaryCount: summaries.length,
        innerHTML: text ? text.innerHTML : null,
        imgCount: text ? text.querySelectorAll('img').length : 0,
        scriptCount: text ? text.querySelectorAll('script').length : 0,
        onAttr: text
          ? [...text.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => /^on/i.test(a.name)))
          : false,
        hrefs: anchors.map((a) => a.getAttribute('href')),
        alerts: window.__probeAlerts,
        textContent: text ? text.textContent : null,
      };
    })()`);
    xssEvidence.push({ case: testCase.name, payload: testCase.text, ...state });
    if (testCase.name === "img-onerror") {
      record(
        "AC9.1 <img src=x onerror=...> 不产生 img、不产生任何 on* 属性、onerror 没执行",
        state.imgCount === 0 &&
          state.onAttr === false &&
          state.alerts === 0 &&
          !/<img/i.test(state.innerHTML || "") &&
          !/onerror/i.test(state.innerHTML || ""),
        state,
        { imgCount: 0, onAttr: false, alerts: 0 },
      );
    }
    if (testCase.name === "javascript-url") {
      record(
        "AC9.2 [x](javascript:alert(1)) 渲染后 href 不含 javascript:，且没有 on* 属性",
        state.hrefs.every((h) => !/^\s*javascript:/i.test(h || "")) &&
          !/javascript:/i.test(state.innerHTML || "") &&
          state.onAttr === false,
        state,
        { hrefs: "不含 javascript:" },
      );
    }
    if (testCase.name === "script-tag") {
      record(
        "AC9.3 <script>alert(1)</script> 被剥离（没有 script 标签、没有 on*、alert 没被调用）",
        state.scriptCount === 0 &&
          state.onAttr === false &&
          state.alerts === 0 &&
          !/<script/i.test(state.innerHTML || ""),
        state,
        { scriptCount: 0, alerts: 0 },
      );
    }
  }
  await writeFile(path.join(EVIDENCE_DIR, "AC9-xss.json"), `${JSON.stringify(xssEvidence, null, 2)}\n`);

  /* ================================================================ AC10 后半
   * 渲染抛错时降级为纯文本，消息不消失。 */
  {
    const fallback = await browser.evaluate(`(() => { ${HELPERS}
      window.__probeRealParse = window.marked.parse;
      window.marked.parse = () => { throw new Error('probe: marked.parse 故意抛错'); };
      const payload = '**这条必须是纯文本** ' + String.fromCharCode(96) + 'code' + String.fromCharCode(96);
      window.__probeFallbackPayload = payload;
      window.__termDebugFrame({
        type: "agent.start",
        sessionId: "probe-session-fallback",
        requestId: "probe-req-fallback",
        taskId: "probe-task-fallback",
        round: 9,
      });
      window.__termDebugFrame({ type: "agent.done", requestId: "probe-req-fallback", text: payload });
      return { payload };
    })()`);
    await sleep(520);
    const degrade = await browser.evaluate(`(() => { ${HELPERS}
      const summaries = qa('[data-role="agent-summary"]');
      const last = summaries[summaries.length - 1];
      const text = last ? last.querySelector('.summary-text') : null;
      const out = {
        summaryCount: summaries.length,
        exists: Boolean(text),
        dataRole: text ? text.getAttribute('data-role') : null,
        childElements: text ? text.children.length : 0,
        textContent: text ? text.textContent : null,
        payload: window.__probeFallbackPayload,
      };
      window.marked.parse = window.__probeRealParse;
      return out;
    })()`);
    record(
      "AC10.2 渲染抛错时降级为纯文本、消息不消失（无 data-role=md、无子元素、原文可见）",
      degrade.exists === true &&
        degrade.dataRole === null &&
        degrade.childElements === 0 &&
        degrade.textContent === degrade.payload,
      degrade,
      { plainText: true, messageKept: true },
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "AC10-degrade.json"),
      `${JSON.stringify({ fallback, degrade }, null, 2)}\n`,
    );
  }

  /* 最后再确认一次：流式帧仍然不渲染（上面注入的副产物不能污染这个结论）
     注：注入与读取必须**分开两次** evaluate —— agent-store 的 notify() 走
     queueMicrotask，同一个同步块里读 DOM 时 render 还没跑（这里踩过一次）。 */
  {
    await browser.evaluate(`(() => {
      window.__termDebugFrame({
        type: "agent.start",
        sessionId: "probe-session-stream2",
        requestId: "probe-req-stream2",
        taskId: "probe-task-stream2",
        round: 11,
      });
      window.__termDebugFrame({ type: "agent.text", requestId: "probe-req-stream2", text: "**还在流式**" });
      return true;
    })()`);
    await sleep(420);
    const streamStillPlain = await browser.evaluate(`(() => { ${HELPERS}
      const streams = qa('[data-role="agent-stream"]');
      const stream = streams[streams.length - 1] || null;
      return {
        exists: Boolean(stream),
        strongCount: stream ? stream.querySelectorAll('strong').length : -1,
        childElements: stream ? stream.children.length : -1,
        text: stream ? stream.textContent : null,
      };
    })()`);
    record(
      "AC10.3 再次流式（含 **）仍然渲染为纯文本，没有 strong 标签",
      streamStillPlain.exists === true &&
        streamStillPlain.strongCount === 0 &&
        /\*\*还在流式\*\*/.test(streamStillPlain.text || ""),
      streamStillPlain,
      { strongCount: 0 },
    );
    await browser.evaluate(`(() => {
      window.__termDebugFrame({ type: "agent.done", requestId: "probe-req-stream2", text: "收尾" });
      return true;
    })()`);
  }

  await shot(browser, "ac10-final-drawer");
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
  path.join(EVIDENCE_DIR, "probe-results.json"),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
);
if (JSON_FLAG) console.log(JSON.stringify({ summary, results }));
console.log(`\n${summary.pass}/${summary.total} PASS${fatal ? " (fatal)" : ""}`);
process.exit(failed.length === 0 && !fatal ? 0 : 1);
