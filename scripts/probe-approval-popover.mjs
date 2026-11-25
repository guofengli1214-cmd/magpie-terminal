// TASK-FIX17-L3 真浏览器探针：未开抽屉时的浮层确认卡（AC1–AC7）。
//
// 全部在**真 Chrome（headless + CDP）+ 真服务**里跑：断言的是 getBoundingClientRect /
// getComputedStyle / 真实 WebSocket 帧 / 真实截图像素，不是读 CSS 自己猜。
// AC8（`node --test` / doctor / probe-terminal-edges / 禁改零改动）不在本探针内，
// 见 .dispatch/fix17-l3/REPORT.md。
//
// 用法（仓库根）：
//   node scripts/probe-approval-popover.mjs            # 跑全部，证据落 .dispatch/fix17-l3/evidence/
//   node scripts/probe-approval-popover.mjs --json     # 额外把结果 JSON 打到 stdout
//
// 退出码：0 全 PASS；1 有失败（失败项与原因同时写进 evidence/AC-results.json）。

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/http.mjs";
import { openBrowser, sleep } from "./lib/cdp.mjs";
import { shutdown } from "./lib/pty-cleanup.mjs";

const EVIDENCE_DIR = path.resolve(".dispatch", "fix17-l3", "evidence");
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

/** 把半透明前景压在底色上（对比度实测必须按最终像素算，不能拿 alpha 值糊弄）。 */
function over(fg, bg) {
  if (!fg || !bg) return null;
  const a = fg[3] === undefined ? 1 : fg[3];
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
    1,
  ];
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

/* ---------------------------------------------------------------- 页面内注入 */

/**
 * 在 app.js 之前装的补丁（Page.addScriptToEvaluateOnNewDocument）：
 *
 *  1. `/api/models` 固定一条假模型 —— 探针验的是浮层卡片，不该被本机网关是否在线左右。
 *  2. `WebSocket.prototype.send` 把 `agent.approve` **记录并吞掉**：探针要断言
 *     「点执行真的发了 approved:true / scope:once」，但绝不能让命令真在这个 shell 里执行。
 *     `agent.run` / `agent.stop` 同样吞掉（浮层走 stopAgent 时也不许真跑）。
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
  const SWALLOW = new Set(["agent.approve", "agent.run", "agent.stop"]);
  const realSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function patchedSend(data) {
    let frame = null;
    try {
      frame = JSON.parse(String(data));
    } catch {
      frame = null;
    }
    if (frame && SWALLOW.has(frame.type)) {
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
  const card = () => q('[data-role="approval-popover"]');
  const cardVisible = () => { const el = card(); if (!el) return false; const s = cs(el); return !el.hidden && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0; };
  const agent = () => (typeof window.__termDebugAgent === 'function' ? window.__termDebugAgent() : null);
  const drawerOpen = () => document.querySelector('[data-role="app"]').getAttribute('data-ai-open');
  const text = (sel) => { const el = q(sel); return el ? el.textContent : null; };
  const cssColor = (expr) => {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.background = expr;
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  };
  const frames = () => window.__probeSentFrames.map((f) => ({ ...f }));
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

/** 真鼠标移动（CDP Input.dispatchMouseEvent）。 */
async function mouseTo(browser, x, y) {
  await browser.raw.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await sleep(90);
}

/** 把鼠标挪到远离卡片与球的空区。 */
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
  await sleep(220);
  return box;
}

async function shot(browser, name) {
  const buffer = await browser.screenshot();
  if (buffer) await writeFile(path.join(SHOTS_DIR, `${name}.png`), buffer);
  return path.join(SHOTS_DIR, `${name}.png`);
}

/** 推一帧 agent.*（真 store 路径；推帧与读 DOM 分两段，见 work-order §4）。 */
async function pushFrame(browser, frame) {
  await browser.evaluate(`(() => { window.__termDebugFrame(${JSON.stringify(frame)}); return true; })()`);
  await sleep(700);
}

async function resetAgent(browser) {
  await browser.evaluate(`(() => { window.__probeSentFrames.length = 0; return true; })()`);
}

/**
 * 把待确认清空（探针内部用：集合断言前必须从干净状态开始）。
 *
 * 一条一条真点浮层卡片上的「拒绝」——走的是与用户完全相同的审批链路，
 * 不直接改 store（否则就绕过了本次要验的范围）。
 */
async function drainApprovals(browser) {
  for (let i = 0; i < 20; i += 1) {
    const remaining = await browser.evaluate(`(() => { ${HELPERS}
      const a = agent();
      return a && a.pendingApprovals ? a.pendingApprovals.length : 0;
    })()`);
    if (!remaining) break;
    // 抽屉要是关着的（用户原话的前提），否则卡片不可点。
    await browser.evaluate(`(() => { ${HELPERS}
      if (drawerOpen() === 'true') q('[data-role="ai-handle"]').click();
      return true;
    })()`);
    await sleep(400);
    const visible = await browser.evaluate(`(() => { ${HELPERS} return cardVisible(); })()`);
    if (!visible) throw new Error(`待确认 ${remaining} 条但卡片不可见`);
    await realClick(browser, '[data-role="popover-reject"]');
    await sleep(360);
  }
  await resetAgent(browser);
  await sleep(200);
}

