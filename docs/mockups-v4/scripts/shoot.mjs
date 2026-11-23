/* V4 截图：Chrome headless + CDP，真实视口，不缩放页面。
   用法：node scripts/shoot.mjs [name ...]  （不带参数则全部） */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const SHOTS = join(ROOT, "shots");
const PROFILE = join(process.env.TEMP || ROOT, "v4-cdp-profile");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9415;

const JOBS = [
  { name: "1440-layout-closed", page: "layout.html", w: 1440, h: 900 },
  { name: "1440-layout-open", page: "layout.html?ai=open", w: 1440, h: 900 },
  { name: "1440-layout-menu", page: "layout.html?menu=1", w: 1440, h: 900 },
  { name: "1440-layout-hosts", page: "layout.html?hosts=1", w: 1440, h: 900 },
  { name: "1440-ai-chat", page: "ai-chat.html", w: 1440, h: 900 },
  { name: "1440-ai-empty", page: "ai-chat.html?view=empty", w: 1440, h: 900 },
  { name: "1440-ai-sessions", page: "ai-chat.html?view=sessions", w: 1440, h: 900 },
  { name: "1440-hosts-files-hosts", page: "hosts-files.html", w: 1440, h: 900 },
  { name: "1440-hosts-files-files", page: "hosts-files.html?view=files", w: 1440, h: 900 },
  { name: "1280-layout-closed", page: "layout.html", w: 1280, h: 760 },
  { name: "1280-layout-open", page: "layout.html?ai=open", w: 1280, h: 760 },
  { name: "1280-layout-menu", page: "layout.html?menu=1", w: 1280, h: 760 },
  { name: "1280-ai-chat", page: "ai-chat.html", w: 1280, h: 760 },
  { name: "1280-ai-sessions", page: "ai-chat.html?view=sessions", w: 1280, h: 760 },
  { name: "1280-ai-empty", page: "ai-chat.html?view=empty", w: 1280, h: 760 },
  { name: "1280-hosts-files-hosts", page: "hosts-files.html", w: 1280, h: 760 },
  { name: "1280-hosts-files-files", page: "hosts-files.html?view=files", w: 1280, h: 760 },
];

const wanted = process.argv.slice(2);
const jobs = wanted.length ? JOBS.filter((j) => wanted.includes(j.name)) : JOBS;

mkdirSync(SHOTS, { recursive: true });
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--allow-file-access-from-files",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitEndpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error("Chrome CDP endpoint did not start");
}

function connect(wsUrl) {
  return new Promise((resolveConn, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.addEventListener("open", () => {
      resolveConn({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close() { ws.close(); },
      });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.method + ": " + msg.error.message));
        else p.res(msg.result);
      }
    });
    ws.addEventListener("error", reject);
  });
}

const version = await waitEndpoint();
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = pages.find((p) => p.type === "page");
const cdp = await connect(target.webSocketDebuggerUrl);

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

for (const job of jobs) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: job.w, height: job.h, deviceScaleFactor: 1, mobile: false,
    screenWidth: job.w, screenHeight: job.h,
  });
  const url = pathToFileURL(join(ROOT, job.page.split("?")[0])).href +
    (job.page.includes("?") ? "?" + job.page.split("?")[1] : "");
  await cdp.send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    const r = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (r.result.value === "complete") break;
    await sleep(60);
  }
  await sleep(650);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = join(SHOTS, job.name + ".png");
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`${job.name}  ${job.w}x${job.h}  -> ${file}`);
}

try {
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser.send("Browser.close");
  browser.close();
} catch {}
await sleep(300);
try { chrome.kill(); } catch {}
try {
  execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
} catch {}
