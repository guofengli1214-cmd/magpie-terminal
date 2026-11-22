// 唯一入口：只做编排。解析 query → 建 store → 建 WS → 建视图 → 启动。

import constants from "./core/constants.js";
import createSessionStore from "./core/session-store.js";
import createWsClient from "./core/ws-client.js";
import api from "./core/api.js";
import createTabBar from "./ui/tab-bar.js";
import createTerminalView from "./ui/terminal-view.js";
import createStatusBar from "./ui/status-bar.js";
import createAiPanel from "./ui/ai-panel.js";

const root = document.querySelector('[data-role="app"]');
const tabbarHost = document.querySelector('[data-role="tabbar"]');
const mainHost = document.querySelector('[data-role="main"]');
const terminalHost = document.querySelector('[data-role="terminal-host"]');
const aiHost = document.querySelector('[data-role="ai-panel"]');
const statusHost = document.querySelector('[data-role="statusbar"]');

const store = createSessionStore();

const banner = document.createElement("div");
banner.setAttribute("data-role", "banner");
banner.setAttribute("role", "status");
banner.hidden = true;
root.insertBefore(banner, mainHost);

let health = null;
let lastAttachedId = null;
// 重连时已发过 pty.attach、还在等 session.resumed / SESSION_GONE 的 id。
const resumePendingIds = new Set();
let aiPanel = null;
let tabBar = null;
let statusBar = null;
let terminalView = null;
let wsClient = null;

function showBanner(text) {
  banner.textContent = text;
  banner.hidden = false;
}

function hideBanner() {
  banner.textContent = "";
  banner.hidden = true;
}

function parseQuery() {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");
  if (theme === "dark" || theme === "light") {
    document.documentElement.style.colorScheme = theme;
    if (theme === "dark") document.documentElement.classList.add("theme-dark");
    else document.documentElement.classList.add("theme-light");
  }
  // 页面由自己的服务发出，端口以 location 为准（兼容 magpie.options.port 改动）。
  const portFromLocation = Number(location.port);
  return {
    theme,
    lang: params.get("lang") || "zh-CN",
    port: Number.isFinite(portFromLocation) && portFromLocation > 0 ? portFromLocation : constants.DEFAULT_PORT,
  };
}

const options = parseQuery();
if (options.lang) document.documentElement.lang = options.lang;

function createTab() {
  if (store.getSnapshot().sessions.length >= constants.TAB_LIMIT) {
    showBanner(`标签数量已达上限（${constants.TAB_LIMIT}）。关掉一个再新建。`);
    setTimeout(hideBanner, 5000);
    return;
  }
  const sent = wsClient.send({ type: "pty.create" });
  if (!sent) {
    statusBar.setHealth(health);
    showBanner("新建标签没发出去：连接还没就绪。点状态栏「重连」后重试。");
    setTimeout(hideBanner, 5000);
    return;
  }
}

function sendResize(id, cols, rows) {
  wsClient.send({ type: "pty.resize", id, cols, rows });
}

function healthPty() {
  return health && typeof health.pty === "string" ? health.pty : null;
}

function shellSummary(info) {
  if (!info) return "shell";
  const name = info.shell && info.shell.name ? info.shell.name : "shell";
  return info.pty === "sentinel" ? `${name}（降级）` : name;
}

