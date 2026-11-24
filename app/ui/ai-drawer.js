// 右侧 AI 抽屉（TASK-V4-E → TASK-V4-H）：会话选择 / 多轮时间线 / 输入区。
//
// 数据来源：core/agent-store.js 的订阅（agent.* 帧由 app.js 转进来）。
// 这里只渲染 + 发帧，不改 store 字段。
//
// data-role 名单是验收探针，逐字不许改（TASK-V4-H §6）：
//   保留：ai-drawer-head / model-select / agent-timeline / agent-question
//        agent-step(+data-status,+data-index) / agent-step-cmd / agent-step-out
//        agent-summary / agent-approval / approval-run / approval-rest / approval-skip
//        agent-input / agent-send / agent-stop / model-menu / composer-box /
//        composer-hint / agent-grow
//   新增：agent-sessions / agent-sessions-toggle / agent-sessions-menu /
//        agent-session-item / agent-new / agent-session-badge / agent-reasoning /
//        approval-review / approval-review-tip
//
// 降级路径：旧的 ai.reply / ai.error 仍然渲染成一条简化块（ai.reply 的 confirm
// 确认卡也搬进抽屉里，但仍是本地直接 pty.input，不发 ai.confirm）。

// V4-E：输入框拖拽高度持久化 key（逐字固定）。
const COMPOSER_HEIGHT_KEY = "magpie.term.composerHeight";
const COMPOSER_LINE_HEIGHT = 19.375;
const COMPOSER_MAX_AUTO = 116;

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
  let timeline = null;
  let input = null;
  let composerEl = null;
  let sendButton = null;
  let stopButton = null;
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

    // 头部：会话选择（点开下拉）+ 新建。没有「收起」，模型选择在输入区底栏。
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
    sessionsSub = el("span", { className: "sess-sub trunc" }, "说你想要什么结果，我来动手。");
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

    composerEl = el("div", { className: "composer" });
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
      placeholder: "继续追问，或描述下一步…",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "告诉 AI 要做什么",
    });
    const hint = el(
      "span",
      { "data-role": "composer-hint", className: "composer-hint" },
      "Enter 发送 · Shift+Enter 换行",
    );
    composerBox.append(grow, input, hint);

    const bar = el("div", { className: "composer-bar" });
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
    stopButton = el(
      "button",
      { type: "button", "data-role": "agent-stop", className: "agent-stop", hidden: "" },
      "停止",
    );
    sendButton = el(
      "button",
      { type: "button", "data-role": "agent-send", className: "agent-send", "aria-label": "发送" },
      "↑",
    );
    bar.append(modelSelect, stopButton, sendButton, modelMenu);
    composerEl.append(composerBox, bar);
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
      input.focus();
      input.select();
    } catch {
      // 忽略：焦点不是安全边界。
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
        main.appendChild(el("b", {}, item.title || "新会话"));
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
      : label || "本机";
    sessionsButton.__titleEl.textContent = headTitle;
    const count = snapshot.sessions.length;
    sessionsCount.textContent = `${count} 个会话`;
    const current = snapshot.sessions.find((item) => item.id === snapshot.currentSessionId) || null;
    const messageCount = current ? Number(current.messageCount) || 0 : 0;
    sessionsSub.textContent = current
      ? `${current.title || "新会话"} · ${messageCount} 条消息`
      : "还没有会话 · 发送第一条消息时创建";
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
      return;
    }
    const model = currentModel() || models[0] || null;
    selectedModelId = model ? model.id : null;
    modelSelect.appendChild(
      document.createTextNode(model ? model.label || model.id : "选择模型"),
    );
    modelSelect.appendChild(el("span", { className: "model-caret", "aria-hidden": "true" }, "▾"));
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
            ? "审阅不可用，按「需要确认」处理：一定要你亲自看过这条命令才行。"
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
    const headText =
      approval.risk === "danger"
        ? "需要你批准：这条命令不可逆"
        : approval.risk === null
          ? "需要你批准：审阅不可用，请自己看一眼"
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
    if (!turn.summary && turn.streamText) {
      block.appendChild(el("div", { className: "agent-stream", "data-role": "agent-stream" }, turn.streamText));
    }

    if (turn.summary) {
      const summary = el("div", { "data-role": "agent-summary", className: "agent-summary" });
      if (snapshot.status === "stopped") {
        summary.appendChild(el("div", { className: "summary-lead" }, "已停止。下面是我已经做完的部分："));
      }
      summary.appendChild(el("div", { className: "summary-text" }, turn.summary));
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

    // 停止按钮只在 running / awaiting 时可见。
    if (stopButton) stopButton.hidden = !(snapshot.status === "running" || snapshot.status === "awaiting");
    // 待确认期间不许再发新问题：发送按钮 disabled。
    if (sendButton) sendButton.disabled = hasPendingApprovals;

    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
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
    const next = Math.max(COMPOSER_LINE_HEIGHT, Math.min(cap, Number(height) || COMPOSER_LINE_HEIGHT));
    input.style.height = `${Math.round(next)}px`;
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
        applyManualHeight(startHeight + (moveEvent.clientY - startY));
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

      sendButton.addEventListener("click", () => send());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeModelMenu();
          closeSessionsMenu();
          return;
        }
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        send();
      });
      stopButton.addEventListener("click", () => {
        onStop();
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
        input.focus();
      } catch {
        // 忽略。
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
      target.scrollIntoView({ block: "center" });
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
