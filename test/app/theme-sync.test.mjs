// TASK-FIX17-B 前端主题引擎：亮度判定 / 字号映射 / 应用主题 / 轮询。
//
// 本文件测的是 `app/app.js` 导出的**纯函数**与 `createThemeSync`（定时器可注入）。
// 为什么导出这些：AC3「不刷新页面颜色就跟着变」在自动化里只能靠假定时器驱动，
// 真等 1 秒一次会让测试变得又慢又脆。`app.js` 在没有 `[data-role="app"]` 骨架时
// 不启动，所以这里可以直接 import 而不需要一整套 DOM 桩。
import test from "node:test";
import assert from "node:assert/strict";

// app.js 顶层只做「查骨架」，查不到就不 init()。给一个最小 document 桩即可。
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
};

const {
  DARK_LUMINANCE_THRESHOLD,
  applyThemePayload,
  createThemeSync,
  fontPxForTextSize,
  parseCssColor,
  relativeLuminance,
  resetThemeFingerprint,
  schemeForBackground,
} = await import("../../app/app.js");

/* ---------------------------------------------------------------- 测试用 DOM 桩 */

/**
 * 最小 `<html>` 桩：只实现 app.js 用到的那几个方法，并记录被写过的变量。
 * 不用 jsdom：仓库没有这个依赖，而且这里只需要「写了什么」。
 */
function fakeRoot() {
  const vars = new Map();
  const classes = new Set();
  const attrs = new Map();
  return {
    vars,
    classes,
    attrs,
    style: {
      setProperty(name, value) {
        vars.set(name, value);
      },
      getPropertyValue(name) {
        return vars.get(name) || "";
      },
      colorScheme: "",
      fontSize: "",
    },
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
  };
}

function fakeDoc() {
  const root = fakeRoot();
  return { documentElement: root, root };
}

/* ---------------------------------------------------------------- 色值解析 */

test("parseCssColor：hex 与 rgb()/rgba() 都能解，非法返回 null", () => {
  assert.deepEqual(parseCssColor("#f4f4f6"), [244, 244, 246]);
  assert.deepEqual(parseCssColor("#1a1a1e"), [26, 26, 30]);
  assert.deepEqual(parseCssColor("#fff").slice(0, 3), [255, 255, 255]);
  assert.deepEqual(parseCssColor("rgb(26, 26, 30)").slice(0, 3), [26, 26, 30]);
  assert.deepEqual(parseCssColor("rgba(26, 26, 30, 1)").slice(0, 3), [26, 26, 30]);
  assert.equal(parseCssColor("Canvas"), null);
  assert.equal(parseCssColor(""), null);
  assert.equal(parseCssColor(null), null);
});

test("relativeLuminance：白 1 / 黑 0，magpie 两套底色的亮度差足够大", () => {
  assert.ok(Math.abs(relativeLuminance([255, 255, 255]) - 1) < 1e-6);
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  const light = relativeLuminance([244, 244, 246]);
  const dark = relativeLuminance([26, 26, 30]);
  assert.ok(light > 0.8 && dark < 0.02, "magpie 浅/深底色必须分别落在两端");
  assert.ok(light - dark > DARK_LUMINANCE_THRESHOLD, "两者跨过阈值，判定不会摇摆");
});

test("schemeForBackground：宽底判浅色、暗底判深色、解析不了返回 null", () => {
  assert.equal(schemeForBackground("#f4f4f6"), "light");
  assert.equal(schemeForBackground("#ffffff"), "light");
  assert.equal(schemeForBackground("#1a1a1e"), "dark");
  assert.equal(schemeForBackground("#000000"), "dark");
  // 修之前 `--term-bg: Canvas` 就走到这里：必须返回 null（调用方保留旧判定），
  // 不能默认成 dark —— 那会让浅色主题的终端整块变黑（A 批的原始症状）。
  assert.equal(schemeForBackground("Canvas"), null);
  assert.equal(schemeForBackground(""), null);
});

