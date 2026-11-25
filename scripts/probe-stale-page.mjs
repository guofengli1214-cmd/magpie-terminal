// TASK-FIX17-E2 AC4：真浏览器探针 —— 服务重启后「旧页面」还会刷多少条告警。
//
// 现场症状（卡片 Goal）：插件重启 / magpie 重启 / 开发热重载之后，已经打开的旧页面
// 仍持有失效 token：主题每秒轮询 `GET /api/theme`、ws 每 ≤10s 重连，服务端每次都写一条
// `warn`。实测 628KB 日志里 5136 条 `AUTH_TOKEN_MISMATCH`，2MB 轮转约 24 分钟就把真
// 排障日志滚掉。
//
// 本探针做三件事（真 Chrome + CDP，真服务，真 token 轮换）：
//   A. 按卡片原文：`GET /` 打开页面 → 关掉第一个服务 → 同一端口用**新 token** 起重启
//      → 观察 12 秒 → 数第二个服务收到的**原始**告警行（`dedupeWindowMs: 0` 关掉限流，
//      否则数到的是限流后的条数，看不出客户端是否停轮询）；
//   B. 隔离场景（旧页面**永远不会自愈**那种）：页面一开始就带 `mt_token_reload=1`，
//      这样 ws 不会走「加标记自动刷新一次」的恢复路径，12 秒内只可能是旧页面的
//      轮询/重连在刷日志 —— 这是 R1/R2 客户端改动的判别性证据；
//   C. 限流场景：同样带标记，但第二个服务用**默认** `dedupeWindowMs`（60000ms）。
//      断言同一键 15 秒内只落 1 条，且每行都是合法 JSON。
//
// 用法（仓库根）：node scripts/probe-stale-page.mjs
// 输出：单行 JSON（含每条断言 actual/expected）。退出码 0 = 全过，1 = 有断言失败。
// 收尾：Chrome 子进程 kill、临时 profile 删除、两个服务都 close（含 PTY 清理）。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { makeLogger, startServer } from "../src/server/http.mjs";
import { findChrome, sleep } from "./lib/cdp.mjs";

const MARK = "mt_token_reload";

/* ------------------------------------------------------------------ 基础工具 */

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
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
    req.setTimeout(5000, () => req.destroy(new Error("devtools http timeout")));
    req.end();
  });
}

async function waitForDevtools(port, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      const info = await httpJson(`http://127.0.0.1:${port}/json/version`);
      if (info && info.webSocketDebuggerUrl) return info;
    } catch {
      // 还没起来。
    }
    if (Date.now() - started > timeoutMs) throw new Error("devtools endpoint never came up");
    await sleep(150);
  }
}

/**
 * 极简 CDP 客户端：除按 id 关联响应外，还要能收到**事件**
 * （`Runtime.exceptionThrown` / `Page.javascriptDialogOpening` 是 AC4 的崩溃判据）。
 */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const handlers = new Map();

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
            }, 20000);
          });
        },
        on(method, fn) {
          if (!handlers.has(method)) handlers.set(method, []);
          handlers.get(method).push(fn);
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
      if (!msg.id) {
        // 事件（没有 id）：分发给订阅者，单个订阅者抛错不影响其它。
        if (msg.method && handlers.has(msg.method)) {
          for (const fn of handlers.get(msg.method)) {
            try {
              fn(msg.params || {});
            } catch {
              // 忽略。
            }
          }
        }
        return;
      }
      if (!pending.has(msg.id)) return;
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(String(msg.error.message || "CDP error")));
      else res(msg.result || {});
    });

    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
  });
}

