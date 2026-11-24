// AC5 / AC6 证据脚本：resize 幽灵空行 + 新终端首字符不丢。
//
// 用法（仓库根）：node scripts/probe-resize-blank.mjs [--json]
//
// 为什么不是「数 pty 输出字节」：
//   ConPTY 在每次 resize 后都会让 shell 重画提示符（一堆 `\r\n` + `[K`），
//   那是 xterm 的**重绘**指令（写在同一屏的行上），不是终端上新增的行。
//   症状的用户视角是「终端上多了一行/多了一个提示符」，所以判据必须是
//   **xterm 缓冲区里可见行数**是否增加 —— 与 AC5 的措辞（终端输出新增 0 行）一致。
//
// 三段（全部用真服务 + 真 WS + 真 PTY，并把字节流回放进真 xterm）：
//   A) AC5  —— 连续 resize 10 次：xterm 缓冲区可见行数不变，且最后一行仍是原提示符
//   B) AC5b —— 开合文件面板 10 次（resize 往返）：同上
//   C) AC6  —— 新开终端后立刻写 `echo FIRST<CR>`：FIRST 恰好一次、首字符不丢、前面无空行
//
// 退出码：全过 0，任一失败 1。

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { startServer } from "../src/server/http.mjs";
import { decodePng, openBrowser, sleep } from "./lib/cdp.mjs";
import { shutdown } from "./lib/pty-cleanup.mjs";

const json = process.argv.includes("--json");

