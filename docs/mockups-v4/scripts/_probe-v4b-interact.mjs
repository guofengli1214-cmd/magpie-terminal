/* 交互探针：验证「模型名纯文本按钮能点开列表 / 输入框自动增高 / 拖把手 / 设置开关 / 角标 tooltip」
   与 _probe-v4b.mjs 的区别：会真的点击、输入、等待，然后回报 DOM 状态。
   用法：node scripts/_probe-v4b-interact.mjs [layout.html?ai=open] [1440] [900] */
import { spawn, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILE = join(process.env.TEMP || ROOT, "v4b-interact-profile");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9418;
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
const [page, w, h] = [process.argv[2] || "layout.html?ai=open", +(process.argv[3] || 1440), +(process.argv[4] || 900)];
await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h });
await cdp.send("Page.navigate", { url: pathToFileURL(join(ROOT, page.split("?")[0])).href + (page.includes("?") ? "?" + page.split("?")[1] : "") });
for (let i = 0; i < 120; i++) { const r = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (r.result.value === "complete") break; await sleep(60); }
await sleep(700);

const ev = async (expr) => (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const out = {};

/* 1. 模型名纯文本按钮：点开 → 列表可见；再点 → 关闭 */
out.modelBtn = await ev(`(() => {
  const b = document.querySelector('.composer .model-text');
  if (!b) return 'NO BUTTON';
  const cs = getComputedStyle(b);
  return { text: b.textContent.trim(), border: cs.borderTopWidth, bg: cs.backgroundColor, radius: cs.borderRadius };
})()`);
out.menuBefore = await ev(`(() => { const m = document.querySelector('.composer .menu'); return m ? m.hidden : 'NO MENU'; })()`);
await ev(`document.querySelector('.composer .model-text').click()`);
await sleep(200);
out.menuAfterClick = await ev(`(() => {
  const m = document.querySelector('.composer .menu');
  if (!m) return 'NO MENU';
  const b = m.getBoundingClientRect();
  return { hidden: m.hidden, rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], items: m.querySelectorAll('.menu-item').length };
})()`);
await ev(`document.querySelector('.composer .model-text').click()`);
await sleep(150);
out.menuAfterSecondClick = await ev(`document.querySelector('.composer .menu').hidden`);

/* 2. 输入框自动增高 1→6 行 */
out.taGrowth = await ev(`(() => {
  const ta = document.querySelector('.composer-box textarea');
  ta.value = ''; ta.dataset.manual = ''; ta.style.height = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const h1 = ta.getBoundingClientRect().height;
  ta.value = 'a'.repeat(40) + ' ' + 'b'.repeat(40);  /* 两条长行 → 至少 2 行 */
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const h2 = ta.getBoundingClientRect().height;
  /* 灌到 12 行看封顶 */
  ta.value = Array.from({length: 12}, (_, i) => 'line ' + i + ' xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').join('\\n');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const h3 = ta.getBoundingClientRect().height;
  const sc = ta.scrollHeight;
  ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
  return { empty: Math.round(h1), twoLines: Math.round(h2), twelveLinesCapped: Math.round(h3), twelveScroll: sc };
})()`);

/* 3. 拖把手：模拟 pointer 从把手上方 60px 往下拖 → 高度变大并写入 localStorage */
out.gripDrag = await ev(`(() => {
  const ta = document.querySelector('.composer-box textarea');
  const grip = document.querySelector('[data-composer-grip]');
  const before = ta.getBoundingClientRect().height;
  const r = grip.getBoundingClientRect();
  const mk = (type, y) => new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: r.x + r.width/2, clientY: y });
  grip.dispatchEvent(mk('pointerdown', r.y + 3));
  grip.dispatchEvent(mk('pointermove', r.y - 90));
  grip.dispatchEvent(mk('pointerup', r.y - 90));
  const after = ta.getBoundingClientRect().height;
  return { before: Math.round(before), after: Math.round(after), saved: localStorage.getItem('v4-composer-h'),
           cap40: Math.round((grip.closest('.drawer')?.clientHeight || 0) * 0.4) };
})()`);

/* 4. 设置开关：默认关 → 点开显示 effect 行 */
out.switchFlow = await ev(`(async () => {
  const b = document.querySelector('[data-toggle="effect"]');
  return b ? { found: true, checked: b.getAttribute('aria-checked') } : { found: false };
})()`);
/* 打开设置页验证开关与 effect 行 */
await cdp.send("Page.navigate", { url: pathToFileURL(join(ROOT, "ai-chat.html")).href + "?view=chat" });
for (let i = 0; i < 120; i++) { const r = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (r.result.value === "complete") break; await sleep(60); }
await sleep(600);
out.effectDefault = await ev(`(() => {
  const eff = document.querySelector('[data-spec-panel="chat"] .approval-effect');
  const sw = document.querySelector('[data-toggle="effect"]');
  return { effectHidden: eff ? eff.hidden : 'NO EFFECT LINE', switchChecked: sw ? sw.getAttribute('aria-checked') : 'NO SWITCH' };
})()`);
out.effectAfterToggle = await ev(`(async () => {
  document.querySelector('[data-toggle="effect"]').click();
  await new Promise(r => setTimeout(r, 120));
  const eff = document.querySelector('[data-spec-panel="chat"] .approval-effect');
  const sw = document.querySelector('[data-toggle="effect"]');
  return { effectHidden: eff.hidden, switchChecked: sw.getAttribute('aria-checked') };
})()`);

/* 5. 角标 tooltip：hover 前后可见性 + 两段标题逐字 */
out.tip = await ev(`(() => {
  const mark = document.querySelector('.review-mark');
  const tip = mark.querySelector('.review-tip');
  const before = getComputedStyle(tip).opacity + '/' + getComputedStyle(tip).visibility;
  mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  return { before, heads: Array.from(tip.querySelectorAll('b')).map(b => b.textContent), marks: document.querySelectorAll('.review-mark').length };
})()`);

console.log(JSON.stringify(out, null, 1));
try { const b = await connect(v.webSocketDebuggerUrl); await b.send("Browser.close"); } catch {}
try { chrome.kill(); } catch {}
try { execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