async function openBrowser(chrome) {
  const devtoolsPort = 9500 + Math.floor(Math.random() * 400);
  const profileDir = mkdtempSync(path.join(tmpdir(), "magpie-term-stale-"));
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
      "--window-size=1280,860",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  if (child.stderr) child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  await waitForDevtools(devtoolsPort, 20000);
  // 新版 Chrome 只接受 PUT /json/new。
  const target = await httpJson(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, "PUT");
  const client = await cdpConnect(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  return {
    client,
    async evaluate(expression) {
      const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
      if (result && result.exceptionDetails) {
        throw new Error(`evaluate failed: ${result.exceptionDetails.text || "unknown"}`);
      }
      return result && result.result ? result.result.value : undefined;
    },
    async navigate(url) {
      await client.send("Page.navigate", { url });
      const started = Date.now();
      for (;;) {
        if (Date.now() - started > 30000) throw new Error("page load timeout");
        await sleep(150);
        try {
          if ((await this.evaluate("document.readyState")) === "complete") return;
        } catch {
          // 页面还在切换。
        }
      }
    },
    async close() {
      client.close();
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
    },
    stderr: () => stderr.slice(-600),
  };
}

/* ------------------------------------------------------------------ 收集器 */

/**
 * 一个收集器 logger。
 *
 * `dedupeWindowMs: 0` = **关闭限流**（见 makeLogger 的注释），这样数到的是原始条数：
 * 只有关掉限流，「旧页面每秒还在打 /api/theme」才会表现为 12 条而不是 1 条。
 * `file: false` 不碰磁盘（不污染用户真实日志）。
 */
function collector(dedupeWindowMs) {
  const lines = [];
  const log = makeLogger(
    {
      log(line) {
        lines.push(line);
      },
      warn() {
        // 收集器不需要 stderr 噪声。
      },
    },
    { file: false, dedupeWindowMs },
  );
  return { log, lines };
}

/** 从收集到的行里挑 `code` 匹配的条目，附上解析后的对象。 */
function pick(lines, code) {
  const out = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = null;
    }
    if (entry && entry.code === code) out.push({ line, entry });
  }
  return out;
}

const routeIncludes = (items, needle) =>
  items.filter((item) => typeof item.entry.route === "string" && item.entry.route.includes(needle));

/** 同端口重启：关掉旧的，等到能 bind 为止（Windows 上偶发 EADDRINUSE 需要重试）。 */
async function restartServer({ port, token, log }) {
  const started = Date.now();
  for (;;) {
    try {
      return await startServer({ port, token, log });
    } catch (err) {
      if (!err || err.code !== "PORT_IN_USE" || Date.now() - started > 5000) throw err;
      await sleep(120);
    }
  }
}

const newToken = () => "e".repeat(8) + Math.random().toString(16).slice(2).padEnd(56, "0");

/* ------------------------------------------------------------------ 场景 */

/**
 * @param {{
 *   name: string,
 *   chrome: string,
 *   pageUrl: (port:number) => string,
 *   observeMs: number,
 *   dedupeWindowMs: number,
 * }} opts
 */
