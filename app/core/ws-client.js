// WebSocket 客户端：连接、帧编解码、指数退避重连。
// 只解码与分发；帧定义的唯一住所是 src/server/ws.mjs。

import constants from "./constants.js";
import { readToken } from "./token.js";

// TASK-FIX-RECONNECT O2：连续失败几次后探一次 /api/health，判断口令是否作废。
export const RELOAD_AFTER_FAILURES = 3;
// 刷新标记只能放在 URL 查询串里：沙箱 opaque origin 禁用 localStorage/sessionStorage。
export const STALE_TOKEN_MARK = "mt_token_reload";
// 探测超时：宿主没起时不能把重连流程卡住。
const PROBE_TIMEOUT_MS = 3000;

/**
 * 重连到第 N 次失败时该做什么（纯函数，不读全局）。
 *
 * - "probe"：用旧口令请求一次 /api/health；
 * - "mark-and-report"：URL 已带刷新标记 → 不再刷新，只上报 staleToken；
 * - "none"：失败次数还不够，或已有一个探测在途（避免并发探测）。
 *
 * 注意 `marked` 优先于 `inFlight`：已经自动刷过一次的页面必须持续上报，
 * 不能因为探测在途而漏掉「请手动刷新」的提示。
 */
export function shouldProbeStaleToken(attempt, { inFlight = false, marked = false } = {}) {
  if (!Number.isFinite(attempt) || attempt < RELOAD_AFTER_FAILURES) return "none";
  if (marked) return "mark-and-report";
  if (inFlight) return "none";
  return "probe";
}

export default function createWsClient(options) {
  const port = options && options.port ? options.port : constants.DEFAULT_PORT;
  const onFrame = typeof options.onFrame === "function" ? options.onFrame : () => {};
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  const fetchImpl =
    options && typeof options.fetchImpl === "function"
      ? options.fetchImpl
      : (...args) => globalThis.fetch(...args);
  const locationRef = options && options.locationRef ? options.locationRef : globalThis.location;
  const reload =
    options && typeof options.reload === "function"
      ? options.reload
      : (target) => locationRef.replace(target);

  let socket = null;
  let attempt = 0;
  let retryTimer = null;
  let closedByUs = false;
  // 当前是否有一个 /api/health 探测在途。只在 finally 里复位：
  // 宿主重启期间服务可能还没起来，探测失败绝不能锁死后续探测和自动刷新。
  let inFlight = false;

  // 刷新标记是否已经在当前 URL 里（search 或完整 href 任一命中都算）。
  function hasStaleMark() {
    try {
      const search = locationRef && typeof locationRef.search === "string" ? locationRef.search : "";
      const href = locationRef && typeof locationRef.href === "string" ? locationRef.href : "";
      return search.includes(STALE_TOKEN_MARK) || href.includes(STALE_TOKEN_MARK);
    } catch {
      return false;
    }
  }

  // 刷新标记只能放在 URL 查询串里；用 location.replace 保留下来，不产生历史记录。
  function reloadWithMark() {
    try {
      const target = new URL(locationRef.href);
      target.searchParams.set(STALE_TOKEN_MARK, "1");
      reload(target.toString());
    } catch {
      // location 不可用（极端文档状态）时不要因此打断退避重连。
    }
  }

  // AbortSignal.timeout 不可用（老环境）时退回 undefined，不影响启动。
  function probeSignal() {
    try {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(PROBE_TIMEOUT_MS);
      }
    } catch {
      // 忽略：没有超时也比抛错好。
    }
    return undefined;
  }

  async function probeStaleToken(marked) {
    inFlight = true;
    try {
      if (typeof fetchImpl !== "function") return;
      let response;
      try {
        response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
          cache: "no-store",
          headers: { "x-magpie-term-token": readToken() },
          signal: probeSignal(),
        });
      } catch {
        // 服务没起 / 网络错误 / 超时：继续退避，下一次失败还会再探。
        return;
      }
      if (closedByUs) return;
      // 探测期间已经重新连上（attempt 被复位）就丢弃这次结果。
      if (attempt < RELOAD_AFTER_FAILURES) return;
      if (!response || response.status !== 403) return;

      if (marked) {
        // 本页已经自动刷过一次：绝不无限刷新，改为让状态栏提示手动刷新。
        onStatus({ state: "closed", staleToken: true, attempt });
        return;
      }
      // 口令确实作废：加标记刷新一次。
      reloadWithMark();
    } finally {
      // 硬要求：200 / 403 / 网络错误 / 超时都必须走到这里，
      // 否则一次探测失败会让页面永远不再刷新。
      inFlight = false;
    }
  }

  // 口令必须显式放进 query：浏览器 WebSocket 构造函数无法设置自定义头，
  // 而沙箱 iframe（opaque origin）里 cookie 根本不会发过来。
  function url() {
    const token = readToken();
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    return `ws://127.0.0.1:${port}${constants.WS_PATH}${query}`;
  }

  function scheduleReconnect() {
    if (closedByUs) return;
    const delay = Math.min(
      constants.RECONNECT_MAX_MS,
      constants.RECONNECT_BASE_MS * Math.pow(2, Math.min(attempt, 5)),
    );
    attempt += 1;
    onStatus({ state: "closed", retryInMs: delay, attempt });

    // TASK-FIX-RECONNECT O2：第 3 次失败开始验证口令；
    // 已带刷新标记时不再探测，每次失败都上报，让状态栏提示手动刷新。
    const marked = hasStaleMark();
    const action = shouldProbeStaleToken(attempt, { inFlight, marked });
    if (action === "mark-and-report") {
      onStatus({ state: "closed", staleToken: true, attempt });
    } else if (action === "probe") {
      void probeStaleToken(marked);
    }

    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    onStatus({ state: "connecting", attempt });
    let ws;
    try {
      ws = new WebSocket(url());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      attempt = 0;
      // 连上了就重新开始：下次断线再探一轮口令。
      inFlight = false;
      onStatus({ state: "open" });
    });

    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== "string") return;
      onFrame(frame);
    });

    ws.addEventListener("error", () => {
      // 具体原因交给 close 处理；这里不重复上报。
    });

    ws.addEventListener("close", () => {
      if (socket === ws) socket = null;
      if (closedByUs) {
        onStatus({ state: "closed", retryInMs: null, attempt });
        return;
      }
      scheduleReconnect();
    });
  }

  function send(frame) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  function retryNow() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    attempt = 0;
    connect();
  }

  function close() {
    closedByUs = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        // 忽略。
      }
      socket = null;
    }
  }

  return { connect, send, retryNow, close, isOpen: () => Boolean(socket && socket.readyState === WebSocket.OPEN) };
}