/** 推一条待批帧并等它成为队首（前面那些先清掉，队首断言才有意义）。 */
async function aloneApproval(browser, frame) {
  await drainApprovals(browser);
  await pushFrame(browser, frame);
  return cardMetrics(browser);
}

/** 读卡片几何 + 文字 + 计算样式（AC1/AC2/AC5/AC6/AC7 共用）。 */
async function cardMetrics(browser) {
  return browser.evaluate(`(() => { ${HELPERS}
    const el = card();
    if (!el) return { found: false };
    const style = cs(el);
    const risk = el.querySelector('[data-role="popover-risk"]');
    const count = el.querySelector('[data-role="popover-count"]');
    const cmd = el.querySelector('[data-role="popover-command"]');
    const why = el.querySelector('[data-role="popover-why"]');
    const effect = el.querySelector('[data-role="popover-effect"]');
    const reason = el.querySelector('[data-role="popover-reason"]');
    const approve = el.querySelector('[data-role="popover-approve"]');
    const reject = el.querySelector('[data-role="popover-reject"]');
    const rest = el.querySelector('[data-role="popover-approve-rest"]');
    const orb = q('[data-role="command-orb"]');
    const statusbar = q('[data-role="statusbar"]');
    const terminal = q('[data-role="terminal-host"]');
    const labels = qa('.ap-label').map((n) => n.textContent);
    return {
      found: true,
      visible: cardVisible(),
      hidden: el.hidden === true,
      rect: rect(el),
      position: style.position,
      zIndex: style.zIndex,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
      background: style.backgroundColor,
      borderColor: style.borderTopColor,
      borderWidth: style.borderTopWidth,
      color: style.color,
      title: text('.ap-title'),
      riskText: risk ? risk.textContent : null,
      riskReview: risk ? risk.getAttribute('data-review') : null,
      riskKey: risk ? risk.getAttribute('data-risk') : null,
      countText: count ? count.textContent : null,
      countHidden: count ? count.hidden === true : null,
      command: cmd ? cmd.textContent : null,
      commandWhiteSpace: cmd ? cs(cmd).whiteSpace : null,
      commandOverflowX: cmd ? cs(cmd).overflowX : null,
      commandBg: cmd ? cs(cmd).backgroundColor : null,
      why: why ? why.textContent : null,
      effect: effect ? effect.textContent : null,
      reason: reason ? reason.textContent : null,
      reasonHidden: reason ? reason.hidden === true : null,
      labels,
      whyColor: why ? cs(why).color : null,
      effectColor: effect ? cs(effect).color : null,
      labelColor: q('.ap-label') ? cs(q('.ap-label')).color : null,
      approveLabel: approve ? approve.textContent : null,
      rejectLabel: reject ? reject.textContent : null,
      restLabel: rest ? rest.textContent : null,
      approveBg: approve ? cs(approve).backgroundColor : null,
      approveBorder: approve ? cs(approve).borderTopColor : null,
      rejectBorder: reject ? cs(reject).borderTopColor : null,
      orbRect: orb ? rect(orb) : null,
      statusbarRect: statusbar ? rect(statusbar) : null,
      terminalRect: terminal ? rect(terminal) : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      docScrollWidth: document.scrollingElement ? document.scrollingElement.scrollWidth : null,
      docClientWidth: document.scrollingElement ? document.scrollingElement.clientWidth : null,
      panelSolid: cssColor('var(--term-panel-solid)'),
      line2: cssColor('var(--term-line-2)'),
      fg2: cssColor('var(--term-fg-2)'),
      muted: cssColor('var(--term-muted)'),
      fg: cssColor('var(--term-fg)'),
      ok: cssColor('var(--term-ok)'),
      warn: cssColor('var(--term-warn)'),
      danger: cssColor('var(--term-danger)'),
      pendingCount: (agent() || {}).pendingApprovals ? agent().pendingApprovals.length : null,
      drawer: drawerOpen(),
    };
  })()`);
}

/* ---------------------------------------------------------------- 主流程 */

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-fix17l3-"));
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