function handleFrame(frame) {
  switch (frame.type) {
    case "session.created": {
      const id = frame.id;
      store.addSession({
        id,
        shell: shellSummary(frame),
        cwd: frame.cwd || "",
        status: "running",
        exitCode: null,
        cols: frame.cols || 80,
        rows: frame.rows || 24,
      });
      terminalView.ensure(id);
      store.patchSession(id, {
        cols: frame.cols || 80,
        rows: frame.rows || 24,
      });
      if (!store.getSnapshot().activeId || store.getSnapshot().activeId === id) {
        store.setActive(id);
      }
      attachActive();
      return;
    }
    case "session.resumed": {
      // 重连后服务端确认这个会话还活着：刷新元数据并重建滚动缓冲。
      const id = frame.id;
      const existing = store.getSession(id);
      if (!existing) {
        // 理论上不该发生（只有已知 id 才 attach），保守起见按新会话处理。
        store.addSession({
          id,
          shell: shellSummary(frame),
          cwd: frame.cwd || "",
          status: "running",
          exitCode: null,
          cols: frame.cols || 80,
          rows: frame.rows || 24,
        });
      } else {
        store.patchSession(id, {
          shell: shellSummary(frame),
          cwd: frame.cwd || existing.cwd,
          status: "running",
          exitCode: null,
          cols: frame.cols || existing.cols,
          rows: frame.rows || existing.rows,
        });
      }
      terminalView.ensure(id);
      terminalView.replay(id, frame.recentOutput || "");
      if (typeof frame.pty === "string" && frame.pty !== healthPty()) {
        showBanner(
          frame.pty === "sentinel"
            ? "降级模式：无 TTY，全屏程序不可用"
            : "PTY 已恢复为原生模式。",
        );
      }
      if (!store.getSnapshot().activeId || store.getSnapshot().activeId === id) {
        store.setActive(id);
      }
      attachActive();
      resumePendingIds.delete(id);
      return;
    }
    case "pty.output": {
      terminalView.write(frame.id, frame.data);
      return;
    }
    case "pty.exit": {
      const session = store.getSession(frame.id);
      resumePendingIds.delete(frame.id);
      if (!session) {
        terminalView.dispose(frame.id);
        return;
      }
      store.patchSession(frame.id, { status: "exited", exitCode: frame.exitCode });
      if (frame.exitCode !== null && frame.exitCode !== undefined) {
        terminalView.writeln(
          frame.id,
          `\r\n[进程已退出，退出码 ${frame.exitCode}] 点左上角「+」新建一个标签。\r`,
        );
      } else {
        terminalView.writeln(frame.id, "\r\n[会话已关闭] 点左上角「+」新建一个标签。\r");
      }
      return;
    }
    case "pty.error": {
      // SESSION_GONE：重连后服务端说这个会话已经结束 —— 移除标签，不要永久转圈。
      if (frame.code === "SESSION_GONE") {
        resumePendingIds.delete(frame.id);
        if (frame.id && store.getSession(frame.id)) {
          store.removeSession(frame.id);
          terminalView.dispose(frame.id);
          showBanner("这个标签的会话已经结束，已移除该标签。点「+」新建一个。");
          setTimeout(hideBanner, 6000);
          if (store.getSnapshot().sessions.length === 0) createTab();
          else attachActive();
          return;
        }
        showBanner("服务端没有这个会话了。点「+」新建一个标签。");
        setTimeout(hideBanner, 6000);
        return;
      }
      if (frame.id && store.getSession(frame.id)) {
        store.patchSession(frame.id, { status: "error" });
        terminalView.writeln(frame.id, `\r\n[错误] ${frame.userText || frame.code}\r\n`);
      } else {
        showBanner(`${frame.userText || "终端发生错误。"}（${frame.code}）`);
        setTimeout(hideBanner, 6000);
        statusBar.setHealth(health);
      }
      return;
    }
    case "ai.reply": {
      aiPanel.onReply(frame);
      return;
    }
    case "ai.error": {
      aiPanel.onError(frame);
      return;
    }
    default:
      return;
  }
}

function attachActive() {
  const snapshot = store.getSnapshot();
  if (!snapshot.activeId) return;
  lastAttachedId = snapshot.activeId;
  terminalView.attach(snapshot.activeId);
  const session = snapshot.sessions.find((s) => s.id === snapshot.activeId);
  if (session) {
    const { cols, rows } = terminalView.colsRows(session.id);
    sendResize(session.id, cols, rows);
  }
}

function handleWsStatus(status) {
  if (status.state === "open") {
    store.setConnection("open");
    if (health) statusBar.setHealth(health);

    const snapshot = store.getSnapshot();
    if (snapshot.sessions.length === 0) {
      // 缺陷 A：打开页面必须自动有一个标签。WS 连上且 store 为空时立刻建一个，
      // 不需要用户点「+」，也不依赖任何其他协议。
      createTab();
    } else {
      // 重连：store 里还留着 id，说明是短暂断线（而不是刷新）。逐个认领，
      // 让服务端取消孤儿回收定时器。刷新后的新页面 store 为空，永远不会走到这里。
      for (const session of snapshot.sessions) {
        if (session.status === "exited" || session.status === "error") continue;
        if (resumePendingIds.has(session.id)) continue;
        resumePendingIds.add(session.id);
        const sent = wsClient.send({ type: "pty.attach", id: session.id });
        if (!sent) resumePendingIds.delete(session.id);
      }
    }
    return;
  }
  if (status.state === "connecting") {
    store.setConnection("connecting");
    return;
  }
  // 断线：清掉 pending 标记，下次 open 时重新 attach。
  resumePendingIds.clear();
  store.setConnection("closed");
}

