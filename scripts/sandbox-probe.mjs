// 第 6 轮验收：把应用页嵌进真实的 `<iframe sandbox="allow-scripts">`，
// 用真浏览器（Edge/Chrome headless + CDP）确认：
//   1) 页面文档没有被 frame-ancestors 拦成错误页
//   2) module 脚本真的执行了（DOM 里有 .xterm 节点、__termDebug 可用）
//   3) WS 真的连上了（页面内 connection === "open"，且 sessions 有 1 条）
//
// 父页必须与子页不同源，否则测不出跨源嵌框；这里父页由本地临时 HTTP 服务提供
// （origin http://127.0.0.1:<parentPort>），子页是 http://127.0.0.1:<appPort>/。
//
// 用法：node scripts/sandbox-probe.mjs [--app-port 3495] [--no-headless]

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

const CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const c of CANDIDATES) if (existsSync(c)) return c;
  return null;
}

function jsonGet(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("devtools timeout")));
    req.end();
  });
}

/** 父页：一个跨源页面，只做一件事 —— 用 sandbox="allow-scripts" 嵌入子页。 */
function startParentPage(appPort, parentPort) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>parent</title></head>
<body>
<iframe id="child" sandbox="allow-scripts" src="http://127.0.0.1:${appPort}/"
        style="width:1100px;height:700px;border:0"></iframe>
<script>
  // 把子页的真实状态汇报给父页（沙箱 iframe 无 allow-same-origin，父页读不到内部，
  // 所以要靠子页 => 不，子页也无 postMessage 通道。父页这里只记录「有没有 onload」）
  window.__childLoaded = false;
  document.getElementById("child").addEventListener("load", () => { window.__childLoaded = true; });
</script>
</body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen({ host: "127.0.0.1", port: parentPort }, () => resolve({ server, port: parentPort }));
  });
}

async function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("cdp open failed")));
  });
  let nextId = 1;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1);
      const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 20000);
      const onMessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        if (msg.error) reject(new Error(msg.error.message || "cdp error"));
        else resolve(msg.result || {});
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

/**
 * @param {{appPort?: number, headless?: boolean, settleMs?: number}} [opts]
 */
export async function probeSandbox(opts = {}) {
  const appPort = opts.appPort || 3495;
  const headless = opts.headless !== false;
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : 9000;
  const parentPort = appPort + 100; // 保证不同源
  const devtoolsPort = appPort + 200;

  const browser = findBrowser();
  if (!browser) return { ok: false, skipped: true, reason: "no Edge/Chrome executable" };

  const parent = await startParentPage(appPort, parentPort);
  const profileDir = mkdtempSync(path.join(tmpdir(), "magpie-term-sandbox-"));
  const flags = [
    `--remote-debugging-port=${devtoolsPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--allow-running-insecure-content",
  ];
  if (headless) flags.unshift("--headless=new", "--disable-gpu");
  flags.push("about:blank");

  const child = spawn(browser, flags, { stdio: ["ignore", "pipe", "pipe"] });
  let conn = null;
  try {
    for (let i = 0; i < 100; i += 1) {
      try {
        await jsonGet(`http://127.0.0.1:${devtoolsPort}/json/version`);
        break;
      } catch {
        await sleep(150);
      }
    }
    const target = await jsonGet(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, "PUT");
    conn = await cdp(target.webSocketDebuggerUrl);

    // 控制台消息（找 CSP / CORS 报错）
    const consoleMessages = [];
    const socket = conn;
    await socket.send("Runtime.enable");
    await socket.send("Page.enable");

    await socket.send("Page.navigate", { url: `http://127.0.0.1:${parentPort}/` });
    await sleep(settleMs);

    // 从父页看：iframe 有没有 load（被 CSP 拦时也会 load，但会是错误页）
    const parentEval = await socket.send("Runtime.evaluate", {
      expression: "JSON.stringify({loaded: window.__childLoaded, title: document.title})",
      returnByValue: true,
    });

    // 关键一步：询问**子页**的 DOM。沙箱 iframe 是独立 target，
    // 用 /json/list 找到它，再开一个 CDP 连上去读 .xterm。
    const list = await jsonGet(`http://127.0.0.1:${devtoolsPort}/json/list`);
    const childTarget = (list || []).find(
      (t) => t.type === "iframe" || (t.type === "page" && String(t.url).includes(`:${appPort}/`)),
    );

    let childInfo = { found: false };
    let childConn = null;
    if (childTarget) {
      childConn = await cdp(childTarget.webSocketDebuggerUrl);
      await childConn.send("Runtime.enable");
      const probe = await childConn.send("Runtime.evaluate", {
        expression: `JSON.stringify({
          title: document.title,
          url: location.href,
          xtermCount: document.querySelectorAll('.xterm').length,
          hasTermDebug: typeof window.__termDebug === 'function',
          sessions: (typeof window.__termDebug === 'function') ? window.__termDebug().sessions.length : -1,
          connection: (typeof window.__termDebug === 'function') ? window.__termDebug().connection : null,
          metaTokenPresent: !!document.querySelector('meta[name="magpie-term-token"]'),
          bodyText: document.body ? document.body.innerText.slice(0, 120) : ''
        })`,
        returnByValue: true,
      });
      childInfo = JSON.parse(probe.result.value || "{}");
      childInfo.found = true;
    }

    return {
      ok:
        childInfo.found === true &&
        childInfo.xtermCount >= 1 &&
        childInfo.hasTermDebug === true &&
        childInfo.sessions === 1 &&
        childInfo.connection === "open",
      appPort,
      parentPort,
      browser,
      headless,
      parent: JSON.parse(parentEval.result.value || "{}"),
      child: childInfo,
      consoleMessages,
    };
  } catch (err) {
    return { ok: false, skipped: false, reason: String(err && err.message ? err.message : err) };
  } finally {
    if (conn) conn.close();
    try {
      child.kill();
    } catch {
      // 忽略。
    }
    await sleep(400);
    try {
      parent.server.close();
    } catch {
      // 忽略。
    }
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 忽略。
    }
  }
}

const isMain = Boolean(process.argv[1]) && process.argv[1].endsWith("sandbox-probe.mjs");
if (isMain) {
  let appPort = 3495;
  let headless = true;
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--app-port") appPort = Number(process.argv[++i]);
    else if (process.argv[i] === "--no-headless") headless = false;
  }
  const result = await probeSandbox({ appPort, headless });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
