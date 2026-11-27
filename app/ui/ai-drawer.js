// 右侧 AI 抽屉（TASK-V4-E → TASK-V4-H → TASK-FIX17-D）：会话选择 / 多轮时间线 / 输入区。
//
// 数据来源：core/agent-store.js 的订阅（agent.* 帧由 app.js 转进来）。
// 这里只渲染 + 发帧，不改 store 字段。
//
// data-role 名单是验收探针，逐字不许改（TASK-V4-H §6）：
//   保留：ai-drawer-head / model-select / agent-timeline / agent-question
//        agent-step(+data-status,+data-index) / agent-step-cmd / agent-step-out
//        agent-summary / agent-approval / approval-run / approval-rest / approval-skip
//        agent-input / model-menu / composer-box / agent-grow
//        agent-sessions / agent-sessions-toggle / agent-sessions-menu /
//        agent-session-item / agent-new / agent-session-badge / agent-reasoning /
//        approval-review / approval-review-tip
//   TASK-FIX17-L4 新增：conversation-reasoning（对话模型的推理强度下拉）
//   TASK-FIX17-D（问题 9/10/11）**删掉**的三个旧钩子：
//        agent-send（发送按钮） / agent-stop（停止按钮） / composer-hint（常驻提示行）
//        发送与停止合成一个元素 `data-role="composer-action"` + `.is-busy`；
//        提示改成 `textarea[data-role="agent-input"]` 的 placeholder。
//
// 降级路径：旧的 ai.reply / ai.error 仍然渲染成一条简化块（ai.reply 的 confirm
// 确认卡也搬进抽屉里，但仍是本地直接 pty.input，不发 ai.confirm）。
//
// TASK-FIX17-D 新增：AI 消息的 markdown 渲染（R5）。流式期间保持纯文本，
// 只在总结落地（agent.done → turn.summary）后把该条换成渲染后的 HTML。

// 相对路径（不是 `/vendor/...`）：浏览器里解析成同一个 URL（静态服务前缀已放行
// `/vendor/`），而 `node --test` 直接 import 本文件时也能解析 —— 以 `/` 开头的路径在
// Node 里是文件系统根，会 ENOENT。
import { renderMarkdown } from "../vendor/markdown/markdown.js";

// V4-E：输入框拖拽高度持久化 key（逐字固定）。
const COMPOSER_HEIGHT_KEY = "magpie.term.composerHeight";
const COMPOSER_LINE_HEIGHT = 19.375;
const COMPOSER_MAX_AUTO = 116;

/** TASK-FIX17-D R3：Enter 提示是 placeholder，不再占一行。 */
const INPUT_PLACEHOLDER = "Enter 发送 · Shift+Enter 换行";

/** 单个动作按钮的两种图标（14×14 描边 SVG，颜色跟随 currentColor）。 */
const ACTION_ICON_SEND =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const ACTION_ICON_STOP =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="7" y="7" width="10" height="10" rx="1.6"/></svg>';

const STEP_LABEL = {
  pending: "等待中",
  running: "进行中",
  awaiting: "等待确认",
  done: "已完成",
  failed: "失败",
  denied: "已拒绝",
  skipped: "已跳过",
};

/** 工具卡左侧状态图标（等/跑/成/败，卡片 §5.6）。 */
const STEP_GLYPH = {
  pending: "·",
  running: "◐",
  awaiting: "!",
  done: "✓",
  failed: "✗",
  denied: "✗",
  skipped: "–",
};

/** 角标四态（TASK-V4-H §5.6 / CHANGES-V4 §1.2）：ok / caution / danger / none。 */
const REVIEW_STATE = {
  safe: { state: "ok", label: "已审阅，判定安全", text: "安全，已审可放行" },
  caution: { state: "caution", label: "需要注意", text: "有改动，需要你判断" },
  danger: { state: "danger", label: "危险", text: "危险，必须你确认" },
  none: { state: "none", label: "未审阅", text: "未审阅，按需要确认处理" },
};

/**
 * 服务端 `REASONING_LEVELS`（src/config/store.mjs）的镜像。
 *
 * 只用于**过滤**：真网关的模型清单里会出现 `none` / `ultra` 这类值，而服务端
 * 的固定枚举只有这六个（PRD R1）。把服务端会 400 的值摆进下拉等于给用户挖坑，
 * 所以选项 = 模型给的档位 ∩ 这张表。选项来源仍然只有 /api/models。
 */
const REASONING_ACCEPTED = Object.freeze(["off", "low", "medium", "high", "xhigh", "max"]);

/**
 * 推理档位的中文名（TASK-FIX17-L4 R4）。
 *
 * 只做「显示层翻译」：选项本身**只能**来自 `/api/models` 的 `reasoningLevels`，
 * 这里多一个少一个都不会凭空造出档位（网关没给的档位永远不出现）。
 * 认不出的档位（网关将来加新档）原样显示，不隐藏、不猜。
 */
const REASONING_LABELS = Object.freeze({
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
});

function reasoningLabel(level) {
  const key = typeof level === "string" ? level : "";
  return REASONING_LABELS[key] || key;
}

/** tooltip 两段标题（逐字固定，CHANGES-V4 §4 第 4 条）。 */
const TIP_TITLE_EFFECT = "执行后会发生什么";
const TIP_TITLE_WHY = "为什么需要你确认";

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "className") node.className = value;
    else node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 毫秒 → 人类可读耗时（0.3s / 1.4s / 12s）。 */
