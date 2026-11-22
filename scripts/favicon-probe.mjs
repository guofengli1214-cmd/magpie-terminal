// D9-1 验证：真 Chrome 打开应用页，确认没有任何 /favicon.ico 请求、也没有 404。
// 用法：node scripts/favicon-probe.mjs [url]
// 输出单行 JSON：{ok, faviconRequests, httpErrors, final404Count}
// 退出码：0 = 没有 404；1 = 仍有 404。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

const DEFAULT_CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function httpJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("devtools http timeout")));
    req.end();
  });
}

async function waitForDevtools(port, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      const list = await httpJson(`http://127.0.0.1:${port}/json/version`);
      if (list && list.webSocketDebuggerUrl) return list;
    } catch {
      // 还没起来。
    }
    if (Date.now() - started > timeoutMs) throw new Error("devtools endpoint never came up");
    await sleep(150);
  }
}

/**
 * @param {{url?: string, devtoolsPort?: number, settleMs?: number}} [opts]
 */
export async function probeFavicon(opts = {}) {
  const url = opts.url || "http://127.0.0.1:3480/";
  const devtoolsPort = Number.isFinite(opts.devtoolsPort) ? opts.devtoolsPort : 9335;
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : 4000;

  const chrome = findChrome();
  if (!chrome) return { ok: false, skipped: true, reason: "no Chrome/Edge executable found" };

  const profileDir = mkdtempSync(path.join(tmpdir(), "magpie-term-favicon-"));
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${devtoolsPort}`,
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let socket = null;
  try {
    await waitForDevtools(devtoolsPort, 15000);
    const target = await httpJson(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, "PUT");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error("cdp open failed")));
    });

    const events = [];
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.method === "Network.requestWillBeSent") {
        events.push({ kind: "req", url: msg.params.request.url });
      } else if (msg.method === "Network.responseReceived") {
        events.push({ kind: "res", url: msg.params.response.url, status: msg.params.response.status });
      }
    });

    let nextId = 1;
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = (nextId += 1);
        const onMessage = (event) => {
          const msg = JSON.parse(String(event.data));
          if (msg.id !== id) return;
          socket.removeEventListener("message", onMessage);
          resolve(msg.result || {});
        };
        socket.addEventListener("message", onMessage);
        socket.send(JSON.stringify({ id, method, params }));
      });

    await send("Network.enable");
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url });
    await sleep(settleMs);

    const faviconRequests = events.filter((e) => /favicon/i.test(e.url));
    const httpErrors = events.filter((e) => e.kind === "res" && e.status >= 400);

    return {
      ok: httpErrors.length === 0 && faviconRequests.length === 0,
      url,
      faviconRequests,
      httpErrors,
      final404Count: httpErrors.filter((e) => e.status === 404).length,
      chrome,
    };
  } catch (err) {
    return { ok: false, skipped: false, reason: err && err.message ? err.message : String(err), url };
  } finally {
    if (socket) {
      try {
        socket.close();
      } catch {
        // 忽略。
      }
    }
    try {
      child.kill();
    } catch {
      // 忽略。
    }
    await sleep(300);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 忽略。
    }
  }
}

const isMain = Boolean(process.argv[1]) && process.argv[1].endsWith("favicon-probe.mjs");
if (isMain) {
  const url = process.argv[2] || "http://127.0.0.1:3480/";
  const result = await probeFavicon({ url });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
