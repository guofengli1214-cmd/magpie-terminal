// 右侧 AI 抽屉（TASK-V4-E）：标题栏（只有标题）/ 时间线 / 输入区。
//
// 数据来源：core/agent-store.js 的订阅（agent.* 帧由 app.js 转进来）。
// 这里只渲染 + 发帧，不改 store 字段。
//
// data-role 名单是验收探针，逐字不许改：
//   ai-drawer-head / model-select / agent-timeline / agent-question
//   agent-step(+data-status,+data-index) / agent-step-cmd / agent-step-out
//   agent-summary / agent-approval / approval-run / approval-rest / approval-skip
//   agent-input / agent-send / agent-stop
// V4-E 新增：model-menu / composer-box / composer-hint / agent-grow
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

const RISK_LABEL = {
  safe: "风险：只读，安全",
  caution: "风险：可撤销的写操作",
  danger: "风险：不可逆，需要谨慎",
};

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

export default function createAiDrawer(elements) {
  const host = elements.host;
  const agentStore = elements.agentStore;
  const api = elements.api;
  const onAsk = typeof elements.onAsk === "function" ? elements.onAsk : () => false;
  const onApprove = typeof elements.onApprove === "function" ? elements.onApprove : () => false;
  const onStop = typeof elements.onStop === "function" ? elements.onStop : () => {};
  const onNotice = typeof elements.onNotice === "function" ? elements.onNotice : () => {};
  const onExecuteLegacy = typeof elements.onExecuteLegacy === "function" ? elements.onExecuteLegacy : () => {};

  let models = [];
  let reachable = false;
  let loading = false;
  // 折叠状态与「展开过」记忆：重渲染时间线时不丢。
  const expandedSteps = new Set();
  // 旧路径（ai.reply / ai.error）的简化块，单独存着，重渲染时一起画。
  const legacyBlocks = [];
  // 内核未就绪的看门狗：发 agent.run 后 N 毫秒内没有任何 agent.* 帧 → 明说。
  // 时长可配置（TASK-V3-C-FIX1 修复 E）；默认 5 秒，慢网关场景可由调用方调大。
  let readyTimeoutMs =
    Number.isFinite(Number(elements.readyTimeoutMs)) && Number(elements.readyTimeoutMs) > 0
      ? Number(elements.readyTimeoutMs)
      : 5000;
  let readyWatchdog = null;
  let sawAgentFrame = false;
  // 待确认时点了发送：输入框不清空，时间线尾部给一行提示（修复 B/D6）。
  let blockedHint = false;

  /* ---------------- 结构 ---------------- */

  function buildShell() {
    host.textContent = "";

    // 头部只留标题：没有「收起」按钮，模型选择在输入区底栏。
    const head = el("div", { "data-role": "ai-drawer-head", className: "drawer-head" });
    head.appendChild(el("span", { className: "drawer-title" }, "AI 助手"));
    host.appendChild(head);

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
      placeholder: "描述任务，或粘贴报错…",
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

  let modelSelect = null;
  let modelMenu = null;
  let timeline = null;
  let input = null;
  let composerEl = null;
  let sendButton = null;
  let stopButton = null;
  let selectedModelId = null;

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

  function approvalForStep(stepId) {
    const snapshot = agentStore.getSnapshot();
    return snapshot.pendingApprovals.find((item) => item.stepId === stepId) || null;
  }

  function orphanApprovals(snapshot) {
    // 找不到对应步骤的审批（服务端可能先发 approval），单独在尾部画一张。
    const ids = new Set(snapshot.steps.map((step) => step.stepId));
    return snapshot.pendingApprovals.filter((item) => !ids.has(item.stepId));
  }

  function buildApprovalCard(approval) {
    const card = el("div", { "data-role": "agent-approval", className: "agent-approval" });
    const riskText = RISK_LABEL[approval.risk] || "风险：未审阅（按需要确认处理）";
    const risk = el(
      "div",
      { className: `risk risk-${approval.risk || "unknown"}` },
      riskText,
    );
    card.appendChild(risk);
    if (approval.reviewWhy) {
      card.appendChild(el("div", { className: "review-why" }, `审阅：${approval.reviewWhy}`));
    }
    if (approval.reversible === false) {
      card.appendChild(el("div", { className: "review-why" }, "这条命令不可撤销，执行前请确认。"));
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
    return card;
  }

  function buildStep(step, snapshot, index) {
    const stepEl = el("div", {
      "data-role": "agent-step",
      "data-index": String(step.index || index + 1),
      "data-status": step.status,
      "data-step-id": step.stepId,
      className: "agent-step",
    });

    const head = el("div", { className: "step-head" });
    head.appendChild(el("span", { className: "step-idx" }, String(step.index || index + 1)));
    if (step.kind === "note") {
      head.appendChild(el("span", { className: "step-kind" }, "说明"));
    }
    head.appendChild(el("span", { className: "step-state" }, STEP_LABEL[step.status] || step.status));
    stepEl.appendChild(head);

    if (step.command) {
      stepEl.appendChild(el("code", { "data-role": "agent-step-cmd" }, step.command));
    }
    if (step.kind === "note" && step.why) {
      stepEl.appendChild(el("div", { className: "step-why" }, step.why));
    } else if (step.why) {
      stepEl.appendChild(el("div", { className: "step-why" }, step.why));
    }
    if (step.userText) {
      stepEl.appendChild(el("div", { className: "step-usertext" }, step.userText));
    }
    if (step.exitCode !== null && step.exitCode !== undefined && step.status !== "running") {
      stepEl.appendChild(el("div", { className: "step-exit" }, `退出码：${step.exitCode}`));
    }

    // 输出：默认折叠，点击展开。
    if (step.output && step.output.length > 0) {
      const expanded = expandedSteps.has(step.stepId);
      const toggle = el(
        "button",
        {
          type: "button",
          "data-role": "agent-step-out-toggle",
          className: "step-out-toggle",
          "aria-expanded": expanded ? "true" : "false",
        },
        expanded ? "收起输出" : "查看输出",
      );
      // 展开态不要写 hidden=""（setAttribute("hidden","false") 依然是隐藏的）。
      const out = el("pre", { "data-role": "agent-step-out", className: "step-out" }, step.output);
      if (!expanded) out.setAttribute("hidden", "");
      toggle.addEventListener("click", () => {
        if (expandedSteps.has(step.stepId)) expandedSteps.delete(step.stepId);
        else expandedSteps.add(step.stepId);
        render(agentStore.getSnapshot());
      });
      stepEl.append(toggle, out);
    }

    const approval = approvalForStep(step.stepId);
    if (approval) stepEl.appendChild(buildApprovalCard(approval));
    return stepEl;
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

  function renderEmptyState() {
    const wrap = el("div", { className: "agent-empty", "data-role": "agent-empty" });
    wrap.appendChild(el("div", { className: "agent-empty-icon" }, "✦"));
    wrap.appendChild(el("div", { className: "agent-empty-text" }, "说你想要什么结果，我来动手。"));
    wrap.appendChild(
      el(
        "div",
        { className: "agent-empty-hint" },
        "比如「看看这个目录里有多少个文件」「把测试跑一遍告诉我有没有失败」。我只跑只读命令，改动类的会先问你。",
      ),
    );
    timeline.appendChild(wrap);
  }

  function render(snapshot) {
    if (!timeline) return;
    timeline.textContent = "";
    const hasPendingApprovals = snapshot.pendingApprovals.length > 0;
    // 待确认清空后提示自动收起。
    if (!hasPendingApprovals) blockedHint = false;

    const hasContent =
      snapshot.steps.length > 0 ||
      snapshot.pendingApprovals.length > 0 ||
      Boolean(snapshot.summary) ||
      Boolean(snapshot.question) ||
      legacyBlocks.length > 0;

    if (snapshot.question) {
      timeline.appendChild(el("div", { "data-role": "agent-question", className: "agent-question" }, snapshot.question));
    }

    if (snapshot.steps.length === 0 && snapshot.question && snapshot.status === "running") {
      timeline.appendChild(el("div", { className: "agent-thinking" }, "正在想怎么做…"));
    }

    if (!hasContent) renderEmptyState();

    for (let index = 0; index < snapshot.steps.length; index += 1) {
      timeline.appendChild(buildStep(snapshot.steps[index], snapshot, index));
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

    if (snapshot.summary) {
      const summary = el("div", { "data-role": "agent-summary", className: "agent-summary" });
      if (snapshot.status === "stopped") summary.appendChild(el("div", { className: "summary-lead" }, "已停止。下面是我已经做完的部分："));
      summary.appendChild(el("div", { className: "summary-text" }, snapshot.summary));
      timeline.appendChild(summary);
    } else if (snapshot.status === "stopped") {
      timeline.appendChild(el("div", { "data-role": "agent-summary", className: "agent-summary" }, "已停止。"));
    }

    // 停止按钮只在 running / awaiting 时可见（其余状态隐藏）。
    if (stopButton) stopButton.hidden = !(snapshot.status === "running" || snapshot.status === "awaiting");
    // 待确认期间不许再发新问题（修复 B/D6）：发送按钮 disabled，直到审批清空。
    if (sendButton) sendButton.disabled = hasPendingApprovals;

    // 滚动到底部（用户正在读中间时略过：靠 near-bottom 判断）。
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 120;
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
    // 门禁（修复 B/D6）：有待确认时不允许开新任务，输入框保留原话。
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
      // 明确标记本地伪造（local:true）：收到任何真实 agent.* 帧时 agent-store 会自动清掉。
      agentStore.failLocally({
        code: "AGENT_NOT_READY",
        userText: "AI 内核还没就绪（TASK-V3-D 未合入）：这版界面已经发得出 agent.run，但服务端没有回任何 agent.* 帧。",
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
      userText: "AI 内核还没就绪（TASK-V3-D 未合入）：服务端拒绝了 agent.run 帧。",
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
      // 用户重新输入即回到自动增高，并清掉上次拖拽记住的高度。
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

      sendButton.addEventListener("click", () => send());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeModelMenu();
          return;
        }
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        send();
      });
      stopButton.addEventListener("click", () => {
        onStop();
      });

      // 点菜单外 / Esc 关菜单。
      document.addEventListener(
        "mousedown",
        (event) => {
          if (!modelMenu || modelMenu.hidden) return;
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (modelMenu.contains(target) || modelSelect.contains(target)) return;
          closeModelMenu();
        },
        true,
      );
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape" && modelMenu && !modelMenu.hidden) {
            closeModelMenu();
          }
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
  };
}
