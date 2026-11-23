import { spawn } from "node:child_process";
const PORT = 9424, BASE = "file:///C:/Users/41807/magpie-terminal/docs/mockups-v4/";
const expr = `(() => {
  const find = (t) => { const out=[]; const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n=w.currentNode; if (n.textContent.trim()===t) { const el=n.parentElement; const b=el.getBoundingClientRect(); out.push({tag:el.tagName, cls:el.className, x:Math.round(b.x), y:Math.round(b.y), w:Math.round(b.width), h:Math.round(b.height), ov:getComputedStyle(el).overflow}); } } return out; };
  return { a: find("pwsh: 25812"), b: find("来源徽标 · 会话记录字段"), c: find("ssh: prod-web-01"), d: find("本机") };
})()`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() { for (let i = 0; i < 40; i++) { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await wait(250); } } throw new Error("no cdp"); }
class WS { constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; } open() { return new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); } send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.p.set(id, { res, rej })); } }
const proc = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--hide-scrollbars", "--user-data-dir=" + process.env.TEMP + "/v4-ovl", "about:blank"], { stdio: "ignore" });
try {
  const l = await targets(); const ws = new WS(l.find((t) => t.type === "page").webSocketDebuggerUrl);
  await ws.open(); await ws.send("Page.enable"); await ws.send("Runtime.enable");
  await ws.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await ws.send("Page.navigate", { url: BASE + "ai-chat.html" });
  for (let i = 0; i < 50; i++) { const r = await ws.send("Runtime.evaluate", { expression: "document.readyState" }); if (r.result.value === "complete") break; await wait(80); }
  await wait(400);
  const r = await ws.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log(JSON.stringify(r.result.value, null, 1));
  ws.ws.close();
} finally { proc.kill(); }
