// toast 栈（TASK-V3-C §6.3）：右下角常驻不自动消失的「需要确认」通知。
//
// 规则（不许退化）：
// - 每条 pendingApproval 一条 toast，文案「需要确认：<command>」
// - **不自动消失**：用户点「去确认」或关闭才会消失
// - 「去确认」→ 打开抽屉 + 滚到审批卡 + 该条 toast 移除
// - 栈固定右下角，宽度 ≤ 360px，z-index 高于状态栏（见 layout.css）
//
// data-role：toast / toast-stack / toast-text / toast-action / toast-close

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

export default function createToastStack(elements) {
  const host = elements.host;
  const agentStore = elements.agentStore;
  const sessionStore = elements.sessionStore || null;
  const onGoConfirm =
    typeof elements.onGoConfirm === "function" ? elements.onGoConfirm : () => {};

  // approvalId -> 节点。按 id 复用，不重复插。
  const nodes = new Map();
  let unsubscribe = null;
  let unsubscribeSession = null;

  function removeToast(approvalId) {
    const node = nodes.get(approvalId);
    if (!node) return;
    node.remove();
    nodes.delete(approvalId);
  }

  function buildToast(approval) {
    const node = el("div", {
      "data-role": "toast",
      "data-approval-id": approval.approvalId,
      className: "toast",
      role: "alert",
    });

    const dot = el("span", { className: "toast-dot", "aria-hidden": "true" }, "!");
    node.appendChild(dot);

    const body = el("div", { className: "toast-body" });
    const text = el("div", { "data-role": "toast-text", className: "toast-text" });
    // 命令单独用 code 包一层，但整条文案仍然可读作「需要确认：xxx」。
    text.appendChild(document.createTextNode("需要确认："));
    text.appendChild(el("code", { className: "toast-command" }, approval.command || "（命令未提供）"));
    body.appendChild(text);

    if (approval.why) {
      body.appendChild(el("div", { className: "toast-why" }, approval.why));
    }
    node.appendChild(body);

    const actions = el("div", { className: "toast-actions" });
    const action = el("button", { type: "button", "data-role": "toast-action" }, "去确认");
    action.addEventListener("click", () => {
      onGoConfirm(approval.approvalId);
      removeToast(approval.approvalId);
    });
    const close = el(
      "button",
      { type: "button", "data-role": "toast-close", className: "toast-close", title: "关闭这条通知" },
      "×",
    );
    close.addEventListener("click", () => removeToast(approval.approvalId));
    actions.append(action, close);
    node.appendChild(actions);

    // 点 toast 本体也直接去确认（用户视角最顺的那条路）。
    body.addEventListener("click", () => {
      onGoConfirm(approval.approvalId);
      removeToast(approval.approvalId);
    });
    return node;
  }

  function clearAll() {
    for (const id of [...nodes.keys()]) removeToast(id);
  }

  function render(snapshot) {
    // 抽屉展开时用户就在会话区里看得到审批卡，不再弹右下角通知。
    // 只清空渲染出来的节点，agentStore 里的待确认数据原封不动；
    // 抽屉一关（sessionStore 订阅触发重渲染）就重新出现。
    if (snapshot.aiOpen === true) {
      clearAll();
      host.setAttribute("data-empty", "true");
      return;
    }

    const pending = snapshot.pendingApprovals || [];
    const alive = new Set(pending.map((item) => item.approvalId));

    // 已被处理掉的（批准/拒绝/超时）→ 撤掉对应 toast。
    for (const id of [...nodes.keys()]) {
      if (!alive.has(id)) removeToast(id);
    }

    // 新增的 → 追加。
    for (const approval of pending) {
      if (nodes.has(approval.approvalId)) continue;
      const node = buildToast(approval);
      nodes.set(approval.approvalId, node);
      host.appendChild(node);
    }

    if (pending.length === 0) host.setAttribute("data-empty", "true");
    else host.removeAttribute("data-empty");
  }

  /** agentStore 的快照不含 aiOpen：合并会话 store 的当前值后再渲染。 */
  function renderNow() {
    const snapshot = agentStore.getSnapshot();
    const aiOpen = sessionStore ? sessionStore.getSnapshot().aiOpen === true : false;
    render({ ...snapshot, aiOpen });
  }

  return {
    init() {
      unsubscribe = agentStore.subscribe(renderNow);
      if (sessionStore && typeof sessionStore.subscribe === "function") {
        unsubscribeSession = sessionStore.subscribe(renderNow);
      }
      renderNow();
    },
    /** 供「去确认」之外的入口用（比如抽屉里批准后手动清）。 */
    clear(approvalId) {
      removeToast(approvalId);
    },
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (unsubscribeSession) unsubscribeSession();
      unsubscribeSession = null;
      clearAll();
    },
  };
}