function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`;
  const seconds = value / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

export default function createAiDrawer(elements) {
  const host = elements.host;
  const agentStore = elements.agentStore;
  const api = elements.api;
  const onAsk = typeof elements.onAsk === "function" ? elements.onAsk : () => false;
  const onApprove = typeof elements.onApprove === "function" ? elements.onApprove : () => false;
  const onStop = typeof elements.onStop === "function" ? elements.onStop : () => {};
  const onNotice = typeof elements.onNotice === "function" ? elements.onNotice : () => {};
  const onExecuteLegacy = typeof elements.onExecuteLegacy === "function" ? elements.onExecuteLegacy : () => {};
  const onNewSession = typeof elements.onNewSession === "function" ? elements.onNewSession : () => false;
  const onSelectSession = typeof elements.onSelectSession === "function" ? elements.onSelectSession : () => false;
  const onRenameSession = typeof elements.onRenameSession === "function" ? elements.onRenameSession : () => false;
  const onDeleteSession = typeof elements.onDeleteSession === "function" ? elements.onDeleteSession : () => false;
  const getTerminal = typeof elements.getTerminal === "function" ? elements.getTerminal : () => null;
  const getTerminalById =
    typeof elements.getTerminalById === "function" ? elements.getTerminalById : () => null;

  let models = [];
  let reachable = false;
  let loading = false;
  // 折叠状态与「展开过」记忆：重渲染时间线时不丢。
  const expandedSteps = new Set();
  const expandedReasoning = new Set();
  const collapsedGroups = new Set();
  let sessionsMenuOpen = false;
  let showApprovalEffect = false;
  // 旧路径（ai.reply / ai.error）的简化块，单独存着，重渲染时一起画。
  const legacyBlocks = [];
  // 内核未就绪的看门狗：发 agent.run 后 N 毫秒内没有任何 agent.* 帧 → 明说。
  let readyTimeoutMs =
    Number.isFinite(Number(elements.readyTimeoutMs)) && Number(elements.readyTimeoutMs) > 0
      ? Number(elements.readyTimeoutMs)
      : 5000;
  let readyWatchdog = null;
  let sawAgentFrame = false;
  let blockedHint = false;

  let modelSelect = null;
  let modelMenu = null;
  // TASK-FIX17-L4 R4：对话模型的推理强度下拉（模型按钮右侧）。
  let reasoningSelect = null;
  // 配置里的真值（null = 不指定 = 网关用自己的默认强度）。
  let conversationReasoning = null;
  let timeline = null;
  let input = null;
  let composerEl = null;
  // TASK-FIX17-D R4：发送/停止合成一个元素（旧的 sendButton / stopButton 已删）。
  let actionButton = null;
  let selectedModelId = null;
  let headEl = null;
  let sessionsButton = null;
  let sessionsMenu = null;
  let sessionsCount = null;
  let sessionsSub = null;
  let ctxBar = null;
  let newButton = null;

  /* ---------------- 结构 ---------------- */

  function buildShell() {
    host.textContent = "";

    // 头部：会话选择（点开下拉）+ 新建。没有「收起」，模型选择在输入框左侧。
    headEl = el("div", { "data-role": "ai-drawer-head", className: "drawer-head ai-head" });

    sessionsButton = el("button", {
      type: "button",
      "data-role": "agent-sessions-toggle",
      className: "sess",
      "aria-expanded": "false",
      "aria-haspopup": "menu",
      title: "切换会话",
    });
    const mark = el("span", { className: "sess-mark", "aria-hidden": "true" }, "▣");
    const main = el("span", { className: "sess-main" });
    const top = el("span", { className: "sess-top" });
    const titleEl = el("span", { className: "sess-title trunc" }, "还没有会话");
    const sep = el("span", { className: "sess-sep", "aria-hidden": "true" }, "·");
    sessionsCount = el("span", { className: "sess-count" }, "0 个会话");
    top.append(titleEl, sep, sessionsCount);
    // TASK-FIX17-U：初始占位与空态副标题保持同一句，避免头部三行重复同一件事。
    sessionsSub = el("span", { className: "sess-sub trunc" }, "问一句就行，我来动手。");
    main.append(top, sessionsSub);
    const caret = el("span", { className: "sess-caret", "aria-hidden": "true" }, "▾");
    sessionsButton.append(mark, main, caret);
    // 标题元素单独存一份引用（渲染时直接改 textContent，不重建头）。
    sessionsButton.__titleEl = titleEl;

    newButton = el("button", {
      type: "button",
      "data-role": "agent-new",
      className: "icon-btn",
      title: "新建会话",
      "aria-label": "新建会话",
    });
    newButton.textContent = "+";

    sessionsMenu = el("div", {
      "data-role": "agent-sessions-menu",
      className: "sess-menu",
      role: "menu",
      "aria-label": "会话列表",
      hidden: "",
    });

    // agent-sessions 是「会话选择器的外壳」：按钮 + 新建 + 菜单一体（下拉定位相对它）。
    const sessionsWrap = el("div", {
      "data-role": "agent-sessions",
      className: "agent-sessions",
    });
    sessionsWrap.append(sessionsButton, newButton, sessionsMenu);
    headEl.appendChild(sessionsWrap);
    host.appendChild(headEl);

    // 上下文条：告诉用户 AI 在哪儿执行（本机 / 主机名 + cwd）。
    ctxBar = el("div", { "data-role": "agent-ctx", className: "ai-ctx" });
    host.appendChild(ctxBar);

    timeline = el("div", {
      "data-role": "agent-timeline",
      className: "agent-timeline",
      "aria-live": "polite",
    });
    host.appendChild(timeline);

    // TASK-FIX17-D R3（问题 9/11）输入区结构：
    //   .composer
    //     .composer-topbar  ← 一行：模型下拉（左） / 单一动作按钮（右）
    //     .composer-box     ← 只有 textarea（撑满，无内嵌按钮）
    //     [model-menu]      ← 定位相对 .composer（topbar 的包含块不再是输入框）
    // 提示不再占一行：改成 `textarea.placeholder`（输入即覆盖 = 浏览器原生行为），
    // 旧的 `.composer-hint` / `composer-hint` 元素与 grid area 一并删除。
    composerEl = el("div", { className: "composer" });
    const topbar = el("div", { className: "composer-topbar" });

    modelSelect = el("button", {
      type: "button",
      "data-role": "model-select",
      "aria-label": "选择模型",
      "aria-expanded": "false",
      title: "选择模型",
      className: "model-text",
    });
    modelMenu = el("div", {
      "data-role": "model-menu",
      className: "model-menu",
      hidden: "",
    });

    // TASK-FIX17-L4 R4：推理强度（模型按钮**右侧**、同一行；不塞进输入框）。
    // 选项 = 当前模型的 reasoningLevels（来自 /api/models），首项「默认」value=""。
    // 模型不支持 / 清单为空 → 整个 select 隐藏（不编造档位）。
    reasoningSelect = el("select", {
      "data-role": "conversation-reasoning",
      className: "composer-reasoning",
      "aria-label": "推理强度",
      title: "对话模型的推理强度",
      hidden: "",
    });
    reasoningSelect.addEventListener("change", () => {
      void persistReasoning(reasoningSelect.value);
    });

    // TASK-FIX17-D R4（问题 10）：发送与停止合成同一个按钮 —— 单元素 + `.is-busy` 类。
    // 空闲：实心圆 + ↑（发送）；忙碌：红环 + 深色圆心（点它 = 停止）。
    // 仍然保留 `data-role="composer-action"` 作为探针钩子（AC6/AC7）。
    actionButton = el("button", {
      type: "button",
      "data-role": "composer-action",
      className: "composer-action",
      "aria-label": "发送",
      title: "发送（Enter）",
    });
    actionButton.innerHTML = ACTION_ICON_SEND;
    topbar.append(modelSelect, reasoningSelect, actionButton);

    const composerBox = el("div", {
      "data-role": "composer-box",
      className: "composer-box",
    });
    const grow = el("div", {
      "data-role": "agent-grow",
      className: "composer-grip",
      title: "拖动调整输入框高度（最高到抽屉高度的 40%）",
    });
    input = el("textarea", {
      "data-role": "agent-input",
      rows: "1",
      // R3：Enter 提示就是 placeholder —— 用户一输入就被覆盖，不占第二行、不抢焦点。
      placeholder: INPUT_PLACEHOLDER,
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "告诉 AI 要做什么",
    });
    composerBox.append(grow, input);
    composerEl.append(topbar, modelMenu, composerBox);
    host.appendChild(composerEl);
  }

  /* ---------------- 上下文条 / 会话头 ---------------- */

  function terminalMeta() {
    const terminal = getTerminal ? getTerminal() : null;
    if (terminal && typeof terminal === "object") return terminal;
    return null;
  }

  function renderCtx() {
    if (!ctxBar) return;
    ctxBar.textContent = "";
    const terminal = terminalMeta();
    // 0.3.0：没有终端就没有"AI 在哪儿执行"可报。整条不渲染，不挂「本机」占位。
    if (!terminal) {
      ctxBar.hidden = true;
      return;
    }
    ctxBar.hidden = false;
    const snapshot = agentStore.getSnapshot();
    const current = snapshot.sessions.find((item) => item.id === snapshot.currentSessionId) || null;
    const kind = current ? current.terminalKind : terminal && terminal.kind === "remote" ? "remote" : "local";
    ctxBar.appendChild(el("span", { className: "ctx-ico", "aria-hidden": "true" }, kind === "remote" ? "🖧" : "▣"));
    ctxBar.appendChild(el("b", {}, kind === "remote" ? (current && current.hostName) || (terminal && terminal.hostName) || "远程主机" : "本机"));
    ctxBar.appendChild(el("span", { "aria-hidden": "true" }, "·"));
    const shell = (current && current.shell) || (terminal && terminal.shell) || "shell";
    ctxBar.appendChild(el("span", {}, shell));
    const cwd = terminal && terminal.cwd ? terminal.cwd : "";
    if (cwd) {
      ctxBar.appendChild(el("span", { "aria-hidden": "true" }, "·"));
      ctxBar.appendChild(el("span", { className: "ctx-path trunc", title: cwd }, cwd));
    }
  }

  /* ---------------- 会话下拉（按终端分组） ---------------- */

  /** 把会话列表按终端分组：本机每个终端一组，每台远程主机一组（卡片 §2 第 4 条）。 */
  function groupSessions(snapshot) {
    const groups = new Map();
    const terminal = terminalMeta();
    const activeTerminalId = terminal && terminal.id ? terminal.id : "";
    for (const item of snapshot.sessions) {
      const isRemote = item.terminalKind === "remote";
      const key = isRemote
        ? `host:${item.hostId || item.hostName || "remote"}`
        : `local:${item.terminalId || "local"}`;
      if (!groups.has(key)) {
        const isCurrentTerminal = Boolean(item.terminalId) && item.terminalId === activeTerminalId;
        // 本机组的标题用该标签的真名（`bash: 41807`），两个本机标签不会都叫“本机”。
        const bound = !isRemote && item.terminalId ? getTerminalById(item.terminalId) : null;
        groups.set(key, {
          key,
          remote: isRemote,
          title: isRemote
            ? item.hostName || item.hostId || "远程主机"
            : (bound && bound.label) || `本机 · ${item.shell || "shell"}`,
          sub: isRemote ? `${item.hostAddr || "地址未知"} · ssh` : item.shell || "本机终端",
          terminalId: item.terminalId || "",
          isCurrentTerminal,
          items: [],
        });
      }
      groups.get(key).items.push(item);
    }
    const list = [...groups.values()];
    // 当前终端那一组置顶（卡片 §5.5）。
    list.sort((a, b) => Number(b.isCurrentTerminal) - Number(a.isCurrentTerminal));
    return list;
  }

  function sourceBadge(item) {
    const remote = item.terminalKind === "remote";
    const badge = el("span", {
      "data-role": "agent-session-badge",
      className: remote ? "src-badge k-ssh" : "src-badge k-local",
      title: remote
        ? `ssh ${item.hostName || ""} · ${item.hostAddr || ""}`
        : `本机 · ${item.shell || "shell"}`,
    });
    if (remote) {
      badge.appendChild(el("span", { className: "sb-t" }, item.hostName || item.hostId || "远程"));
      badge.appendChild(el("span", { className: "addr" }, item.hostAddr || "—"));
    } else {
      badge.appendChild(el("span", { className: "sb-t" }, item.shell || "shell"));
    }
    return badge;
  }

  /**
   * 行内重命名（TASK-V4-H：不靠 window.prompt）。
   *
   * 为什么不用 `window.prompt`：在 magpie 的沙箱 iframe / headless WebView 里它会
   * 阻塞甚至直接不返回（本机 CDP 实测 `Runtime.evaluate` 直接超时）。
   * 这里把标题就地换成一个输入框，Enter 保存、Esc 取消、失焦保存。
   */
  function startRename(row, item) {
    const main = row.querySelector(".mi-main");
    if (!main) return;
    const previous = main.querySelector("b");
    const input = el("input", {
      type: "text",
      "data-role": "agent-session-rename-input",
      className: "sess-rename-input",
      maxlength: "80",
      value: item.title || "",
      "aria-label": "会话新标题（≤80 字）",
    });
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const title = String(input.value || "").trim();
      if (commit && title.length > 0 && title !== item.title) {
        onRenameSession({ sessionId: item.id, title });
      }
      closeSessionsMenu();
      openSessionsMenu();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    if (previous) previous.replaceWith(input);
    else main.appendChild(input);
    try {
      // TASK-FIX17-D R1：重命名输入框也在抽屉里，同样不能把 `.main` 滚走。
      input.focus({ preventScroll: true });
      input.select();
    } catch {
      // 忽略：焦点不是安全边界；另外 `select()` 也不滚动。
    }
  }

  /** 行内二次确认删除（同样不用 window.confirm）。 */
  function confirmDelete(row, item) {
    if (row.querySelector('.sess-confirm')) return;
    const bar = el('div', { className: 'sess-confirm', role: 'group', 'aria-label': '确认删除会话' });
    bar.appendChild(el('span', { className: 'sess-confirm-text' }, '删掉这个会话？'));
    const yes = el('button', { type: 'button', 'data-role': 'agent-session-delete-confirm', className: 'sess-action danger' }, '删');
    const no = el('button', { type: 'button', 'data-role': 'agent-session-delete-cancel', className: 'sess-action' }, '取消');
    yes.addEventListener('click', (event) => {
      event.stopPropagation();
      onDeleteSession({ sessionId: item.id });
      closeSessionsMenu();
      openSessionsMenu();
    });
    no.addEventListener('click', (event) => {
      event.stopPropagation();
      bar.remove();
    });
    bar.append(yes, no);
    row.appendChild(bar);
  }

  function renderSessionsMenu(snapshot) {
    if (!sessionsMenu) return;
    sessionsMenu.textContent = "";
    sessionsMenu.appendChild(el("div", { className: "menu-label" }, "会话 · 按终端分组"));
    const groups = groupSessions(snapshot);
    if (groups.length === 0) {
      sessionsMenu.appendChild(
        el("div", { className: "menu-empty" }, "还没有会话。发送第一条消息时创建。"),
      );
    }
    for (const group of groups) {
      const groupEl = el("div", {
        className: "sess-group",
        "data-current": group.isCurrentTerminal ? "true" : "false",
      });
      const expanded = !collapsedGroups.has(group.key);
      const head = el("button", {
        type: "button",
        className: "sess-group-head",
        "aria-expanded": expanded ? "true" : "false",
        "data-group-key": group.key,
      });
      head.append(
        el("span", { className: "gr-chev", "aria-hidden": "true" }, "▾"),
        el("span", { className: "gr-ico", "aria-hidden": "true" }, group.remote ? "🖧" : "▣"),
      );
      const grMain = el("span", { className: "gr-main" });
      grMain.append(el("b", {}, group.title), el("small", {}, group.sub));
      head.append(grMain, el("span", { className: "gr-count" }, String(group.items.length)));
      head.addEventListener("click", (event) => {
        event.stopPropagation();
        if (collapsedGroups.has(group.key)) collapsedGroups.delete(group.key);
        else collapsedGroups.add(group.key);
        renderSessionsMenu(agentStore.getSnapshot());
      });
      groupEl.appendChild(head);

      const items = el("div", { className: "sess-items" });
      if (!expanded) items.setAttribute("hidden", "");
      for (const item of group.items) {
        const isCurrent = item.id === snapshot.currentSessionId;
        const row = el("div", {
          "data-role": "agent-session-item",
          "data-session-id": item.id,
          "data-current": isCurrent ? "true" : "false",
          className: "sess-item",
          role: "menuitem",
          tabindex: "0",
        });
        row.appendChild(el("span", { className: "si-mark", "aria-hidden": "true" }, isCurrent ? "✓" : "·"));
        const main = el("span", { className: "mi-main" });
        const titleText = item.title || "新会话";
        // L1-08：长标题最多两行（CSS line-clamp），并用 title 提供全文。
        main.appendChild(el("b", { title: titleText }, titleText));
        const count = Number(item.messageCount) || 0;
        main.appendChild(el("small", {}, `${count} 条消息${isCurrent ? " · 当前" : ""}`));
        row.append(main, sourceBadge(item));

        const actions = el("div", { className: "sess-actions" });
        const rename = el("button", {
          type: "button",
          "data-role": "agent-session-rename",
          className: "sess-action",
          title: "重命名会话",
        }, "改名");
        rename.addEventListener("click", (event) => {
          event.stopPropagation();
          startRename(row, item);
        });
        const remove = el("button", {
          type: "button",
          "data-role": "agent-session-delete",
          className: "sess-action danger",
          title: "删除会话",
        }, "删除");
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          // 删除是不可撤销的操作：先二次确认（就地露一个确认行，不用 window.confirm，
          // 它在沙箱 iframe / headless WebView 里会阻塞）。
          confirmDelete(row, item);
        });
        actions.append(rename, remove);
        row.appendChild(actions);

        row.addEventListener("click", (event) => {
          if (event.target instanceof Element && event.target.closest(".sess-actions")) return;
          onSelectSession(item.id);
          closeSessionsMenu();
        });
        row.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onSelectSession(item.id);
          closeSessionsMenu();
        });
        items.appendChild(row);
      }
      groupEl.appendChild(items);
      sessionsMenu.appendChild(groupEl);
    }
    sessionsMenu.appendChild(
      el(
        "div",
        { className: "menu-note" },
        "会话属于终端：切标签时抽屉自动落到该终端最近的会话。",
      ),
    );
  }

  function openSessionsMenu() {
    if (!sessionsMenu) return;
    sessionsMenuOpen = true;
    renderSessionsMenu(agentStore.getSnapshot());
    sessionsMenu.hidden = false;
    sessionsButton.setAttribute("aria-expanded", "true");
  }

  function closeSessionsMenu() {
    if (!sessionsMenu) return;
    sessionsMenuOpen = false;
    sessionsMenu.hidden = true;
    sessionsButton.setAttribute("aria-expanded", "false");
  }

  function toggleSessionsMenu() {
    if (sessionsMenuOpen) closeSessionsMenu();
    else openSessionsMenu();
  }

  /** 会话头：标题 = 当前终端描述，副标题 = 当前会话名 · 条数。 */
  function renderSessionsHead(snapshot) {
    if (!sessionsButton || !sessionsButton.__titleEl) return;
    const terminal = terminalMeta();
    const isRemote = terminal && terminal.kind === "remote";
    // terminal.label 已经是 `bash: 41807` / `PS7: x` 这种「shell: 尾巴」形状，
    // 直接用作标题；没有 label 时才拼。
    const label = terminal && typeof terminal.label === "string" ? terminal.label : "";
    const headTitle = isRemote
      ? `ssh: ${(terminal && terminal.hostName) || "远程主机"}`
      : label || "未连接主机";
    sessionsButton.__titleEl.textContent = headTitle;
    const count = snapshot.sessions.length;
    sessionsCount.textContent = `${count} 个会话`;
    const current = snapshot.sessions.find((item) => item.id === snapshot.currentSessionId) || null;
    const messageCount = current ? Number(current.messageCount) || 0 : 0;
    sessionsSub.textContent = current
      ? `${current.title || "新会话"} · ${messageCount} 条消息`
      : "问一句就行，我来动手。";
    sessionsButton.title = `切换 ${headTitle} 的会话`;
    if (newButton) newButton.title = `新建会话（${headTitle}）`;
  }

  /* ---------------- 模型菜单（纯文本按钮 + 锚定菜单） ---------------- */

  function currentModel() {
    return models.find((model) => model.id === selectedModelId) || null;
  }

  function closeModelMenu() {
    if (!modelMenu) return;
    modelMenu.hidden = true;
    if (modelSelect) modelSelect.setAttribute("aria-expanded", "false");
  }

  function updateModelLabel() {
    if (!modelSelect) return;
    modelSelect.textContent = "";
    if (!reachable || models.length === 0) {
      modelSelect.appendChild(document.createTextNode("网关不可用，点重试"));
      modelSelect.setAttribute("data-gateway", "down");
      modelSelect.title = "网关不可用，点重试";
      // TASK-FIX17-L4 R4：没有模型清单就没有可信档位 —— 下拉隐藏，不许编造。
      if (reasoningSelect) {
        reasoningSelect.textContent = "";
        reasoningSelect.hidden = true;
      }
      return;
    }
    const model = currentModel() || models[0] || null;
    selectedModelId = model ? model.id : null;
    const full = model ? model.label || model.id : "选择模型";
    // 尾部省略交给 .model-label（flex 子项里 text-overflow 才生效）；
    // title 保留完整模型名，截断时仍可悬停看全名。
    modelSelect.appendChild(el("span", { className: "model-label" }, full));
    modelSelect.appendChild(el("span", { className: "model-caret", "aria-hidden": "true" }, "▾"));
    modelSelect.title = full;
    modelSelect.removeAttribute("data-gateway");
  }

  function renderModelMenu() {
    if (!modelMenu) return;
    modelMenu.textContent = "";
    modelMenu.appendChild(el("div", { className: "menu-label" }, "模型"));
    for (const model of models) {
      const item = el("button", {
        type: "button",
        className: "model-item",
        "data-model-id": model.id,
        "data-available": model.available === false ? "false" : "true",
      });
      const main = el("span", { className: "model-item-main" });
      main.appendChild(el("b", {}, model.available === false ? `${model.label}（上次失败）` : model.label || model.id));
      if (model.id === selectedModelId) main.appendChild(el("small", {}, "当前"));
      item.appendChild(main);
      if (model.id === selectedModelId) {
        item.appendChild(el("span", { className: "model-check", "aria-hidden": "true" }, "✓"));
      }
      item.addEventListener("click", () => {
        selectedModelId = model.id;
        updateModelLabel();
        // 换模型 → 档位列表跟着换；旧值不在新列表里就回落默认。
        syncReasoningSelect({ fromModelChange: true });
        closeModelMenu();
        void persistModel(model.id);
      });
      modelMenu.appendChild(item);
    }
  }

  function toggleModelMenu() {
    if (!modelMenu) return;
    if (!reachable || models.length === 0) {
      void loadModels();
      return;
    }
    const nextOpen = modelMenu.hidden;
    if (nextOpen) {
      renderModelMenu();
      // L1-06：按输入区顶边限制菜单高度，窗口再矮也不会顶出抽屉。
      // TASK-FIX17-D R3：菜单现在锚在 `.composer` 上方（不再是 composer-box 内部），
      // 所以可用高度从 composer 的顶边算。
      if (host && composerEl) {
        const available = Math.floor(
          composerEl.getBoundingClientRect().top - host.getBoundingClientRect().top - 12,
        );
        modelMenu.style.maxHeight = `${Math.max(80, Math.min(240, available))}px`;
      }
      modelMenu.hidden = false;
      modelSelect.setAttribute("aria-expanded", "true");
    } else {
      closeModelMenu();
    }
  }

  function renderOptions(chosenId) {
    if (!reachable || models.length === 0) {
      selectedModelId = null;
      updateModelLabel();
      // 模型清单为空（网关不可用）→ 下拉隐藏：没有清单就没有可信的档位。
      if (reasoningSelect) {
        reasoningSelect.textContent = "";
        reasoningSelect.hidden = true;
      }
      closeModelMenu();
      return;
    }
    const target = models.some((model) => model.id === chosenId)
      ? chosenId
      : models[0]
        ? models[0].id
        : null;
    selectedModelId = target;
    updateModelLabel();
    if (modelMenu && !modelMenu.hidden) renderModelMenu();
  }

  async function loadModels() {
    if (loading) return;
    loading = true;
    if (modelSelect) modelSelect.setAttribute("aria-busy", "true");
    const [modelsResult, configResult] = await Promise.all([api.models(), api.config()]);
    loading = false;
    if (modelSelect) modelSelect.removeAttribute("aria-busy");
    if (configResult && configResult.ok && configResult.data) {
      showApprovalEffect = configResult.data.showApprovalEffect === true;
      // TASK-FIX17-L4 R4：刷新页面后从 GET /api/config 恢复档位。
      const saved = configResult.data.conversationReasoning;
      conversationReasoning = typeof saved === "string" && saved.length > 0 ? saved : null;
    }
    if (!modelsResult.ok) {
      reachable = false;
      models = [];
      renderOptions(null);
      return;
    }
    const payload = modelsResult.data || {};
    reachable = Boolean(payload.gateway && payload.gateway.reachable);
    models = Array.isArray(payload.models) ? payload.models : [];
    const configured = configResult.ok && configResult.data ? configResult.data.model : null;
    const defaultId =
      typeof payload.default === "string" && payload.default.length > 0
        ? payload.default
        : models[0]
          ? models[0].id
          : null;
    const wanted =
      configured && models.some((model) => model.id === configured) ? configured : defaultId;
    renderOptions(wanted);
    // renderOptions → updateModelLabel 已经把当前模型定下来，这里按它的档位重建下拉。
    syncReasoningSelect();
  }

  // PUT 串行 + 只写最新一次选择（与 ai-bar.js 同一理由：并发 PUT 落盘顺序会乱）。
  let writeChain = Promise.resolve();
  let latestWanted = null;

  function persistModel(modelId) {
    latestWanted = modelId;
    writeChain = writeChain.then(async () => {
      if (latestWanted !== modelId) return null;
      const result = await api.saveConfig({ model: modelId });
      if (!result.ok) onNotice("模型偏好没存住", "warn");
      return result;
    });
    return writeChain;
  }

  /* ---------------- 推理强度（TASK-FIX17-L4 R4） ---------------- */

  /** 当前模型可用的档位（= 模型清单 ∩ 服务端枚举）；没有就是 []，绝不拿枚举凑选项。 */
  function levelsOf(model) {
    if (!model || !Array.isArray(model.reasoningLevels)) return [];
    return model.reasoningLevels.filter(
      (level) => typeof level === "string" && REASONING_ACCEPTED.includes(level),
    );
  }

  /**
   * 按当前模型重建下拉。
   *
   * @param {{fromModelChange?:boolean}} [opts]
   *   fromModelChange=true 时，如果原来的档位不在新模型的列表里，回落「默认」并把
   *   配置写回 null（否则会一直给新模型发一个它不认的档位）。初次加载**不**这么做：
   *   模型不支持推理时配置值要留着（AC7：模型不支持 + 设了值 → 请求不带该键）。
   */
  function syncReasoningSelect({ fromModelChange = false } = {}) {
    if (!reasoningSelect) return;
    const model = currentModel();
    const levels = levelsOf(model);
    const supported = Boolean(model) && model.supportsReasoning === true && levels.length > 0;
    reasoningSelect.textContent = "";
    if (!supported) {
      reasoningSelect.hidden = true;
      reasoningSelect.title = "这个模型不支持推理强度";
      return;
    }
    reasoningSelect.hidden = false;
    reasoningSelect.title = "对话模型的推理强度";
    reasoningSelect.appendChild(el("option", { value: "" }, "默认"));
    for (const level of levels) {
      reasoningSelect.appendChild(el("option", { value: level }, `推理：${reasoningLabel(level)}`));
    }
    const kept = typeof conversationReasoning === "string" && levels.includes(conversationReasoning);
    if (!kept && conversationReasoning && fromModelChange) {
      const dropped = conversationReasoning;
      conversationReasoning = null;
      void persistReasoning(null, { silent: true });
      onNotice(`这个模型的推理档位里没有「${reasoningLabel(dropped)}」，已回到默认。`, "warn");
    }
    reasoningSelect.value = kept ? conversationReasoning : "";
  }

  // 与模型选择同一条串行链的理由：并发 PUT 落盘顺序会乱。
  let reasoningChain = Promise.resolve();

  /**
   * 把一次选择写进配置。失败回滚下拉并 toast（PRD R4）。
   *
   * @param {string} value 下拉的 value（"" = 默认）
   * @param {{silent?:boolean}} [opts] silent=true 时不 toast（换模型的自动回落）
   */
  function persistReasoning(value, { silent = false } = {}) {
    const previous = conversationReasoning;
    const next = typeof value === "string" && value.length > 0 ? value : null;
    conversationReasoning = next;
    if (reasoningSelect) reasoningSelect.value = next || "";
    reasoningChain = reasoningChain.then(async () => {
      const result = await api.saveConfig({ conversationReasoning: next });
      if (!result || !result.ok) {
        // 回滚到上一次成功的值，并让下拉跟着回去。
        conversationReasoning = previous;
        if (reasoningSelect) reasoningSelect.value = previous || "";
        if (!silent) onNotice("推理强度没存住，已回到原来的档位。", "warn");
        return false;
      }
      return true;
    });
    return reasoningChain;
  }

  /* ---------------- 时间线渲染 ---------------- */

  function approvalForStep(snapshot, stepId) {
    const pool = Array.isArray(snapshot.sessionPending) ? snapshot.sessionPending : snapshot.pendingApprovals;
    return pool.find((item) => item.stepId === stepId) || null;
  }

  function orphanApprovals(snapshot) {
    // 只画当前会话的待确认（其他终端会话的待确认进把手角标 / toast，不属于这条时间线）。
    const pool = Array.isArray(snapshot.sessionPending) ? snapshot.sessionPending : snapshot.pendingApprovals;
    const ids = new Set(snapshot.steps.map((step) => step.stepId));
    return pool.filter((item) => !ids.has(item.stepId));
  }

  /** 角标四态 + tooltip 两段（TASK-V4-H §5.6）。 */
  function buildReviewMark(approval) {
    const key = ["safe", "caution", "danger"].includes(approval.risk) ? approval.risk : "none";
    const state = REVIEW_STATE[key];
    const mark = el("span", {
      "data-role": "approval-review",
      "data-review": state.state,
      className: "review-mark",
      tabindex: "0",
      role: "img",
      "aria-label": `审核 AI 判定：${state.state}，${state.label}`,
    });
    mark.appendChild(el("span", { className: "review-glyph", "aria-hidden": "true" }, "⛨"));
    const tip = el("span", {
      "data-role": "approval-review-tip",
      className: "review-tip",
      role: "tooltip",
    });
    tip.appendChild(el("b", {}, TIP_TITLE_EFFECT));
    tip.appendChild(
      el(
        "p",
        {},
        approval.effect ||
          (state.state === "none"
            ? "审阅服务没给出结论，这一条没有效果评估可看。"
            : "审阅没有给出这一段的具体影响。"),
      ),
    );
    tip.appendChild(el("div", { className: "rt-sep" }));
    tip.appendChild(el("b", {}, TIP_TITLE_WHY));
    tip.appendChild(
      el(
        "p",
        {},
        approval.confirmWhy ||
          (state.state === "none"
            ? approval.reviewReason
              ? `${approval.reviewReason}，所以没有送审：一定要你亲自看过这条命令才行。`
              : "审阅不可用，按「需要确认」处理：一定要你亲自看过这条命令才行。"
            : "审阅没有说明为什么要你确认；按当前安全档位，这条不会自动执行。"),
      ),
    );
    const metaParts = [];
    if (approval.reviewModel) metaParts.push(`审核 AI · ${approval.reviewModel}`);
    metaParts.push(`risk=${approval.risk || "null"}`);
    if (approval.reversible !== null && approval.reversible !== undefined) {
      metaParts.push(`reversible=${approval.reversible === true}`);
    }
    tip.appendChild(el("div", { className: "rt-foot" }, metaParts.join(" · ")));
    mark.appendChild(tip);
    return mark;
  }

  function buildApprovalCard(approval) {
    const card = el("div", {
      "data-role": "agent-approval",
      "data-review": (REVIEW_STATE[["safe", "caution", "danger"].includes(approval.risk) ? approval.risk : "none"]).state,
      className: "agent-approval",
    });
    // risk=null 有两种情况，不许混成一句「审阅不可用」（TASK-FIX17-H R3）：
    //   ① judge 明确说了原因（reviewReason，例如「命令含输出重定向，可能写文件」）
    //      → 直接说原因，用户才知道该看哪儿；
    //   ② 真的没有原因（审阅失败 / 超时）→ 维持原文案。
    const headText =
      approval.risk === "danger"
        ? "需要你批准：这条命令不可逆"
        : approval.risk === null
          ? approval.reviewReason
            ? `需要你批准：${approval.reviewReason}`
            : "需要你批准：审阅不可用，请自己看一眼"
          : "需要你批准：这条会改动东西";
    const head = el("div", { className: "approval-head" });
    head.append(el("span", { className: "approval-head-glyph", "aria-hidden": "true" }, "!"), headText);
    card.appendChild(head);
    if (approval.command) {
      card.appendChild(el("code", { "data-role": "agent-step-cmd", className: "approval-cmd" }, approval.command));
    }
    if (approval.why) {
      card.appendChild(el("p", { className: "approval-why" }, approval.why));
    }
    // TASK-FIX17-J R5：审阅的一句话依据（为什么它认为符合/不符合你的意图）。
    // 没有就不画 —— 老服务端发的帧没有这个字段，不许因此多出一行空行。
    if (approval.justification) {
      const justification = el("p", { "data-role": "approval-justification", className: "approval-justification" });
      justification.appendChild(el("b", {}, "审阅判断："));
      justification.appendChild(document.createTextNode(approval.justification));
      card.appendChild(justification);
    }
    // 常显效果行（设置开关打开时才有；默认关，卡片 §5.6）。
    if (showApprovalEffect && approval.effect) {
      const effectLine = el("p", { className: "approval-effect" });
      effectLine.appendChild(el("b", {}, `${TIP_TITLE_EFFECT}：`));
      effectLine.appendChild(document.createTextNode(approval.effect));
      card.appendChild(effectLine);
    }

    const actions = el("div", { className: "agent-approval-actions" });
    const run = el("button", { type: "button", "data-role": "approval-run" }, "执行这一条");
    const rest = el("button", { type: "button", "data-role": "approval-rest" }, "剩下的都自动执行");
    const skip = el("button", { type: "button", "data-role": "approval-skip" }, "跳过");
    run.addEventListener("click", () => {
      onApprove({ approvalId: approval.approvalId, approved: true, scope: "once" });
    });
    rest.addEventListener("click", () => {
      onApprove({ approvalId: approval.approvalId, approved: true, scope: "rest" });
    });
    skip.addEventListener("click", () => {
      onApprove({ approvalId: approval.approvalId, approved: false, scope: "once" });
    });
    actions.append(run, rest, skip);
    card.appendChild(actions);
    // 右下角角标（四态 + tooltip 两段）。
    card.appendChild(buildReviewMark(approval));
    return card;
  }

  function buildReasoningBlock(turn, index) {
    if (!turn.reasoning) return null;
    const expanded = expandedReasoning.has(index);
    const wrap = el("div", {
      "data-role": "agent-reasoning",
      className: "agent-reasoning",
      "data-expanded": expanded ? "true" : "false",
    });
    const toggle = el("button", {
      type: "button",
      className: "think-btn",
      "aria-expanded": expanded ? "true" : "false",
      "data-role": "agent-reasoning-toggle",
    });
    toggle.appendChild(el("span", { className: "think-chev", "aria-hidden": "true" }, expanded ? "▾" : "▸"));
    toggle.appendChild(
      document.createTextNode(`思考过程 · ${turn.reasoning.length} 字`),
    );
    const body = el("div", { className: "think-body" }, turn.reasoning);
    if (!expanded) body.setAttribute("hidden", "");
    toggle.addEventListener("click", () => {
      if (expandedReasoning.has(index)) expandedReasoning.delete(index);
      else expandedReasoning.add(index);
      render(agentStore.getSnapshot());
    });
    wrap.append(toggle, body);
    return wrap;
  }

  /** 审阅中的那一行（TASK-FIX17-J R5）：灰色，带一句「最多 60 秒」。 */
  function buildReviewingLine() {
    // 60 秒对应 REVIEW_TIMEOUT_MS；前端不自己算超时，只说实话。
    return el(
      "div",
      { "data-role": "agent-reviewing", className: "agent-reviewing" },
      "正在审阅这条命令…（最多 60 秒）",
    );
  }

  /** 当前是否有哪一步正在审阅（stepId 为空 = 没在审）。 */
  function reviewingStepId(snapshot) {
    return snapshot && snapshot.reviewing && typeof snapshot.reviewing.stepId === "string"
      ? snapshot.reviewing.stepId
      : "";
  }

  function buildToolCard(step, snapshot, index) {
    const stepEl = el("div", {
      "data-role": "agent-step",
      "data-index": String(step.index || index + 1),
      "data-status": step.status,
      "data-step-id": step.stepId,
      className: "tool",
    });

    const head = el("div", { className: "tool-head" });
    head.appendChild(
      el(
        "span",
        { className: `tool-status-icon s-${step.status}`, "aria-hidden": "true" },
        STEP_GLYPH[step.status] || "·",
      ),
    );
    const stateText = STEP_LABEL[step.status] || step.status;
    head.appendChild(
      el("span", { className: `dot dot-${dotTone(step.status)}`, title: stateText, "aria-label": stateText }),
    );
    head.appendChild(el("span", { className: "tool-name" }, "run_command"));
    head.appendChild(el("span", { className: "tool-sep", "aria-hidden": "true" }, "·"));
    head.appendChild(el("span", { className: "tool-sub" }, stateText));
    const right = el("span", { className: "tool-right" });
    const duration = formatDuration(step.durationMs);
    if (duration) right.appendChild(el("span", { className: "tool-time" }, duration));
    else if (step.status === "running") right.appendChild(el("span", { className: "tool-time" }, "执行中"));
    else if (step.exitCode !== null && step.exitCode !== undefined) {
      right.appendChild(el("span", { className: "tool-time" }, `退出 ${step.exitCode}`));
    }
    head.appendChild(right);
    stepEl.appendChild(head);

    if (step.command) {
      stepEl.appendChild(
        el("code", { "data-role": "agent-step-cmd", className: "tool-cmd" }, step.command),
      );
    }
    if (step.why) {
      stepEl.appendChild(el("div", { className: "step-why" }, step.why));
    }
    if (step.userText) {
      stepEl.appendChild(el("div", { className: "step-usertext" }, step.userText));
    }
    // 审阅中：这一行就是「60 秒不是卡死」的唯一证据（数据来自 agent.review 帧）。
    if (reviewingStepId(snapshot) === step.stepId) {
      stepEl.appendChild(buildReviewingLine());
    }

    // 输出：默认只露 3 行（折叠），点「展开」看全部。
    if (step.output && step.output.length > 0) {
      const expanded = expandedSteps.has(step.stepId);
      const out = el("pre", { "data-role": "agent-step-out", className: "tool-out" }, step.output);
      if (!expanded) out.setAttribute("data-collapsed", "true");
      const foot = el("button", {
        type: "button",
        "data-role": "agent-step-out-toggle",
        className: "tool-foot",
        "aria-expanded": expanded ? "true" : "false",
      });
      foot.append(
        el("span", { className: "foot-chev", "aria-hidden": "true" }, expanded ? "▴" : "▾"),
        document.createTextNode(expanded ? "收起输出" : "展开输出"),
      );
      foot.addEventListener("click", () => {
        if (expandedSteps.has(step.stepId)) expandedSteps.delete(step.stepId);
        else expandedSteps.add(step.stepId);
        render(agentStore.getSnapshot());
      });
      stepEl.append(out, foot);
    }

    const approval = approvalForStep(snapshot, step.stepId);
    if (approval) stepEl.appendChild(buildApprovalCard(approval));
    return stepEl;
  }

  function dotTone(status) {
    if (status === "running" || status === "awaiting") return "run";
    if (status === "failed" || status === "denied") return "err";
    if (status === "skipped") return "warn";
    return "ok";
  }

  function buildLegacyBlock(block) {
    const box = el("div", {
      "data-role": "agent-legacy",
      className: "agent-legacy",
      "data-tone": block.tone || "",
    });
    box.appendChild(el("div", { className: "legacy-lead" }, block.lead));
    if (block.command) {
      box.appendChild(el("code", { "data-role": "agent-step-cmd" }, block.command));
    }
    if (block.reason) box.appendChild(el("div", { className: "step-why" }, `理由：${block.reason}`));
    if (block.model) box.appendChild(el("div", { className: "legacy-meta" }, `模型：${block.model}`));
    if (block.command && block.confirm) {
      // 旧路径的确认：仍然是本地直接写 PTY（不发 ai.confirm）。
      const actions = el("div", { "data-role": "agent-approval", className: "agent-approval legacy" });
      actions.appendChild(el("div", { className: "risk risk-unknown" }, "旧的单命令路径：需要你确认后才会写入终端"));
      const row = el("div", { className: "agent-approval-actions" });
      const run = el("button", { type: "button", "data-role": "approval-run" }, "执行");
      const skip = el("button", { type: "button", "data-role": "approval-skip" }, "取消");
      run.addEventListener("click", () => {
        onExecuteLegacy(block.command);
        block.confirm = false;
        block.lead = `已写入当前标签：${block.command}`;
        render(agentStore.getSnapshot());
      });
      skip.addEventListener("click", () => {
        block.confirm = false;
        block.lead = "已取消，命令没有执行。";
        render(agentStore.getSnapshot());
      });
      row.append(run, skip);
      actions.appendChild(row);
      box.appendChild(actions);
    }
    return box;
  }

  function renderEmptyState(snapshot) {
    const wrap = el("div", { className: "agent-empty", "data-role": "agent-empty" });
    wrap.appendChild(el("div", { className: "agent-empty-icon" }, "✦"));
    const hasSessions = snapshot.sessions.length > 0;
    const terminal = terminalMeta();
    const where = terminal && terminal.kind === "remote" ? (terminal.hostName || "这台机器") : "当前终端";
    wrap.appendChild(
      el(
        "div",
        { className: "agent-empty-text" },
        hasSessions ? "这个会话是空的，问一句就行。" : `${where}还没有会话。`,
      ),
    );
    wrap.appendChild(
      el(
        "div",
        { className: "agent-empty-hint" },
        "比如「看看这个目录里有多少个文件」「把测试跑一遍告诉我有没有失败」。我只跑只读命令，改动类的会先问你。",
      ),
    );
    if (!hasSessions) {
      wrap.appendChild(
        el(
          "div",
          { className: "empty-note" },
          "会话属于终端：发第一条消息时创建，切标签会回到那个终端最近的会话。",
        ),
      );
    }
    timeline.appendChild(wrap);
  }

  /**
   * markdown 渲染结果的小缓存（text → html|null）。
   *
   * 为何要缓存：`render()` 是整条时间线重画（无 diff），流式期间每个 `agent.text`
   * 帧都会重画一次。已完成的历史轮次也就会被反复重渲染 —— 不缓存的话同一个
   * 长回复每秒要重新跑十几次 marked + DOMPurify。
   * 上限 64 条：抽屉里同时可见的轮次远不到这个量，超出直接清空（一屏内的会话
   * 不可能有这个量；清空不会错，只是下次重新算）。
   */
  const markdownCache = new Map();
  const MARKDOWN_CACHE_MAX = 64;

  /**
   * 一条 AI 总结的正文节点：markdown → 安全 HTML；不可用时降级成纯文本。
   *
   * TASK-FIX17-D R5（问题 12）的三条硬要求都落在这里：
   *   1. **只在消息结束后调**。调用点是 `renderTurn` 的 `turn.summary` 分支；
   *      流式帧走的是 `turn.streamText`（纯文本），所以不会每帧跑一遍 marked。
   *   2. **渲染失败不能丢消息**。`renderMarkdown` 返回 null（库缺失 / marked 抛错 /
   *      清洗后仍有危险形态）就保持 `textContent`，消息一字不少。
   *   3. **用户消息不渲染**。`turn.question` 用的是 `el()` 的 textContent 路径，
   *      这里只处理 AI 侧的 summary。
   *
   * @param {string} text
   * @returns {HTMLElement}
   */
  function buildSummaryText(text) {
    const wrap = el("div", { className: "summary-text" });
    let html;
    if (typeof text === "string" && markdownCache.has(text)) {
      html = markdownCache.get(text);
    } else {
      html = renderMarkdown(text);
      if (typeof text === "string") {
        if (markdownCache.size >= MARKDOWN_CACHE_MAX) markdownCache.clear();
        markdownCache.set(text, html);
      }
    }
    if (html === null) {
      wrap.textContent = text;
      return wrap;
    }
    // html 已经过 DOMPurify（白名单标签/属性）+ 本项目的危险形态闸门，
    // 见 app/vendor/markdown/markdown.js。
    wrap.innerHTML = html;
    wrap.setAttribute("data-role", "agent-summary-md");
    return wrap;
  }

  function renderTurn(turn, snapshot, turnIndex) {
    const block = el("div", { className: "agent-turn", "data-round": String(turn.round) });

    if (turn.question) {
      block.appendChild(
        el("div", { "data-role": "agent-question", className: "agent-question" }, turn.question),
      );
    }

    const reasoning = buildReasoningBlock(turn, turnIndex);
    if (reasoning) block.appendChild(reasoning);

    if (turn.steps.length === 0 && snapshot.status === "running" && turnIndex === snapshot.turns.length - 1) {
      block.appendChild(el("div", { className: "agent-thinking" }, "正在想怎么做…"));
    }

    for (let index = 0; index < turn.steps.length; index += 1) {
      block.appendChild(buildToolCard(turn.steps[index], snapshot, index));
    }

    // 流式增量的实时区（AC13）：只在还没有总结时显示。
    // TASK-FIX17-D R5（AC10）：**流式期间一律纯文本**——这个分支不能用 innerHTML。
    if (!turn.summary && turn.streamText) {
      block.appendChild(el("div", { className: "agent-stream", "data-role": "agent-stream" }, turn.streamText));
    }

    if (turn.summary) {
      const summary = el("div", { "data-role": "agent-summary", className: "agent-summary" });
      if (snapshot.status === "stopped") {
        summary.appendChild(el("div", { className: "summary-lead" }, "已停止。下面是我已经做完的部分："));
      }
      summary.appendChild(buildSummaryText(turn.summary));
      block.appendChild(summary);
    } else if (snapshot.status === "stopped" && turnIndex === snapshot.turns.length - 1) {
      block.appendChild(el("div", { "data-role": "agent-summary", className: "agent-summary" }, "已停止。"));
    }

    timeline.appendChild(block);
  }

  function render(snapshot) {
    if (!timeline) return;
    renderSessionsHead(snapshot);
    renderCtx();
    if (sessionsMenuOpen) renderSessionsMenu(snapshot);

    // 保留滚动位置：整体重画前先记住是否在底部。
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 120;
    timeline.textContent = "";

    const hasPendingApprovals = snapshot.pendingApprovals.length > 0;
    if (!hasPendingApprovals) blockedHint = false;

    const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
    const hasContent =
      turns.length > 0 ||
      orphanApprovals(snapshot).length > 0 ||
      Boolean(snapshot.summary) ||
      legacyBlocks.length > 0;

    if (!hasContent) renderEmptyState(snapshot);

    for (let index = 0; index < turns.length; index += 1) {
      renderTurn(turns[index], snapshot, index);
    }

    for (const approval of orphanApprovals(snapshot)) {
      timeline.appendChild(buildApprovalCard(approval));
    }

    // 审阅中的那一行：还在审、且那一一步的 step 帧还没到（首条命令常见）时，
    // 直接画在时间线末尾，否则用户会以为点下去没反应。
    const reviewingId = reviewingStepId(snapshot);
    if (reviewingId && !turns.some((turn) => turn.steps.some((step) => step.stepId === reviewingId))) {
      timeline.appendChild(buildReviewingLine());
    }

    for (const block of legacyBlocks) {
      timeline.appendChild(buildLegacyBlock(block));
    }

    if (blockedHint && hasPendingApprovals) {
      timeline.appendChild(
        el(
          "div",
          { "data-role": "agent-send-hint", className: "agent-empty-hint" },
          "先处理上面的待确认命令（或点停止），再问新的。",
        ),
      );
    }

    if (snapshot.error) {
      const errorBox = el("div", { className: "agent-error", "data-role": "agent-error" });
      errorBox.appendChild(el("div", {}, `出错了：${snapshot.error.userText}`));
      errorBox.appendChild(el("div", { className: "legacy-meta" }, `（${snapshot.error.code}）`));
      timeline.appendChild(errorBox);
    }

    // TASK-FIX17-D R4（问题 10 / AC6 / AC7）：**一个**元素、两种形态。
    //   空闲：实心圆 + ↑，点击 = 发送；`disabled` 仅在「输入为空且不在跑」时置位（R4 逐字）。
    //   忙碌：`.is-busy` → 红环 + 深色圆心，点击 = 停止（在跑时永远可点）。
    updateActionButton(snapshot);

    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
  }

  /**
   * 单一动作按钮的两形态同步（R4）。只用类 + 属性，不重建元素：
   * AC6 要求的“同一个 DOM 节点变形态”靠的就是这一点。
   *
   * `disabled` 的判定按 R4 逐字：**只在「输入为空且不在跑」时置位**。
   * （在跑时永远可点 —— 那就是唯一的停止入口，禁用等于把停止锁死。）
   * 所以还要在 input 事件里再调一次，否则用户输入后按钮永远停在禁用态。
   *
   * @param {object} snapshot agentStore 快照
   */
  function updateActionButton(snapshot) {
    if (!actionButton) return;
    const busy = snapshot.status === "running" || snapshot.status === "awaiting";
    const empty = !input || input.value.trim().length === 0;
    actionButton.classList.toggle("is-busy", busy);
    actionButton.setAttribute("aria-label", busy ? "停止" : "发送");
    actionButton.title = busy ? "停止（现在就能停）" : "发送（Enter）";
    actionButton.setAttribute("data-state", busy ? "busy" : "idle");
    if (!busy) actionButton.removeAttribute("aria-busy");
    else actionButton.setAttribute("aria-busy", "true");
    actionButton.disabled = !busy && empty;
    const icon = busy ? ACTION_ICON_STOP : ACTION_ICON_SEND;
    // 只在真变了才写 innerHTML（避免每帧重建 SVG 导致子节点闪烁）。
    if (actionButton.dataset.icon !== (busy ? "stop" : "send")) {
      actionButton.dataset.icon = busy ? "stop" : "send";
      actionButton.innerHTML = icon;
    }
  }

  /* ---------------- 发送 / 审批 / 停止 ---------------- */

  const BLOCKED_PENDING_TEXT = "先处理上面的待确认命令（或点停止），再问新的。";

  function send() {
    const question = input.value.trim();
    if (!question) {
      onNotice("先说一句你想干什么。", "warn");
      return;
    }
    const snapshot = agentStore.getSnapshot();
    if (snapshot.pendingApprovals.length > 0) {
      blockedHint = true;
      render(agentStore.getSnapshot());
      onNotice(BLOCKED_PENDING_TEXT, "warn");
      return;
    }
    const model = currentModel();
    // onAsk 的返回值："sent" | "blocked-pending" | "no-active" | "send-failed"（见 app.js）。
    const result = onAsk({ question, model: model ? model.id : null });
    if (result === "blocked-pending") {
      blockedHint = true;
      render(agentStore.getSnapshot());
      onNotice(BLOCKED_PENDING_TEXT, "warn");
      return;
    }
    if (result !== "sent") {
      onNotice("AI 请求没发出去：连接还没就绪。点状态栏「重连」后重试。", "error");
      return;
    }
    input.value = "";
    legacyBlocks.length = 0;
    armReadyWatchdog();
  }

  function armReadyWatchdog() {
    sawAgentFrame = false;
    if (readyWatchdog) clearTimeout(readyWatchdog);
    readyWatchdog = setTimeout(() => {
      readyWatchdog = null;
      if (sawAgentFrame) return;
      const snapshot = agentStore.getSnapshot();
      if (snapshot.status !== "running" && snapshot.status !== "awaiting") return;
      agentStore.failLocally({
        code: "AGENT_NOT_READY",
        userText: "AI 内核没有回任何 agent.* 帧：服务端可能没在跑，或者网关太慢。",
      });
    }, readyTimeoutMs);
  }

  /** app.js 每收到一个 agent.* 帧就调一次（关掉内核未就绪的看门狗）。 */
  function notifyAgentFrame() {
    sawAgentFrame = true;
    if (readyWatchdog) {
      clearTimeout(readyWatchdog);
      readyWatchdog = null;
    }
  }

  /** 服务端明说不认识这个帧（BAD_FRAME）→ 直接说内核没就绪，不假装成功。 */
  function handleBadFrame() {
    notifyAgentFrame();
    agentStore.failLocally({
      code: "AGENT_NOT_READY",
      userText: "服务端拒绝了 agent.run 帧（BAD_FRAME）。",
    });
  }

  /* ---------------- 旧路径（ai.reply / ai.error） ---------------- */

  function onLegacyReply(frame) {
    const decision = frame.decision === "auto" ? "auto" : "confirm";
    const block = {
      lead: decision === "auto" ? "只读命令，已自动执行：" : "需要确认后才会执行：",
      command: typeof frame.command === "string" ? frame.command : "",
      reason: typeof frame.reason === "string" ? frame.reason : "",
      model: typeof frame.model === "string" ? frame.model : "",
      confirm: decision === "confirm",
      tone: decision === "auto" ? "auto" : "confirm",
    };
    legacyBlocks.push(block);
    render(agentStore.getSnapshot());
    if (decision === "auto" && block.command) onExecuteLegacy(block.command);
  }

  function onLegacyError(frame) {
    legacyBlocks.push({
      lead: `${frame.userText || "AI 暂时不可用，命令仍可手动输入。"}（${frame.code || "AI_ERROR"}）`,
      tone: "error",
    });
    render(agentStore.getSnapshot());
  }

  /* ---------------- 输入框自动增高 / 拖拽把手 ---------------- */

  function savedHeightCap() {
    const hostHeight = host && host.clientHeight > 0 ? host.clientHeight : 0;
    return Math.max(COMPOSER_MAX_AUTO, Math.round(hostHeight * 0.4));
  }

  function autoGrow() {
    if (!input) return;
    input.style.height = "auto";
    const next = Math.max(
      COMPOSER_LINE_HEIGHT,
      Math.min(COMPOSER_MAX_AUTO, input.scrollHeight || COMPOSER_LINE_HEIGHT),
    );
    input.style.height = `${Math.round(next)}px`;
    input.dataset.manual = "false";
  }

  function applyManualHeight(height) {
    if (!input) return;
    const cap = savedHeightCap();
    const clamped = Math.max(COMPOSER_LINE_HEIGHT, Math.min(cap, Number(height) || COMPOSER_LINE_HEIGHT));
    // 19.375px 是单行基准：保留小数，避免 min 被四舍五入成 19px。
    const next = clamped === COMPOSER_LINE_HEIGHT ? clamped : Math.round(clamped);
    input.style.height = `${next}px`;
    input.dataset.manual = "true";
    return next;
  }

  function rememberHeight(height) {
    try {
      window.localStorage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(height)));
    } catch {
      // 隐私模式 / 禁用存储：不阻塞输入。
    }
  }

  function restoreHeight() {
    let saved = 0;
    try {
      saved = Number(window.localStorage.getItem(COMPOSER_HEIGHT_KEY)) || 0;
    } catch {
      saved = 0;
    }
    if (saved > 0) applyManualHeight(saved);
    else autoGrow();
  }

  function clearManualHeight() {
    try {
      window.localStorage.removeItem(COMPOSER_HEIGHT_KEY);
    } catch {
      // 忽略。
    }
  }

  function attachComposerBehavior() {
    const grip = host.querySelector('[data-role="agent-grow"]');
    if (!grip || !input) return;

    input.addEventListener("input", () => {
      clearManualHeight();
      autoGrow();
      // R4：`disabled` 依赖「输入是否为空」，所以每次输入都要重算一次按钮态。
      // 不重算的话，用户打一个字之后按钮仍是禁用的 —— 那就永远发不出去了。
      updateActionButton(agentStore.getSnapshot());
    });

    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = input.getBoundingClientRect().height || COMPOSER_LINE_HEIGHT;
      const cap = savedHeightCap();
      if (typeof grip.setPointerCapture === "function") {
        try {
          grip.setPointerCapture(event.pointerId);
        } catch {
          // 合成事件没有可捕获的 pointerId；继续用 window 监听即可。
        }
      }
      if (composerEl) composerEl.setAttribute("data-resizing", "true");

      const onMove = (moveEvent) => {
        // TASK-FIX-ACCEPT G：向上拖（clientY 变小）变高、向下拖变矮。
        applyManualHeight(startHeight + (startY - moveEvent.clientY));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (composerEl) composerEl.removeAttribute("data-resizing");
        try {
          if (typeof grip.releasePointerCapture === "function") {
            grip.releasePointerCapture(event.pointerId);
          }
        } catch {
          // 忽略。
        }
        const finalHeight = Math.min(cap, input.getBoundingClientRect().height || COMPOSER_LINE_HEIGHT);
        rememberHeight(finalHeight);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  }

  /* ---------------- 外部接口 ---------------- */

  return {
    init() {
      buildShell();

      modelSelect.addEventListener("click", () => toggleModelMenu());
      sessionsButton.addEventListener("click", () => toggleSessionsMenu());
      newButton.addEventListener("click", () => {
        closeSessionsMenu();
        const created = onNewSession();
        if (created === false) onNotice("当前没有终端标签：先点「+」新建一个。", "warn");
      });

      // TASK-FIX17-D R4：同一个按钮，按状态分流。
      // `disabled` 不会在忙碌态置位（见 updateActionButton），所以「点它停止」总能落到；
      // 但仍然再判一次 busy，避免在极短的状态抖动窗口里把停止误发成发送。
      actionButton.addEventListener("click", () => {
        const snapshot = agentStore.getSnapshot();
        if (snapshot.status === "running" || snapshot.status === "awaiting") {
          onStop();
          return;
        }
        send();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeModelMenu();
          closeSessionsMenu();
          return;
        }
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        // Enter 永远是「发送」：忙碌态下再开一轮由 app/agent-store 的 pendingRun 接管，
        // 与原行为一致（V4-H §5.2），不因按钮合一而改发送语义。
        send();
      });

      // 点菜单外 / Esc 关菜单（模型 + 会话两个菜单）。
      document.addEventListener(
        "mousedown",
        (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (modelMenu && !modelMenu.hidden) {
            if (!modelMenu.contains(target) && !modelSelect.contains(target)) closeModelMenu();
          }
          if (sessionsMenuOpen && sessionsMenu && sessionsMenu.hidden === false) {
            if (!sessionsMenu.contains(target) && !sessionsButton.contains(target) && !newButton.contains(target)) {
              closeSessionsMenu();
            }
          }
        },
        true,
      );
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Escape") return;
          if (modelMenu && !modelMenu.hidden) closeModelMenu();
          if (sessionsMenuOpen) closeSessionsMenu();
        },
        true,
      );

      attachComposerBehavior();
      restoreHeight();

      agentStore.subscribe(render);
      render(agentStore.getSnapshot());
      void loadModels();
    },
    focusInput() {
      try {
        // TASK-FIX17-D R1（问题 7）：**必须** preventScroll。
        // 裸 focus() 会让浏览器把元素滚进可视区 —— 而 `.main` 曾被抽屉撑出
        // 385px 横向滚动区（scrollWidth 2201 > clientWidth 1816），于是
        // `.main.scrollLeft` 0→385，tabbar / 终端 / 文件面板整体左移。
        // CSS 那边的 `overflow: clip` 是第一道修法，这里是第二道（双保险）。
        input.focus({ preventScroll: true });
      } catch {
        // 老内核不认 options 也不认空对象：退化到赋值 activeElement 不划算，直接忽略。
      }
    },
    /** toast 的「去确认」：滚到对应审批卡并高亮一瞬。 */
    scrollToApproval(approvalId) {
      const snapshot = agentStore.getSnapshot();
      const approval = snapshot.pendingApprovals.find((item) => item.approvalId === approvalId);
      if (!approval) return false;
      const node = timeline.querySelector(
        `[data-role="agent-step"][data-step-id="${CSS.escape(approval.stepId)}"] [data-role="agent-approval"]`,
      );
      const target = node || timeline.querySelector('[data-role="agent-approval"]');
      if (!target) return false;
      // TASK-FIX17-D R1：**不碰 scrollIntoView**。
      // scrollIntoView 会逐级滚动所有祖先滚动容器，包括 `.main`（横向）与
      // `document.scrollingElement`——那正是问题 7 的另一条发生路径。
      // 这里只滚时间线自身：算目标相对 timeline 的顶边，写 timeline.scrollTop。
      const timelineRect = timeline.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const delta = targetRect.top - timelineRect.top;
      const next = timeline.scrollTop + delta - (timeline.clientHeight - targetRect.height) / 2;
      timeline.scrollTop = Math.max(0, next);
      target.setAttribute("data-highlight", "true");
      setTimeout(() => target.removeAttribute("data-highlight"), 1200);
      return true;
    },
    notifyAgentFrame,
    handleBadFrame,
    /** 设置页改了「常显效果评估」→ 立刻反映到确认卡。 */
    setShowApprovalEffect(value) {
      showApprovalEffect = value === true;
      render(agentStore.getSnapshot());
      return showApprovalEffect;
    },
    /** 测试/慢网关用：调整看门狗时长（毫秒）。 */
    setReadyTimeout(ms) {
      const next = Number(ms);
      if (Number.isFinite(next) && next > 0) readyTimeoutMs = next;
      return readyTimeoutMs;
    },
    onLegacyReply,
    onLegacyError,
    reloadModels() {
      return loadModels();
    },
    selectedModel() {
      const model = currentModel();
      return model ? model.id : null;
    },
    closeSessionsMenu,
    get sessionsMenuOpen() {
      return sessionsMenuOpen;
    },
  };
}
