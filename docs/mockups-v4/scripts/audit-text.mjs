// Text layout audit: clipping, overlap, off-parent drift. Substitutes for vision review.
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9417;
const BASE = "file:///C:/Users/41807/magpie-terminal/docs/mockups-v4/";
const cases = [
  ["layout-closed", "layout.html", 1440, 900],
  ["layout-open", "layout.html?ai=open", 1440, 900],
  ["layout-hosts", "layout.html?hosts=1", 1440, 900],
  ["layout-menu", "layout.html?menu=1", 1440, 900],
  ["ai-chat", "ai-chat.html", 1440, 900],
  ["ai-empty", "ai-chat.html?view=empty", 1440, 900],
  ["ai-sessions", "ai-chat.html?menu=1", 1440, 900],
  ["hf-hosts", "hosts-files.html", 1440, 900],
  ["hf-files", "hosts-files.html?view=files", 1440, 900],
  ["layout-closed-1280", "layout.html", 1280, 760],
  ["layout-open-1280", "layout.html?ai=open", 1280, 760],
  ["ai-chat-1280", "ai-chat.html", 1280, 760],
  ["ai-empty-1280", "ai-chat.html?view=empty", 1280, 760],
  ["hf-hosts-1280", "hosts-files.html", 1280, 760],
  ["hf-files-1280", "hosts-files.html?view=files", 1280, 760],
];

const audit = `(() => {
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const clipped = [];
  const drifted = [];
  const leaves = [];
  document.querySelectorAll("body *").forEach((el) => {
    if (!vis(el)) return;
    const tag = el.tagName.toLowerCase();
    if (["script","style","svg","path","use","symbol","img"].includes(tag)) return;
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");
    if (!text) return;
    leaves.push(el);
    if (el.scrollWidth > el.clientWidth + 1 && !el.classList.contains("tl") && getComputedStyle(el).textOverflow !== "ellipsis") {
      clipped.push({ cls: el.className && String(el.className).slice(0,40), text: text.slice(0,40), sw: el.scrollWidth, cw: el.clientWidth });
    }
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
      drifted.push({ cls: String(el.className).slice(0,40), text: text.slice(0,30), l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) });
    }
  });
  const overlaps = [];
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 4 && oy > 4) {
        // ignore cases where they share a positioned ancestor less than 2 levels up (badges deliberately overlay)
        overlaps.push({ a: a.textContent.trim().slice(0,24), b: b.textContent.trim().slice(0,24), ox: Math.round(ox), oy: Math.round(oy) });
      }
    }
  }
  const blank = [];
  document.querySelectorAll(".files,.terminal,.drawer,.hosts,.spec-left,.spec-right,.ai-msgs").forEach((el) => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > 400000 && el.children.length === 0) blank.push(String(el.className));
  });
  return { clipped: clipped.slice(0, 12), drifted: drifted.slice(0, 12), overlaps: overlaps.slice(0, 15), blank };
})()`;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function cdpTargets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      return await r.json();
    } catch { await wait(250); }
  }
  throw new Error("CDP not ready");
}

class WS {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pend = new Map();
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pend.set(id, { res, rej })); }
}

const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--user-data-dir=" + process.env.TEMP + "/v4-audit-profile", "about:blank"], { stdio: "ignore" });

try {
  const targets = await cdpTargets();
  const page = targets.find((t) => t.type === "page");
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  await ws.send("Page.enable");
  await ws.send("Runtime.enable");
  for (const [name, path, w, h] of cases) {
    await ws.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await ws.send("Page.navigate", { url: BASE + path });
    for (let i = 0; i < 50; i++) {
      const r = await ws.send("Runtime.evaluate", { expression: "document.readyState" });
      if (r.result.value === "complete") break;
      await wait(80);
    }
    await wait(500);
    const r = await ws.send("Runtime.evaluate", { expression: audit, returnByValue: true });
    console.log("==", name, JSON.stringify(r.result.value));
  }
  ws.ws.close();
} finally {
  proc.kill();
}
