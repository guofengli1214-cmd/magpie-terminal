// 唯一入口：只做编排。解析 query → 建 store → 建 WS → 建视图 → 启动。

import constants from "./core/constants.js";
import createSessionStore from "./core/session-store.js";
import createWsClient from "./core/ws-client.js";
import api from "./core/api.js";
import createTabBar, { shellShortName } from "./ui/tab-bar.js";
import createTerminalView from "./ui/terminal-view.js";
import createStatusBar from "./ui/status-bar.js";
import createAgentStore from "./core/agent-store.js";
import createAiDrawer from "./ui/ai-drawer.js";
import createToastStack from "./ui/toast.js";
import createSettingsPanel from "./ui/settings-panel.js";
import createRail from "./ui/rail.js";
import createHostsPanel from "./ui/hosts-panel.js";
import createFilePanel from "./ui/file-panel.js";

const root = document.querySelector('[data-role="app"]');
const railHost = document.querySelector('[data-role="rail"]');
const tabbarHost = document.querySelector('[data-role="tabbar"]');
const mainHost = document.querySelector('[data-role="main"]');
const terminalHost = document.querySelector('[data-role="terminal-host"]');
const aiDrawerHost = document.querySelector('[data-role="ai-drawer"]');
const aiHandle = document.querySelector('[data-role="ai-handle"]');
const aiHandleBadge = document.querySelector('[data-role="ai-handle-badge"]');
const toastHost = document.querySelector('[data-role="toast-stack"]');
const settingsHost = document.querySelector('[data-role="settings-host"]');
const statusHost = document.querySelector('[data-role="statusbar"]');
const filePanelHost = document.querySelector('[data-role="file-panel-host"]');

const store = createSessionStore();
// Agent 状态独立成 store（PROTOCOL-AGENT.md §7），视图订阅它而不是污染会话 store。
const agentStore = createAgentStore();

// TASK-FIX17-B：没有骨架时（node --test 直接 import 本文件的纯函数）不做
// 任何 DOM 副作用。页面里没有 `[data-role="app"]` 时下面的 init() 本来就跑不成，
// 所以这层守卫不是为了容错而存在，是为了让纯函数可单测。
const banner = document.createElement("div");
banner.setAttribute("data-role", "banner");
banner.setAttribute("role", "status");
banner.hidden = true;
// 提示条放进主区顶部（骨架里 root 是网格容器，往里塞第五个格子会破布局）。
if (mainHost) mainHost.insertBefore(banner, mainHost.firstChild);

let health = null;
let lastAttachedId = null;
// 重连时已发过 pty.attach、还在等 session.resumed / SESSION_GONE 的 id。
const resumePendingIds = new Set();
let aiDrawer = null;
let toastStack = null;
let settingsPanel = null;
let rail = null;
let tabBar = null;
let statusBar = null;
let terminalView = null;
let wsClient = null;
let hostsPanel = null;
let filePanel = null;
// 远程会话建连中的 hostId → 等 session.created 时补上的元数据（用于建标签后同步面板）。
let pendingRemoteHost = null;
// 刚发出、还没收到 session.created 的 pty.create 数。命中这些帧时只建标签并 attach，
// 绝不走恢复路径（不做 recentOutput replay）。
let pendingCreateCount = 0;

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
  // `theme-dark` / `theme-light` 是 A 批的类名，B 批的正式名字是 `is-dark` /
  // `is-light`（AC6 要求「类有对应 CSS 规则」，且 classes 在 tokens.css 里
  // 必须有真实声明）。这里两个都留：`theme-*` 兼容旧页面的外部引用，
  // `is-*` 由 applyTheme() 按**实际生效的背景色**写，不在这里猜。
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

// TASK-FIX17-B：同样的守卫。没有 `location` 时（node --test 直接 import 本文件）
// 用一份空选项，不抛错。
const options = typeof location === "undefined" ? { theme: null, lang: null, port: constants.DEFAULT_PORT } : parseQuery();
if (options.lang && typeof document !== "undefined") document.documentElement.lang = options.lang;

/* ======================================================================
 * 主主题链路（TASK-FIX17-B R1 / R2 / R3 / AC3 / AC6 / AC7）
 *
 * 数据流：
 *   GET /api/theme ──▶ applyTheme(payload)
 *                       ├─ 写 --magpie-* 到 <html>（变量变成真的）
 *                       ├─ 算亮度 → is-dark / is-light（AC6）
 *                       ├─ 写 --mt-font-scale + 根字号（AC7）
 *                       └─ terminalView.refreshTheme()（所有实例，AC5）
 *
 * 为什么是**轮询**而不是事件：magpie 改主题时，插件页面已经不在带路页了，
 * `window.magpie` 在这个 origin 是 undefined（page/index.html:29 →
 * boot.js:98），bridge 的 onTheme 收不到。magpie 也没有其它持久通道。
 * 服务端现读 `~/.config/magpie/settings.json`（带 mtime 缓存）是唯一可靠来源，
 * 轮询是让它「实时」的最小代价：一次 200 字节的 loopback GET。
 *
 * 可测性（卡里的约束）：纯计算部分（亮度、字号、差异比较）导出成纯函数，
 * 轮询用可注入的 `setTimer` / `clearTimer`，所以 AC3 能用假定时器推。
 * ====================================================================== */

/** 轮询间隔（毫秒）。magpie 改设置是人工动作，1 秒足够快且能忽略不计。 */
const THEME_POLL_MS = 1000;

