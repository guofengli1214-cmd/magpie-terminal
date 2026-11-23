/* V4b 截图：Chrome headless + CDP。
   与 shoot.mjs 的区别：支持 sel（按元素裁近景，2x 像素）与 clip（按区域裁）。
   用法：node scripts/shoot-v4b.mjs [name ...]（不带参数则全部） */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const SHOTS = join(ROOT, "shots");
const PROFILE = join(process.env.TEMP || ROOT, "v4b-cdp-profile");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9416;

const JOBS = [
  /* ---- 1440x900 ---- */
  { name: "v4b-1440-overview-closed", page: "layout.html", w: 1440, h: 900 },
  { name: "v4b-1440-overview-open", page: "layout.html?ai=open", w: 1440, h: 900 },
  { name: "v4b-1440-edge-handle", page: "layout.html", w: 1440, h: 900, clip: { x: 1180, y: 246, w: 260, h: 408 } },
  { name: "v4b-1440-approval-tip", page: "layout.html?ai=open&tip=1", w: 1440, h: 900, union: [".approval", ".review-tip"], pad: 16 },
  { name: "v4b-1440-composer-grow", page: "layout.html?ai=open&grow=1", w: 1440, h: 900, sel: ".composer", pad: 12 },
  { name: "v4b-1440-sessions-collapsed", page: "ai-chat.html?view=sessions", w: 1440, h: 900 },
  { name: "v4b-1440-sessions-expanded", page: "ai-chat.html?view=sessions&sess=2", w: 1440, h: 900 },
  { name: "v4b-1440-settings", page: "ai-chat.html?view=settings", w: 1440, h: 900 },
  { name: "v4b-1440-settings-effect", page: "ai-chat.html?view=settings&effect=1", w: 1440, h: 900, sel: ".drawer-zoom", pad: 10 },
  { name: "v4b-1440-chat-effect", page: "ai-chat.html?view=chat&effect=1", w: 1440, h: 900, sel: ".approval", pad: 16 },
  { name: "v4b-1440-files", page: "hosts-files.html?view=files", w: 1440, h: 900 },
  { name: "v4b-1440-hosts", page: "hosts-files.html?view=hosts", w: 1440, h: 900 },

  /* ---- 1280x760 ---- */
  { name: "v4b-1280-overview-closed", page: "layout.html", w: 1280, h: 760 },
  { name: "v4b-1280-overview-open", page: "layout.html?ai=open", w: 1280, h: 760 },
  { name: "v4b-1280-approval-tip", page: "layout.html?ai=open&tip=1", w: 1280, h: 760, union: [".approval", ".review-tip"], pad: 14 },
  { name: "v4b-1280-composer-grow", page: "layout.html?ai=open&grow=1", w: 1280, h: 760, sel: ".composer", pad: 10 },
  { name: "v4b-1280-sessions-collapsed", page: "ai-chat.html?view=sessions", w: 1280, h: 760 },
  { name: "v4b-1280-settings-effect", page: "ai-chat.html?view=settings&effect=1", w: 1280, h: 760, sel: ".drawer-zoom", pad: 8 },
  { name: "v4b-1280-files", page: "hosts-files.html?view=files", w: 1280, h: 760 },
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
  for (let i = 0; i < 120; i++) {
    const r = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (r.result.value === "complete") break;
    await sleep(60);
  }
  await sleep(700);

  let clip = null;
  let scale = 1;
  if (job.sel || job.union) {
    const sels = job.union || [job.sel];
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const sels = ${JSON.stringify(sels)};
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const s of sels) {
          const el = document.querySelector(s);
          if (!el) continue;
          const b = el.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) continue;
          x1 = Math.min(x1, b.left); y1 = Math.min(y1, b.top);
          x2 = Math.max(x2, b.right); y2 = Math.max(y2, b.bottom);
        }
        if (x1 === Infinity) return null;
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      })()`,
      returnByValue: true,
    });
    const b = r.result.value;
    if (b) {
      const pad = job.pad || 10;
      clip = {
        x: Math.max(0, b.x - pad),
        y: Math.max(0, b.y - pad),
        width: Math.min(job.w, b.w + pad * 2),
        height: Math.min(job.h, b.h + pad * 2),
        scale: 2,
      };
      scale = 2;
    }
  } else if (job.clip) {
    clip = {
      x: job.clip.x, y: job.clip.y,
      width: Math.min(job.w - job.clip.x, job.clip.w),
      height: Math.min(job.h - job.clip.y, job.clip.h),
      scale: 2,
    };
    scale = 2;
  }

  const params = { format: "png", captureBeyondViewport: false };
  if (clip) params.clip = clip;
  const shot = await cdp.send("Page.captureScreenshot", params);
  const file = join(SHOTS, job.name + ".png");
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`${job.name}  ${job.w}x${job.h}${scale > 1 ? " @" + scale + "x" : ""}  -> ${file}`);
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
