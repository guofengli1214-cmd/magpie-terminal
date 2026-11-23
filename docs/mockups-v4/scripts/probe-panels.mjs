// Focused geometry probe for the AI drawer header at both widths.
import { spawn } from "node:child_process";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9418;
const BASE = "file:///C:/Users/41807/magpie-terminal/docs/mockups-v4/";
const cases = [
  ["ai-chat-1440", "ai-chat.html", 1440, 900],
  ["ai-chat-1280", "ai-chat.html", 1280, 760],
  ["ai-empty-1280", "ai-chat.html?view=empty", 1280, 760],
  ["hf-hosts-1280", "hosts-files.html", 1280, 760],
  ["hf-files-1280", "hosts-files.html?view=files", 1280, 760],
];
const expr = `(() => {
  const q = (s) => document.querySelector(s);
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const c = getComputedStyle(el); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), sh: el.scrollHeight, ch: el.clientHeight, ov: c.overflow, fs: c.fontSize, lh: c.lineHeight }; };
  const out = {};
  [".spec", ".spec-head", ".spec-body", ".spec-left", ".hf-left", ".hf-files-col", ".hf-files-board", ".hf-subgrid", ".board.col", ".drawer-zoom", ".ai-head", ".sess", ".ai-ctx", ".ai-msgs", ".composer", ".mini-term", ".stage", ".hosts", ".files-zoom", ".state-card", ".hf-hint"].forEach((s) => out[s] = r(q(s)));
  out.sessRows = [...document.querySelectorAll(".sess-title,.sess-sub,.sess-count")].map((el) => ({ t: el.textContent.trim().slice(0, 18), ...r(el) }));
  out.msgs = [...document.querySelectorAll(".msg-user,.msg-ai,.ai-name,.ai-text")].slice(0, 4).map((el) => ({ t: el.textContent.trim().slice(0, 16), ...r(el) }));
  return out;
})()`;
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function targets() { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); return await r.json(); } catch { await wait(250); } } throw new Error("no cdp"); }
class WS { constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; } open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); } send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.p.set(id, { res, rej })); } }
const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--user-data-dir=" + process.env.TEMP + "/v4-geo-profile", "about:blank"], { stdio: "ignore" });
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
