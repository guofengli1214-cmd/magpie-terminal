// 规格页纵向溢出检查：spec-body / spec-right / spec-left
import { spawn } from "node:child_process";
const PORT = 9422, BASE = "file:///C:/Users/41807/magpie-terminal/docs/mockups-v4/";
const expr = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth, ov: getComputedStyle(el).overflow }; };
  const out = {};
  [".spec", ".spec-head", ".spec-body", ".spec-left", ".spec-right", ".notes", ".field-card", ".state-cards", ".scope-board", ".drawer-zoom", ".sess-menu"].forEach((s) => out[s] = r(document.querySelector(s)));
  const last = document.querySelector(".state-card:last-child");
  out.lastCard = r(last);
  out.bodyOverflowY = document.body.scrollHeight - window.innerHeight;
  return out;
})()`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() { for (let i = 0; i < 40; i++) { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await wait(250); } } throw new Error("no cdp"); }
class WS { constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; } open() { return new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); } send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.p.set(id, { res, rej })); } }
const proc = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--hide-scrollbars", "--user-data-dir=" + process.env.TEMP + "/v4-ovf", "about:blank"], { stdio: "ignore" });
try {
  const l = await targets();
  const ws = new WS(l.find((t) => t.type === "page").webSocketDebuggerUrl);
  await ws.open(); await ws.send("Page.enable"); await ws.send("Runtime.enable");
  for (const [p, w, h] of [["ai-chat.html", 1440, 900], ["ai-chat.html?view=sessions", 1440, 900], ["ai-chat.html", 1280, 760], ["ai-chat.html?view=sessions", 1280, 760]]) {
    await ws.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await ws.send("Page.navigate", { url: BASE + p });
    for (let i = 0; i < 50; i++) { const r = await ws.send("Runtime.evaluate", { expression: "document.readyState" }); if (r.result.value === "complete") break; await wait(80); }
    await wait(500);
    const r = await ws.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    const d = r.result.value;
    console.log("==", p, w + "x" + h, "bodyOverflowY", d.bodyOverflowY);
    for (const k of [".spec-body", ".spec-left", ".spec-right", ".notes", ".field-card", ".state-cards", ".lastCard"]) {
      const v = d[k];
      if (v) console.log("  ", k, "y", v.y, "h", v.h, "sh", v.sh, "ch", v.ch, v.sh > v.ch + 2 ? "OVERFLOW" : "");
    }
    console.log("   sess-menu", JSON.stringify(d[".sess-menu"]));
  }
  ws.ws.close();
} finally { proc.kill(); }