async function runScenario(opts) {
  const port = await freePort();
  const token1 = newToken();
  const token2 = newToken();
  const first = collector(0);
  const exceptions = [];
  const dialogs = [];
  const loads = [];

  let server1 = null;
  let server2 = null;
  let browser = null;
  try {
    server1 = await startServer({ port, token: token1, log: first.log });
    browser = await openBrowser(opts.chrome);
    browser.client.on("Runtime.exceptionThrown", (params) => {
      const detail = params && params.exceptionDetails ? params.exceptionDetails : {};
      exceptions.push({
        text: detail.text || "",
        description: detail.exception ? detail.exception.description : "",
        url: detail.url || "",
      });
    });
    browser.client.on("Page.javascriptDialogOpening", (params) => {
      dialogs.push({ type: params && params.type, message: params && params.message });
    });
    browser.client.on("Page.loadEventFired", () => loads.push(Date.now()));

    await browser.navigate(opts.pageUrl(port));
    // 等页面把首屏跑起来（ws 连上、首个会话起来、主题第一拍）。
    await sleep(2500);
    const beforeRestart = {
      authWarnings: pick(first.lines, "AUTH_TOKEN_MISMATCH").length,
      pageUrl: await browser.evaluate("location.href"),
      readyState: await browser.evaluate("document.readyState"),
    };

    // 「插件重启」：同一端口换新 token。旧页面手里的 token 从此永远 403。
    await server1.close();
    server1 = null;
    const second = collector(opts.dedupeWindowMs);
    server2 = await restartServer({ port, token: token2, log: second.log });

    const observeStarted = Date.now();
    await sleep(opts.observeMs);
    const observedMs = Date.now() - observeStarted;

    const after = {
      pageUrl: await browser.evaluate("location.href"),
      readyState: await browser.evaluate("document.readyState"),
      themeSyncAlive: await browser.evaluate(
        "String(document.documentElement.getAttribute('data-mt-served'))",
      ),
    };

    // 页面在观察窗口内自己 reload 过几次（有 reload 说明走了「加标记自动刷新」那条路）。
    const marks = loads.length;
    const authAll = pick(second.lines, "AUTH_TOKEN_MISMATCH");
    const themeLines = routeIncludes(authAll, "/api/theme");
    const wsLines = routeIncludes(authAll, "ws");
    const otherLines = authAll.length - themeLines.length - wsLines.length;

    // 每条行都要是合法 JSON（AC4.4 的一半；限流不能把行写坏）。
    let badJson = 0;
    const keys = new Map();
    for (const line of second.lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.level !== "warn" && entry.level !== "error") continue;
        const key = `${entry.level}|${entry.code}|${entry.route || ""}`;
        keys.set(key, (keys.get(key) || 0) + 1);
      } catch {
        badJson += 1;
      }
    }

    return {
      name: opts.name,
      port,
      dedupeWindowMs: opts.dedupeWindowMs,
      observedMs,
      beforeRestart,
      after,
      pageLoadsDuringObserve: marks,
      exceptions: exceptions.length,
      exceptionSamples: exceptions.slice(0, 3),
      dialogs: dialogs.length,
      dialogSamples: dialogs.slice(0, 3),
      counts: {
        rawAuthWarnings: authAll.length,
        theme: themeLines.length,
        ws: wsLines.length,
        other: otherLines,
        badJsonLines: badJson,
      },
      themeRoutes: [...new Set(themeLines.map((item) => item.entry.route))],
      wsRoutes: [...new Set(wsLines.map((item) => item.entry.route))],
      keyCounts: Object.fromEntries(keys),
      suppressedSeen: second.lines
        .map((line) => {
          try {
            const entry = JSON.parse(line);
            return entry.suppressed === undefined ? null : { code: entry.code, route: entry.route, suppressed: entry.suppressed };
          } catch {
            return null;
          }
        })
        .filter(Boolean),
      totalLines: second.lines.length,
    };
  } finally {
    try {
      if (server2) await server2.close();
    } catch {
      // 忽略。
    }
    try {
      if (server1) await server1.close();
    } catch {
      // 忽略。
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        // 忽略。
      }
    }
  }
}

/* ------------------------------------------------------------------ 主流程 */

const assertions = [];
function check(id, ok, actual, expected, note) {
  assertions.push({ id, ok: Boolean(ok), actual, expected, ...(note ? { note } : {}) });
  return ok;
}

