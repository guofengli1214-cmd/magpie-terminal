// 未开 AI 抽屉时的浮层确认卡（TASK-FIX17-L3 / 用户问题清单第 3 条）。
//
// 用户原话：「未打开 ai 栏的情况下，弹出的确认卡能够直接点击确认或拒绝，还要展示两个文字
// 信息，执行这个要做什么，执行后会怎么样。」
//
// 三件事，一条都不许自作聪明：
//   1. 只在 AI 抽屉**关着**且有待确认时出现（抽屉开着时抽屉自己有卡片，两层同时出现
//      会让用户以为同一件事要确认两次）；
//   2. 卡片上必须有**两段人话**：「要做什么」与「执行后会怎样」——而且只能来自帧里的
//      真实字段（why / confirmWhy / effect），缺字段才按 PRD R4 的固定顺序回落，
//      绝不在这里编一句听起来像审阅结论的话；
//   3. 点「执行 / 拒绝」走的是与抽屉**完全同一条**审批链路（app.js 的 onApprove →
//      `agent.approve` 帧），不是自己拼帧、也不是本地直接写 PTY。
//
// 本文件不认识 agentStore、不认识 ws、不认识 DOM 结构里的任何别的组件：
// 只接收 `render(snapshot)` 把状态画出来，点击时把意图交回 app.js。
// 这样「抽屉内的卡片」与「浮层卡片」永远读同一份 snapshot，状态天然同步。

/** 与 `app/ui/ai-drawer.js` 的 REVIEW_STATE 同语义的四态（data-review 值不许改名）。 */
const REVIEW_STATE = {
  safe: { state: "ok", label: "已审阅，判定安全", text: "安全，已审可放行" },
  caution: { state: "caution", label: "需要注意", text: "有改动，需要你判断" },
  danger: { state: "danger", label: "危险", text: "危险，必须你确认" },
  none: { state: "none", label: "未审阅", text: "未审阅，按需要确认处理" },
};

/** 卡片标题（R4.1 逐字）。 */
export const POPOVER_TITLE = "AI 想执行一条命令";

/** 两段人话的小标题（R4.3 / R4.4 逐字）。 */
export const LABEL_WHY = "要做什么";
export const LABEL_EFFECT = "执行后会怎样";

/**
 * 「执行后会怎样」的**最后**一级回落（R4.4 逐字）。
 *
 * 只有在 confirmWhy 与 effect 都缺失时才会出现。它说的是一件永远为真的事
 * （命令确实会在这台机器上执行），因此不需要任何审阅结论就能讲。
 */
export const EFFECT_FALLBACK = "会直接在这台电脑上执行，无法自动撤销。";

