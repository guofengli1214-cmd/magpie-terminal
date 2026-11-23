// pty.create 的 shellId 行为锁（TASK-V4-F §5.2 / AC2 / AC4 / AC5）。
//
// 只验帧接线与 shell 归属：真 shell 的版本号已由 test/pty/shells.test.mjs 与
// 现场探针（.dispatch/v4f-probe）覆盖，这里不再重复起三个 shell。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { startServer } from "../../src/server/http.mjs";
import { loadNodePty } from "../../src/pty/bridge.mjs";

const ptyLoad = loadNodePty();
const skipReason = ptyLoad.ok ? null : `node-pty unavailable: ${ptyLoad.reason}`;

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

async function withServer(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-pty-shell-"));
  const previous = process.env.MAGPIE_TERMINAL_CONFIG_PATH;
  process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
  const port = await freePort();
  const handle = await startServer({ port, log: () => {} });
  try {
    return await fn({ port, handle });
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env.MAGPIE_TERMINAL_CONFIG_PATH;
    else process.env.MAGPIE_TERMINAL_CONFIG_PATH = previous;
  }
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
      for (const waiter of [...waiters]) {
        if (waiter.predicate(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
    ws.addEventListener("error", reject);
    ws.addEventListener("open", () =>
      resolve({
        frames,
        send: (frame) => ws.send(JSON.stringify(frame)),
        waitFor(predicate, timeoutMs = 10000) {
          const existing = frames.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error(`timeout: ${frames.map((f) => f.type).join(",")}`)),
              timeoutMs,
            );
            waiters.push({
              predicate,
              resolve: (frame) => {
                clearTimeout(timer);
                res(frame);
              },
            });
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

// skip 只应在 node-pty 不可用时传；传 null 会被 node:test 当成「跳过」。
const ptyTestOptions = skipReason ? { skip: skipReason } : {};

test("pty.create 组", ptyTestOptions, async (t) => {
  await t.test("shellId:'zsh' → session.failed / PTY_UNKNOWN_SHELL，服务不崩", async () => {
    await withServer(async ({ port, handle }) => {
      const client = await connect(port, handle.token);
      try {
        client.send({ type: "pty.create", cols: 90, rows: 28, shellId: "zsh" });
        const failed = await client.waitFor((f) => f.type === "session.failed");
        assert.equal(failed.code, "PTY_UNKNOWN_SHELL");
        assert.equal(typeof failed.userText, "string");
        assert.equal(handle.sessions.size, 0);
        // 服务仍在，且还能正常建会话。
        const created = await (async () => {
          client.send({ type: "pty.create", cols: 90, rows: 28 });
          return client.waitFor((f) => f.type === "session.created");
        })();
        assert.equal(created.kind, "local");
        assert.match(created.shell.name, /bash/i);
      } finally {
        client.close();
      }
    });
  });

  await t.test("shellId:'powershell' → session.created.shell 是该会话真实 shell", async () => {
    await withServer(async ({ port, handle }) => {
      const client = await connect(port, handle.token);
      try {
        client.send({ type: "pty.create", cols: 90, rows: 28, shellId: "powershell" });
        const created = await client.waitFor((f) => f.type === "session.created");
        assert.match(created.shell.name, /PowerShell/i);
        assert.match(created.shell.version, /^5\.1\./);
        // 契约：session.created 既有字段一个不少。
        assert.equal(created.kind, "local");
        assert.equal(typeof created.cwd, "string");
        assert.equal(created.pty, "native");
        assert.equal(created.cols, 90);
        assert.equal(created.rows, 28);
      } finally {
        client.close();
      }
    });
  });

  await t.test("不带 shellId 时保持旧行为（bash，回归）", async () => {
    await withServer(async ({ port, handle }) => {
      const client = await connect(port, handle.token);
      try {
        client.send({ type: "pty.create", cols: 90, rows: 28 });
        const created = await client.waitFor((f) => f.type === "session.created");
        assert.match(created.shell.name, /bash/i);
      } finally {
        client.close();
      }
    });
  });
});