test("fontPxForTextSize：13px 基准，夹在 80…160%", () => {
  assert.equal(fontPxForTextSize(100), 13);
  assert.equal(fontPxForTextSize(110), 14.3);
  assert.equal(fontPxForTextSize(130), 16.9);
  assert.equal(fontPxForTextSize(50), fontPxForTextSize(80));
  assert.equal(fontPxForTextSize(500), fontPxForTextSize(160));
  assert.equal(fontPxForTextSize(undefined), 13);
});

/* ---------------------------------------------------------------- applyThemePayload */

test("applyThemePayload：写 --magpie-* 变量、加 is-dark、标记 data-mt-served", () => {
  resetThemeFingerprint();
  const doc = fakeDoc();
  const result = applyThemePayload(
    { scheme: "dark", textSize: 100, tokens: { "--magpie-bg": "#1a1a1e", "--magpie-fg": "#ededf1" } },
    { doc },
  );
  assert.equal(result.changed, true);
  assert.equal(result.scheme, "dark");
  assert.equal(doc.root.style.getPropertyValue("--magpie-bg"), "#1a1a1e");
  assert.equal(doc.root.style.getPropertyValue("--magpie-fg"), "#ededf1");
  assert.equal(doc.root.classList.contains("is-dark"), true);
  assert.equal(doc.root.classList.contains("is-light"), false);
  assert.equal(doc.root.getAttribute("data-mt-served"), "1");
  assert.equal(doc.root.style.colorScheme, "dark");
});

test("applyThemePayload：浅色时 is-light 与 is-dark 互斥", () => {
  resetThemeFingerprint();
  const doc = fakeDoc();
  applyThemePayload({ scheme: "light", textSize: 100, tokens: {} }, { doc });
  assert.equal(doc.root.classList.contains("is-light"), true);
  assert.equal(doc.root.classList.contains("is-dark"), false);
  // 再切深色：两个类必须交换，不能同时存在。
  resetThemeFingerprint();
  applyThemePayload({ scheme: "dark", textSize: 100, tokens: {} }, { doc });
  assert.equal(doc.root.classList.contains("is-dark"), true);
  assert.equal(doc.root.classList.contains("is-light"), false);
});

test("applyThemePayload：没给 scheme 时用 --magpie-bg 的亮度自己判（第二道保险）", () => {
  resetThemeFingerprint();
  const dark = fakeDoc();
  applyThemePayload({ textSize: 100, tokens: { "--magpie-bg": "#1a1a1e" } }, { doc: dark });
  assert.equal(dark.root.classList.contains("is-dark"), true);

  resetThemeFingerprint();
  const light = fakeDoc();
  applyThemePayload({ textSize: 100, tokens: { "--magpie-bg": "#f4f4f6" } }, { doc: light });
  assert.equal(light.root.classList.contains("is-light"), true);
});

test("applyThemePayload：也可以直接传 <html> 元素（不要求整份 Document）", () => {
  resetThemeFingerprint();
  const root = fakeRoot();
  applyThemePayload({ scheme: "dark", textSize: 100, tokens: { "--magpie-bg": "#1a1a1e" } }, { doc: root });
  assert.equal(root.style.getPropertyValue("--magpie-bg"), "#1a1a1e");
  assert.equal(root.classList.contains("is-dark"), true);
});

test("applyThemePayload：字号写进根 style 与 --mt-font-scale（AC7）", () => {
  resetThemeFingerprint();
  const doc = fakeDoc();
  applyThemePayload({ scheme: "light", textSize: 130, tokens: {} }, { doc });
  assert.equal(doc.root.style.fontSize, "16.9px");
  assert.equal(doc.root.style.getPropertyValue("--mt-font-scale"), "1.3");
});

test("applyThemePayload：同一份主题不发第二次变更（避免每秒重写变量重画终端）", () => {
  resetThemeFingerprint();
  const doc = fakeDoc();
  let calls = 0;
  const payload = { scheme: "dark", textSize: 100, tokens: { "--magpie-bg": "#1a1a1e" } };
  applyThemePayload(payload, { doc, onChanged: () => (calls += 1) });
  const second = applyThemePayload(payload, { doc, onChanged: () => (calls += 1) });
  assert.equal(second.changed, false);
  assert.equal(calls, 1, "指纹相同就不应再通知终端");
});

