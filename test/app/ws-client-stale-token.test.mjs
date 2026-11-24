// TASK-FIX-RECONNECT O2：连续 3 次连不上时用旧口令探 /api/health。
//
// 真实浏览器里最难测的是「宿主重启 → 旧 token 403 → 自动刷新一次」。
// 这里把 fetch / location / reload 全部注入成假的，锁住四条边界：
//   403 + 没刷新过 → 只刷一次，URL 带 mt_token_reload=1；
//   200 → 不刷新；
//   探测抛错 → 不刷新，而且下一次失败仍会继续探（inFlight 必须在 finally 复位）；
//   403 / 已带标记 → 绝不刷新，改为上报 staleToken:true。
import test from "node:test";
import assert from "node:assert/strict";

import createWsClient, {
  RELOAD_AFTER_FAILURES,
  STALE_TOKEN_MARK,
  shouldProbeStaleToken,
} from "../../app/core/ws-client.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeLocation(search = "") {
  return {
    href: `http://127.0.0.1:3795/${search}`,
    search,
    replaceCalls: [],
    replace(url) {
      this.replaceCalls.push(url);
    },
  };
}

function installFakeWebSocket() {
  const sockets = [];
  const original = globalThis.WebSocket;
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    emit(type) {
      if (type === "close") this.readyState = 3;
      for (const fn of this.listeners.get(type) || []) fn({});
    }

    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  return {
    sockets,
    restore() {
      globalThis.WebSocket = original;
    },
  };
}

async function waitFor(predicate, label, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(20);
  }
}

/**
 * 让客户端连续断线 count 次，触发第 count 次 scheduleReconnect。
 * 前两次要等指数退避定时器建出新 socket（500ms / 1000ms），测试容忍这点真实时间。
 */
async function dropConnectionNTimes(sockets, count) {
  for (let i = 0; i < count; i += 1) {
    const current = await waitFor(() => sockets[sockets.length - 1], "socket");
    current.emit("close");
    if (i < count - 1) {
      const before = sockets.length;
      await waitFor(() => sockets.length > before, "next socket");
    }
  }
}

function setup(t, options) {
  const ws = installFakeWebSocket();
  const statuses = [];
  const client = createWsClient({
    port: 3795,
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  t.after(() => {
    client.close();
    ws.restore();
  });
  client.connect();
  return { client, sockets: ws.sockets, statuses };
}

test("shouldProbeStaleToken：第 3 次失败才探，marked / inFlight 的优先级正确", () => {
  assert.equal(shouldProbeStaleToken(2, {}), "none");
  assert.equal(shouldProbeStaleToken(3, {}), "probe");
  assert.equal(shouldProbeStaleToken(3, { inFlight: true }), "none");
  assert.equal(shouldProbeStaleToken(3, { marked: true }), "mark-and-report");
  assert.equal(shouldProbeStaleToken(9, {}), "probe");
  // marked 优先于 inFlight：刷新过的页面必须持续提示，不能因探测在途而沉默。
  assert.equal(shouldProbeStaleToken(3, { marked: true, inFlight: true }), "mark-and-report");
  // 常量与文案约定位保持一致（第 3 次失败 + URL 标记名）。
  assert.equal(RELOAD_AFTER_FAILURES, 3);
  assert.equal(STALE_TOKEN_MARK, "mt_token_reload");
});

test("旧口令 403 且 URL 没标记：调用一次 location.replace，URL 带 mt_token_reload=1", async (t) => {
  const locationRef = fakeLocation("?foo=1");
  const fetchCalls = [];
  const { sockets } = setup(t, {
    locationRef,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return { status: 403 };
    },
  });

  await dropConnectionNTimes(sockets, RELOAD_AFTER_FAILURES);
  await waitFor(() => locationRef.replaceCalls.length === 1, "location.replace");

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /^http:\/\/127\.0\.0\.1:3795\/api\/health$/);
  assert.equal(fetchCalls[0].init.cache, "no-store");
  assert.ok(fetchCalls[0].init.headers["x-magpie-term-token"] !== undefined);
  // AC11：探测必须带超时信号（Node / 现代 Chrome 有 AbortSignal.timeout）。
  assert.ok(fetchCalls[0].init.signal !== undefined);
  const target = new URL(locationRef.replaceCalls[0]);
  assert.equal(target.searchParams.get(STALE_TOKEN_MARK), "1");
  assert.equal(target.searchParams.get("foo"), "1");
});

test("探测返回 200：不刷新，继续退避（默认 fetch / location 路径）", async (t) => {
  const locationRef = fakeLocation();
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { status: 200 };
  };
  globalThis.location = locationRef;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
  });

  // 不传 fetchImpl / locationRef / reload：走 createWsClient 的默认值（AC10）。
  const { sockets } = setup(t, {});
  await dropConnectionNTimes(sockets, RELOAD_AFTER_FAILURES);
  await waitFor(() => fetchCount === 1, "health probe");
  await sleep(100);

  assert.equal(fetchCount, 1);
  assert.deepEqual(locationRef.replaceCalls, []);
});

test("探测抛错：不刷新，且下一次失败仍会 probe → 第二次 403 只 replace 一次", async (t) => {
  const locationRef = fakeLocation();
  let fetchCount = 0;
  const { sockets } = setup(t, {
    locationRef,
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) throw new Error("ECONNREFUSED（模拟宿主还没起来）");
      return { status: 403 };
    },
  });

  await dropConnectionNTimes(sockets, RELOAD_AFTER_FAILURES);
  await waitFor(() => fetchCount === 1, "first probe");
  await sleep(100);
  // 第一次探测失败绝不能锁死刷新：此时还没有 replace。
  assert.deepEqual(locationRef.replaceCalls, []);

  // 等退避建出第 4 个 socket，再让它失败 → 第 4 次 scheduleReconnect 必须继续 probe。
  await waitFor(() => sockets.length >= RELOAD_AFTER_FAILURES + 1, "next socket");
  sockets[RELOAD_AFTER_FAILURES].emit("close");
  await waitFor(() => locationRef.replaceCalls.length === 1, "replace after second probe");

  assert.equal(fetchCount, 2);
  await sleep(150);
  assert.equal(locationRef.replaceCalls.length, 1);
  const target = new URL(locationRef.replaceCalls[0]);
  assert.equal(target.searchParams.get(STALE_TOKEN_MARK), "1");
});

test("URL 已带 mt_token_reload：不探测、不刷新，onStatus 收到 staleToken:true", async (t) => {
  const locationRef = fakeLocation(`?${STALE_TOKEN_MARK}=1`);
  let fetchCount = 0;
  const { sockets, statuses } = setup(t, {
    locationRef,
    fetchImpl: async () => {
      fetchCount += 1;
      return { status: 403 };
    },
  });

  await dropConnectionNTimes(sockets, RELOAD_AFTER_FAILURES);
  await waitFor(() => statuses.some((s) => s.staleToken === true), "staleToken status");
  await sleep(100);

  assert.deepEqual(locationRef.replaceCalls, []);
  // 已带标记时根本不该再探：标记本身就是「已经自动刷过一次」的证据。
  assert.equal(fetchCount, 0);
  const stale = statuses.find((s) => s.staleToken === true);
  assert.equal(stale.state, "closed");
  assert.equal(stale.attempt, RELOAD_AFTER_FAILURES);
});