/* 探针用的帧：一条完整 approval（含两段人话的全部字段）。 */
const FULL_FRAME = {
  type: "agent.approval",
  requestId: "probe-l3-req",
  taskId: "probe-l3-task",
  stepId: "probe-l3-step-1",
  approvalId: "probe-l3-approval-1",
  command: "rm -rf ./build && ls -la",
  why: "想清掉上一次构建产物",
  risk: "caution",
  effect: "会删掉 build 目录里的 3 个文件",
  confirmWhy: "这条会真的删文件，删掉之后就回不来了",
  reversible: false,
  reviewModel: "probe/model-a",
  reviewReason: "命令含输出重定向，可能写文件",
  reviewHit: "redirect",
};

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
  await waitFor(browser, "Boolean(card())", { label: "approval popover mounted" });
  await sleep(600);
  await mouseAway(browser);
  await sleep(400);

  // 抽屉必须是关着的（用户原话的前提）。顺手记一下初始状态。
  await browser.evaluate(`(() => { ${HELPERS}
    if (drawerOpen() === 'true') q('[data-role="ai-handle"]').click();
    return true;
  })()`);
  await sleep(500);
  const initial = await cardMetrics(browser);
  record(
    "前置：抽屉关闭 + 没有待确认 → 卡片不可见（挂载了但不挡任何东西）",
    initial.found === true && initial.visible === false && initial.drawer === "false",
    { found: initial.found, visible: initial.visible, drawer: initial.drawer },
    { found: true, visible: false, drawer: "false" },
  );

  /* ================================================================ AC1
   * 抽屉关闭 + 推入 approval 帧 → 卡片可见、居中于浮球上方、宽 400±2、不溢出视口。 */
  let ac1 = null;
  {
    await pushFrame(browser, FULL_FRAME);
    const m = await cardMetrics(browser);
    const orb = m.orbRect;
    ac1 = m;
    record(
      "AC1.1 抽屉关闭时推入 approval 帧 → 卡片可见（display/visibility/opacity 都过）",
      m.found === true && m.visible === true && m.hidden === false && m.pendingCount >= 1,
      { visible: m.visible, hidden: m.hidden, pendingCount: m.pendingCount, drawer: m.drawer },
      { visible: true, pendingCount: 1 },
    );
    record(
      "AC1.2 position:fixed、宽 400±2、水平居中于浮球（中心差 ≤2px）",
      m.position === "fixed" &&
        Math.abs(m.rect.width - 400) <= 2 &&
        orb !== null &&
        Math.abs(m.rect.x + m.rect.width / 2 - (orb.x + orb.width / 2)) <= 2,
      {
        position: m.position,
        width: Number(m.rect.width.toFixed(2)),
        cardCenterX: Number((m.rect.x + m.rect.width / 2).toFixed(2)),
        orbCenterX: orb ? Number((orb.x + orb.width / 2).toFixed(2)) : null,
        delta: orb ? Number(Math.abs(m.rect.x + m.rect.width / 2 - (orb.x + orb.width / 2)).toFixed(2)) : null,
      },
      { position: "fixed", width: 400, delta: "<=2" },
    );
    record(
      "AC1.3 卡片整体在浮球**上方**（底边 ≤ 球顶），且不压状态栏，左右不溢出视口（各留 ≥12px）",
      orb !== null &&
        m.rect.bottom <= orb.top + 0.5 &&
        m.rect.bottom <= m.statusbarRect.top - 4 &&
        m.rect.left >= 12 &&
        m.rect.right <= m.viewport.width - 12 &&
        m.docScrollWidth === m.docClientWidth,
      {
        cardBottom: Number(m.rect.bottom.toFixed(2)),
        orbTop: orb ? Number(orb.top.toFixed(2)) : null,
        statusbarTop: Number(m.statusbarRect.top.toFixed(2)),
        left: Number(m.rect.left.toFixed(2)),
        right: Number(m.rect.right.toFixed(2)),
        viewportWidth: m.viewport.width,
        docScrollWidth: m.docScrollWidth,
        docClientWidth: m.docClientWidth,
      },
      { cardBottom: "<= orbTop", left: ">=12", right: "<= viewport-12" },
    );
    record(
      "AC1.4 卡片不压住浮球的可点区域（球矩形与卡片矩形不相交），层级高于球（z-index 35 > 30）",
      orb !== null && m.rect.bottom <= orb.top && Number(m.zIndex) === 35,
      { cardBottom: Number(m.rect.bottom.toFixed(2)), orbTop: orb ? Number(orb.top.toFixed(2)) : null, zIndex: m.zIndex },
      { zIndex: 35, disjoint: true },
    );
    await shot(browser, "ac1-visible");
    await writeFile(path.join(EVIDENCE_DIR, "AC1-geometry.json"), `${JSON.stringify(m, null, 2)}\n`);
  }

  /* ================================================================ AC2
   * 两段人话同时出现，文本分别取 why / confirmWhy；缺字段按 R4 回落逐个断言。 */
  {
    const m = await cardMetrics(browser);
    record(
      "AC2.1 卡片同时出现「要做什么」与「执行后会怎样」两段小标题（逐字）",
      Array.isArray(m.labels) &&
        m.labels[0] === "要做什么" &&
        m.labels[1] === "执行后会怎样" &&
        m.labels.length === 2,
      { labels: m.labels },
      { labels: ["要做什么", "执行后会怎样"] },
    );
    record(
      "AC2.2 两段正文分别取 why 与 confirmWhy（真实字段，不是写死）",
      m.why === FULL_FRAME.why && m.effect === FULL_FRAME.confirmWhy,
      { why: m.why, effect: m.effect },
      { why: FULL_FRAME.why, effect: FULL_FRAME.confirmWhy },
    );
    record(
      "AC2.3 标题与命令行逐字（命令行等宽、不折行、可横向滚动）",
      m.title === "AI 想执行一条命令" &&
        m.command === FULL_FRAME.command &&
        m.commandWhiteSpace === "pre" &&
        m.commandOverflowX === "auto",
      {
        title: m.title,
        command: m.command,
        commandWhiteSpace: m.commandWhiteSpace,
        commandOverflowX: m.commandOverflowX,
      },
      { title: "AI 想执行一条命令", command: FULL_FRAME.command, whiteSpace: "pre", overflowX: "auto" },
    );

    /* ---- 回落链：逐条断言（AC2 要求「缺字段时按 R4 回落，逐个断言」）---- */
    const fallbacks = [];
    const pushAndRead = async (label, frame) => {
      // 每条都先清空待批，再换一个 approvalId 推入：队首断言必须从干净状态开始。
      const cm = await aloneApproval(browser, frame);
      fallbacks.push({ label, why: cm.why, effect: cm.effect, pendingCount: cm.pendingCount });
      return cm;
    };

    // ① why 为空 → 用 command。
    const noWhy = await pushAndRead("why 空 → command", {
      ...FULL_FRAME,
      requestId: "probe-l3-req",
      approvalId: "probe-l3-approval-2",
      stepId: "probe-l3-step-2",
      why: "",
      confirmWhy: "",
      effect: "",
    });
    record(
      "AC2.4 回落①：why 为空 → 「要做什么」用 command；confirmWhy/effect 都空 → 固定兜底句",
      noWhy.why === FULL_FRAME.command && noWhy.effect === "会直接在这台电脑上执行，无法自动撤销。",
      { why: noWhy.why, effect: noWhy.effect },
      { why: FULL_FRAME.command, effect: "会直接在这台电脑上执行，无法自动撤销。" },
    );

    // ② confirmWhy 空但 effect 有 → 用 effect。
    const noConfirm = await pushAndRead("confirmWhy 空 → effect", {
      ...FULL_FRAME,
      approvalId: "probe-l3-approval-3",
      stepId: "probe-l3-step-3",
      confirmWhy: null,
      effect: "只会读取磁盘占用，不改任何文件",
    });
    record(
      "AC2.5 回落②：confirmWhy 缺失 → 「执行后会怎样」用 effect",
      noConfirm.effect === "只会读取磁盘占用，不改任何文件",
      { effect: noConfirm.effect },
      { effect: "只会读取磁盘占用，不改任何文件" },
    );

    // ③ 只有 why，没有 confirmWhy/effect → 兜底句；why 仍然来自真实字段。
    const onlyWhy = await pushAndRead("只有 why", {
      ...FULL_FRAME,
      approvalId: "probe-l3-approval-4",
      stepId: "probe-l3-step-4",
      why: "想确认一下当前目录里有什么",
      confirmWhy: null,
      effect: null,
    });
    record(
      "AC2.6 回落③：只有 why（没有 confirmWhy/effect）→ 兜底句，且 why 仍是真实字段",
      onlyWhy.why === "想确认一下当前目录里有什么" &&
        onlyWhy.effect === "会直接在这台电脑上执行，无法自动撤销。",
      { why: onlyWhy.why, effect: onlyWhy.effect },
      { why: "想确认一下当前目录里有什么", effect: "会直接在这台电脑上执行，无法自动撤销。" },
    );
    await shot(browser, "ac2-two-sections");
    await writeFile(
      path.join(EVIDENCE_DIR, "AC2-texts.json"),
      `${JSON.stringify({ ac2: m, fallbacks }, null, 2)}\n`,
    );
  }

  /* ================================================================ AC6
   * 多条待批 → 只显示队首 + 「还有 N 条等待」。 */
  {
    // 从干净状态起：一条 FULL_FRAME + 三条回落的帧 = 4 条待批。
    await drainApprovals(browser);
    await pushFrame(browser, FULL_FRAME);
    await pushFrame(browser, { ...FULL_FRAME, approvalId: "probe-l3-q2", stepId: "probe-l3-q2-step" });
    await pushFrame(browser, { ...FULL_FRAME, approvalId: "probe-l3-q3", stepId: "probe-l3-q3-step" });
    const m = await cardMetrics(browser);
    record(
      "AC6.1 三条待批时卡片只显示队首（命令行 / 两段文字都是第 1 条的）",
      m.command === FULL_FRAME.command &&
        m.why === FULL_FRAME.why &&
        m.effect === FULL_FRAME.confirmWhy &&
        m.pendingCount === 3,
      { command: m.command, why: m.why, effect: m.effect, pendingCount: m.pendingCount },
      { pendingCount: 3, command: FULL_FRAME.command },
    );
    record(
      "AC6.2 底部显示「还有 2 条等待」（N = 待批总数 − 1，逐字）",
      m.countHidden === false && m.countText === "还有 2 条等待",
      { countText: m.countText, countHidden: m.countHidden },
      { countText: "还有 2 条等待" },
    );
    await shot(browser, "ac6-queue");
    await writeFile(path.join(EVIDENCE_DIR, "AC6-queue.json"), `${JSON.stringify(m, null, 2)}\n`);
  }

  /* ================================================================ AC5
   * 风险四态：danger 的角标与标题语义正确；risk===null && reviewReason 时显示真实原因。 */
  {
    // 先点掉前面那些，只留 danger 那一条做断言（队首 = danger）。
    await drainApprovals(browser);
    await pushFrame(browser, {
      ...FULL_FRAME,
      approvalId: "probe-l3-approval-danger",
      stepId: "probe-l3-step-danger",
      command: "rm -rf /",
      why: "用户说要清空",
      risk: "danger",
      effect: "会删掉整个磁盘",
      confirmWhy: "这条不可逆，删掉就回不来了",
      reviewReason: null,
    });
    const danger = await cardMetrics(browser);
    record(
      "AC5.1 risk=danger → 角标 data-review=danger、文案「危险，必须你确认」",
      danger.riskReview === "danger" &&
        danger.riskKey === "danger" &&
        danger.riskText === "危险，必须你确认",
      { riskReview: danger.riskReview, riskKey: danger.riskKey, riskText: danger.riskText },
      { riskReview: "danger", riskText: "危险，必须你确认" },
    );
    record(
      "AC5.2 danger 时标题仍是「AI 想执行一条命令」，两段人话来自 danger 帧的真实字段",
      danger.title === "AI 想执行一条命令" &&
        danger.why === "用户说要清空" &&
        danger.effect === "这条不可逆，删掉就回不来了",
      { title: danger.title, why: danger.why, effect: danger.effect },
      { why: "用户说要清空", effect: "这条不可逆，删掉就回不来了" },
    );
    record(
      "AC5.3 danger 时不显示 reviewReason 行（三态不许被 risk=null 的文案覆盖）",
      danger.reasonHidden === true && (danger.reason === "" || danger.reason === null),
      { reasonHidden: danger.reasonHidden, reason: danger.reason },
      { reasonHidden: true },
    );
    await shot(browser, "ac5-danger");

    // 清掉 danger，推一条 risk=null + reviewReason（judge 说了原因但没送审）。
    const none = await aloneApproval(browser, {
      ...FULL_FRAME,
      approvalId: "probe-l3-approval-null",
      stepId: "probe-l3-step-null",
      command: "echo hi > out.txt",
      why: "写一行到 out.txt",
      risk: null,
      effect: null,
      confirmWhy: null,
      reviewReason: "命令含输出重定向，可能写文件",
      reviewHit: "redirect",
    });
    record(
      "AC5.4 risk=null → 角标 data-review=none（未审阅），并显示真实原因（不是「审阅不可用」）",
      none.riskReview === "none" &&
        none.reasonHidden === false &&
        typeof none.reason === "string" &&
        none.reason.includes("命令含输出重定向，可能写文件") &&
        !none.reason.includes("审阅不可用"),
      { riskReview: none.riskReview, reason: none.reason, reasonHidden: none.reasonHidden },
      { riskReview: "none", reason: "含「命令含输出重定向，可能写文件」，且不含「审阅不可用」" },
    );
    record(
      "AC5.5 risk=null 时两段人话仍然齐全（why 来自字段，effect 走兜底句）",
      none.why === "写一行到 out.txt" &&
        none.effect === "会直接在这台电脑上执行，无法自动撤销。",
      { why: none.why, effect: none.effect },
      { why: "写一行到 out.txt", effect: "会直接在这台电脑上执行，无法自动撤销。" },
    );
    await shot(browser, "ac5-none-with-reason");
    await writeFile(
      path.join(EVIDENCE_DIR, "AC5-risk.json"),
      `${JSON.stringify({ danger, none }, null, 2)}\n`,
    );

    // 清掉这一条，后面的 AC4 / AC3 从干净状态开始。
    await drainApprovals(browser);
  }

  /* ================================================================ AC4
   * 抽屉打开 → 卡片隐藏；关闭 → 重新显示；点浮层按钮后抽屉内卡片状态同步。 */
  {
    // 先推一条新的待批，确保有东西可显示。
    const before = await aloneApproval(browser, {
      ...FULL_FRAME,
      approvalId: "probe-l3-approval-ac4",
      stepId: "probe-l3-step-ac4",
    });
    record(
      "AC4.0 前置：卡片可见（抽屉关闭）",
      before.visible === true && before.drawer === "false",
      { visible: before.visible, drawer: before.drawer },
      { visible: true, drawer: "false" },
    );

    // 打开抽屉（点把手，真用户路径）。
    await browser.evaluate(`(() => { ${HELPERS} q('[data-role="ai-handle"]').click(); return true; })()`);
    await sleep(700);
    const opened = await cardMetrics(browser);
    const drawerCard = await browser.evaluate(`(() => { ${HELPERS}
      return {
        drawer: drawerOpen(),
        drawerCards: qa('[data-role="agent-approval"]').length,
        drawerApprove: qa('[data-role="approval-run"]').length,
        cardVisible: cardVisible(),
      };
    })()`);
    record(
      "AC4.1 抽屉打开 → 浮层卡片隐藏（抽屉里自己的卡片还在）",
      opened.visible === false &&
        drawerCard.drawer === "true" &&
        drawerCard.cardVisible === false &&
        drawerCard.drawerCards >= 1,
      { ...drawerCard, visible: opened.visible },
      { visible: false, drawer: "true", drawerCards: ">=1" },
    );
    await shot(browser, "ac4-drawer-open-no-popover");

    // 关回去 → 卡片重新出现（隐藏不清状态）。
    await browser.evaluate(`(() => { ${HELPERS} q('[data-role="ai-handle"]').click(); return true; })()`);
    await sleep(700);
    const closed = await cardMetrics(browser);
    record(
      "AC4.2 抽屉关闭 → 卡片重新出现（隐藏期间没清状态）",
      closed.visible === true && closed.drawer === "false" && closed.command === FULL_FRAME.command,
      { visible: closed.visible, drawer: closed.drawer, command: closed.command },
      { visible: true, command: FULL_FRAME.command },
    );

    // 点浮层里的「拒绝」→ 抽屉再打开时抽屉里卡片也不再有这一条（同一份 store）。
    // 先把抽屉关着的现场确认一遍（前面 AC4.2 已经关回去了），再真点。
    await resetAgent(browser);
    const beforePopover = await cardMetrics(browser);
    await realClick(browser, '[data-role="popover-reject"]');
    await sleep(900);
    const afterPopover = await cardMetrics(browser);
    const framesAfter = await browser.evaluate(`(() => { ${HELPERS} return frames(); })()`);
    const approveFrames = framesAfter.filter((f) => f.type === "agent.approve");
    record(
      "AC4.3 点浮层「拒绝」→ 本地待批清空、卡片消失；ws 只发了一条 agent.approve(approved:false)",
      beforePopover.visible === true &&
        beforePopover.command === FULL_FRAME.command &&
        afterPopover.visible === false &&
        afterPopover.pendingCount === 0 &&
        approveFrames.length === 1 &&
        approveFrames[0].approved === false &&
        approveFrames[0].scope === "once" &&
        approveFrames[0].approvalId === "probe-l3-approval-ac4",
      {
        before: { visible: beforePopover.visible, command: beforePopover.command },
        visible: afterPopover.visible,
        pendingCount: afterPopover.pendingCount,
        approveFrames,
      },
      { visible: false, pendingCount: 0, approveFrames: 1 },
    );

    // 抽屉打开后里面的卡片也不再有这一条（不重复待批）。
    await browser.evaluate(`(() => { ${HELPERS} q('[data-role="ai-handle"]').click(); return true; })()`);
    await sleep(700);
    const drawerSync = await browser.evaluate(`(() => { ${HELPERS}
      return {
        drawer: drawerOpen(),
        drawerCards: qa('[data-role="agent-approval"]').length,
        agentPending: (agent() || {}).pendingApprovals.length,
      };
    })()`);
    record(
      "AC4.4 点浮层按钮后抽屉内卡片同步（抽屉里没有多的待批卡片，store 里 0 条）",
      drawerSync.drawerCards === 0 && drawerSync.agentPending === 0,
      drawerSync,
      { drawerCards: 0, agentPending: 0 },
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "AC4-drawer.json"),
      `${JSON.stringify({ before, opened, closed, afterPopover, drawerSync, approveFrames }, null, 2)}\n`,
    );

    // 关掉抽屉，回到「未开抽屉」的现场。
    await browser.evaluate(`(() => { ${HELPERS}
      if (drawerOpen() === 'true') q('[data-role="ai-handle"]').click();
      return true;
    })()`);
    await sleep(600);
  }

  /* ================================================================ AC3
   * 点「执行」→ ws 收到 agent.approve {approved:true, scope:"once"}；
   * 点「拒绝」→ approved:false；「本会话都允许」→ scope:"rest"；本地待批清空、卡片消失。 */
  {
    const runs = [];
    // ① 执行
    await drainApprovals(browser);
    await pushFrame(browser, {
      ...FULL_FRAME,
      approvalId: "probe-l3-approval-run",
      stepId: "probe-l3-step-run",
      command: "df -h",
      risk: "safe",
      why: "看下磁盘还剩多少",
      confirmWhy: "只读，不会改任何东西",
    });
    const beforeRun = await cardMetrics(browser);
    await realClick(browser, '[data-role="popover-approve"]');
    await sleep(900);
    const afterRun = await cardMetrics(browser);
    const runFrames = (await browser.evaluate(`(() => { ${HELPERS} return frames(); })()`)).filter(
      (f) => f.type === "agent.approve",
    );
    runs.push({ step: "approve-once", beforeRun: beforeRun.approveLabel, afterRun: afterRun.visible, runFrames });
    record(
      "AC3.1 点「执行」→ ws 收到 agent.approve{approved:true, scope:once, approvalId 正确}，卡片消失、待批清空",
      runFrames.length === 1 &&
        runFrames[0].approved === true &&
        runFrames[0].scope === "once" &&
        runFrames[0].approvalId === "probe-l3-approval-run" &&
        afterRun.visible === false &&
        afterRun.pendingCount === 0,
      { runFrames, visible: afterRun.visible, pendingCount: afterRun.pendingCount },
      { frames: 1, approved: true, scope: "once", visible: false },
    );
    await shot(browser, "ac3-after-approve");

    // ② 拒绝
    await drainApprovals(browser);
    await pushFrame(browser, {
      ...FULL_FRAME,
      approvalId: "probe-l3-approval-reject",
      stepId: "probe-l3-step-reject",
      command: "rm -rf ./build",
      risk: "danger",
      why: "清构建产物",
      confirmWhy: "会删掉 build 目录",
    });
    await realClick(browser, '[data-role="popover-reject"]');
    await sleep(900);
    const afterReject = await cardMetrics(browser);
    const rejectFrames = (await browser.evaluate(`(() => { ${HELPERS} return frames(); })()`)).filter(
      (f) => f.type === "agent.approve",
    );
    runs.push({ step: "reject", afterReject: afterReject.visible, rejectFrames });
    record(
      "AC3.2 点「拒绝」→ ws 收到 agent.approve{approved:false, scope:once}，卡片消失",
      rejectFrames.length === 1 &&
        rejectFrames[0].approved === false &&
        rejectFrames[0].scope === "once" &&
        rejectFrames[0].approvalId === "probe-l3-approval-reject" &&
        afterReject.visible === false &&
        afterReject.pendingCount === 0,
      { rejectFrames, visible: afterReject.visible, pendingCount: afterReject.pendingCount },
      { approved: false, scope: "once", visible: false },
    );

    // ③ 本会话都允许（scope=rest）
    await drainApprovals(browser);
    await pushFrame(browser, {
      ...FULL_FRAME,
      approvalId: "probe-l3-approval-rest",
      stepId: "probe-l3-step-rest",
      command: "npm run lint",
      risk: "safe",
      why: "跑一遍 lint",
      confirmWhy: "只读检查，不改文件",
    });
    const restMetrics = await cardMetrics(browser);
    await realClick(browser, '[data-role="popover-approve-rest"]');
    await sleep(900);
    const afterRest = await cardMetrics(browser);
    const restFrames = (await browser.evaluate(`(() => { ${HELPERS} return frames(); })()`)).filter(
      (f) => f.type === "agent.approve",
    );
    runs.push({ step: "approve-rest", restLabel: restMetrics.restLabel, afterRest: afterRest.visible, restFrames });
    record(
      "AC3.3 点「本会话都允许」→ ws 收到 agent.approve{approved:true, scope:\"rest\"}；标签逐字「本会话都允许」",
      restMetrics.restLabel === "本会话都允许" &&
        restFrames.length === 1 &&
        restFrames[0].approved === true &&
        restFrames[0].scope === "rest" &&
        afterRest.visible === false,
      { restLabel: restMetrics.restLabel, restFrames, visible: afterRest.visible },
      { restLabel: "本会话都允许", scope: "rest" },
    );

    // ④ 按钮文案逐字（R4.5）
    record(
      "AC3.4 按钮文案逐字：「执行」「拒绝」，data-role 三个都在",
      runs.length === 3 &&
        (await browser.evaluate(`(() => { ${HELPERS}
          return [q('[data-role="popover-approve"]') !== null, q('[data-role="popover-reject"]') !== null, q('[data-role="popover-approve-rest"]') !== null];
        })()`)).every(Boolean),
      { runs: runs.map((r) => r.step) },
      { roles: 3 },
    );
    await writeFile(path.join(EVIDENCE_DIR, "AC3-buttons.json"), `${JSON.stringify(runs, null, 2)}\n`);
  }

  /* ================================================================ AC7
   * 1100×800 与 1600×1000：不溢出、不遮球、不遮状态栏（并做一遍深浅色对比度实测）。 */
  {
    const sizes = [];
    for (const [w, h] of [
      [1100, 800],
      [1600, 1000],
    ]) {
      await browser.raw.send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(700);
      await drainApprovals(browser);
      await pushFrame(browser, {
        ...FULL_FRAME,
        approvalId: `probe-l3-size-${w}`,
        stepId: `probe-l3-size-step-${w}`,
      });
      const m = await cardMetrics(browser);
      sizes.push({
        viewport: `${w}x${h}`,
        cardRect: m.rect,
        orbRect: m.orbRect,
        statusbarRect: m.statusbarRect,
        visible: m.visible,
        docScrollWidth: m.docScrollWidth,
        docClientWidth: m.docClientWidth,
      });
      record(
        `AC7 ${w}×${h}：卡片可见、左右各留 ≥12px、底边在球顶之上、不压状态栏、无横向溢出`,
        m.visible === true &&
          m.rect.left >= 12 &&
          m.rect.right <= w - 12 &&
          m.orbRect !== null &&
          m.rect.bottom <= m.orbRect.top + 0.5 &&
          m.rect.bottom <= m.statusbarRect.top &&
          m.rect.bottom <= h &&
          m.docScrollWidth === m.docClientWidth,
        {
          cardRect: m.rect,
          orbTop: m.orbRect ? m.orbRect.top : null,
          statusbarTop: m.statusbarRect.top,
          viewport: m.viewport,
          docScrollWidth: m.docScrollWidth,
          docClientWidth: m.docClientWidth,
        },
        { left: ">=12", right: `<=${w - 12}`, cardBottom: "<= orbTop" },
      );
      await shot(browser, `ac7-${w}x${h}`);
      await realClick(browser, '[data-role="popover-reject"]');
      await sleep(400);
    }

    // 深色 + 浅色各量一次对比度（正文 ≥4.5:1、边框 ≥3:1）。
    const themeRows = {};
    for (const theme of ["light", "dark"]) {
      await writeSettings(theme);
      await sleep(2600); // 主题同步是 1s 轮询 + 令牌注入
      await drainApprovals(browser);
      await pushFrame(browser, {
        ...FULL_FRAME,
        approvalId: `probe-l3-theme-${theme}`,
        stepId: `probe-l3-theme-step-${theme}`,
      });
      const m = await cardMetrics(browser);
      const cardBg = parseColor(m.background) || parseColor(m.panelSolid);
      const border = parseColor(m.borderColor);
      const whyFg = over(parseColor(m.whyColor), cardBg);
      const effectBg = parseColor(m.commandBg) || cardBg;
      const effectFg = over(parseColor(m.effectColor), cardBg);
      const labelFg = over(parseColor(m.labelColor), cardBg);
      const titleFg = over(parseColor(m.color), cardBg);
      const approveBg = parseColor(m.approveBg) || cardBg;
      const approveBorder = parseColor(m.approveBorder);
      themeRows[theme] = {
        cardBg: m.background,
        borderColor: m.borderColor,
        whyColor: m.whyColor,
        effectColor: m.effectColor,
        labelColor: m.labelColor,
        effectBg: m.commandBg,
        borderVsCard: border && cardBg ? Number(contrast(border, cardBg).toFixed(2)) : null,
        whyVsCard: whyFg && cardBg ? Number(contrast(whyFg, cardBg).toFixed(2)) : null,
        effectVsCard: effectFg && cardBg ? Number(contrast(effectFg, cardBg).toFixed(2)) : null,
        labelVsCard: labelFg && cardBg ? Number(contrast(labelFg, cardBg).toFixed(2)) : null,
        approveBorderVsCard: approveBorder && cardBg ? Number(contrast(approveBorder, cardBg).toFixed(2)) : null,
        approveBgVsCard: approveBg && cardBg ? Number(contrast(approveBg, cardBg).toFixed(2)) : null,
      };
      await shot(browser, `ac7-theme-${theme}`);
      await realClick(browser, '[data-role="popover-reject"]');
      await sleep(400);
    }
    await writeSettings("light");
    await sleep(2400);

    const rows = Object.values(themeRows);
    record(
      "AC7.5 深浅色都可读：两段人话正文对卡片底色 ≥4.5:1",
      rows.every((r) => Number(r.whyVsCard) >= 4.5 && Number(r.effectVsCard) >= 4.5),
      rows.map((r) => ({ why: r.whyVsCard, effect: r.effectVsCard })),
      { contrast: ">=4.5" },
    );
    record(
      "AC7.6 卡片边框 / 按钮边框对底色 ≥3:1（边界看得见，深浅色都成立）",
      rows.every((r) => Number(r.borderVsCard) >= 3 && Number(r.approveBorderVsCard) >= 3),
      rows.map((r) => ({ border: r.borderVsCard, approveBorder: r.approveBorderVsCard })),
      { contrast: ">=3" },
    );
    record(
      "AC7.7 小标题（弱化文字）对底色 ≥4.5:1",
      rows.every((r) => Number(r.labelVsCard) >= 4.5),
      rows.map((r) => ({ label: r.labelVsCard })),
      { contrast: ">=4.5" },
    );
    await writeFile(path.join(EVIDENCE_DIR, "AC7-sizes.json"), `${JSON.stringify(sizes, null, 2)}\n`);
    await writeFile(path.join(EVIDENCE_DIR, "AC7-contrast.json"), `${JSON.stringify(themeRows, null, 2)}\n`);
  }

  /* ================================================================ 走查：真的走一遍用户路径 */
  {
    const steps = [];
    await browser.raw.send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(600);
    await drainApprovals(browser);
    await pushFrame(browser, {
      ...FULL_FRAME,
      approvalId: "probe-l3-walk",
      stepId: "probe-l3-walk-step",
      command: "rm -rf ./dist",
      why: "清掉旧的 dist",
      confirmWhy: "会删掉 dist 目录，删了要重新构建",
      risk: "caution",
    });
    const snap = async (label) => {
      const m = await cardMetrics(browser);
      steps.push({
        label,
        visible: m.visible,
        drawer: m.drawer,
        command: m.command,
        why: m.why,
        effect: m.effect,
        count: m.countText,
      });
    };
    await snap("1 抽屉关着收到待确认 → 卡片出现");
    await browser.evaluate(`(() => { ${HELPERS} q('[data-role="ai-handle"]').click(); return true; })()`);
    await sleep(700);
    await snap("2 点把手打开抽屉 → 卡片让位");
    await browser.evaluate(`(() => { ${HELPERS} q('[data-role="ai-handle"]').click(); return true; })()`);
    await sleep(700);
    await snap("3 再点把手收起 → 卡片回来");
    await realClick(browser, '[data-role="popover-reject"]');
    await sleep(800);
    await snap("4 点「拒绝」→ 卡片消失、待批清空");
    await writeFile(path.join(EVIDENCE_DIR, "WALK-user-path.json"), `${JSON.stringify(steps, null, 2)}\n`);
    record(
      "走查：抽屉关→卡片出现 / 开抽屉→让位 / 关抽屉→回来 / 点拒绝→消失，四步与用户原话一致",
      steps[0].visible === true &&
        steps[1].visible === false &&
        steps[1].drawer === "true" &&
        steps[2].visible === true &&
        steps[3].visible === false &&
        steps[0].why === "清掉旧的 dist" &&
        steps[0].effect === "会删掉 dist 目录，删了要重新构建",
      steps,
      { visible: [true, false, true, false] },
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