/**
 * 解析 CSS 色值成 `[r,g,b]`。
 * 支持 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`。
 * 解析不了返回 null（调用方据此保留上一次的判定，不默认成深色）。
 *
 * @param {unknown} value
 * @returns {[number,number,number]|null}
 */
export function parseCssColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(text);
  if (hex) {
    const body = hex[1];
    const expand = (s) => Number.parseInt(s.length === 1 ? s + s : s, 16);
    if (body.length === 3 || body.length === 4) {
      return [expand(body[0]), expand(body[1]), expand(body[2])];
    }
    if (body.length === 6 || body.length === 8) {
      return [
        Number.parseInt(body.slice(0, 2), 16),
        Number.parseInt(body.slice(2, 4), 16),
        Number.parseInt(body.slice(4, 6), 16),
      ];
    }
    return null;
  }
  const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
  if (fn) {
    return [
      Math.min(255, Math.max(0, Math.round(Number(fn[1])))),
      Math.min(255, Math.max(0, Math.round(Number(fn[2])))),
      Math.min(255, Math.max(0, Math.round(Number(fn[3])))),
    ];
  }
  return null;
}

/**
 * sRGB 相对亮度（WCAG 定义，gamma 展开后再加权）。
 * @param {[number,number,number]} rgb
 * @returns {number} 0（黑）… 1（白）
 */
