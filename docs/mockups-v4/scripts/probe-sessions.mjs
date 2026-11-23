// Geometry probe for the grouped session dropdown (ai-chat.html, 会话列表 view).
import { spawn } from "node:child_process";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9419;
const BASE = "file:///C:/Users/41807/magpie-terminal/docs/mockups-v4/";
const cases = [
  ["sessions-1440", "ai-chat.html?view=sessions", 1440, 900],
  ["sessions-1280", "ai-chat.html?view=sessions", 1280, 760],
  ["layoutmenu-1440", "layout.html?menu=1", 1440, 900],
];
const expr = `(() => {
  const q = (s) => document.querySelector(s);
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const c = getComputedStyle(el); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), sh: el.scrollHeight, ch: el.clientHeight, ov: c.overflowY }; };
  const out = {};
  const scope = document.querySelector('[data-spec-panel="sessions"]') || document;
  const sq = (s) => scope.querySelector(s);
  out.menu = r(sq(".sess-menu"));
  out.drawer = r(sq(".drawer-zoom"));
  out.groups = [...document.querySelectorAll(".sess-menu .sess-group")].map((g) => {
    const head = g.querySelector(".sess-group-head");
    const items = g.querySelector(".sess-items");
    return { cur: g.dataset.current || "no", head: r(head), items: items ? r(items) : null, label: head.textContent.trim().replace(/\\s+/g, " ").slice(0, 26) };
  });
  out.badges = [...document.querySelectorAll(".sess-menu .src-badge")].map((el) => {
    const t = el.querySelector(".sb-t"), a = el.querySelector(".addr");
    return { cls: el.className, ...r(el), tCut: t ? t.scrollWidth > t.clientWidth + 1 : null, aCut: a ? a.scrollWidth > a.clientWidth + 1 : null, txt: el.textContent.trim().replace(/\\s+/g, " ").slice(0, 30) };
  });
  out.items = [...document.querySelectorAll(".sess-menu .sess-item")].map((el) => {
    const b = el.querySelector(".mi-main b"), s = el.querySelector(".mi-main small");
    return { ...r(el), title: b.textContent.trim().slice(0, 20), bCut: b.scrollWidth > b.clientWidth + 1, sCut: s.scrollWidth > s.clientWidth + 1 };
  });
  out.field = r(q(".field-table"));
  out.ftRows = [...document.querySelectorAll(".field-table .ft-row")].map((el) => ({ ...r(el), txt: el.textContent.trim().replace(/\\s+/g, " ").slice(0, 24) }));
  out.docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  return out;
})()`;
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function targets() { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); return await r.json(); } catch { await wait(250); } } throw new Error("no cdp"); }
class WS { constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; } open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); } send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.p.set(id, { res, rej })); } }
const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--hide-scrollbars", "--user-data-dir=" + process.env.TEMP + "/v4-sess-profile", "about:blank"], { stdio: "ignore" });
try {
  const list = await targets();
  const ws = new WS(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await ws.open(); await ws.send("Page.enable"); await ws.send("Runtime.enable");
  for (const [name, path, w, h] of cases) {
    await ws.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await ws.send("Page.navigate", { url: BASE + path });
    for (let i = 0; i < 50; i++) { const r = await ws.send("Runtime.evaluate", { expression: "document.readyState" }); if (r.result.value === "complete") break; await wait(80); }
    await wait(450);
    const r = await ws.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    console.log("==", name, JSON.stringify(r.result.value));
  }
  ws.ws.close();
} finally { proc.kill(); }
