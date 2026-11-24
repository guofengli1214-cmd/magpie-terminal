// AC7 证据脚本：AI 执行一条 `echo AI`，终端输出里该命令之前**没有空行**。
//
// 用法（仓库根）：node scripts/probe-ai-blank.mjs [--json]
//
// 做法（不依赖真 LLM）：起真服务 + 真 WS + 真 bash PTY，直接用仓库自己的
// createCommandRunner（与 ws.mjs 里的 AI 执行路径同一个执行器）跑 `echo AI`，
// 然后把这一段 pty 字节流回放进真 xterm，读缓冲区判断「命令块之前有没有空行」。
//
// 对照组：同一段流程用旧包装串（`printf '\n%s\n'`）跑一遍，证明探针能测出空行。

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { startServer } from "../src/server/http.mjs";
import { createCommandRunner } from "../src/ai/runner.mjs";
import { openBrowser, sleep } from "./lib/cdp.mjs";
import { shutdown } from "./lib/pty-cleanup.mjs";

const json = process.argv.includes("--json");

function visibleText(raw) {
  return String(raw || "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

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

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const frames = [];
    const waiters = [];
    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      frames.push(frame);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter.predicate(frame)) {
          waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
    ws.addEventListener("open", () =>
      resolve({
        frames,
        send: (frame) => ws.send(JSON.stringify(frame)),
        waitFor(predicate, timeoutMs = 20000) {
          const existing = frames.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error(`waitFor timeout after ${timeoutMs}ms`)),
              timeoutMs,
            );
            waiters.push({ predicate, resolve: res, timer });
          });
        },
        outputFor(id) {
          return frames
            .filter((frame) => frame.type === "pty.output" && (!id || frame.id === id))
            .map((frame) => frame.data)
            .join("");
        },
        close: () => ws.close(),
      }),
    );
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    await sleep(50);
  }
}

/** 在真 Chrome 里把一段 pty 字节流回放进 xterm，返回可见行。 */
async function renderLines(browser, pageUrl, stream) {
  await browser.navigate(pageUrl);
  await sleep(1200);
  await browser.evaluate(`
    (() => {
      const host = document.createElement("div");
      host.id = "__probe-term-host";
      host.style.cssText = "position:fixed;left:0;top:0;width:800px;height:500px;visibility:hidden;";
      document.body.appendChild(host);
      const term = new window.Terminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
      term.open(host);
      window.__probeTerm = term;
      return true;
    })()
  `);
  try {
    await browser.evaluate(`window.__probeTerm.write(${JSON.stringify(stream)}); true`);
    await sleep(700);
    return await browser.evaluate(`
      (() => {
        const buffer = window.__probeTerm.buffer.active;
        const out = [];
        for (let i = 0; i < buffer.length; i += 1) {
          const line = buffer.getLine(i);
          out.push(line ? line.translateToString(true) : "");
        }
        return out;
      })()
    `);
  } finally {
    await browser.evaluate(`
      (() => {
        try { window.__probeTerm && window.__probeTerm.dispose(); } catch {}
        const host = document.querySelector("#__probe-term-host");
        if (host) host.remove();
        return true;
      })()
    `);
  }
}

/**
 * 判断「命令块之前有没有空行」：找到 echo AI 的命令行，看它上面那行是否为空。
 * 只看**用户可见**的痕迹 —— AI 写入的 `printf …startMark` 是作为命令行出现的。
 */
function analyze(lines, marker) {
  const visible = lines.filter((line, index) => line.trim() !== "" || index < 3);
  const idx = visible.findIndex((line) => line.includes("echo AI"));
  const startIdx = visible.findIndex((line) => line.includes(marker));
  const promptIdx = visible.findIndex((line) => /echo AI/.test(line));
  const before = promptIdx > 0 ? visible.slice(Math.max(0, promptIdx - 3), promptIdx) : [];
  return {
    echoAiLine: idx >= 0 ? visible[idx] : null,
    startMarkLineIndex: startIdx,
    linesBeforeCommand: before,
    blankLineBeforeCommand: promptIdx > 0 && visible[promptIdx - 1].trim() === "",
    visible: visible.filter((line) => line.trim() !== "").slice(0, 14),
  };
}

/* ---------------------------------------------------------------- 主流程 */

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-ai-blank-"));
process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
const port = await freePort();
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const handle = await startServer({ port, log: quiet });
const base = `http://127.0.0.1:${port}`;

const results = [];
const record = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });
let error = null;
let browser = null;
let client = null;

