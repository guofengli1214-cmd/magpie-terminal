// 唯一入口：只做编排。解析 query → 建 store → 建 WS → 建视图 → 启动。

import constants from "./core/constants.js";
import createSessionStore from "./core/session-store.js";
import createWsClient from "./core/ws-client.js";
import api from "./core/api.js";
import createTabBar from "./ui/tab-bar.js";
import createTerminalView from "./ui/terminal-view.js";
import createStatusBar from "./ui/status-bar.js";
import createAiPanel from "./ui/ai-panel.js";
import createAiBar from "./ui/ai-bar.js";
import createRail from "./ui/rail.js";
import createHostsPanel from "./ui/hosts-panel.js";

const root = document.querySelector('[data-role="app"]');
const railHost = document.querySelector('[data-role="rail"]');
const tabbarHost = document.querySelector('[data-role="tabbar"]');
const mainHost = document.querySelector('[data-role="main"]');
const terminalHost = document.querySelector('[data-role="terminal-host"]');
const aiLayer = document.querySelector('[data-role="ai-layer"]');
const modelSelect = document.querySelector('[data-role="model-select"]');
const aiQuestion = document.querySelector('[data-role="ai-question"]');
const aiSubmit = document.querySelector('[data-role="ai-submit"]');
const modelNote = document.querySelector('[data-role="model-note"]');
const statusHost = document.querySelector('[data-role="statusbar"]');

const store = createSessionStore();

const banner = document.createElement("div");
banner.setAttribute("data-role", "banner");
banner.setAttribute("role", "status");
banner.hidden = true;
// 提示条放进主区顶部（骨架里 root 是网格容器，往里塞第五个格子会破布局）。
mainHost.insertBefore(banner, mainHost.firstChild);

let health = null;
let lastAttachedId = null;
// 重连时已发过 pty.attach、还在等 session.resumed / SESSION_GONE 的 id。
const resumePendingIds = new Set();
let aiPanel = null;
let aiBar = null;
let rail = null;
let tabBar = null;
let statusBar = null;
let terminalView = null;
let wsClient = null;
let hostsPanel = null;
// 远程会话建连中的 hostId → 等 session.created 时补上的元数据（用于建标签后同步面板）。
let pendingRemoteHost = null;

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

/**
 * 建一个远程标签（TASK-V2-B §2.6）。
 * 帧带 hostId，服务端建连成功后才回 session.created（kind=remote）。
 */
function createRemoteTab(host) {
  if (!host || typeof host.id !== "string") return;
  if (store.getSnapshot().sessions.length >= constants.TAB_LIMIT) {
    showBanner(`标签数量已达上限（${constants.TAB_LIMIT}）。关掉一个再新建。`);
    setTimeout(hideBanner, 5000);
    return;
  }
  const sent = wsClient.send({ type: "pty.create", hostId: host.id });
  if (!sent) {
    showBanner("连接还没就绪，远程标签没发出去。点状态栏「重连」后重试。");
    setTimeout(hideBanner, 5000);
    return;
  }
  pendingRemoteHost = host;
  if (statusBar) statusBar.setNotice(`正在连接 ${host.name}…`, "info");
}

