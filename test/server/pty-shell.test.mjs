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

  // ---- TASK-FIX17-A AC2：新发现的 id 也能建会话、echo 能回显 ----
  await t.test("shellId:'cmd' → session.created + echo 回显（AC2）", async () => {
    await withServer(async ({ port, handle }) => {
      const client = await connect(port, handle.token);
      try {
        client.send({ type: "pty.create", cols: 90, rows: 28, shellId: "cmd" });
        const created = await client.waitFor((f) => f.type === "session.created");
        assert.equal(created.kind, "local");
        assert.match(created.shell.name, /cmd/i);
        assert.equal(created.pty, "native");

        // cmd 的换行是 \r\n；用 \r\n 提交才能确保回车被 cmd 认到。
        // 注意：cmd 不展开 $() / $x（那是 bash 语法），这里用纯字面量验证回显。
        client.send({ type: "pty.input", id: created.id, data: "echo CMD_OK_123\r\n" });
        const started = Date.now();
        let output = "";
        let hits = 0;
        // 回显 + 执行结果都要有：`CMD_OK_123` 至少出现两次。
        // 注意：必须等「第二次」到位才退循环（只看 includes 会在回显那一瞬就退出）。
        while (Date.now() - started < 12000) {
          output = client.frames
            .filter((f) => f.type === "pty.output" && f.id === created.id)
            .map((f) => f.data)
            .join("");
          hits = (output.match(/CMD_OK_123/g) || []).length;
          if (hits >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(hits >= 2, `cmd 没回显（命中 ${hits} 次）: ${JSON.stringify(output.slice(-400))}`);
      } finally {
        client.close();
      }
    });
  });

  await t.test("shellId:'wsl:<发行版>' → session.created + echo 回显（本机无发行版时跳过）", async () => {
    const { detectShells } = await import("../../src/pty/shells.mjs");
    const wslItem = detectShells().find(
      (item) => item.group === "wsl" && item.available && /^wsl:[A-Za-z0-9._-]+$/.test(item.id),
    );
    if (!wslItem) {
      // 没有 WSL 发行版时，「wsl:* 能建会话」就无法真验；但要明确报出来而不是静默跳过。
      console.log("（本机没有可用的 WSL 发行版，wsl:* 建会话断言跳过）");
      return;
    }
    await withServer(async ({ port, handle }) => {
      const client = await connect(port, handle.token);
      try {
        client.send({ type: "pty.create", cols: 90, rows: 28, shellId: wslItem.id });
        const created = await client.waitFor((f) => f.type === "session.created");
        assert.equal(created.kind, "local");
        assert.match(created.shell.name, /WSL/);
        assert.equal(created.pty, "native");

        client.send({ type: "pty.input", id: created.id, data: "echo WSL_$(echo 1)$(echo 2)\r" });
        const started = Date.now();
        let output = "";
        while (Date.now() - started < 30000) {
          output = client.frames
            .filter((f) => f.type === "pty.output" && f.id === created.id)
            .map((f) => f.data)
            .join("");
          if (output.includes("WSL_12")) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        assert.match(output, /WSL_12/, `wsl 没回显: ${JSON.stringify(output.slice(-400))}`);
      } finally {
        client.close();
      }
    });
  }, { timeout: 90000 });

  // ---- TASK-FIX17-A AC3：非法 id 不能落在 BAD_FRAME 上，必须是 PTY_UNKNOWN_SHELL ----
  await t.test("shellId:'nope:' → session.failed / PTY_UNKNOWN_SHELL（不是 BAD_FRAME）", async () => {
    await withServer(async ({ port, handle }) => {
      const client = await connect(port, handle.token);
      try {
        client.send({ type: "pty.create", cols: 90, rows: 28, shellId: "nope:" });
        const failed = await client.waitFor(
          (f) => f.type === "session.failed" || f.type === "pty.error",
        );
        assert.equal(failed.type, "session.failed", `不该是 ${failed.type}（BAD_FRAME 会让前端显示协议错误）`);
        assert.equal(failed.code, "PTY_UNKNOWN_SHELL");
        assert.equal(handle.sessions.size, 0);
      } finally {
        client.close();
      }
    });
  });

  // ---- TASK-FIX17-A AC3 的另一半：64 字符内的 id 不该被 zod 打成 BAD_FRAME ----
  await t.test("shellId 长度 33–64（旧上限 32 会 BAD_FRAME）→ 仍是 PTY_UNKNOWN_SHELL", async () => {
    await withServer(async ({ port, handle }) => {
      const client = await connect(port, handle.token);
      try {
        const longId = `wsl:${"x".repeat(40)}`; // 44 字符：旧 max(32) 会被拒成 BAD_FRAME
        assert.equal(longId.length > 32 && longId.length <= 64, true);
        client.send({ type: "pty.create", cols: 90, rows: 28, shellId: longId });
        const failed = await client.waitFor(
          (f) => f.type === "session.failed" || f.type === "pty.error",
        );
        assert.equal(failed.type, "session.failed", "33–64 字符的 id 必须过帧校验");
        assert.equal(failed.code, "PTY_UNKNOWN_SHELL");
      } finally {
        client.close();
      }
    });
  });

  await t.test("shellId 超过 64 字符 → zod 拒帧但连接不断（BAD_FRAME）", async () => {
    await withServer(async ({ port, handle }) => {
      const client = await connect(port, handle.token);
      try {
        client.send({ type: "pty.create", cols: 90, rows: 28, shellId: "x".repeat(65) });
        const rejected = await client.waitFor((f) => f.type === "pty.error");
        assert.equal(rejected.code, "BAD_FRAME");
        // 连接必须仍然可用：再建一个正常会话。
        client.send({ type: "pty.create", cols: 90, rows: 28 });
        const created = await client.waitFor((f) => f.type === "session.created");
        assert.match(created.shell.name, /bash/i);
      } finally {
        client.close();
      }
    });
  });
});
