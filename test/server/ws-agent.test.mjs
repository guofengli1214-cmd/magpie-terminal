// WS 帧接线锁（TASK-V3-D §6.9 / PROTOCOL-AGENT.md §3）。
//
// 只验「帧能进得来、分发到对的地方」：
//   - agent.run 没有可用会话 → agent.error{code:"NO_SESSION"}
//   - agent.approve 未知 approvalId → 不崩、不断线
//   - agent.stop 没有任务 → 不崩、不断线
//   - 字段不合法 → 仍然是 BAD_FRAME（旧行为）
//
// 这里不打真网关：正常路径已经由 test/ai/agent.test.mjs 用假 generateText 覆盖。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { startServer } from "../../src/server/http.mjs";
// Node 20 没有全局 WebSocket（22 才有），用 ws 包提供的实现，接口兼容。
import { WebSocket } from "ws";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-wsagent-"));
  const previous = process.env.MAGPIE_TERMINAL_CONFIG_PATH;
  process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
  const port = await freePort();
  const handle = await startServer({ port, log: () => {} });
  try {
    return await fn({ port, handle });
  } finally {
    // TASK-V4-F-FIX1 §4：客户端 ws.close() 之后立刻 handle.close()（内部 client.terminate()）
    // 在 Windows/node24 上会偶发 libuv 断言
    //   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`
    // （基线老问题，服务端 4 种改法都拦不住）。这里给正在关闭的 socket 留一点
    // 收尾时间，再关服务。只是测试侧时序缓解，不改产品语义。
    await new Promise((resolve) => setTimeout(resolve, 80));
    await handle.close();
    if (previous === undefined) delete process.env.MAGPIE_TERMINAL_CONFIG_PATH;
    else process.env.MAGPIE_TERMINAL_CONFIG_PATH = previous;
  }
}

/** 连一条 WS，按需要发帧，收集所有回来的帧。 */
function connect(port, token) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/ws?token=${token}`;
    const ws = new WebSocket(url);
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
        ws,
        frames,
        send: (frame) => ws.send(JSON.stringify(frame)),
        waitFor(predicate, timeoutMs = 2000) {
          const existing = frames.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`timeout: ${frames.map((f) => f.type).join(",")}`)), timeoutMs);
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

test("agent.run 没有可用会话 → agent.error{code:NO_SESSION}", async () => {
  await withServer(async ({ port, handle }) => {
    const client = await connect(port, handle.token);
    try {
      client.send({ type: "agent.run", requestId: "r1", question: "看看有几个文件" });
      const frame = await client.waitFor((f) => f.type === "agent.error");
      assert.equal(frame.code, "NO_SESSION");
      assert.equal(frame.requestId, "r1");
      assert.equal(typeof frame.userText, "string");
    } finally {
      client.close();
    }
  });
});

test("agent.approve 未知 approvalId → 不崩、不断线", async () => {
  await withServer(async ({ port, handle }) => {
    const client = await connect(port, handle.token);
    try {
      client.send({ type: "agent.approve", requestId: "r1", approvalId: "nope", approved: true });
      // 用一条正常的 pty 帧证明连接还活着。
      client.send({ type: "pty.attach", id: "no-such-session" });
      const frame = await client.waitFor((f) => f.type === "pty.error");
      assert.equal(frame.code, "SESSION_GONE");
    } finally {
      client.close();
    }
  });
});

test("agent.stop 没有任务 → 安静忽略，不断线", async () => {
  await withServer(async ({ port, handle }) => {
    const client = await connect(port, handle.token);
    try {
      client.send({ type: "agent.stop", requestId: "r1" });
      client.send({ type: "pty.attach", id: "no-such-session" });
      const frame = await client.waitFor((f) => f.type === "pty.error");
      assert.equal(frame.code, "SESSION_GONE");
    } finally {
      client.close();
    }
  });
});

test("agent.run 缺 question → 仍然是 BAD_FRAME（zod 联合拒绝）", async () => {
  await withServer(async ({ port, handle }) => {
    const client = await connect(port, handle.token);
    try {
      client.send({ type: "agent.run", requestId: "r1" });
      const frame = await client.waitFor((f) => f.type === "pty.error");
      assert.equal(frame.code, "BAD_FRAME");
    } finally {
      client.close();
    }
  });
});

test("agent.approve 的 scope 只接受 once / rest", async () => {
  await withServer(async ({ port, handle }) => {
    const client = await connect(port, handle.token);
    try {
      client.send({ type: "agent.approve", requestId: "r1", approvalId: "x", approved: true, scope: "always" });
      const frame = await client.waitFor((f) => f.type === "pty.error");
      assert.equal(frame.code, "BAD_FRAME");
    } finally {
      client.close();
    }
  });
});
