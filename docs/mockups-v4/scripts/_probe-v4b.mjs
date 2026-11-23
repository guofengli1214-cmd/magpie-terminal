import { spawn, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILE = join(process.env.TEMP || ROOT, "v4b-probe-profile");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9417;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
  "--allow-file-access-from-files", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ep() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch {}
    await sleep(150);
  }
  throw new Error("no cdp");
}
function connect(wsUrl) {
  return new Promise((res0, rej) => {
    const ws = new WebSocket(wsUrl); const pend = new Map(); let id = 0;
    ws.addEventListener("open", () => res0({
      send(m, p = {}) { return new Promise((res, rej2) => { const i = ++id; pend.set(i, { res, rej: rej2 }); ws.send(JSON.stringify({ id: i, method: m, params: p })); }); },
      close() { ws.close(); },
    }));
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    ws.addEventListener("error", rej);
  });
}
const v = await ep();
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const cdp = await connect(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
const [page, w, h] = [process.argv[2] || "layout.html", +(process.argv[3] || 1440), +(process.argv[4] || 900)];
const expr = process.argv[5];
await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h });
await cdp.send("Page.navigate", { url: pathToFileURL(join(ROOT, page.split("?")[0])).href + (page.includes("?") ? "?" + page.split("?")[1] : "") });
for (let i = 0; i < 120; i++) { const r = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (r.result.value === "complete") break; await sleep(60); }
await sleep(700);
const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 1));
try { const b = await connect(v.webSocketDebuggerUrl); await b.send("Browser.close"); } catch {}
try { chrome.kill(); } catch {}
try { execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
