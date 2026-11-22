// WebSocket 客户端：连接、帧编解码、指数退避重连。
// 只解码与分发；帧定义的唯一住所是 src/server/ws.mjs。

import constants from "./constants.js";
import { readToken } from "./token.js";

export default function createWsClient(options) {
  const port = options && options.port ? options.port : constants.DEFAULT_PORT;
  const onFrame = typeof options.onFrame === "function" ? options.onFrame : () => {};
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};

  let socket = null;
  let attempt = 0;
  let retryTimer = null;
  let closedByUs = false;

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