try {
  client = await connect(port, handle.token);
  browser = await openBrowser();
  const pageUrl = `${base}/?token=${handle.token}`;

  // 真会话（bash）。
  client.send({ type: "pty.create", cols: 100, rows: 30 });
  const created = await client.waitFor((frame) => frame.type === "session.created");
  const id = created.id;
  let lastLen = -1;
  await waitUntil(() => {
    const current = client.outputFor(id).length;
    const stable = current > 0 && current === lastLen;
    lastLen = current;
    return stable;
  }, 25000, "prompt settled");
  await sleep(800);

  // createCommandRunner 的 registry 接口：run 时需要 get/write/on/off。
  const registry = {
    get: (sessionId) => (sessionId === id ? handle.sessions.get(id) : null),
    write: (sessionId, data) => handle.sessions.write(sessionId, data),
    on: (event, handler) => handle.sessions.on(event, handler),
    off: (event, handler) => handle.sessions.off(event, handler),
  };
  const runner = createCommandRunner({
    sessions: registry,
    quietMs: 200,
    minWaitMs: 100,
    timeoutMs: 20000,
    quietFactor: 1,
    tailGraceMs: 120,
  });
  runner.setSessionResolver((sessionId) => (sessionId === id ? "local" : null));
  runner.setShellNameResolver((sessionId) => (sessionId === id ? "bash" : null));

  const beforeRun = client.outputFor(id);
  const runResult = await runner.run({ sessionId: id, command: "echo AI" });
  await sleep(600);
  const afterRun = client.outputFor(id);
  const stream = afterRun.slice(beforeRun.length);
  runner.dispose(id);

  const lines = await renderLines(browser, pageUrl, afterRun);
  const marks = /__MT_S_[0-9a-f]+__/.exec(afterRun);
  const analysis = analyze(lines, marks ? marks[0] : "__MT_S_");

  record("AC7.a 命令执行成功（runner 拿到 AI 输出）", runResult && runResult.ok === true && /AI/.test(runResult.output || ""), {
    ok: runResult && runResult.ok,
    exitCode: runResult && runResult.exitCode,
    output: runResult && runResult.output,
  });
  record(
    "AC7.b 终端里该命令之前没有空行",
    analysis.blankLineBeforeCommand === false,
    { linesBeforeCommand: analysis.linesBeforeCommand, echoAiLine: analysis.echoAiLine },
  );
  record("AC7.c 终端里看得见 AI 输出行（不只是一堆标记）", analysis.visible.some((line) => line.trim() === "AI"), {
    visible: analysis.visible,
  });

  // 负对照：证明探针确实能测出空行。
  // 空行出在**命令输出**上：`printf '\n%s\n'` 先往 stdout 吐一个换行，
  // 所以 startMark 行上方多一条空行。必须真的在 PTY 里执行才能看到。
  // 做法：新包装串与旧包装串各跑一次（同一个终端、同一段流程），比较
  // 「startMark 行上面还紧邻什么」。
  async function runInline(label, payload) {
    const before = client.outputFor(id);
    handle.sessions.write(id, payload);
    await waitUntil(
      () => client.outputFor(id).includes(`__MT_${label}_E_1__`),
      20000,
      `${label} payload done`,
    );
    await sleep(600);
    const after = client.outputFor(id);
    const lines = await renderLines(browser, pageUrl, after.slice(before.length));
    const startIndex = lines.findIndex((line) => line.trim() === `__MT_${label}_S_1__`);
    const lineBeforeStart = startIndex > 0 ? lines[startIndex - 1] : null;
    return {
      startIndex,
      lineBeforeStart,
      blankLineBeforeStart: startIndex > 0 && lines[startIndex - 1].trim() === "",
      visible: lines.filter((line) => line.trim() !== "").slice(0, 12),
    };
  }

  const oldResult = await runInline(
    "OLD",
    "printf '\\n%s\\n' '__MT_OLD_S_1__'; ( echo OLDCTRL\n ) 2>&1; printf '__MT_OLD_E_1__%s\\n' \"$?\"\n",
  );
  const newResult = await runInline(
    "NEW",
    "printf '%s\\n' '__MT_NEW_S_1__'; ( echo NEWCTRL\n ) 2>&1; printf '__MT_NEW_E_1__%s\\n' \"$?\"\n",
  );
  record(
    "AC7.d 负对照：旧包装串（前导 \\n）的 startMark 上方确实多一条空行，新包装串没有",
    oldResult.blankLineBeforeStart === true && newResult.blankLineBeforeStart === false,
    { oldResult, newResult },
  );

  client.send({ type: "pty.close", id });
} catch (err) {
  error = err && err.message ? err.message : String(err);
} finally {
  if (client) client.close();
  if (browser) await browser.close();
  // 必须等 ConPTY 真正释放 console 再退进程（见 scripts/lib/pty-cleanup.mjs）。
  await shutdown(handle);
}

const failed = results.filter((item) => !item.pass);
if (json) {
  console.log(JSON.stringify({ results, error }, null, 2));
} else {
  for (const item of results) {
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}`);
    console.log(`      ${JSON.stringify(item.detail)}`);
  }
  if (error) console.log(`ERROR ${error}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
}

process.exit(error || failed.length > 0 ? 1 : 0);