test("applyThemePayload：主题真的变了才通知（changed=true + onChanged 拿到 scheme）", () => {
  resetThemeFingerprint();
  const doc = fakeDoc();
  const seen = [];
  applyThemePayload({ scheme: "light", textSize: 100, tokens: {} }, { doc, onChanged: (i) => seen.push(i.scheme) });
  applyThemePayload({ scheme: "dark", textSize: 100, tokens: {} }, { doc, onChanged: (i) => seen.push(i.scheme) });
  assert.deepEqual(seen, ["light", "dark"]);
});

test("applyThemePayload：非法变量名 / 非字符串值被跳过，不影响其余变量", () => {
  resetThemeFingerprint();
  const doc = fakeDoc();
  applyThemePayload(
    {
      scheme: "light",
      textSize: 100,
      tokens: {
        "--magpie-bg": "#f4f4f6",
        "bad name": "#000",
        "--magpie-fg": 123,
        "no-prefix": "#fff",
      },
    },
    { doc },
  );
  assert.equal(doc.root.style.getPropertyValue("--magpie-bg"), "#f4f4f6");
  assert.equal(doc.root.style.getPropertyValue("bad name"), "");
  assert.equal(doc.root.style.getPropertyValue("--magpie-fg"), "");
  assert.equal(doc.root.style.getPropertyValue("no-prefix"), "");
});

test("applyThemePayload：setProperty 抛错时只跳那一个变量", () => {
  resetThemeFingerprint();
  const doc = fakeDoc();
  const original = doc.root.style.setProperty;
  doc.root.style.setProperty = (name, value) => {
    if (name === "--magpie-fg") throw new Error("boom");
    original.call(doc.root.style, name, value);
  };
  applyThemePayload(
    { scheme: "light", textSize: 100, tokens: { "--magpie-bg": "#f4f4f6", "--magpie-fg": "#111111" } },
    { doc },
  );
  assert.equal(doc.root.style.getPropertyValue("--magpie-bg"), "#f4f4f6");
  assert.equal(doc.root.style.getPropertyValue("--magpie-fg"), "");
});

/* ---------------------------------------------------------------- createThemeSync */

/**
 * 可控定时器：手动推进，不真的等 1 秒。
 * @returns {{setTimer:Function, clearTimer:Function, tick:Function, pending:Function}}
 */
function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** 跑一次最早注册的定时器（模拟时间到）。 */
    async tick() {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[0] - b[0])[0] || [];
      if (!timer) return false;
      timers.delete(id);
      timer.fn();
      // 让 await 链走完。
      await new Promise((resolve) => setImmediate(resolve));
      return true;
    },
    pending() {
      return timers.size;
    },
    intervals() {
      return [...timers.values()].map((t) => t.ms);
    },
  };
}