function setupKeyboard() {
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || !event.shiftKey) return;
    if (event.key === "T" || event.key === "t") {
      event.preventDefault();
      createTab();
      return;
    }
    if (event.key === "W" || event.key === "w") {
      event.preventDefault();
      const snapshot = store.getSnapshot();
      if (snapshot.activeId) {
        store.removeSession(snapshot.activeId);
        wsClient.send({ type: "pty.close", id: snapshot.activeId });
        terminalView.dispose(snapshot.activeId);
        attachActive();
      }
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const snapshot = store.getSnapshot();
      if (snapshot.sessions.length < 2) return;
      event.preventDefault();
      const index = snapshot.sessions.findIndex((s) => s.id === snapshot.activeId);
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = (index + delta + snapshot.sessions.length) % snapshot.sessions.length;
      store.setActive(snapshot.sessions[next].id);
      attachActive();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    const snapshot = store.getSnapshot();
    if (snapshot.sessions.some((s) => s.status === "running")) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

function toggleAi() {
  const open = mainHost.getAttribute("data-ai-open") !== "true";
  mainHost.setAttribute("data-ai-open", open ? "true" : "false");
  aiHost.hidden = !open;
  terminalView.resizeAll();
}

function init() {
  mainHost.setAttribute("data-ai-open", "true");

  tabBar = createTabBar({
    host: tabbarHost,
    store,
    onCreate: createTab,
    onClose: (id) => {
      wsClient.send({ type: "pty.close", id });
      terminalView.dispose(id);
      attachActive();
    },
  });
  tabBar.init();

  terminalView = createTerminalView({
    host: terminalHost,
    onInput: (id, data) => wsClient.send({ type: "pty.input", id, data }),
    onResize: (id, cols, rows) => sendResize(id, cols, rows),
  });

  aiPanel = createAiPanel({
    host: aiHost,
    store,
    onAsk: (payload) => wsClient.send({ type: "ai.ask", ...payload }),
    onExecute: (id, command) => {
      wsClient.send({ type: "pty.input", id, data: `${command}\r` });
    },
    getRecentOutput: (id) => terminalView.recentOutput(id, constants.RECENT_OUTPUT_LINES),
    onToggle: toggleAi,
  });
  aiPanel.init();

  statusBar = createStatusBar({
    host: statusHost,
    store,
    onRetry: () => wsClient.retryNow(),
    onToggleAi: toggleAi,
  });
  statusBar.init();

  wsClient = createWsClient({
    port: options.port,
    onFrame: handleFrame,
    onStatus: handleWsStatus,
  });
  wsClient.connect();

  setupKeyboard();

  store.subscribe((snapshot) => {
    // 只在活动标签真正变化时切换终端，避免任何门店变更都把焦点抢回终端。
    if (snapshot.activeId !== lastAttachedId && snapshot.activeId && terminalView) {
      attachActive();
    }
  });

  // 健康行：只读，失败不阻塞终端。
  api.health().then((result) => {
    if (!result.ok) {
      showBanner(`${result.userText}（${result.code}）点状态栏「重连」再试。`);
      return;
    }
    health = result.data;
    statusBar.setHealth(health);
    if (health.pty === "sentinel") {
      showBanner("降级模式：无 TTY，全屏程序不可用");
    }
    if (health.nodePtyVersion && health.nodePtyVersion !== "1.2.0-beta.15") {
      showBanner(`node-pty 版本不符：期望 1.2.0-beta.15，实际 ${health.nodePtyVersion}`);
    }
  });

  // 5 秒内没连上：明确给出可读错误，不无限转圈。
  setTimeout(() => {
    if (store.getSnapshot().connection !== "open") {
      showBanner("连不上本地终端服务。确认服务在运行，然后点状态栏「重连」。");
    }
  }, constants.CONNECT_TIMEOUT_MS);

  // 调试出口：只读快照，仅 loopback。避免被打包/污染。
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    Object.defineProperty(window, "__termDebug", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: () => structuredClone(store.getSnapshot()),
    });
  }
}

init();