function sendResize(id, cols, rows) {
  wsClient.send({ type: "pty.resize", id, cols, rows });
  // PTY 尺寸是服务端权威，把它同步进 store，状态栏 / 调试出口才看得到真值。
  store.patchSession(id, { cols, rows });
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
      const isRemote = frame.kind === "remote";
      store.addSession({
        id,
        shell: shellSummary(frame),
        cwd: frame.cwd || "",
        status: "running",
        exitCode: null,
        cols: frame.cols || 80,
        rows: frame.rows || 24,
        kind: isRemote ? "remote" : "local",
        hostId: isRemote ? frame.hostId || null : null,
        hostName: isRemote ? frame.hostName || frame.host || "远程主机" : null,
      });
      terminalView.ensure(id);
      store.patchSession(id, {
        cols: frame.cols || 80,
        rows: frame.rows || 24,
      });
      if (!store.getSnapshot().activeId || store.getSnapshot().activeId === id) {
        store.setActive(id);
      }
      if (isRemote) {
        // 用户点主机就是为了用这条远程会话：建好后把焦点切过去
        // （本地首个标签是自动建的，不能让远程标签默默藏在后面）。
        if (pendingRemoteHost && pendingRemoteHost.id === (frame.hostId || null)) {
          store.setActive(id);
        }
        pendingRemoteHost = null;
        if (hostsPanel) hostsPanel.sync();
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
        const isRemote = frame.kind === "remote";
        store.addSession({
          id,
          shell: shellSummary(frame),
          cwd: frame.cwd || "",
          status: "running",
          exitCode: null,
          cols: frame.cols || 80,
          rows: frame.rows || 24,
          kind: isRemote ? "remote" : "local",
          hostId: isRemote ? frame.hostId || null : null,
          hostName: isRemote ? frame.hostName || frame.host || "远程主机" : null,
        });
      } else {
        const isRemote = frame.kind === "remote" || existing.kind === "remote";
        store.patchSession(id, {
          shell: shellSummary(frame),
          cwd: frame.cwd || existing.cwd,
          status: "running",
          exitCode: null,
          cols: frame.cols || existing.cols,
          rows: frame.rows || existing.rows,
          kind: isRemote ? "remote" : "local",
          hostId: isRemote ? frame.hostId || existing.hostId || null : null,
          hostName: isRemote ? frame.hostName || existing.hostName || null : null,
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
        if (hostsPanel) hostsPanel.sync();
      } else {
        showBanner(`${frame.userText || "终端发生错误。"}（${frame.code}）`);
        setTimeout(hideBanner, 6000);
        statusBar.setHealth(health);
      }
      if (pendingRemoteHost && (frame.code === "UNKNOWN_HOST_KEY" || frame.code === "HOST_KEY_MISMATCH")) {
        pendingRemoteHost = null;
      }
      return;
    }
    case "ai.reply": {
      aiPanel.onReply(frame);
      arriveAiResult();
      return;
    }
    case "ai.error": {
      aiPanel.onError(frame);
      arriveAiResult();
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

// 浮层默认 hidden（§2.1）：只有真正出现了结果 / 用户问了问题才显示，
// 否则一屏半透明面板会盖住终端。
let aiLayerHasContent = false;

function openAiLayer() {
  aiLayerHasContent = true;
  store.setAiOpen(true);
  store.setAiUnread(false);
  // setAiOpen(true) 在已经是 true 时不会通知，所以这里显式同步一次可见性。
  applyAiOpen(true);
}

/** 「收起」：只藏浮层，输入条仍留着（继续提问不用先展开）。 */
function hideAiLayer() {
  aiLayerHasContent = false;
  applyAiOpen(store.getSnapshot().aiOpen !== false);
  if (aiPanel) aiPanel.closeConfirm({ restoreFocus: false });
  requestAnimationFrame(() => terminalView && terminalView.resizeAll());
}

/**
 * AI 结果到达时该做什么：
 * - 浮层此刻可见（AI 条展开且已有内容）→ 什么都不用做，用户已经看得到；
 * - 浮层被收起（点了「收起」）或 AI 条整体关掉 → 不抢用户的终端焦点，
 *   只在 rail-ai 上点一个未读圆点，等用户自己展开。
 */
function arriveAiResult() {
  const visible = !aiLayer.hidden && aiLayer.getAttribute("data-open") === "true";
  if (visible) {
    store.setAiUnread(false);
    return;
  }
  store.setAiUnread(true);
}

function toggleAi() {
  const open = store.getSnapshot().aiOpen !== true;
  if (open) aiLayerHasContent = true;
  store.setAiOpen(open);
  applyAiOpen(open);
  store.setAiUnread(false);
  if (open) {
    // 浮层刚展开：把焦点交给输入条（用户按下 AI 按钮就是要问问题）。
    if (aiBar) aiBar.focusInput();
  } else if (aiPanel) {
    aiPanel.closeConfirm({ restoreFocus: false });
  }
  // 终端宽度可能变化（浮层不挤宽度，但收起时可能触发 fit），保险再量一次。
  requestAnimationFrame(() => terminalView && terminalView.resizeAll());
}

/** #root[data-ai-open] / 浮层可见性 / 终端 fit 唯一同步点。 */
function applyAiOpen(open) {
  root.setAttribute("data-ai-open", open ? "true" : "false");
  aiLayer.hidden = !open || !aiLayerHasContent;
  aiLayer.setAttribute("data-open", open ? "true" : "false");
}

function init() {
  applyAiOpen(store.getSnapshot().aiOpen);

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

  rail = createRail({
    host: railHost,
    store,
    onToggleAi: toggleAi,
  });
  rail.init();

  // `data-role=rail-hosts` 从 A 卡的占位变成真入口（TASK-V2-B §2.6）。
  // rail.js / index.html 都不在本卡的文件清单里，所以接线放在这里：
  // 去掉 HTML 上的 hidden（A 卡留的），并挂上开关主机面板的监听。
  const railHostsButton = railHost.querySelector('[data-role="rail-hosts"]');
  if (railHostsButton) {
    railHostsButton.hidden = false;
    railHostsButton.title = "主机（SSH）";
    railHostsButton.addEventListener("click", () => {
      if (hostsPanel) hostsPanel.toggle();
    });
    // 连接中/已连的小绿点（rail 面板与列表同一语义）。
    store.subscribe((snapshot) => {
      const connected = snapshot.sessions.some(
        (s) => s.kind === "remote" && s.status === "running",
      );
      railHostsButton.setAttribute("data-connected", connected ? "true" : "false");
    });
  }

  hostsPanel = createHostsPanel({
    api,
    store,
    // 面板盖住终端区，但不遮标签栏 / AI 条 / 状态栏。
    anchor: tabbarHost,
    bottomAnchors: [
      document.querySelector('[data-role="aibar"]'),
      statusHost,
    ],
    onCreateSession: (host) => createRemoteTab(host),
    onNotice: (text, tone) => statusBar && statusBar.setNotice(text, tone),
    // 双击文件 → 只把路径填进当前远程终端输入，不执行（让用户自己确认再回车）。
    onPickFile: (remotePath) => {
      const active = store.getActive();
      if (!active || active.kind !== "remote") return;
      wsClient.send({ type: "pty.input", id: active.id, data: remotePath });
      statusBar.setNotice(`已填入路径：${remotePath}（回车才执行）`, "info");
    },
  });
  hostsPanel.init();

  aiPanel = createAiPanel({
    host: aiLayer,
    store,
    onExecute: (id, command) => {
      wsClient.send({ type: "pty.input", id, data: `${command}\r` });
    },
    onClose: () => hideAiLayer(),
  });
  aiPanel.init();

  aiBar = createAiBar({
    store,
    select: modelSelect,
    input: aiQuestion,
    submit: aiSubmit,
    note: modelNote,
    api,
    onNotice: (text, tone) => statusBar && statusBar.setNotice(text, tone),
    onAsk: ({ question, model }) => {
      const active = store.getActive();
      if (!active) return false;
      const context = {
        cwd: active.cwd,
        shell: active.shell,
        recentOutput: terminalView.recentOutput(active.id, constants.RECENT_OUTPUT_LINES),
      };
      // 请求帧必须带 model（服务端透传给网关）。
      const frame = { type: "ai.ask", requestId: `req-${Date.now()}`, question, context };
      if (model) frame.model = model;
      const sent = wsClient.send(frame);
      if (sent) {
        aiPanel.appendQuestion(question);
        openAiLayer();
      }
      return sent;
    },
    onPersistFailed: (result) => {
      // PUT 失败：保留本地选择，只提示。状态栏由 ai-bar 的 onNotice 闪。
      if (result && result.code === "GATEWAY_UNAVAILABLE") {
        // 网关这会儿不可达：顺手重拉清单，让下拉切到「网关不可用」。
        void aiBar.reload();
      }
    },
  });

  statusBar = createStatusBar({
    host: statusHost,
    store,
    onRetry: () => wsClient.retryNow(),
    onToggleAi: toggleAi,
  });
  statusBar.init();

  aiBar.init();

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
    const open = snapshot.aiOpen !== false;
    if (root.getAttribute("data-ai-open") !== (open ? "true" : "false")) applyAiOpen(open);
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
