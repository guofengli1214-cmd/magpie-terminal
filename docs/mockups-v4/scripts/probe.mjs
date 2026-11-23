/* 布局探针：用 CDP 读关键元素几何与溢出，替代肉眼核对。
   用法：node scripts/probe.mjs */
import { spawn, execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rmSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILE = join(process.env.TEMP || ROOT, "v4-probe-profile");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9416;

const CASES = [
  { name: "layout-closed", page: "layout.html", w: 1440, h: 900 },
  { name: "layout-open", page: "layout.html?ai=open", w: 1440, h: 900 },
  { name: "layout-hosts", page: "layout.html?hosts=1", w: 1440, h: 900 },
  { name: "layout-menu", page: "layout.html?menu=1", w: 1440, h: 900 },
  { name: "layout-closed-1280", page: "layout.html", w: 1280, h: 760 },
  { name: "layout-open-1280", page: "layout.html?ai=open", w: 1280, h: 760 },
  { name: "ai-chat", page: "ai-chat.html", w: 1440, h: 900 },
  { name: "ai-empty", page: "ai-chat.html?view=empty", w: 1440, h: 900 },
  { name: "ai-empty-1280", page: "ai-chat.html?view=empty", w: 1280, h: 760 },
  { name: "hf-hosts", page: "hosts-files.html", w: 1440, h: 900 },
  { name: "hf-files", page: "hosts-files.html?view=files", w: 1440, h: 900 },
  { name: "hf-files-1280", page: "hosts-files.html?view=files", w: 1280, h: 760 },
];

try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--allow-file-access-from-files", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitEndpoint() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch {}
    await sleep(150);
  }
  throw new Error("CDP endpoint did not start");
}
function connect(wsUrl) {
  return new Promise((res0, rej) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.addEventListener("open", () => res0({
      send(method, params = {}) {
        return new Promise((res, rej2) => {
          const mid = ++id; pending.set(mid, { res, rej: rej2 });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close() { ws.close(); },
    }));
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.rej(new Error(m.method + ": " + m.error.message)); else p.res(m.result);
      }
    });
    ws.addEventListener("error", rej);
  });
}

const version = await waitEndpoint();
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const cdp = await connect(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

const PROBE = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      z: cs.zIndex, ov: cs.overflow, disp: cs.display, vis: cs.visibility, op: cs.opacity }; };
  const q = (s) => r(document.querySelector(s));
  const app = document.querySelector(".app");
  const term = document.querySelector(".terminal");
  const termBox = term ? term.getBoundingClientRect() : null;
  const cols = (() => {
    if (!term) return null;
    const tl = term.querySelector(".tl");
    if (!tl) return null;
    const cs = getComputedStyle(tl);
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.textContent = "0".repeat(10);
    tl.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 10;
    probe.remove();
    const inner = tl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { px: +ch.toFixed(2), cols: Math.floor(inner / ch), inner: +inner.toFixed(1) };
  })();
  const overflow = [...document.querySelectorAll(".workarea *, .drawer *, .files *, .hosts *")]
    .filter((el) => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === "visible")
    .slice(0, 12)
    .map((el) => ({ cls: el.className && el.className.baseVal !== undefined ? "svg" : String(el.className).slice(0, 40), tag: el.tagName, sw: el.scrollWidth, cw: el.clientWidth }));
  return {
    app: r(app),
    appData: app ? { ...app.dataset } : null,
    term: termBox ? { x: termBox.x, w: termBox.width } : null,
    cols,
    drawer: q(".drawer"), drawerOpen: app && app.dataset.ai,
    handle: q(".ai-handle"), badge: q(".ai-badge"),
    files: q(".files"), filesGrid: q(".file-grid"),
    selbar: q(".selbar"), ctx: (() => { const c = document.querySelector("#file-ctx"); if (!c) return null;
      const rr = c.getBoundingClientRect(); const cs = getComputedStyle(c);
      return { x: rr.x, y: rr.y, w: rr.width, h: rr.height, hidden: c.hidden, disp: cs.display, vis: cs.visibility, op: cs.opacity }; })(),
    filesHead: q(".files-head"), filesTools: q(".files-tools"), crumbs: q(".crumbs"),
    hosts: q(".hosts"), hostsScrim: q(".hosts-scrim"), hostsLayer: q(".hosts-layer"),
    miniTerm: q(".mini-term"),
    toast: q(".toast"), status: q(".statusbar"),
    menuOpen: [...document.querySelectorAll(".menu")].filter((m) => !m.hidden && getComputedStyle(m).display !== "none")
      .map((m) => { const b = m.getBoundingClientRect(); return { id: m.id, x: b.x, y: b.y, w: b.width, h: b.height }; }),
    scrollBody: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight },
    overflow,
  };
})()`;

const out = [];
for (const c of CASES) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: c.w, height: c.h, deviceScaleFactor: 1, mobile: false, screenWidth: c.w, screenHeight: c.h,
  });
  const url = pathToFileURL(join(ROOT, c.page.split("?")[0])).href + (c.page.includes("?") ? "?" + c.page.split("?")[1] : "");
  await cdp.send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    const r = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (r.result.value === "complete") break;
    await sleep(60);
  }
  await sleep(500);
  const r = await cdp.send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
  out.push({ case: c.name, ...r.result.value });
  console.log("== " + c.name);
  console.log(JSON.stringify(r.result.value));
}

try { const b = await connect(version.webSocketDebuggerUrl); await b.send("Browser.close"); } catch {}
await sleep(300);
try { chrome.kill(); } catch {}
try { execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