test("createThemeSync：启动立刻取一发（不等第一个轮询周期）", async () => {
  const timers = fakeTimers();
  const seen = [];
  const sync = createThemeSync({
    fetchTheme: async () => ({ ok: true, data: { scheme: "dark", textSize: 100, tokens: {} } }),
    apply: (payload) => {
      seen.push(payload.scheme);
      return payload;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["dark"], "启动必须先取一次，否则首帧可能停在兜底色");
  sync.stop();
});

test("createThemeSync：定时器到点会再取一发（这就是「不刷新也变色」的驱动）", async () => {
  const timers = fakeTimers();
  const seen = [];
  let theme = "light";
  const sync = createThemeSync({
    fetchTheme: async () => ({ ok: true, data: { scheme: theme, textSize: 100, tokens: {} } }),
    apply: (payload) => {
      seen.push(payload.scheme);
      return payload;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    intervalMs: 1000,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["light"]);

  theme = "dark";
  await timers.tick();
  assert.deepEqual(seen, ["light", "dark"], "第二拍必须看到新主题");
  sync.stop();
});

test("createThemeSync：轮询间隔用注入值，默认 1000ms", async () => {
  const timers = fakeTimers();
  const sync = createThemeSync({
    fetchTheme: async () => ({ ok: false, code: "X", userText: "" }),
    apply: () => ({}),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timers.intervals(), [1000]);
  sync.stop();
});

test("createThemeSync：取主题失败（ok:false）不调 apply，也不抛", async () => {
  const timers = fakeTimers();
  let applied = 0;
  const sync = createThemeSync({
    fetchTheme: async () => ({ ok: false, code: "NETWORK", userText: "连不上" }),
    apply: () => (applied += 1),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied, 0, "失败时保留当前配色，不能白屏");
  await timers.tick();
  assert.equal(applied, 0);
  sync.stop();
});

test("createThemeSync：fetch 抛异常也被吞掉，下一拍继续", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const sync = createThemeSync({
    fetchTheme: async () => {
      calls += 1;
      throw new Error("network down");
    },
    apply: () => ({}),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  await timers.tick();
  assert.equal(calls, 2, "异常后必须继续轮询（主题不是关键路径，不能把页面弄崩）");
  sync.stop();
});

test("createThemeSync：并发保护——上一发没回来时不叠加请求", async () => {
  const timers = fakeTimers();
  let calls = 0;
  let release = null;
  const sync = createThemeSync({
    fetchTheme: () => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, data: { scheme: "light", textSize: 100, tokens: {} } });
      });
    },
    apply: () => ({}),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  // 第一发还挂着，再手动推一拍。
  await timers.tick();
  assert.equal(calls, 1, "上一发没回来时不应再发");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  sync.stop();
});

test("createThemeSync：stop() 之后不再轮询、不再取", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const sync = createThemeSync({
    fetchTheme: async () => {
      calls += 1;
      return { ok: true, data: { scheme: "light", textSize: 100, tokens: {} } };
    },
    apply: () => ({}),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const before = calls;
  sync.stop();
  assert.equal(timers.pending(), 0, "stop 必须清掉待触发的定时器");
  await timers.tick();
  assert.equal(calls, before, "stop 之后不应再取");
});

test("createThemeSync：visibilitychange / focus 会立刻取一发（后台标签页被节流时的补位）", async () => {
  const timers = fakeTimers();
  const listeners = new Map();
  const events = {
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
  };
  let calls = 0;
  const sync = createThemeSync({
    fetchTheme: async () => {
      calls += 1;
      return { ok: true, data: { scheme: "light", textSize: 100, tokens: {} } };
    },
    apply: () => ({}),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const baseline = calls;
  assert.equal(typeof listeners.get("visibilitychange"), "function");
  assert.equal(typeof listeners.get("focus"), "function");

  listeners.get("focus")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, baseline + 1, "focus 应立刻取一发");

  listeners.get("visibilitychange")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, baseline + 2, "visibilitychange 也应立刻取一发");

  sync.stop();
  assert.equal(listeners.size, 0, "stop 必须解绑自己加的所有监听");
});

test("createThemeSync：tick() 返回 apply 的结果（探针可观测）", async () => {
  const timers = fakeTimers();
  const sync = createThemeSync({
    fetchTheme: async () => ({ ok: true, data: { scheme: "dark", textSize: 130, tokens: {} } }),
    apply: (payload) => ({ applied: payload.scheme }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const result = await sync.tick();
  assert.deepEqual(result, { applied: "dark" });
  sync.stop();
});

/* ---------------------------------------------------------------- TASK-FIX17-E2 R1 */

/** 永不触发的定时器：手动调 tick() 驱动，避免 schedule() 自己跑拍。 */
function inertTimers() {
  let nextId = 1;
  return {
    setTimer() {
      return nextId++;
    },
    clearTimer() {},
  };
}

/** 可控响应队列；队列用尽后一直返回最后一条。 */
function sequenceFetch(responses) {
  const state = { calls: 0 };
  const fetchTheme = async () => {
    const index = Math.min(state.calls, responses.length - 1);
    state.calls += 1;
    return responses[index];
  };
  return { state, fetchTheme };
}

const OK_THEME = { ok: true, data: { scheme: "light", textSize: 100, tokens: {} } };

test("createThemeSync（E2 R1）：连续 2 次 403 后停止轮询，第 3 拍不再 fetch", async () => {
  const timers = fakeTimers();
  let calls = 0;
  let authLost = 0;
  const sync = createThemeSync({
    fetchTheme: async () => {
      calls += 1;
      return { ok: false, code: "FORBIDDEN", userText: "没权限" };
    },
    apply: () => ({}),
    onAuthLost: () => (authLost += 1),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "启动第一拍");
  assert.equal(timers.pending(), 1);

  await timers.tick(); // 第二拍：第 2 次 403 → stop
  assert.equal(calls, 2, "第 2 次 403 必须已经发出去才会知道口令失效");
  assert.equal(authLost, 1, "确认失效时上报一次 onAuthLost");
  assert.equal(timers.pending(), 0, "stop 必须清掉已排的那一拍");

  // 旧行为：schedule() 永远每秒一拍。现在推进 5 次也不该再有 fetch。
  for (let i = 0; i < 5; i += 1) await timers.tick();
  assert.equal(calls, 2, "第 3 拍起不许再 fetch");
  assert.equal(await sync.tick(), null, "stop 之后手动 tick 也不 fetch");
  assert.equal(calls, 2);
  assert.equal(authLost, 1, "onAuthLost 只许调一次");
});

test("createThemeSync（E2 R1）：HTTP_403 与 FORBIDDEN 都算鉴权失败", async () => {
  const timers = inertTimers();
  const { state, fetchTheme } = sequenceFetch([
    { ok: false, code: "HTTP_403", userText: "" },
    { ok: false, code: "FORBIDDEN", userText: "" },
  ]);
  const sync = createThemeSync({
    fetchTheme,
    apply: () => ({}),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await sync.tick();
  assert.equal(state.calls, 2);
  const afterStop = await sync.tick();
  assert.equal(afterStop, null);
  assert.equal(state.calls, 2, "两种 403 形态合起来算连续 2 次");
});

test("createThemeSync（E2 R1）：中间成功一次就清零计数（不能因一次抖动永久停掉）", async () => {
  const timers = inertTimers();
  const { state, fetchTheme } = sequenceFetch([
    { ok: false, code: "FORBIDDEN", userText: "" }, // 启动：第 1 次
    OK_THEME, // 成功 → 清零
    { ok: false, code: "FORBIDDEN", userText: "" }, // 第 1 次
    { ok: false, code: "FORBIDDEN", userText: "" }, // 第 2 次 → stop
    { ok: false, code: "FORBIDDEN", userText: "" }, // stop 之后不该被取
  ]);
  let authLost = 0;
  let applied = 0;
  const sync = createThemeSync({
    fetchTheme,
    apply: () => (applied += 1),
    onAuthLost: () => (authLost += 1),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls, 1);

  await sync.tick(); // 成功
  assert.equal(state.calls, 2);
  assert.equal(applied, 1);
  assert.equal(authLost, 0);

  await sync.tick(); // 失败 1
  assert.equal(authLost, 0, "清零之后只失败一次还不能停");
  await sync.tick(); // 失败 2 → stop
  assert.equal(authLost, 1);

  assert.equal(await sync.tick(), null);
  assert.equal(state.calls, 4, "stop 之后不再 fetch（序列第 5 条永远取不到）");
});

test("createThemeSync（E2 R1）：NETWORK 不算鉴权失败，连续多次也只继续轮询", async () => {
  const timers = fakeTimers();
  let calls = 0;
  let authLost = 0;
  const sync = createThemeSync({
    fetchTheme: async () => {
      calls += 1;
      return { ok: false, code: "NETWORK", userText: "连不上本地服务" };
    },
    apply: () => ({}),
    onAuthLost: () => (authLost += 1),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 5; i += 1) await timers.tick();
  assert.equal(calls, 6, "网络错误必须继续每秒重试");
  assert.equal(authLost, 0, "NETWORK 绝不能被当成口令失效");
  assert.equal(timers.pending(), 1, "轮询链仍然活着");
  sync.stop();
});

test("createThemeSync（E2 R1）：onAuthLost 抛错不影响停止与后续行为", async () => {
  const timers = inertTimers();
  const sync = createThemeSync({
    fetchTheme: async () => ({ ok: false, code: "FORBIDDEN", userText: "" }),
    apply: () => ({}),
    onAuthLost: () => {
      throw new Error("boom");
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.doesNotReject(() => sync.tick());
  assert.equal(await sync.tick(), null, "回调抛错也必须已经 stop");
});
