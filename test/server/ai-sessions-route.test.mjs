// GET/PATCH/DELETE /api/ai/sessions 的行为锁（TASK-V4-H §5.4 / AC2）。
//
// 配置路径一律用 MAGPIE_TERMINAL_CONFIG_PATH 指到临时目录：
// ai-sessions/ 跟着 stateDir() 走，绝不碰真的 ~/.config/magpie-terminal/。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir } from "node:fs/promises";
import { startServer } from "../../src/server/http.mjs";
import { CONFIG_PATH_ENV, stateDir } from "../../src/config/store.mjs";
import { createSessionStore } from "../../src/ai/sessions.mjs";

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

/** 临时配置 + 真服务，跑完都收掉。 */
async function withServer(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-ai-sessions-route-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(dir, "config.json");
  const port = await freePort();
  const handle = await startServer({ port, log: () => {} });
  try {
    return await fn({ port, handle, dir });
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await handle.close();
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
  }
}

function headers(handle) {
  return { "x-magpie-term-token": handle.token, "content-type": "application/json" };
}

test("GET /api/ai/sessions 未带 token → 403（与其它 /api 同一道门）", async () => {
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/sessions`);
    assert.equal(response.status, 403);
  });
});

test("GET /api/ai/sessions：空目录回 {sessions: []}，不报错", async () => {
  await withServer(async ({ port, handle }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/sessions`, { headers: headers(handle) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.sessions, []);
  });
});

test("会话落盘在 stateDir()/ai-sessions/ 下（不写进仓库）", async () => {
  await withServer(async ({ handle, dir }) => {
    const created = await handle.aiSessions.createSession({
      terminalId: "t1",
      terminalKind: "local",
      shell: "bash 5.2.37",
    });
    assert.equal(handle.aiSessions.dir(), path.join(dir, "ai-sessions"));
    assert.equal(stateDir(), dir);
    assert.ok(await handle.aiSessions.getSession(created.id));
  });
});

test("GET 列表只回摘要；GET 全文含 messages 与 steps（AC2 的还原依据）", async () => {
  await withServer(async ({ port, handle }) => {
    const store = handle.aiSessions;
    const created = await store.createSession({
      terminalId: "t7",
      terminalKind: "remote",
      shell: "ssh deploy@10.0.4.21",
      hostId: "h-abc",
      hostName: "prod-web-01",
      hostAddr: "10.0.4.21",
    });
    await store.appendMessage(created.id, { role: "user", text: "看看 nginx 日志", round: 1 });
    await store.appendMessage(created.id, { role: "assistant", text: "最近 30 分钟有 3 条 502", round: 1 });
    await store.upsertStep(created.id, {
      stepId: "st1",
      command: "tail -n 50 /var/log/nginx/error.log",
      decision: "auto",
      status: "done",
      output: "upstream timed out",
      round: 1,
    });

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/ai/sessions?current=${created.id}`, {
      headers: headers(handle),
    });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.sessions.length, 1);
    const item = list.sessions[0];
    assert.equal(item.id, created.id);
    assert.equal(item.title, "看看 nginx 日志");
    assert.equal(item.terminalKind, "remote");
    assert.equal(item.hostName, "prod-web-01");
    assert.equal(item.hostAddr, "10.0.4.21");
    assert.equal(item.shell, "ssh deploy@10.0.4.21");
    assert.equal(item.messageCount, 2);
    assert.equal(item.current, true, "current 标记来自 ?current=");
    assert.equal(item.messages, undefined, "列表不许返回全文");
    assert.equal(item.steps, undefined);

    const fullResponse = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${created.id}`, {
      headers: headers(handle),
    });
    assert.equal(fullResponse.status, 200);
    const full = await fullResponse.json();
    assert.equal(full.messages.length, 2);
    assert.equal(full.steps.length, 1);
    assert.equal(full.steps[0].command, "tail -n 50 /var/log/nginx/error.log");
    assert.equal(full.steps[0].status, "done");
    assert.equal(full.steps[0].output, "upstream timed out");
  });
});

test("GET /api/ai/sessions/:id 未知 id → 404 SESSION_NOT_FOUND", async () => {
  await withServer(async ({ port, handle }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/s-nope`, {
      headers: headers(handle),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "SESSION_NOT_FOUND");
  });
});

test("PATCH /api/ai/sessions/:id 改标题；空/超长 → 400 INVALID_TITLE", async () => {
  await withServer(async ({ port, handle }) => {
    const created = await handle.aiSessions.createSession({ terminalId: "t1" });
    const ok = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${created.id}`, {
      method: "PATCH",
      headers: headers(handle),
      body: JSON.stringify({ title: "修 PTY 尺寸同步" }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).title, "修 PTY 尺寸同步");
    assert.equal((await handle.aiSessions.getSession(created.id)).title, "修 PTY 尺寸同步");

    const empty = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${created.id}`, {
      method: "PATCH",
      headers: headers(handle),
      body: JSON.stringify({ title: "   " }),
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, "INVALID_TITLE");

    const long = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${created.id}`, {
      method: "PATCH",
      headers: headers(handle),
      body: JSON.stringify({ title: "x".repeat(81) }),
    });
    assert.equal(long.status, 400);
    assert.equal((await long.json()).code, "INVALID_TITLE");
  });
});