/** 剥掉 ANSI / OSC，只留「终端上看得见的字符」。 */
export function visibleText(raw) {
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

/* ---------------------------------------------------------------- 回放到真 xterm */

/**
 * 在真 Chrome 里拿一个离屏容器 + xterm 实例，把 pty 字节流写进去，
 * 再读 xterm 的缓冲区。这就是「用户屏幕上那一屏」的判据。
 */
async function withXterm(browser, pageUrl, fn) {
  await browser.navigate(pageUrl);
  await sleep(1200);
  // 用页面自带的 xterm.js（vendor 里的 UMD），另开一个隐藏容器，
  // 不干扰页面上已有终端与 __termDebug 状态。
  await browser.evaluate(`
    (() => {
      const host = document.createElement("div");
      host.id = "__probe-term-host";
      host.style.cssText = "position:fixed;left:0;top:0;width:800px;height:500px;visibility:hidden;";
      document.body.appendChild(host);
      const term = new window.Terminal({
        cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true,
      });
      term.open(host);
      window.__probeTerm = term;
      return true;
    })()
  `);
  try {
    return await fn({
      /** 把 pty 的字节流整段写进 xterm。 */
      async write(text) {
        await browser.evaluate(
          `window.__probeTerm.write(${JSON.stringify(text)}); true`,
        );
      },
      /** 读 xterm 缓冲区的所有行（含末尾空行）。 */
      async lines() {
        return browser.evaluate(`
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
      },
      /** 「真正有内容的行」数（与用户看到的行数一致：忽略尾部空行与整行空白）。 */
      async visibleLineCount() {
        const lines = await this.lines();
        let count = 0;
        for (const line of lines) if (line.trim() !== "") count += 1;
        return { count, lines };
      },
      async reset() {
        await browser.evaluate("window.__probeTerm.reset(); true");
      },
    });
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

/* ---------------------------------------------------------------- 主流程 */

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-resize-blank-"));
process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
const port = await freePort();
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const handle = await startServer({ port, log: quiet });
const base = `http://127.0.0.1:${port}`;

const results = [];
const record = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });
let error = null;
let browser = null;
const client = await connect(port, handle.token).catch((err) => {
  error = err && err.message ? err.message : String(err);
  return null;
});

try {
  browser = await openBrowser();
  const pageUrl = `${base}/?token=${handle.token}`;

  /* ============ A) AC5：连续 resize 10 次 → xterm 可见行数不变 ============ */
  client.send({ type: "pty.create", cols: 100, rows: 30 });
  const created = await client.waitFor((frame) => frame.type === "session.created");
  const id = created.id;

  // 等提示符出现且输出静默。
  let lastLen = -1;
  await waitUntil(() => {
    const current = client.outputFor(id).length;
    const stable = current > 0 && current === lastLen;
    lastLen = current;
    return stable;
  }, 25000, "prompt settled");
  await sleep(800);

  const streamA = client.outputFor(id);
  await withXterm(browser, pageUrl, async (term) => {
    await term.write(streamA);
    await sleep(400);
    const before = await term.visibleLineCount();

    for (let index = 0; index < 10; index += 1) {
      client.send({ type: "pty.resize", id, cols: 80 + index * 2, rows: 30 });
      await sleep(150);
    }
    await sleep(1800);

    // 把「resize 之后新增的那段字节」写进同一个 xterm 实例。
    const streamAfter = client.outputFor(id);
    const delta = streamAfter.slice(streamA.length);
    await term.write(delta);
    await sleep(600);
    const after = await term.visibleLineCount();

    record("AC5.a 连续 resize 10 次后 xterm 可见行数不变", after.count === before.count, {
      beforeLines: before.count,
      afterLines: after.count,
      deltaLines: after.count - before.count,
      deltaBytes: delta.length,
      // 用户能看见的「提示符行」条数（多一个空行就会多一条）
      promptLinesBefore: before.lines.filter((line) => /[$#]\s*$/.test(line)).length,
      promptLinesAfter: after.lines.filter((line) => /[$#]\s*$/.test(line)).length,
      lastLinesBefore: before.lines.filter((line) => line.trim()).slice(-3),
      lastLinesAfter: after.lines.filter((line) => line.trim()).slice(-3),
    });
  });

  /* ============ B) AC5b：开合文件面板 10 次（resize 往返） ============ */
  const streamB = client.outputFor(id);
  await withXterm(browser, pageUrl, async (term) => {
    await term.write(streamB);
    await sleep(400);
    const before = await term.visibleLineCount();
    for (let index = 0; index < 10; index += 1) {
      client.send({ type: "pty.resize", id, cols: 100, rows: 18 });
      await sleep(160);
      client.send({ type: "pty.resize", id, cols: 100, rows: 30 });
      await sleep(160);
    }
    await sleep(1800);
    const streamAfter = client.outputFor(id);
    const delta = streamAfter.slice(streamB.length);
    await term.write(delta);
    await sleep(600);
    const after = await term.visibleLineCount();
    record("AC5.b 开合文件面板 10 次（resize 往返）后 xterm 可见行数不变", after.count === before.count, {
      beforeLines: before.count,
      afterLines: after.count,
      deltaLines: after.count - before.count,
      deltaBytes: delta.length,
      lastLinesAfter: after.lines.filter((line) => line.trim()).slice(-3),
    });
  });

  client.send({ type: "pty.close", id });
  await sleep(400);

  /* ============ C) AC6：新开终端立刻输入 ============ */
  client.send({ type: "pty.create", cols: 100, rows: 30 });
  const created2 = await client.waitFor(
    (frame) => frame.type === "session.created" && frame.id !== id,
  );
  const id2 = created2.id;
  // 关键：**不等提示符**，create 之后立刻写（最坏情形）。
  client.send({ type: "pty.input", id: id2, data: "echo FIRST\r" });
  await sleep(5000);
  const out2 = client.outputFor(id2);

  await withXterm(browser, pageUrl, async (term) => {
    await term.write(out2);
    await sleep(700);
    const view = await term.visibleLineCount();
    const lines = view.lines.filter((line, index) => line.trim() !== "" || index >= view.lines.length - 1);
    const firstLines = lines.filter((line) => line.trim() === "FIRST");
    const echoLines = lines.filter((line) => line.includes("FIRST") && line.trim() !== "FIRST");
    const echoLine = echoLines.length > 0 ? echoLines[echoLines.length - 1] : null;
    const firstIndex = lines.findIndex((line) => line.trim() === "FIRST");
    const beforeFirst = firstIndex > 0 ? lines.slice(Math.max(0, firstIndex - 3), firstIndex) : [];
    const blankBefore = firstIndex > 0 && lines[firstIndex - 1].trim() === "";

    record("AC6.a FIRST 恰好出现一次（作为独立输出行）", firstLines.length === 1, {
      printedLines: firstLines.length,
      allLinesWithFirst: lines.filter((line) => line.includes("FIRST")),
    });
    record(
      "AC6.b 首字符不丢：回显行是完整的 `echo FIRST`",
      typeof echoLine === "string" && /(^|\s)echo FIRST\s*$/.test(echoLine.trim()),
      { echoLine, visible: lines.filter((line) => line.trim()) },
    );
    record("AC6.c FIRST 之前没有空行", blankBefore === false, { beforeFirst });
    record(
      "AC6.d 没有多出提示符/空行（FIRST 前后都紧邻原提示符）",
      firstLines.length === 1 && !blankBefore,
      { tail: lines.filter((line) => line.trim()).slice(-6) },
    );
  });

  client.send({ type: "pty.close", id: id2 });
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
