import { spawn } from "node:child_process";
const PORT = 9423, BASE = "file:///C:/Users/41807/magpie-terminal/docs/mockups-v4/";
const expr = `(() => {
  const kids = [...document.querySelector(".spec-right").children].map((el) => ({ cls: el.className, y: Math.round(el.getBoundingClientRect().y), h: Math.round(el.getBoundingClientRect().height), sh: el.scrollHeight }));
  return { kids, sh: document.querySelector(".spec-right").scrollHeight, ch: document.querySelector(".spec-right").clientHeight };
})()`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() { for (let i = 0; i < 40; i++) { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await wait(250); } } throw new Error("no cdp"); }
class WS { constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; } open() { return new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); } send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.p.set(id, { res, rej })); } }
const proc = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--hide-scrollbars", "--user-data-dir=" + process.env.TEMP + "/v4-ovf2", "about:blank"], { stdio: "ignore" });
try {
  const l = await targets();
  const ws = new WS(l.find((t) => t.type === "page").webSocketDebuggerUrl);
  await ws.open(); await ws.send("Page.enable"); await ws.send("Runtime.enable");
  for (const [p, w, h] of [["ai-chat.html", 1280, 760], ["ai-chat.html?view=sessions", 1280, 760]]) {
    await ws.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await ws.send("Page.navigate", { url: BASE + p });
    for (let i = 0; i < 50; i++) { const r = await ws.send("Runtime.evaluate", { expression: "document.readyState" }); if (r.result.value === "complete") break; await wait(80); }
    await wait(400);
    const r = await ws.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    console.log("==", p, JSON.stringify(r.result.value, null, 1));
  }
  ws.ws.close();
} finally { proc.kill(); }