export function relativeLuminance(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return 0;
  const channel = (v) => {
    const c = Math.min(255, Math.max(0, Number(v))) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** 亮度阈值：与研究卡 design.md 一致。 */
export const DARK_LUMINANCE_THRESHOLD = 0.45;

/**
 * 由背景色判定深浅色。
 * 服务端已经算过一遍（它知道 magpie 的 `theme` 设置），这里是**第二道保险**：
 * 万一注入的颜色与设置不符（用户自定义主题、`color-mix()` 解析差异），
 * 以「实际渲染出来的背景色」为准，避免页面变成「半套深色半套浅色」。
 *
 * @param {unknown} bg
 * @returns {"dark"|"light"|null} 解析不了返回 null（调用方保留旧判定）
 */
export function schemeForBackground(bg) {
  const rgb = parseCssColor(bg);
  if (!rgb) return null;
  return relativeLuminance(rgb) < DARK_LUMINANCE_THRESHOLD ? "dark" : "light";
}

/**
 * magpie 的 `textSize`（百分比）转成根字号（px）。
 * 夹在 80…160%：magpie 的设置面板自己也只给这个区间，超出不是「更大的字」而是
 * 「布局碎掉」，所以宁可夹住。
 *
 * @param {unknown} percent
 * @returns {number} px
 */
export function fontPxForTextSize(percent) {
  const value = Number(percent);
  const clamped = Number.isFinite(value) ? Math.min(160, Math.max(80, value)) : 100;
  return Math.round(13 * (clamped / 100) * 100) / 100;
}

/** 上一套主题的指纹：key 变才动手，避免每秒重写 CSS 变量、每秒重画 xterm。 */
let lastThemeKey = null;

/**
 * 把一份 `/api/theme` 响应应用到页面。**纯 DOM 操作**，不取网络。
 *
 * @param {{tokens?:Record<string,string>, scheme?:string, textSize?:number, lang?:string}} payload
 * @param {object} [deps]
 * @param {{documentElement?:object}|object} [deps.doc] 传入 Document 或直接传 `<html>` 元素
 * @param {(info:{scheme:string,first:boolean,fontPx:number}) => void} [deps.onChanged]
 * @returns {{changed:boolean, scheme:"dark"|"light", key:string}}
 */
export function applyThemePayload(payload, deps = {}) {
  const doc = deps.doc || document;
  // 接受 Document（有 documentElement）或直接给 `<html>` 元素：两种调用方式都支持，
  // 单测可以只搭一个极简 `<html>` 桩，不必造整份 Document。
  const root = doc.documentElement || doc;
  const tokens = payload && typeof payload.tokens === "object" && payload.tokens ? payload.tokens : {};
  const onChanged = typeof deps.onChanged === "function" ? deps.onChanged : null;

  const scheme =
    payload && (payload.scheme === "dark" || payload.scheme === "light")
      ? payload.scheme
      : schemeForBackground(tokens["--magpie-bg"]) || "light";
  const fontPx = fontPxForTextSize(payload ? payload.textSize : 100);

  const key = JSON.stringify({ t: tokens, s: scheme, f: fontPx });
  if (key === lastThemeKey) return { changed: false, scheme, key };
  const first = lastThemeKey === null;
  lastThemeKey = key;

  // ① 变量：服务端已经过白名单，这里原样写。
  for (const [name, value] of Object.entries(tokens)) {
    if (!/^--[a-z0-9-]+$/.test(name)) continue;
    if (typeof value !== "string" || !value) continue;
    try {
      root.style.setProperty(name, value);
    } catch {
      // 非法值：跳过这一个，不影响其余变量。
    }
  }

  // ② 深浅色类（AC6）。两个类互斥，永远只留一个。
  root.classList.toggle("is-dark", scheme === "dark");
  root.classList.toggle("is-light", scheme !== "dark");
  // color-scheme 让滚动条 / 原生控件也跟着走（UA 绘制的部件只认它）。
  root.style.colorScheme = scheme;
  // 标记「服务端已给过主题」：tokens.css 里那条兜底底色只在**没有**这个标记时生效。
  root.setAttribute("data-mt-served", "1");

  // ③ 字号（AC7）：magpie 的 textSize 映射到根字号与终端的 --term-font-size。
  root.style.fontSize = `${fontPx}px`;
  root.style.setProperty("--mt-font-scale", String(Math.round((fontPx / 13) * 1000) / 1000));

  // ④ 通知终端。**所有**实例都要重上色（AC5）：xterm 的 theme 是构造时的
  //    JS 对象，改 CSS 变量不会自动生效（theme-tokens.md §4）。
  if (onChanged) onChanged({ scheme, first, fontPx });
  return { changed: true, scheme, key };
}

/** 只给测试用：清掉指纹缓存，让下一发 applyThemePayload 一定生效。 */
export function resetThemeFingerprint() {
  lastThemeKey = null;
}

function createTab(frameOptions) {
  const shellId =
    frameOptions && typeof frameOptions.shellId === "string" ? frameOptions.shellId : null;
  if (store.getSnapshot().sessions.length >= constants.TAB_LIMIT) {
    showBanner(`标签数量已达上限（${constants.TAB_LIMIT}）。关掉一个再新建。`);
    setTimeout(hideBanner, 5000);
    return;
  }
  // 一次就以终端真实尺寸建 PTY：服务端不会按 80×24 建完再被 resize 触发 SIGWINCH，
  // bash 少一次重画提示符（V4-E 第 6 步）。
  const size = terminalView ? terminalView.proposeDimensions() : { cols: 80, rows: 24 };
  const frame = { type: "pty.create", cols: size.cols, rows: size.rows };
  // TASK-V4-F：只有显式指定时才带 shellId（不带 = 保持旧行为）。
  if (shellId) frame.shellId = shellId;
  const sent = wsClient.send(frame);
  if (!sent) {
    statusBar.setHealth(health);
    showBanner("新建标签没发出去：连接还没就绪。点状态栏「重连」后重试。");
    setTimeout(hideBanner, 5000);
    return;
  }
  pendingCreateCount += 1;
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
  pendingCreateCount += 1;
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

/** 远程会话的展示地址 `host:port`（端口是 22 就不写，卡片 D5：两行徒标不超过 120px）。 */
function remoteAddrOf(frame) {
  const host = frame && typeof frame.host === "string" ? frame.host : "";
  if (!host) return null;
  const port = Number(frame.port);
  return Number.isFinite(port) && port > 0 && port !== 22 ? `${host}:${port}` : host;
}

function handleFrame(frame) {
  switch (frame.type) {
    case "session.created": {
      const id = frame.id;
      const isRemote = frame.kind === "remote";
      // 这一帧是不是刚发出去的 pty.create 的回执？命中就绝不做恢复式 replay。
      const isFreshCreate = pendingCreateCount > 0;
      if (isFreshCreate) pendingCreateCount -= 1;
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
        hostAddr: isRemote ? remoteAddrOf(frame) : null,
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
      if (isFreshCreate) {
        // 新会话：服务端已经在 pty.create 时按正确尺寸建好，不需要 attach 去换尺寸，
        // 更没有 recentOutput 需要 replay。
        if (store.getSnapshot().activeId === id) terminalView.attach(id);
      } else {
        attachActive();
      }
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
          hostAddr: isRemote ? remoteAddrOf(frame) : null,
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
          hostAddr: isRemote ? remoteAddrOf(frame) || existing.hostAddr || null : null,
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
    case "session.cwd": {
      // TASK-V4-G §5.1：服务端从 OSC 7 解出来的当前目录。
      // 先写进 store（状态栏 / AI 上下文都读它），再交给文件面板决定要不要跳。
      if (frame.id && store.getSession(frame.id) && typeof frame.cwd === "string") {
        store.patchSession(frame.id, { cwd: frame.cwd });
      }
      if (filePanel) filePanel.onSessionCwd(frame.id, frame.cwd);
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
      // 内核未就绪的显式信号（TASK-V3-C §6.7）：agent.run 被服务端判成坏帧。
      // 只有在「刚发了 agent.run、还没收到任何 agent.* 帧」时才这么解读，
      // 避免把普通 pty 错误误报成内核缺失。
      if (
        frame.code === "BAD_FRAME" &&
        pendingAgentRequestId &&
        agentStore &&
        agentStore.getSnapshot().status === "running" &&
        // 只有「这个 BAD_FRAME 针对的就是当前活动任务」时才当成内核未就绪：
        // 别的任务还在跑时，新请求被拒不能把老任务的界面清掉（修复 B/C 的配套）。
        agentStore.getSnapshot().requestId === pendingAgentRequestId &&
        aiDrawer
      ) {
        const wasPending = pendingAgentRequestId;
        pendingAgentRequestId = null;
        aiDrawer.handleBadFrame();
        logInternal(`agent.run 被服务端拒为 BAD_FRAME（requestId=${wasPending}）`);
        return;
      }
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
      // 旧的单命令路径（保留）：降级渲染进抽屉，确认卡也在抽屉里。
      if (aiDrawer) aiDrawer.onLegacyReply(frame);
      arriveAiResult();
      return;
    }
    case "ai.error": {
      if (aiDrawer) aiDrawer.onLegacyError(frame);
      arriveAiResult();
      return;
    }
    case "agent.start": {
      if (aiDrawer) aiDrawer.notifyAgentFrame();
      clearPendingAgentRequest(frame);
      agentStore.onStart(frame);
      // 新一轮拿到真实 service 会话 id 后，刷新会话列表（标题/条数）。
      void refreshAiSessions();
      return;
    }
    case "agent.step": {
      if (aiDrawer) aiDrawer.notifyAgentFrame();
      clearPendingAgentRequest(frame);
      agentStore.onStep(frame);
      return;
    }
    case "agent.text": {
      // AC13：流式文本增量（工具与审批仍然走 agent.step / agent.approval）。
      if (aiDrawer) aiDrawer.notifyAgentFrame();
      clearPendingAgentRequest(frame);
      agentStore.onText(frame);
      return;
    }
    case "agent.reasoning": {
      if (aiDrawer) aiDrawer.notifyAgentFrame();
      clearPendingAgentRequest(frame);
      agentStore.onReasoning(frame);
      return;
    }
    case "agent.approval": {
      if (aiDrawer) aiDrawer.notifyAgentFrame();
      clearPendingAgentRequest(frame);
      agentStore.onApproval(frame);
      return;
    }
    case "agent.done": {
      if (aiDrawer) aiDrawer.notifyAgentFrame();
      clearPendingAgentRequest(frame);
      agentStore.onDone(frame);
      void refreshAiSessions();
      return;
    }
    case "agent.error": {
      if (aiDrawer) aiDrawer.notifyAgentFrame();
      clearPendingAgentRequest(frame);
      const result = agentStore.onError(frame);
      // 被作用域挡下的错误（例如另一个 requestId 的 BUSY）：不动当前状态，只给一句轻提示。
      if (result && result.applied === false) {
        if (frame && frame.code === "BUSY" && statusBar) {
          statusBar.setNotice(
            frame.userText || "上一个任务还在跑，等它结束或点停止。",
            "warn",
          );
        }
        logInternal(
          `丢弃不属于当前任务的 agent.error（code=${frame && frame.code} requestId=${frame && frame.requestId}）`,
        );
      }
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
  // TASK-FIX17-A R4：attach 之前先把配色与 CSS 变量对齐。
  // 首帧渲染与令牌注入都在 attach 之前，不在这里同步就会「页面浅色、终端一片黑」。
  if (terminalView) terminalView.refreshTheme();
  // 只做 attach：fit 由 terminal-view 在下一帧按容器真实尺寸算，
  // 这里绝不能在 fit 之前用终端初始 80×24 去 sendResize（那会多一次 SIGWINCH 重画提示符）。
  terminalView.attach(snapshot.activeId);
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
  // TASK-FIX-RECONNECT O2：口令已作废（自动刷新过一次仍连不上）→ 状态栏提示手动刷新。
  if (status.staleToken === true) store.setStaleToken(true);
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

/* ------------------------------------------------------------------ *
 * AI 抽屉（TASK-V4-E）：默认收起，主区右缘把手点一次开、再点收起。
 * 抽屉是覆盖层，开合只动 #root[data-ai-open]；绝不触发终端 fit / pty.resize。
 * ------------------------------------------------------------------ */

let pendingAgentRequestId = null;
// V4-H：上一次已切过 AI 会话的终端 id（避免 store 每帧变更都重算会话）。
let lastFocusedTerminalId = null;

/* ------------------------------------------------------------------ *
 * V4-H：AI 会话列表 / 终端归属 / 会话切换
 * ------------------------------------------------------------------ */

/** 从本地会话 store 算该标签的归属（会话列表分组 + 徒标靠它）。 */
function terminalMetaOf(session) {
  if (!session) return null;
  const remote = session.kind === "remote";
  return {
    id: session.id,
    kind: remote ? "remote" : "local",
    shell: session.shell || "shell",
    hostId: remote ? session.hostId || null : null,
    hostName: remote ? session.hostName || null : null,
    hostAddr: remote ? session.hostAddr || null : null,
    cwd: session.cwd || "",
    label: shortLabelOf(session),
  };
}

/** 标签短名：bash: 41807 / PS7: 1234 / 主机名（与 tab-bar 同口径，直接复用 titleFor 的 shell 段）。 */
function shortLabelOf(session) {
  if (!session) return "本机";
  if (session.kind === "remote") return session.hostName || "远程主机";
  const shell = shellShortName(session.shell);
  const cwd = String(session.cwd || "");
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const tail = parts.length > 0 ? parts[parts.length - 1] : "";
  return tail ? `${shell}: ${tail}` : shell;
}

/** 当前活动终端（抽屉上下文条 / 会话归属读它）。 */
function activeTerminalMeta() {
  const active = store.getActive();
  if (!active) return null;
  const meta = terminalMetaOf(active);
  if (meta) meta.serviceSessionId = meta.id;
  return meta;
}

let sessionListToken = 0;

/** GET /api/ai/sessions → agentStore.setSessionsList（服务端是唯一事实来源）。 */
async function refreshAiSessions() {
  const token = ++sessionListToken;
  const current = agentStore.getCurrentSessionId();
  const result = await api.aiSessions(current);
  if (token !== sessionListToken) return null;
  if (!result.ok) return null;
  const payload = result.data || {};
  agentStore.setSessionsList(Array.isArray(payload.sessions) ? payload.sessions : []);
  return payload.sessions || [];
}

/** 切终端标签 → 抽屉切到该终端绑定的会话（卡片 §5.5）。 */
function focusTerminalSession() {
  const meta = activeTerminalMeta();
  if (!meta) return;
  agentStore.focusTerminal(meta.id, meta);
  // 已落的会话要把时间线拉回来（刷新后 / 切回标签）。
  const bound = agentStore.getSnapshot().sessions.find((item) => item.terminalId === meta.id);
  if (bound) void restoreSessionIfNeeded(bound.id);
}

const restoredSessionIds = new Set();

async function restoreSessionIfNeeded(sessionId) {
  if (!sessionId || restoredSessionIds.has(sessionId)) return;
  restoredSessionIds.add(sessionId);
  const result = await api.aiSession(sessionId);
  if (!result.ok || !result.data) {
    restoredSessionIds.delete(sessionId);
    return;
  }
  agentStore.restoreSession(sessionId, result.data);
}

/** 只清掉「这一帧对应的」待确认 requestId，别把刚发出去的那次请求抹了。 */
function clearPendingAgentRequest(frame) {
  if (!pendingAgentRequestId) return;
  const requestId = frame && typeof frame.requestId === "string" ? frame.requestId : null;
  if (!requestId || requestId === pendingAgentRequestId) pendingAgentRequestId = null;
}

function logInternal(text) {
  try {
    console.info(`[magpie-terminal] ${text}`);
  } catch {
    // 忽略。
  }
}

function openDrawer({ focus = false } = {}) {
  store.setAiOpen(true);
  store.setAiUnread(false);
  applyAiOpen(true);
  if (focus && aiDrawer) aiDrawer.focusInput();
}

function closeDrawer() {
  store.setAiOpen(false);
  applyAiOpen(false);
}

function toggleAi() {
  if (store.getSnapshot().aiOpen === true) closeDrawer();
  else openDrawer({ focus: true });
}

/** #root[data-ai-open] / 把手 aria-expanded 的唯一同步点。
 *  覆盖式抽屉不改终端宽度，所以这里绝不调用 terminalView.resizeAll()/fit：
 *  那会触发 pty.resize → SIGWINCH → bash 多画一行提示符。
 *
 *  TASK-V4-S §6.9（P0-焦点-b）：收起态必须真的不可交互。
 *  只靠 `transform: translateX(100%)` 把抽屉挪出视野不够 —— 里面的输入框仍然
 *  能 Tab 到、能程序聚焦、能打字、回车能把请求发出去（VERIFY-V4-G §7 用 CDP
 *  打 20 个字符全都进了看不见的输入框，用户完全看不到自己打了什么）。 */
function applyAiOpen(open) {
  root.setAttribute("data-ai-open", open ? "true" : "false");
  if (aiDrawerHost) {
    // 三重关死：inert 挡聚焦与点击，aria-hidden 挡读屏，CSS visibility 兜底旧 WebView2
    //（旧内核不认 inert 时至少还看不见、点不到）。
    if (open) {
      aiDrawerHost.removeAttribute("inert");
      aiDrawerHost.removeAttribute("aria-hidden");
    } else {
      aiDrawerHost.setAttribute("inert", "");
      aiDrawerHost.setAttribute("aria-hidden", "true");
      // 焦点如果还在抽屉里，挪到把手上 —— 否则 inert 会让焦点掉到 <body>，
      // 下一次 Tab 从头开始，用户会以为自己按丢了。
      const active = document.activeElement;
      if (active && aiDrawerHost.contains(active)) {
        try {
          if (aiHandle) aiHandle.focus();
        } catch {
          // 忽略。
        }
      }
    }
  }
  if (aiHandle) {
    aiHandle.setAttribute("aria-expanded", open ? "true" : "false");
    aiHandle.setAttribute("title", open ? "收起 AI 助手" : "打开 AI 助手");
  }
}

/**
 * AI 结果到达时该做什么：
 * - 抽屉已经展开 → 用户看得到，清掉未读；
 * - 抽屉收起 → 不抢终端焦点，只记下未读（V4-E 已无 rail 小圆点，
 *   待确认另有把手角标 + toast，见 syncAgentBadge()）。
 */
function arriveAiResult() {
  if (store.getSnapshot().aiOpen === true) {
    store.setAiUnread(false);
    return;
  }
  store.setAiUnread(true);
}

/** agent-store 的待确认条数 → 把手角标（data-badge 与文字同步）。 */
function syncAgentBadge(snapshot) {
  const count = snapshot.pendingApprovals ? snapshot.pendingApprovals.length : 0;
  if (aiHandle) {
    aiHandle.setAttribute("data-badge", String(count));
    aiHandle.setAttribute(
      "title",
      count > 0 ? `打开 AI 助手（${count} 条待确认）` : "打开 AI 助手",
    );
  }
  if (aiHandleBadge) {
    aiHandleBadge.textContent = String(count);
    aiHandleBadge.hidden = count === 0;
  }
  // rail 上的小圆点也要跟着待确认走（rail.subscribe 用的是同一个 store）。
  store.setPendingCount(count);
}

/**
 * 浏览器自己看到的系统深浅色（magpie 的 `theme: "system"` 靠它判断）。
 * 拿不到（老 WebView2 没有 matchMedia）就返回 null，让服务端用已知信息推。
 * @returns {"dark"|"light"|null}
 */
function systemPreference() {
  try {
    if (typeof window.matchMedia !== "function") return null;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return null;
  }
}

/** 主题轮询的返回句柄：只给测试 / 页面卸载时用。 */
let themeSync = null;

/**
 * 启动主题同步（AC3 的「不刷新就变色」就是由它保证的）。
 *
 * 四个触发点：
 *   ① 启动时立刻一发（首帧注入可能没覆盖到，比如在普通浏览器里打开）
 *   ② 每 `THEME_POLL_MS` 一发（magpie 改设置 → 下一拍就生效）
 *   ③ `visibilitychange` 回到可见时立刻一发（后台标签页的定时器会被节流）
 *   ④ `focus` 时也立刻一发（与③互补：有些 WebView 不发 visibilitychange）
 *
 * 所有定时器都可注入，所以单测不用真等 1 秒（见 test/app/theme-sync.test.mjs）。
 *
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.fetchTheme] 取主题的函数（默认走 api.theme）
 * @param {(payload:object) => object} [deps.apply] 应用主题的函数
 * @param {(fn:() => void, ms:number) => any} [deps.setTimer]
 * @param {(handle:any) => void} [deps.clearTimer]
 * @param {number} [deps.intervalMs]
 * @param {EventTarget} [deps.events] 监听 visibilitychange / focus 的目标
 * @returns {{stop:()=>void, tick:()=>Promise<object|null>}}
 */
export function createThemeSync(deps = {}) {
  const fetchTheme = typeof deps.fetchTheme === "function" ? deps.fetchTheme : () => api.theme(systemPreference());
  const apply =
    typeof deps.apply === "function"
      ? deps.apply
      : (payload) =>
          applyThemePayload(payload, {
            onChanged: () => {
              // **所有**终端实例都要重上色（AC5）：refreshTheme() 内部遍历 views。
              if (terminalView) terminalView.refreshTheme();
            },
          });
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof deps.clearTimer === "function" ? deps.clearTimer : (h) => clearTimeout(h);
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : THEME_POLL_MS;
  const events = deps.events === undefined ? (typeof window !== "undefined" ? window : null) : deps.events;

  let stopped = false;
  let timer = null;
  let inFlight = false;

  async function tick() {
    if (stopped || inFlight) return null;
    inFlight = true;
    let result = null;
    try {
      const response = await fetchTheme();
      // api.theme() 把非 2xx 统一成 {ok:false}；拿不到就保留当前配色（不白屏）。
      if (response && response.ok && response.data) result = apply(response.data);
    } catch {
      // 网络抖动：下一拍再试。主题不是关键路径，绝不让它把页面弄崩。
    } finally {
      inFlight = false;
    }
    return result;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimer(() => {
      tick();
      schedule();
    }, intervalMs);
  }

  function onVisible() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    tick();
  }

  // ③④ 事件驱动：后台标签页的 setInterval 会被节流到分钟级，
  // 靠这两个事件保证「切回 magpie 窗口时颜色已经是对的」。
  if (events && typeof events.addEventListener === "function") {
    events.addEventListener("visibilitychange", onVisible);
    events.addEventListener("focus", onVisible);
  }

  const handle = {
    tick,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (events && typeof events.removeEventListener === "function") {
        events.removeEventListener("visibilitychange", onVisible);
        events.removeEventListener("focus", onVisible);
      }
    },
  };
  tick();
  schedule();
  return handle;
}

function startThemeSync() {
  if (themeSync) return themeSync;
  themeSync = createThemeSync();
  if (typeof window !== "undefined") window.addEventListener("beforeunload", () => themeSync && themeSync.stop());
  return themeSync;
}

function init() {
  applyAiOpen(store.getSnapshot().aiOpen);

  tabBar = createTabBar({
    host: tabbarHost,
    store,
    onCreate: (options) => createTab(options),
    // 「+」菜单里的主机分组：连主机走同一个建连函数（不复制逻辑）。
    onConnectHost: (host) => createRemoteTab(host),
    onOpenHosts: () => {
      if (hostsPanel) hostsPanel.open();
    },
    // 菜单数据：本机 shell 清单 + 已配置主机。任一边读不到都不抦整个菜单。
    loadMenu: async () => {
      const [shells, hosts] = await Promise.all([api.shells(), api.hosts()]);
      return {
        shells: shells.ok && shells.data && Array.isArray(shells.data.shells) ? shells.data.shells : [],
        defaultShell: shells.ok && shells.data ? shells.data.default : null,
        hosts: hosts.ok && hosts.data && Array.isArray(hosts.data.hosts) ? hosts.data.hosts : [],
      };
    },
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
    onOpenSettings: () => {
      if (settingsPanel) settingsPanel.open();
    },
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

  hostsPanel = createHostsPanel({    api,
    store,
    // 面板盖住终端区，但不遮标签栏 / 状态栏（底部 AI 条在 V3 已删除）。
    anchor: tabbarHost,
    bottomAnchors: [statusHost],
    onCreateSession: (host) => createRemoteTab(host),
    // TASK-V4-F：主机面板顶部的「本机」条目点击 = 用当前默认 shell 新开一个标签。
    onCreateLocal: (shellId) => createTab(shellId ? { shellId } : null),
    onNotice: (text, tone) => statusBar && statusBar.setNotice(text, tone),
    // TASK-V4-G：主机面板不再自带文件树，只负责把用户送到终端的文件面板。
    onOpenFiles: () => {
      if (filePanel) filePanel.setOpen(true);
    },
  });
  hostsPanel.init();

  /* ---------------- AI 抽屉（V3 取代底部 AI 条） ---------------- */

  aiDrawer = createAiDrawer({
    host: aiDrawerHost,
    agentStore,
    api,
    onNotice: (text, tone) => statusBar && statusBar.setNotice(text, tone),
    /** 抽屉读当前终端（上下文条 / 会话头 / 会话归属）。 */
    getTerminal: () => activeTerminalMeta(),
    /** 按 PTY 会话 id 找终端（会话下拉的组标题用它的真名）。 */
    getTerminalById: (id) => {
      const session = store.getSession(id);
      return session ? terminalMetaOf(session) : null;
    },
    /** 「新会话」按钮：起一个空会话，不写服务端记录（发第一条消息才落盘）。 */
    onNewSession: () => {
      const meta = activeTerminalMeta();
      if (!meta) return false;
      agentStore.newDraft(meta.id, meta);
      return true;
    },
    /** 下拉里点一条会话 → 切过去并拉全文。 */
    onSelectSession: (sessionId) => {
      if (!sessionId) return false;
      agentStore.selectSession(sessionId);
      void restoreSessionIfNeeded(sessionId);
      return true;
    },
    /** 重命名会话：PATCH /api/ai/sessions/:id。 */
    onRenameSession: ({ sessionId, title }) => {
      void api.renameAiSession(sessionId, title).then((result) => {
        if (!result.ok) {
          statusBar.setNotice(result.userText || "重命名没成功。", "warn");
          return;
        }
        agentStore.renameSession(sessionId, (result.data && result.data.title) || title);
        statusBar.setNotice("会话已改名", "ok");
        void refreshAiSessions();
      });
      return true;
    },
    /** 删除会话：DELETE，忙会话（409）照实说。 */
    onDeleteSession: ({ sessionId }) => {
      void api.deleteAiSession(sessionId).then((result) => {
        if (!result.ok) {
          statusBar.setNotice(result.userText || "删除没成功。", "warn");
          return;
        }
        if (agentStore.getCurrentSessionId() === sessionId) {
          const meta = activeTerminalMeta();
          if (meta) agentStore.focusTerminal(meta.id, meta);
        }
        agentStore.dropSession(sessionId);
        restoredSessionIds.delete(sessionId);
        statusBar.setNotice("会话已删除", "ok");
        void refreshAiSessions();
      });
      return true;
    },
    // 发 agent.run（字段逐字按 PROTOCOL-AGENT.md §3.1）。
    // 返回值："sent" | "blocked-pending" | "no-active" | "send-failed"（ai-drawer 按它决定是否清输入框）。
    onAsk: ({ question, model }) => {
      // 门禁（修复 B/D6）：有待确认时不许开新任务，一个状态都不动。
      const before = agentStore.getSnapshot();
      if (before.pendingApprovals.length > 0) {
        statusBar.setNotice("先处理上面的待确认命令（或点停止），再问新的。", "warn");
        return "blocked-pending";
      }
      const active = store.getActive();
      if (!active) {
        statusBar.setNotice("还没有可用的终端标签：先点「+」新建一个。", "warn");
        return "no-active";
      }
      const requestId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const meta = terminalMetaOf(active);
      const context = {
        cwd: active.cwd || "",
        shell: active.shell || null,
        recentOutput: terminalView.recentOutput(active.id, constants.RECENT_OUTPUT_LINES) || "",
        sessionId: active.id,
        terminalKind: meta.kind,
        ...(meta.hostId ? { hostId: meta.hostId, hostName: meta.hostName, hostAddr: meta.hostAddr } : {}),
      };
      const frame = { type: "agent.run", requestId, question, context };
      // TASK-V4-H §5.2：续哪个 AI 会话（草稿不带：让服务端按终端兜底或新建）。
      const aiSessionId = agentStore.currentServerSessionId();
      if (aiSessionId) frame.sessionId = aiSessionId;
      if (model) frame.model = model;
      const sent = wsClient.send(frame);
      if (!sent) {
        statusBar.setNotice("AI 请求没发出去：连接还没就绪。点状态栏「重连」后重试。", "error");
        return "send-failed";
      }
      pendingAgentRequestId = requestId;
      // 有活动任务时 beginRun 只记下这次请求、不清当前状态（等 agent.start 再切）。
      const begun = agentStore.beginRun({ requestId, question });
      if (begun && begun.adopted === false) {
        logInternal(`上一个任务还在跑，本次 agent.run 等 agent.start 再接管（requestId=${requestId}）`);
      }
      openDrawer();
      return "sent";
    },
    // 审批按钮 → agent.approve（scope 默认 once；requestId 必须取当前活动任务）。
    onApprove: ({ approvalId, approved, scope }) => {
      const snapshot = agentStore.getSnapshot();
      const requestId = snapshot.requestId;
      if (!requestId) return false;
      const frame = {
        type: "agent.approve",
        requestId,
        approvalId,
        approved: Boolean(approved),
        scope: scope === "rest" ? "rest" : "once",
      };
      const sent = wsClient.send(frame);
      if (!sent) {
        statusBar.setNotice("审批没发出去：连接断了。点状态栏「重连」后重试。", "error");
        return false;
      }
      // 立刻收尾本地状态（修复 D4）：不等内核补 agent.step{running}。
      agentStore.removeApproval(approvalId, Boolean(approved));
      return true;
    },
    onStop: () => {
      const snapshot = agentStore.getSnapshot();
      if (!snapshot.requestId) return;
      wsClient.send({ type: "agent.stop", requestId: snapshot.requestId });
      agentStore.markStopped();
    },
    // 旧 ai.reply 的确认卡走本地直接写 PTY（不发 ai.confirm，保持原行为）。
    onExecuteLegacy: (command) => {
      const active = store.getActive();
      if (!active) {
        statusBar.setNotice("当前没有活动终端标签，命令没有执行。", "error");
        return;
      }
      wsClient.send({ type: "pty.input", id: active.id, data: `${command}
` });
      statusBar.setNotice(`已写入当前标签：${command}`, "info");
    },
  });
  aiDrawer.init();

  toastStack = createToastStack({
    host: toastHost,
    agentStore,
    sessionStore: store,
    onGoConfirm: (approvalId) => {
      openDrawer();
      requestAnimationFrame(() => {
        if (aiDrawer) aiDrawer.scrollToApproval(approvalId);
      });
    },
  });
  toastStack.init();

  // TASK-V4-G：文件面板（终端下方）。入口是 rail-files，默认按上次的状态。
  // 高度变化会改变终端可用高度 → 让 xterm 重新 fit（走常规 resize 管道）。
  filePanel = createFilePanel({
    host: filePanelHost,
    api,
    store,
    onNotice: (text, tone) => statusBar && statusBar.setNotice(text, tone),
  });
  filePanel.init();
  window.addEventListener("magpie:file-panel-resize", () => {
    if (terminalView) terminalView.resizeAll();
  });
  window.addEventListener("magpie:file-panel-toggle", () => {
    // 开合只改变高度：下一帧再 fit，避免读到旧布局。
    requestAnimationFrame(() => {
      if (terminalView) terminalView.resizeAll();
    });
  });

  settingsPanel = createSettingsPanel({    host: settingsHost,
    api,
    // TASK-V4-H §5.6：开关一变就反映到确认卡（不必等保存）。
    onShowEffectChange: (value) => {
      if (aiDrawer) aiDrawer.setShowApprovalEffect(value === true);
    },
    onSaved: () => statusBar && statusBar.setNotice("设置已保存", "ok"),
  });
  settingsPanel.init();

  // agent-store：待确认条数 → 把手角标 / rail 小圆点；status → 状态栏任务态。
  agentStore.subscribe((snapshot) => {
    syncAgentBadge(snapshot);
    store.setAgentStatus(snapshot.status);
    // 切到一个还没还原过、也没本地内容的会话 → 拉服务端全文填时间线。
    const id = snapshot.currentSessionId;
    if (id && !restoredSessionIds.has(id) && (!snapshot.turns || snapshot.turns.length === 0)) {
      if (snapshot.sessions.some((item) => item.id === id)) void restoreSessionIfNeeded(id);
    }
  });

  // V4-H：打开页面就拉一次会话列表（画下拉），并给首个标签绑上会话。
  void refreshAiSessions().then(() => focusTerminalSession());

  // 把手：点它开、再点收起（抽屉顶上不再有「收起」按钮）。
  if (aiHandle) {
    aiHandle.addEventListener("click", () => toggleAi());
  }

  statusBar = createStatusBar({
    host: statusHost,
    store,
    onRetry: () => wsClient.retryNow(),
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
    // V4-H：切终端标签 → 抽屉跳到该终端最近的会话（卡片 §5.5 / AC3）。
    if (snapshot.activeId && snapshot.activeId !== lastFocusedTerminalId) {
      lastFocusedTerminalId = snapshot.activeId;
      focusTerminalSession();
    }
    const open = snapshot.aiOpen === true;
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

  // TASK-FIX17-B R1：主题的**唯一驱动**。启动一发 + 1s 轮询 + 切回标签页时立刻一发。
  // 换掉 A 批的 matchMedia 监听：现在深浅色由 magpie 的设置决定，不由媒体查询。
  startThemeSync();

  // 调试出口：只读快照 + 假帧注入，仅 loopback。避免被打包/污染。
  // __termDebugFrame 的用途：验收探针在内核（TASK-V3-D）尚未合入时注入 agent.* 帧，
  // 以便单独验证前端渲染；与 __termDebug 同一层级的调试口，不参与业务逻辑。
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    Object.defineProperty(window, "__termDebug", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: () => structuredClone(store.getSnapshot()),
    });
    Object.defineProperty(window, "__termDebugFrame", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (frame) => handleFrame(frame),
    });
    Object.defineProperty(window, "__termDebugAgent", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: () => structuredClone(agentStore.getSnapshot()),
    });
    // 验收探针用：读某个标签的 xterm 缓冲区（提示符重复 / 总行数）。
    Object.defineProperty(window, "__termDebugBuffer", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (id) => {
        const snapshot = store.getSnapshot();
        const target = id || snapshot.activeId;
        return terminalView ? terminalView.bufferLines(target) : { cols: 0, rows: 0, lines: [] };
      },
    });
    // TASK-FIX17-B 验收用：读某个终端实例**真正在用**的 xterm theme 与字号。
    // 只看 CSS 变量不够 —— xterm 的 theme 是构造时的 JS 对象，改变量不会自动生效，
    // 「页面变白了、终端还是黑的」就是这么来的（AC5 要断言到这一层）。
    Object.defineProperty(window, "__termDebugTheme", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (id) => (terminalView ? terminalView.themeReport(id) : null),
    });
    // 慢网关模拟用：调整「内核未就绪」看门狗时长（毫秒）。
    Object.defineProperty(window, "__termDebugWatchdog", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (ms) => (aiDrawer ? aiDrawer.setReadyTimeout(ms) : null),
    });
    // TASK-V4-G：文件面板的只读快照（验收探针用）。
    Object.defineProperty(window, "__termDebugFiles", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: () => (filePanel ? structuredClone(filePanel.state) : null),
    });
  }
}

/* 启动。
 *
 * TASK-FIX17-B：加了 `root` 存在性判断。理由：本文件的其余导出
 * （`applyThemePayload` / `schemeForBackground` / `createThemeSync` / …）是**纯函数**，
 * 必须能被 `node --test` 直接 import 而不用拉一整套 DOM 桩。没骨架时不启动——
 * 这本来就是唯一合理的解释：页面里没有 `[data-role="app"]` 时，init() 内部
 * 每一句 `document.querySelector('[data-role="…"]')` 都会是 null，本来就跑不成。 */
if (root) init();