test("DELETE /api/ai/sessions/:id → 204，再 GET 就 404", async () => {
  await withServer(async ({ port, handle }) => {
    const created = await handle.aiSessions.createSession({ terminalId: "t1" });
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${created.id}`, {
      method: "DELETE",
      headers: headers(handle),
    });
    assert.equal(response.status, 204);
    const after = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${created.id}`, {
      headers: headers(handle),
    });
    assert.equal(after.status, 404);
  });
});

test("DELETE 正在跑的会话 → 409 SESSION_BUSY，文件留着", async () => {
  await withServer(async ({ port, handle }) => {
    const created = await handle.aiSessions.createSession({ terminalId: "t1" });
    handle.aiSessions.markBusy(created.id, true);
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${created.id}`, {
      method: "DELETE",
      headers: headers(handle),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "SESSION_BUSY");
    assert.ok(await handle.aiSessions.getSession(created.id), "忙会话不能被删");
    handle.aiSessions.markBusy(created.id, false);
  });
});

test("重启服务后 GET /api/ai/sessions 仍能列出会话，全文能还原 steps（AC2）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-ai-sessions-restart-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(dir, "config.json");
  let firstHandle = null;
  let secondHandle = null;
  try {
    const port1 = await freePort();
    firstHandle = await startServer({ port: port1, log: () => {} });
    const created = await firstHandle.aiSessions.createSession({
      terminalId: "pty-restart",
      terminalKind: "local",
      shell: "bash 5.2.37",
    });
    await firstHandle.aiSessions.appendMessage(created.id, {
      role: "user",
      text: "重启前问的问题",
      round: 1,
    });
    await firstHandle.aiSessions.upsertStep(created.id, {
      stepId: "st-restart",
      command: "uname -a",
      decision: "auto",
      status: "done",
      output: "MINGW64_NT-10.0",
      round: 1,
    });
    await firstHandle.aiSessions.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await firstHandle.close();
    firstHandle = null;

    // 第二个进程/实例：全新的 store 实例，只能靠磁盘。
    const port2 = await freePort();
    secondHandle = await startServer({ port: port2, log: () => {} });
    const list = await (
      await fetch(`http://127.0.0.1:${port2}/api/ai/sessions`, { headers: headers(secondHandle) })
    ).json();
    assert.equal(list.sessions.length, 1, "重启后会话必须还在");
    assert.equal(list.sessions[0].id, created.id);
    assert.equal(list.sessions[0].title, "重启前问的问题");

    const full = await (
      await fetch(`http://127.0.0.1:${port2}/api/ai/sessions/${created.id}`, {
        headers: headers(secondHandle),
      })
    ).json();
    assert.equal(full.steps.length, 1);
    assert.equal(full.steps[0].command, "uname -a");
    assert.equal(full.messages.length, 1);
  } finally {
    if (firstHandle) {
      await firstHandle.close().catch(() => {});
    }
    if (secondHandle) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await secondHandle.close().catch(() => {});
    }
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
  }
});

test("两个 store 实例对同一目录的写入不会写出半个文件（原子写）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-ai-sessions-two-"));
  const a = createSessionStore({ dir, log: () => {} });
  const b = createSessionStore({ dir, log: () => {} });
  const created = await a.createSession({ terminalId: "t1" });
  // 两个实例各写一次。写链是进程内的（同一 store 串行），跨 store 靠原子写保证
  // 不出现半个 JSON；Windows 上两个 rename 撞同一目标可能拿到 EPERM，
  // 那是平台语义（不是数据损坏）——这里断言的是「文件仍可解析」。
  await Promise.allSettled([
    a.appendMessage(created.id, { role: "user", text: "A1", round: 1 }),
    b.appendMessage(created.id, { role: "user", text: "B1", round: 1 }),
  ]);
  const back = await a.getSession(created.id);
  assert.ok(back, "文件必须还是合法 JSON");
  assert.ok(back.messages.length >= 1);
  const again = await b.getSession(created.id);
  assert.ok(again);
  // 目录里不该留下 .tmp（失败的 rename 会被清掉）。
  const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, [], `不该留下临时文件：${leftovers.join(",")}`);
});

test("非 GET/PATCH/DELETE 方法 → 405（不静默当成 404）", async () => {
  await withServer(async ({ port, handle }) => {
    const created = await handle.aiSessions.createSession({ terminalId: "t1" });
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${created.id}`, {
      method: "POST",
      headers: headers(handle),
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 405);
  });
});