/** 兜底文案同样只用于「一条待批都没有其他可读信息」的极端情况。 */
function pickText(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

/**
 * 「要做什么」= `why`，为空回落 `command`（R4.3）。
 * 导出是为了让单测直接断言回落顺序，不必造 DOM。
 */
export function approvalWhyText(approval) {
  if (!approval) return "";
  return pickText(approval.why) || pickText(approval.command);
}

/**
 * 「执行后会怎样」= `confirmWhy` → `effect` → 固定兜底句（R4.4）。
 * 顺序不许调换：confirmWhy 是审阅**针对这条命令**说的后果，effect 是更泛的影响描述。
 */
export function approvalEffectText(approval) {
  if (!approval) return EFFECT_FALLBACK;
  return pickText(approval.confirmWhy) || pickText(approval.effect) || EFFECT_FALLBACK;
}

/** 风险归一化：认不出的值一律当 none（与抽屉的角标判定同一条规则）。 */
export function approvalReviewState(approval) {
  const risk = approval && ["safe", "caution", "danger"].includes(approval.risk) ? approval.risk : "none";
  return REVIEW_STATE[risk];
}

/** `data-risk`：PRD 那四个名字（认不出 → "none"）。 */
function riskKeyOf(approval) {
  return approval && ["safe", "caution", "danger"].includes(approval.risk) ? approval.risk : "none";
}

/** 极小的 DOM 工厂（同 ai-drawer / command-orb 的 el，不引依赖）。 */
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

/**
 * 创建浮层确认卡。
 *
 * @param {object} [options]
 * @param {Element} [options.mount] 父节点（默认 document.body；卡片自己 fixed 定位）
 * @param {(payload: {approvalId: string, approved: boolean, scope: "once"|"rest"}) => boolean} [options.onApprove]
 *   与抽屉**同一个** onApprove（app.js 里那份唯一实现）
 * @param {(text: string, tone: string) => void} [options.onNotice] 状态栏提示
 * @param {() => boolean} [options.isDrawerOpen] 抽屉是否打开（由 app.js 传，不猜 DOM 类名）
 * @returns {{ render(snapshot: object): object, destroy(): void, get element(): Element }}
 */
export default function createApprovalPopover(options = {}) {
  const {
    mount = document.body,
    onApprove = () => false,
    onNotice = () => {},
    isDrawerOpen = () => false,
  } = options || {};

  const host = mount || document.body;

  let destroyed = false;
  // 当前展示的那一条（点击时按它回传 approvalId，避免渲染与点击之间被新帧换队首）。
  let current = null;

  /* ---------------- DOM（只建一次，之后只改文字） ---------------- */

  const root = el("div", {
    "data-role": "approval-popover",
    className: "approval-popover",
    role: "group",
    "aria-label": POPOVER_TITLE,
    "data-visible": "false",
  });
  root.hidden = true;

  const head = el("div", { className: "ap-head" });
  const riskMark = el("span", {
    "data-role": "popover-risk",
    className: "ap-risk",
    "data-risk": "none",
    "data-review": "none",
  });
  const riskGlow = el("span", { className: "ap-risk-dot", "aria-hidden": "true" });
  const riskText = el("span", { className: "ap-risk-text" });
  riskMark.append(riskGlow, riskText);
  const title = el("span", { className: "ap-title" }, POPOVER_TITLE);
  const count = el("span", { "data-role": "popover-count", className: "ap-count" });
  count.hidden = true;
  head.append(riskMark, title, count);

  const command = el("code", {
    "data-role": "popover-command",
    className: "ap-command",
  });

  const whySection = el("div", { className: "ap-section" });
  const whyLabel = el("span", { className: "ap-label" }, LABEL_WHY);
  const whyBody = el("p", { "data-role": "popover-why", className: "ap-why" });
  whySection.append(whyLabel, whyBody);

  const effectSection = el("div", { className: "ap-section" });
  const effectLabel = el("span", { className: "ap-label" }, LABEL_EFFECT);
  const effectBody = el("p", { "data-role": "popover-effect", className: "ap-effect" });
  effectSection.append(effectLabel, effectBody);

  // 「为什么没送审」那一条真实原因（只在 risk=null 且有 reviewReason 时出现）。
  const reasonLine = el("p", { "data-role": "popover-reason", className: "ap-reason" });
  reasonLine.hidden = true;

  const actions = el("div", { className: "ap-actions" });
  const approveButton = el("button", { type: "button", "data-role": "popover-approve" }, "执行");
  const rejectButton = el("button", { type: "button", "data-role": "popover-reject" }, "拒绝");
  // 抽屉卡片总是同时给 scope=rest（ai-drawer.js 的 approval-rest），这里保持一致。
  const restButton = el("button", { type: "button", "data-role": "popover-approve-rest" }, "本会话都允许");
  actions.append(approveButton, rejectButton, restButton);

  root.append(head, command, whySection, effectSection, reasonLine, actions);
  host.appendChild(root);

  /* ---------------- 点击 → onApprove（与抽屉同一条链路） ---------------- */

  function decide({ approved, scope }) {
    if (destroyed || !current) return false;
    const approvalId = current.approvalId;
    let ok = false;
    try {
      ok = onApprove({ approvalId, approved, scope }) === true;
    } catch {
      // onApprove 抛错 = 我们连「帧发没发出去」都不知道，这里必须说一声；
      // 返回 false 是**已知**的失败（app.js 已经在状态栏说明了原因），不重复提示。
      ok = false;
      safeNotice("审批没发出去，卡片还在：可以直接再点一次。", "error");
      return false;
    }
    if (!ok) {
      // 具体原因 app.js 已经在状态栏说过了（连接断了 / 没有活动任务）。
      // 不在这里假装成功：卡片保持可见，用户可以重试。
      return false;
    }
    return true;
  }

  function safeNotice(text, tone) {
    try {
      onNotice(text, tone);
    } catch {
      // 提示失败不能把点击链炸掉。
    }
  }

  approveButton.addEventListener("click", () => decide({ approved: true, scope: "once" }));
  rejectButton.addEventListener("click", () => decide({ approved: false, scope: "once" }));
  restButton.addEventListener("click", () => decide({ approved: true, scope: "rest" }));

  /* ---------------- 渲染 ---------------- */

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function hide() {
    if (!root.hidden) root.hidden = true;
    if (root.getAttribute("data-visible") !== "false") root.setAttribute("data-visible", "false");
    current = null;
  }

  function render(snapshot) {
    if (destroyed) return { visible: false, count: 0 };
    const pool = snapshot && Array.isArray(snapshot.pendingApprovals) ? snapshot.pendingApprovals : [];
    const total = pool.length;

    // R2：有待确认 **且** 抽屉关着才显示。抽屉开着时抽屉里有卡片，这里让位。
    let drawerOpen = false;
    try {
      drawerOpen = isDrawerOpen() === true;
    } catch {
      drawerOpen = false;
    }
    if (total === 0 || drawerOpen) {
      hide();
      return { visible: false, count: total };
    }

    const approval = pool[0];
    current = approval;

    // 1) 风险角标四态 + 标题
    const state = approvalReviewState(approval);
    riskMark.setAttribute("data-risk", riskKeyOf(approval));
    riskMark.setAttribute("data-review", state.state);
    riskMark.setAttribute("aria-label", `审核 AI 判定：${state.label}`);
    riskMark.setAttribute("title", state.label);
    setText(riskText, state.text);

    // 2) 命令行原样（等宽、横向滚动，不折行破坏命令）
    setText(command, pickText(approval.command) || "（这条命令没有内容）");

    // 3) 两段人话，字段优先级见 approvalWhyText / approvalEffectText
    setText(whyBody, approvalWhyText(approval));
    setText(effectBody, approvalEffectText(approval));

    // 4) 真实原因（risk=null 且 judge 说了原因时才显示；danger 三态一律不覆盖）
    const reason = pickText(approval.reviewReason);
    const showReason = approval.risk === null && reason.length > 0;
    setText(reasonLine, showReason ? `审阅没有送审：${reason}` : "");
    reasonLine.hidden = !showReason;

    // 5) 队列：「还有 N 条等待」只在真的还有别的待批时出现（R2）
    const waiting = total - 1;
    setText(count, waiting > 0 ? `还有 ${waiting} 条等待` : "");
    count.hidden = waiting <= 0;

    if (root.hidden) root.hidden = false;
    if (root.getAttribute("data-visible") !== "true") root.setAttribute("data-visible", "true");
    return { visible: true, count: total };
  }

  return {
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      current = null;
      root.remove();
    },
    /** 只读：给探针 / 调试用（不参与业务逻辑）。 */
    get element() {
      return root;
    },
  };
}
