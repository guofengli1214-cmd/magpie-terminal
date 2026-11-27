// 远程会话注册表的行为锁（TASK-V2-B §2.4）。
//
// **不打真网络**：openShell 换成假的（一个 EventEmitter + write/setWindow 记录），
// cwd 探测也换成假的。真连接留给验收 E5（本机 sshd）。
//
// 锁的事：
// - 方法签名与 SessionManager 对齐（create/write/resize/close/get/size）
// - 事件名对齐（session.created / pty.output / session.exited / session.failed）
// - 换行归一化：`\n` → `\r\n`，`\r\n` 不重复
// - 未知指纹 / 缺凭据 → session.failed，绝不自作主张连
// - close / 流关闭 → session.exited（前端掉标签）
// - 没记录指纹时绝不建连（防「自动接受未知指纹」）

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { RemoteRegistry, normalizeInput } from "../../src/ssh/registry.mjs";
import {
  CONFIG_PATH_ENV,
  addHost,
  rememberKnownHost,
  saveSecret,
} from "../../src/config/store.mjs";
import { fingerprintOf, keyAlgorithm, mapSshError } from "../../src/ssh/client.mjs";

let dir = "";
let restore = null;

async function boot() {
  dir = await mkdtemp(path.join(os.tmpdir(), "mt-ssh-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(dir, "config.json");
  restore = () => {
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
  };
}

/** 假 shell：记录写入与 resize，能手动 emit data / close。 */
function fakeShell() {
  const client = new EventEmitter();
  client.end = () => {
    client.ended = true;
    client.emit("close");
  };
  const stream = new EventEmitter();
  stream.written = [];
  stream.windows = [];
  stream.closed = false;
  stream.write = (data) => {
    stream.written.push(data);
    return true;
  };
  stream.setWindow = (rows, cols) => {
    stream.windows.push({ rows, cols });
  };
  stream.close = () => {
    stream.closed = true;
    stream.emit("close");
  };
  stream.stderr = new EventEmitter();
  return { client, stream, writes: () => stream.written.join("") };
}

/** 等一个事件（带超时，避免测试挂住）。 */
function once(emitter, name, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    emitter.once(name, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** 等条件成立（并行负载下别用固定 sleep）。 */
async function waitUntil(fn, timeoutMs = 2000, label = "") {
  const started = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待超时${label ? `：${label}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeHost({ port = 22, authType = "password", password = "pw" } = {}) {
  const host = await addHost({
    name: "probe-host",
    host: "127.0.0.1",
    port,
    username: "probe",
    authType,
  });
  if (authType === "password") await saveSecret(host.id, { password });
  await rememberKnownHost("127.0.0.1", port, "ssh-ed25519", "SHA256:trusted");
  return host;
}

test("远程注册表组", async (t) => {
  await boot();
  t.after(() => restore());

  await t.test("normalizeInput：\\n → \\r\\n，\\r\\n 不重复，裸 \\r 原样", () => {
    assert.equal(normalizeInput("echo hi\n"), "echo hi\r\n");
    assert.equal(normalizeInput("echo hi\r\n"), "echo hi\r\n");
    assert.equal(normalizeInput("a\rb"), "a\rb");
    assert.equal(normalizeInput("a\nb\nc"), "a\r\nb\r\nc");
    assert.equal(normalizeInput(""), "");
    assert.equal(normalizeInput(null), "");
  });

  await t.test("方法签名与 SessionManager 对齐（create/write/resize/close/get/size 都是函数）", () => {
    const registry = new RemoteRegistry();
    for (const name of ["create", "write", "resize", "close", "get"]) {
      assert.equal(typeof registry[name], "function", `missing ${name}`);
    }
    assert.equal(typeof registry.size, "number");
    assert.equal(registry.size, 0);
  });

  await t.test("成功路径：created 带 kind=remote/hostId/hostName/host；pty.output 透传", async () => {
    const host = await makeHost();
    const fake = fakeShell();
    const registry = new RemoteRegistry({
      openShell: async () => ({ client: fake.client, stream: fake.stream }),
      probeRemoteCwd: async () => "/home/probe",
    });
    const createdPromise = once(registry, "session.created");
    const stub = registry.create({ hostId: host.id, cols: 120, rows: 40 });
    assert.equal(typeof stub.id, "string");
    assert.equal(registry.size, 1);

    const created = await createdPromise;
    assert.equal(created.type, undefined, "created 帧由 ws 层补 type，registry 只给 payload");
    assert.equal(created.kind, "remote");
    assert.equal(created.hostId, host.id);
    assert.equal(created.hostName, "probe-host");
    assert.equal(created.host, "127.0.0.1");
    assert.equal(created.port, 22);
    assert.equal(created.username, "probe");
    assert.equal(created.cwd, "/home/probe");
    assert.equal(created.cols, 120);
    assert.equal(created.rows, 40);
    assert.equal(created.pty, "remote");

    const output = once(registry, "pty.output");
    fake.stream.emit("data", Buffer.from("hello from remote\r\n"));
    const frame = await output;
    assert.equal(frame.id, stub.id);
    assert.equal(frame.data, "hello from remote\r\n");
    assert.equal(registry.get(stub.id).recentOutput.includes("hello"), true);

    registry.close(stub.id);
    assert.equal(registry.size, 0);
  });

  await t.test("write 归一化 + 未连上时 write 返回 false（不吞输入也不崩）", async () => {
    const host = await makeHost();
    const fake = fakeShell();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const registry = new RemoteRegistry({
      openShell: async () => {
        await gate;
        return { client: fake.client, stream: fake.stream };
      },
      probeRemoteCwd: async () => "/srv",
    });
    const stub = registry.create({ hostId: host.id });
    // 还在建连：state=starting，write 必须安全失败。
    assert.equal(registry.write(stub.id, "x\n"), false);

    const createdPromise = once(registry, "session.created");
    release();
    await createdPromise;

    assert.equal(registry.write(stub.id, "echo REMOTE_OK\n"), true);
    assert.equal(fake.writes(), "echo REMOTE_OK\r\n");
    // 前端若发 \r\n 也不能变成 \r\r\n。
    registry.write(stub.id, "ls\r\n");
    assert.equal(fake.writes(), "echo REMOTE_OK\r\nls\r\n");
    registry.close(stub.id);
  });

  await t.test("resize 走 setWindow(rows, cols)（ssh2 的参数顺序）", async () => {
    const host = await makeHost();
    const fake = fakeShell();
    const registry = new RemoteRegistry({
      openShell: async () => ({ client: fake.client, stream: fake.stream }),
      probeRemoteCwd: async () => "/srv",
    });
    const createdPromise = once(registry, "session.created");
    const stub = registry.create({ hostId: host.id, cols: 80, rows: 24 });
    await createdPromise;

    assert.equal(registry.resize(stub.id, 132, 40), true);
    assert.deepEqual(fake.stream.windows, [{ rows: 40, cols: 132 }]);
    const session = registry.get(stub.id);
    assert.equal(session.cols, 132);
    assert.equal(session.rows, 40);
    // 尺寸没变 → 不发多余的 setWindow。
    assert.equal(registry.resize(stub.id, 132, 40), true);
    assert.equal(fake.stream.windows.length, 1);
    registry.close(stub.id);
  });

  await t.test("远端主动断开（stream close）→ session.exited，注册表清空", async () => {
    const host = await makeHost();
    const fake = fakeShell();
    const registry = new RemoteRegistry({
      openShell: async () => ({ client: fake.client, stream: fake.stream }),
      probeRemoteCwd: async () => "/srv",
    });
    const createdPromise = once(registry, "session.created");
    const stub = registry.create({ hostId: host.id });
    await createdPromise;

    const exited = once(registry, "session.exited");
    fake.stream.emit("close");
    const frame = await exited;
    assert.equal(frame.id, stub.id);
    assert.equal(registry.size, 0);
    assert.equal(registry.get(stub.id), null);
  });

  await t.test("client error → session.exited（断线掉标签），且只发一次", async () => {
    const host = await makeHost();
    const fake = fakeShell();
    const registry = new RemoteRegistry({
      openShell: async () => ({ client: fake.client, stream: fake.stream }),
      probeRemoteCwd: async () => "/srv",
    });
    const createdPromise = once(registry, "session.created");
    const stub = registry.create({ hostId: host.id });
    await createdPromise;

    const frames = [];
    registry.on("session.exited", (info) => frames.push(info));
    fake.client.emit("error", Object.assign(new Error("keepalive"), { code: "SSH_ERROR" }));
    fake.stream.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(frames.length, 1, "重复的退出信号只能产生一个 session.exited");
    assert.equal(frames[0].id, stub.id);
  });

  await t.test("未知指纹 → session.failed / UNKNOWN_HOST_KEY，且没有建连（openShell 未被调用）", async () => {
    const host = await addHost({
      name: "never-connected",
      host: "10.9.9.9",
      port: 22,
      username: "probe",
      authType: "password",
    });
    await saveSecret(host.id, { password: "pw" });
    let called = false;
    const registry = new RemoteRegistry({
      openShell: async () => {
        called = true;
        return fakeShell();
      },
    });
    const failed = once(registry, "session.failed");
    const stub = registry.create({ hostId: host.id });
    const frame = await failed;
    assert.equal(frame.id, stub.id);
    assert.equal(frame.code, "UNKNOWN_HOST_KEY");
    assert.equal(called, false, "没有已知指纹时绝不许建连");
    assert.equal(registry.size, 0);
  });

  await t.test("缺凭据（secrets 里没有这条）→ session.failed / SSH_SECRET_MISSING，不建连", async () => {
    const host = await addHost({
      name: "no-secret",
      host: "10.9.9.8",
      port: 22,
      username: "probe",
      authType: "password",
    });
    await rememberKnownHost("10.9.9.8", 22, "ssh-ed25519", "SHA256:trusted");
    let called = false;
    const registry = new RemoteRegistry({
      openShell: async () => {
        called = true;
        return fakeShell();
      },
    });
    const failed = once(registry, "session.failed");
    registry.create({ hostId: host.id });
    const frame = await failed;
    assert.equal(frame.code, "SSH_SECRET_MISSING");
    assert.equal(called, false);
  });

  await t.test("主机不存在 → session.failed / HOST_NOT_FOUND", async () => {
    const registry = new RemoteRegistry({});
    const failed = once(registry, "session.failed");
    registry.create({ hostId: "h-nope" });
    const frame = await failed;
    assert.equal(frame.code, "HOST_NOT_FOUND");
  });

  await t.test("建连后立刻 close：不 emit created，也不留会话，已开的连接必须关掉", async () => {
    const host = await makeHost();
    const fake = fakeShell();
    let release;
    let entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const registry = new RemoteRegistry({
      openShell: async () => {
        entered = true;
        await gate;
        return { client: fake.client, stream: fake.stream };
      },
      probeRemoteCwd: async () => "/srv",
    });
    const created = [];
    registry.on("session.created", (info) => created.push(info));
    const stub = registry.create({ hostId: host.id });
    // 等 openShell 真正进入（此时会话还没 created），再关标签 → 覆盖「建连中途关掉」这条路径。
    await waitUntil(() => entered === true, 2000, "openShell 进入");
    assert.equal(entered, true);
    registry.close(stub.id);
    release();
    await waitUntil(() => fake.client.ended === true && registry.size === 0, 2000, "close 生效并关掉连接");
    assert.equal(created.length, 0, "用户已经关掉标签，不能再冒出 session.created");
    assert.equal(fake.client.ended, true, "已建立的连接必须被关掉");
    assert.equal(registry.size, 0);
  });

  await t.test("OSC 7 接线：远端 OSC 7 → session.cwd 更新 + session.cwd 事件（POSIX / Windows / 负例 / 同值去重）", async () => {
    const host = await makeHost();
    const fake = fakeShell();
    const registry = new RemoteRegistry({
      openShell: async () => ({ client: fake.client, stream: fake.stream }),
      probeRemoteCwd: async () => "/home/probe",
    });
    const createdPromise = once(registry, "session.created");
    const stub = registry.create({ hostId: host.id });
    await createdPromise;

    const cwdFrames = [];
    registry.on("session.cwd", (info) => cwdFrames.push(info));

    // POSIX 远端：走真实数据通路（stream data → handleOutput → handleOsc7）。
    fake.stream.emit("data", Buffer.from("\x1b]7;file://probe-host/home/deploy/app\x07"));
    assert.equal(cwdFrames.length, 1, "OSC 7 必须触发一次 session.cwd");
    assert.deepEqual(cwdFrames[0], { id: stub.id, cwd: "/home/deploy/app" });
    assert.equal(registry.get(stub.id).cwd, "/home/deploy/app");

    // 同值去重：同一条路径再来一次，不许重复 emit。
    fake.stream.emit("data", Buffer.from("\x1b]7;file://probe-host/home/deploy/app\x07"));
    assert.equal(cwdFrames.length, 1, "同值不应重复 emit session.cwd");

    // Windows 远端：file://HOST/C:/Users/x → C:\Users\x
    fake.stream.emit("data", Buffer.from("\x1b]7;file://probe-host/C:/Users/x\x07"));
    assert.equal(cwdFrames.length, 2);
    assert.equal(cwdFrames[1].cwd, String.raw`C:\Users\x`);
    assert.equal(registry.get(stub.id).cwd, String.raw`C:\Users\x`);

    // 负例：不含 OSC 7 的普通输出 → cwd 不变，也不许多 emit。
    fake.stream.emit("data", Buffer.from("plain output\r\n"));
    assert.equal(cwdFrames.length, 2, "普通输出不应产生 session.cwd");
    assert.equal(registry.get(stub.id).cwd, String.raw`C:\Users\x`);

    registry.close(stub.id);
  });

  await t.test("killAllSync 清空会话（进程退出用）", async () => {
    const host = await makeHost();
    const fake = fakeShell();
    const registry = new RemoteRegistry({
      openShell: async () => ({ client: fake.client, stream: fake.stream }),
      probeRemoteCwd: async () => "/srv",
    });
    const createdPromise = once(registry, "session.created");
    registry.create({ hostId: host.id });
    await createdPromise;
    assert.equal(registry.size, 1);
    registry.killAllSync();
    assert.equal(registry.size, 0);
  });
});

test("ssh client 纯函数组", async (t) => {
  await t.test("keyAlgorithm / fingerprintOf：与 ssh-keyscan 风格一致（SHA256:base64 无 padding）", () => {
    // 手工构造一个 ssh-ed25519 公钥 blob 的前缀（真实 key 的算法字段就是这个）。
    const name = Buffer.from("ssh-ed25519", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(name.length, 0);
    const blob = Buffer.concat([header, name, Buffer.alloc(32, 7)]);
    assert.equal(keyAlgorithm(blob), "ssh-ed25519");
    const fp = fingerprintOf(blob);
    assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
    assert.equal(fp.includes("="), false);
  });

  await t.test("keyAlgorithm 对垃圾输入返回 unknown（不抛）", () => {
    assert.equal(keyAlgorithm(null), "unknown");
    assert.equal(keyAlgorithm(Buffer.alloc(2)), "unknown");
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(9999, 0);
    assert.equal(keyAlgorithm(bad), "unknown");
  });

  await t.test("mapSshError：认证失败 / 超时 / socket 都映射成本项目 code", () => {
    assert.equal(mapSshError({ level: "client-authentication" }).code, "SSH_AUTH_FAILED");
    assert.equal(mapSshError({ level: "client-timeout" }).code, "SSH_CONNECT_TIMEOUT");
    assert.equal(mapSshError({ level: "client-socket" }).code, "SSH_CONNECT_FAILED");
    assert.equal(mapSshError({ code: "ENOTFOUND" }).code, "SSH_HOST_NOT_FOUND");
    assert.equal(mapSshError({ code: "ECONNREFUSED" }).code, "SSH_CONNECT_REFUSED");
    assert.equal(mapSshError({ code: "ETIMEDOUT" }).code, "SSH_CONNECT_TIMEOUT");
    assert.equal(mapSshError(new Error("weird")).code, "SSH_CONNECT_FAILED");
    // 已经是本项目错误形状的原样返回。
    const own = Object.assign(new Error("x"), { code: "HOST_KEY_MISMATCH", userText: "指纹不匹配" });
    assert.equal(mapSshError(own), own);
    // userText 永远不含原始 message（可能带路径/用户名）。
    assert.equal(mapSshError({ level: "client-authentication", message: "/home/x" }).userText.includes("/home/x"), false);
  });
});
