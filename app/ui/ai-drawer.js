// 右侧 AI 抽屉（TASK-V3-C §6.2）：标题栏（标题 + 模型下拉 + 收起）/ 时间线 / 输入条。
//
// 数据来源：core/agent-store.js 的订阅（agent.* 帧由 app.js 转进来）。
// 这里只渲染 + 发帧，不改 store 字段。
//
// data-role 名单是验收探针，逐字不许改：
//   ai-drawer-head / model-select / ai-close / agent-timeline / agent-question
//   agent-step(+data-status,+data-index) / agent-step-cmd / agent-step-out
//   agent-summary / agent-approval / approval-run / approval-rest / approval-skip
//   agent-input / agent-send / agent-stop
//
// 降级路径：旧的 ai.reply / ai.error 仍然渲染成一条简化块（ai.reply 的 confirm
// 确认卡也搬进抽屉里，但仍是本地直接 pty.input，不发 ai.confirm）。

const RETRY_VALUE = "__retry__";

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
  const onClose = typeof elements.onClose === "function" ? elements.onClose : () => {};
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

    const head = el("div", { "data-role": "ai-drawer-head", className: "drawer-head" });
    head.appendChild(el("span", { className: "drawer-title" }, "AI 助手"));

    modelSelect = el("select", {
      "data-role": "model-select",
      "aria-label": "选择模型",
      title: "选择模型",
      className: "drawer-model",
    });
    head.appendChild(modelSelect);

    closeButton = el("button", { type: "button", "data-role": "ai-close", title: "收起 AI 抽屉" }, "收起");
    head.appendChild(closeButton);
    host.appendChild(head);

    timeline = el("div", {
      "data-role": "agent-timeline",
      className: "agent-timeline",
      "aria-live": "polite",
    });
    host.appendChild(timeline);

    const inputBar = el("div", { className: "agent-input-bar" });
    input = el("input", {
      type: "text",
      "data-role": "agent-input",
      placeholder: "用中文说要干什么，AI 会自己动手…",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "告诉 AI 要做什么",
    });
    sendButton = el("button", { type: "button", "data-role": "agent-send", className: "agent-send" }, "发送");
    stopButton = el(
      "button",
      { type: "button", "data-role": "agent-stop", className: "agent-stop", hidden: "" },
      "停止",
    );
    inputBar.append(input, sendButton, stopButton);
    host.appendChild(inputBar);
  }

  let modelSelect = null;
  let closeButton = null;
  let timeline = null;
  let input = null;
  let sendButton = null;
  let stopButton = null;

  /* ---------------- 模型下拉（沿用 ai-bar.js 的失败记忆 + __retry__） ---------------- */

  function currentModel() {
    return models.find((model) => model.id === modelSelect.value) || null;
  }

  function renderOptions(chosenId) {
    modelSelect.textContent = "";
    if (!reachable || models.length === 0) {
      const option = el("option", { value: RETRY_VALUE }, "网关不可用，点重试");
      modelSelect.appendChild(option);
      modelSelect.value = RETRY_VALUE;
      modelSelect.setAttribute("data-gateway", "down");
      return;
    }
    for (const model of models) {
      const option = el(
        "option",
        {
          value: model.id,
          "data-available": model.available === false ? "false" : "true",
        },
        model.available === false ? `${model.label}（上次失败）` : model.label,
      );
      modelSelect.appendChild(option);
    }
    const target = models.some((model) => model.id === chosenId)
      ? chosenId
      : models[0]
        ? models[0].id
        : "";
    modelSelect.value = target;
    modelSelect.removeAttribute("data-gateway");
  }

  async function loadModels() {
    if (loading) return;
    loading = true;
    modelSelect.setAttribute("aria-busy", "true");
    const [modelsResult, configResult] = await Promise.all([api.models(), api.config()]);
    loading = false;
    modelSelect.removeAttribute("aria-busy");
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

  /* ---------------- 外部接口 ---------------- */

  return {
    init() {
      buildShell();

      modelSelect.addEventListener("change", () => {
        if (modelSelect.value === RETRY_VALUE) {
          void loadModels();
          return;
        }
        void persistModel(modelSelect.value);
      });

      closeButton.addEventListener("click", () => onClose());

      sendButton.addEventListener("click", () => send());
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        send();
      });
      stopButton.addEventListener("click", () => {
        onStop();
      });

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
