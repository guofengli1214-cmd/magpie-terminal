// 用真 Chrome（CDP）打开应用页，读回 getComputedStyle 的 --magpie-bg。
// 用法：node scripts/browser-probe.mjs <url> [--chrome <path>] [--timeout <ms>]
// 输出单行 JSON：{ok, value, expected, url, title, evaluated}
// 退出码：0 表示取到了非兜底值；1 表示失败（含「未在真浏览器验证」）。

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 极简 CDP 客户端：一个 WS 连接，按 id 关联响应。 */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          nextId += 1;
          const id = nextId;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP timeout: ${method}`));
              }
            }, 15000);
          });
        },
        close() {
          try {
            socket.close();
          } catch {
            // 忽略。
          }
        },
      });
    });

    socket.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!msg.id || !pending.has(msg.id)) return;
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message || "CDP error"}`));
      else res(msg.result || {});
    });

    socket.addEventListener("error", (event) => {
      reject(new Error(`CDP socket error: ${event && event.message ? event.message : "unknown"}`));
    });
  });
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
    req.setTimeout(5000, () => {
      req.destroy(new Error("devtools http timeout"));
    });
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
 * @param {{url: string, chrome?: string, timeoutMs?: number, expected?: string}} opts
 */
export async function probeComputedVar(opts) {
  const url = opts.url;
  const expected = opts.expected || "#1e1e2e";
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000;
  const chrome = findChrome(opts.chrome);
  if (!chrome) {
    return { ok: false, skipped: true, reason: "no Chrome/Edge executable found", url, expected };
  }

  const profileDir = mkdtempSync(path.join(tmpdir(), "magpie-term-cdp-"));
  const devtoolsPort = 9333;
  const args = [
    `--remote-debugging-port=${devtoolsPort}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "about:blank",
  ];

  const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  if (child.stderr) child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  let client = null;
  try {
    await waitForDevtools(devtoolsPort, 15000);

    // 新版 Chrome 只接受 PUT /json/new（GET 返回 "Using unsafe HTTP verb..."）。
    const targets = await httpJson(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, "PUT");
    const wsUrl = targets.webSocketDebuggerUrl;
    client = await cdpConnect(wsUrl);

    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.navigate", { url });

    // 等页面加载完 + 模块脚本执行完（app.js 是 type=module）。
    const started = Date.now();
    let ready = false;
    while (!ready) {
      if (Date.now() - started > timeoutMs) throw new Error("page load timeout");
      await sleep(200);
      try {
        const result = await client.send("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        });
        if (result && result.result && result.result.value === "complete") ready = true;
      } catch {
        // 页面还在切换。
      }
    }
    // 再留一点时间给 module 脚本与 xterm 初始化。
    await sleep(800);

    const evaluated = await client.send("Runtime.evaluate", {
      expression:
        "getComputedStyle(document.documentElement).getPropertyValue('--magpie-bg').trim()",
      returnByValue: true,
    });
    const inlineStyle = await client.send("Runtime.evaluate", {
      expression:
        "Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\\n')",
      returnByValue: true,
    });
    const title = await client.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    const xtermMounted = await client.send("Runtime.evaluate", {
      expression: "document.querySelectorAll('.xterm').length",
      returnByValue: true,
    });

    // 等前端自动建出首个标签（缺陷 A 的页面侧断言）。
    // app.js 在 WS open 且 store 为空时会发 pty.create；这里等 __termDebug 有 1 个会话。
    const targetSessions = Number.isFinite(opts.expectedSessions) ? opts.expectedSessions : 1;
    const sessionsStarted = Date.now();
    let sessionCount = 0;
    let debugAvailable = false;
    while (Date.now() - sessionsStarted < 15000) {
      const probe = await client.send("Runtime.evaluate", {
        expression:
          "typeof window.__termDebug === 'function' ? window.__termDebug().sessions.length : -1",
        returnByValue: true,
      });
      const raw = probe && probe.result ? probe.result.value : -1;
      if (typeof raw === "number" && raw >= 0) debugAvailable = true;
      sessionCount = typeof raw === "number" ? raw : 0;
      if (sessionCount >= targetSessions) break;
      await sleep(150);
    }
    const debugSnapshot = await client.send("Runtime.evaluate", {
      expression: "typeof window.__termDebug === 'function' ? window.__termDebug() : null",
      returnByValue: true,
    });

    const value = evaluated && evaluated.result ? String(evaluated.result.value || "") : "";
    const styleText = inlineStyle && inlineStyle.result ? String(inlineStyle.result.value || "") : "";
    return {
      ok: value === expected,
      value,
      expected,
      url,
      title: title && title.result ? title.result.value : null,
      xtermCount: xtermMounted && xtermMounted.result ? xtermMounted.result.value : null,
      inlineStyleInjected: styleText.includes(`--magpie-bg: ${expected}`),
      debugAvailable,
      sessionCount,
      sessions: debugSnapshot && debugSnapshot.result ? debugSnapshot.result.value : null,
      chrome,
    };
  } catch (err) {
    return { ok: false, skipped: false, reason: err && err.message ? err.message : String(err), url, expected, stderr: stderr.slice(-800) };
  } finally {
    if (client) client.close();
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

const isMain = Boolean(process.argv[1]) && process.argv[1].endsWith("browser-probe.mjs");
if (isMain) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: node scripts/browser-probe.mjs <url> [--chrome <path>] [--timeout <ms>]");
    process.exit(2);
  }
  let chrome;
  let timeoutMs;
  for (let i = 3; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--chrome") chrome = process.argv[++i];
    else if (process.argv[i] === "--timeout") timeoutMs = Number(process.argv[++i]);
  }
  const result = await probeComputedVar({ url, chrome, timeoutMs });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