async function main() {
  const chrome = findChrome(process.env.CHROME_PATH);
  if (!chrome) {
    console.log(JSON.stringify({ ok: false, reason: "no Chrome/Edge executable found", assertions }));
    process.exit(1);
  }

  const startedAt = Date.now();
  const out = { ok: false, chrome, scenarios: {} };

  // A. 卡片原文场景：`GET /` 打开 → 同端口换 token 重启 → 观察 12 秒。
  const scenarioA = await runScenario({
    name: "A-root-page",
    chrome,
    pageUrl: (port) => `http://127.0.0.1:${port}/`,
    observeMs: 12000,
    dedupeWindowMs: 0,
  });
  out.scenarios.A = scenarioA;

  // B. 隔离场景：页面从一打开就带刷新标记 → 绝不会「自动刷新一次」自愈，
  //    12 秒里只可能是旧页面在轮询 / 重连（R1 / R2 的判别性证据）。
  const scenarioB = await runScenario({
    name: "B-marked-page",
    chrome,
    pageUrl: (port) => `http://127.0.0.1:${port}/?${MARK}=1`,
    observeMs: 12000,
    dedupeWindowMs: 0,
  });
  out.scenarios.B = scenarioB;

  // C. 限流场景：默认 60s 窗口，15 秒里同一键只允许落 1 条。
  const scenarioC = await runScenario({
    name: "C-dedupe-default",
    chrome,
    pageUrl: (port) => `http://127.0.0.1:${port}/?${MARK}=1`,
    observeMs: 15000,
    dedupeWindowMs: 60000,
  });
  out.scenarios.C = scenarioC;

  /* ---------------------------------------------------------------- 断言 */

  check(
    "AC4.1a",
    scenarioA.counts.theme <= 3,
    scenarioA.counts.theme,
    "<=3",
    "第二个服务收到的 AUTH_TOKEN_MISMATCH(route 含 /api/theme) 行数；旧行为约 12 条",
  );
  check(
    "AC4.1b",
    scenarioA.counts.ws <= 3,
    scenarioA.counts.ws,
    "<=3",
    "第二个服务收到的 AUTH_TOKEN_MISMATCH(route 含 ws) 行数；旧行为持续重连",
  );
  check("AC4.2", scenarioA.exceptions === 0, scenarioA.exceptions, 0, "Runtime.exceptionThrown 计数");
  check("AC4.3", scenarioA.dialogs === 0, scenarioA.dialogs, 0, "Page.javascriptDialogOpening 计数");

  // B 的判据与 A 同量级，但场景不可自愈：这两个数字直接证明「客户端停了」。
  check(
    "AC4.B-theme",
    scenarioB.counts.theme <= 3,
    scenarioB.counts.theme,
    "<=3",
    "带刷新标记的旧页面 12 秒内仍打 /api/theme 的条数（连续 2 次 403 后应停止）",
  );
  check(
    "AC4.B-ws",
    scenarioB.counts.ws <= 3,
    scenarioB.counts.ws,
    "<=3",
    "带刷新标记的旧页面 12 秒内 ws upgrade 被拒的条数（staleToken 上报后应停止重连）",
  );
  check("AC4.B-crash", scenarioB.exceptions === 0 && scenarioB.dialogs === 0, {
    exceptions: scenarioB.exceptions,
    dialogs: scenarioB.dialogs,
  }, { exceptions: 0, dialogs: 0 });

  const cKeys = Object.entries(scenarioC.keyCounts);
  const cAuthKeys = cKeys.filter(([key]) => key.includes("AUTH_TOKEN_MISMATCH"));
  check(
    "AC4.4a",
    cAuthKeys.length >= 1 && cAuthKeys.every(([, count]) => count === 1),
    Object.fromEntries(cAuthKeys),
    "每个 AUTH_TOKEN_MISMATCH 键恰好 1 条",
    "默认 60s 窗口：15 秒观察期内同键只落一条",
  );
  check("AC4.4b", scenarioC.counts.badJsonLines === 0, scenarioC.counts.badJsonLines, 0, "落盘行非法 JSON 数");
  check(
    "AC4.4c",
    cKeys.every(([, count]) => count <= 1),
    Object.fromEntries(cKeys),
    "所有 warn/error 键 <=1 条",
  );

  out.totalMs = Date.now() - startedAt;
  out.ok = assertions.every((item) => item.ok);
  out.assertions = assertions;
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

main().catch((err) => {
  console.log(
    JSON.stringify({
      ok: false,
      reason: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack).split("\n").slice(0, 4) : undefined,
      assertions,
    }),
  );
  process.exit(1);
});
