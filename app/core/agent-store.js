// Agent 状态模型（docs/PROTOCOL-AGENT.md §7，逐字对齐字段名）。
//
// 只持有 agent.* 帧带来的状态，不碰会话/终端状态（那是 core/session-store.js）。
// 视图只订阅，所有变更走具名方法；subscribers 出错不互相影响。
//
// 状态：
// {
//   taskId, requestId,
//   status: "idle" | "running" | "awaiting" | "done" | "error" | "stopped",
//   question, summary,
//   steps: [{ stepId, index, kind, status, command, why, output, exitCode, durationMs, userText }],
//   pendingApprovals: [{ approvalId, stepId, command, why, risk, reviewWhy, reversible }],
//   error: { code, userText, local? } | null,
// }
//
// 关键不变量：
// - steps 按 stepId upsert（同一 stepId 多次 agent.step 只会有一条）
// - pendingApprovals 按 approvalId 去重（一个 stepId 只会收到一次 agent.approval）
// - pendingApprovals 变化是「红点 + toast」的唯一触发源
// - 作用域隔离（TASK-V3-C-FIX1 修复 A）：只有属于「当前活动任务」的帧能改状态；
//   requestId 优先，缺 requestId 时用 taskId；两者都没有就宽容地当成当前任务。
// - 状态收尾（修复 D）：agent.done 之后时间线里不许再有任何 awaiting/running/pending 的 step。
// - 本地伪造的错误（看门狗 / BAD_FRAME）带 local:true，收到任何真实 agent.* 帧就清掉（修复 E）。

const STATUS_VALUES = new Set(["idle", "running", "awaiting", "done", "error", "stopped"]);
const STEP_STATUS_VALUES = new Set([
  "pending",
  "running",
  "awaiting",
  "done",
  "failed",
  "denied",
  "skipped",
]);

function pickStepStatus(value) {
  return STEP_STATUS_VALUES.has(value) ? value : "pending";
}

function pickString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function emptyState() {
  return {
    taskId: null,
    requestId: null,
    status: "idle",
    question: "",
    summary: "",
    steps: [],
    pendingApprovals: [],
    error: null,
  };
}

export default function createAgentStore() {
  let state = emptyState();
  // 已经发出 agent.run、但内核还没回 agent.start 的「下一次」任务。
  // 当前有任务在跑时不覆盖当前状态，等 agent.start 到了再切换（修复 B/D2 的配套）。
  let pendingRun = null;
  const subscribers = new Set();
  let scheduled = false;

  function snapshotOf() {
    return {
      taskId: state.taskId,
      requestId: state.requestId,
      status: state.status,
      question: state.question,
      summary: state.summary,
      steps: state.steps.map((step) => ({ ...step })),
      pendingApprovals: state.pendingApprovals.map((item) => ({ ...item })),
      error: state.error ? { ...state.error } : null,
    };
  }

  function notify() {
    if (scheduled) return;
    scheduled = true;
    const flush = () => {
      scheduled = false;
      const snapshot = snapshotOf();
      for (const fn of subscribers) {
        try {
          fn(snapshot);
        } catch {
          // 单个订阅者出错不影响其他订阅者。
        }
      }
    };
    if (typeof queueMicrotask === "function") queueMicrotask(flush);
    else Promise.resolve().then(flush);
  }

  function setStatus(value) {
    const next = STATUS_VALUES.has(value) ? value : state.status;
    if (state.status === next) return;
    state.status = next;
    notify();
  }

  function findStep(stepId) {
    return state.steps.find((step) => step.stepId === stepId) || null;
  }

  function hasActiveTask() {
    return (
      (state.status === "running" || state.status === "awaiting") &&
      typeof state.requestId === "string" &&
      state.requestId.length > 0
    );
  }

  /**
   * 作用域判定（修复 A）：帧是否属于当前活动任务。
   * - 帧带 requestId：必须等于当前 requestId；当前还没有活动任务时接受并认领。
   * - 帧没带 requestId 但带 taskId：在当前 taskId 已知时必须相等。
   * - 两者都没带：宽容地当成当前任务（协议规定后续帧都带，但旧内核可能漏）。
   */
  function frameBelongsToCurrent(frame) {
    if (!frame || typeof frame !== "object") return false;
    const requestId = pickString(frame.requestId);
    const taskId = pickString(frame.taskId);
    if (requestId) {
      if (!state.requestId) {
        state.requestId = requestId;
        return true;
      }
      return requestId === state.requestId;
    }
    if (taskId && state.taskId) return taskId === state.taskId;
    return true;
  }

  /**
   * 修复 E：本地伪造的错误（AGENT_NOT_READY 等）一旦收到真实 agent.* 帧就必须消失，
   * 因为内核显然已经就绪。返回到「有任务在跑」的状态，后续帧处理会再纠正。
   */
  function clearLocalError() {
    if (!state.error || state.error.local !== true) return false;
    state.error = null;
    if (state.status === "error") {
      state.status = state.pendingApprovals.length > 0 ? "awaiting" : "running";
    }
    return true;
  }

  /** agent.done / agent.error 的收尾：不许留任何未完成状态（修复 D/D9）。 */
  function closeOpenSteps() {
    for (const step of state.steps) {
      if (step.status === "awaiting" || step.status === "running") step.status = "done";
      else if (step.status === "pending") step.status = "skipped";
    }
  }

  return {
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    getSnapshot: snapshotOf,

    /**
     * agent.run 发出后调用。
     * - 没有活动任务：立刻置为 running（本地先动，不等 agent.start），返回 { adopted: true }。
     * - 已有任务在跑/待确认：**不清任何状态**，只记下这次请求，等 agent.start 到了再切换
     *   （修复 B/D2：别的 requestId 的 BUSY 不会吞掉当前任务的审批）。
     */
    beginRun({ requestId, question }) {
      const nextRequestId = typeof requestId === "string" ? requestId : null;
      const nextQuestion = typeof question === "string" ? question : "";
      if (hasActiveTask()) {
        pendingRun = { requestId: nextRequestId, question: nextQuestion };
        return { adopted: false, pending: true };
      }
      pendingRun = null;
      state = emptyState();
      state.requestId = nextRequestId;
      state.question = nextQuestion;
      state.status = "running";
      notify();
      return { adopted: true, pending: false };
    },

    /** agent.start：记为当前活动任务。换了 requestId 就是新任务 → 丢掉上一个任务的残帧。 */
    onStart(frame) {
      const frameRequestId = pickString(frame && frame.requestId);
      const requestId =
        frameRequestId ||
        (pendingRun && pendingRun.requestId) ||
        state.requestId ||
        null;
      const taskId = pickString(frame && frame.taskId);
      const startingNewTask = !state.requestId || requestId !== state.requestId;
      if (startingNewTask) {
        const carriedQuestion =
          pendingRun && pendingRun.requestId && pendingRun.requestId === requestId
            ? pendingRun.question
            : state.question;
        state = emptyState();
        state.requestId = requestId;
        state.question = carriedQuestion;
      }
      if (taskId) state.taskId = taskId;
      // 内核显然活着：本地看门狗伪造的错误必须消失（修复 E）。
      clearLocalError();
      state.status = state.pendingApprovals.length > 0 ? "awaiting" : "running";
      pendingRun = null;
      notify();
      return { adopted: true, newTask: startingNewTask };
    },

    /** agent.step：按 stepId upsert（同一 stepId 不重复 append）。别的任务的帧直接丢弃。 */
    onStep(frame) {
      if (!frame || typeof frame.stepId !== "string") return null;
      if (!frameBelongsToCurrent(frame)) {
        if (typeof console !== "undefined" && console.debug) {
          console.debug(
            `[agent-store] 丢弃别的任务的 step：requestId=${frame.requestId} 当前=${state.requestId}`,
          );
        }
        return null;
      }
      clearLocalError();
      const patch = {
        stepId: frame.stepId,
        index: Number.isFinite(Number(frame.index)) ? Number(frame.index) : state.steps.length + 1,
        kind: frame.kind === "note" ? "note" : "command",
        status: pickStepStatus(frame.status),
        command: typeof frame.command === "string" ? frame.command : "",
        why: typeof frame.why === "string" ? frame.why : "",
        output: typeof frame.output === "string" ? frame.output : "",
        exitCode: frame.exitCode === undefined ? null : frame.exitCode,
        durationMs: frame.durationMs === undefined ? null : frame.durationMs,
        userText: typeof frame.userText === "string" ? frame.userText : "",
      };
      const existing = findStep(frame.stepId);
      if (existing) {
        Object.assign(existing, patch);
      } else {
        state.steps.push(patch);
      }
      // 步骤状态变化会带动整体状态：有 awaiting 步骤即 awaiting。
      const hasAwaiting = state.steps.some((step) => step.status === "awaiting");
      if (hasAwaiting) state.status = "awaiting";
      else if (state.status === "idle" || state.status === "error") state.status = "running";
      notify();
      return patch;
    },

    /** agent.approval：插一条待确认（同一 approvalId 只保留一条）。别的任务的帧直接丢弃。 */
    onApproval(frame) {
      if (!frame || typeof frame.approvalId !== "string") return null;
      if (!frameBelongsToCurrent(frame)) {
        if (typeof console !== "undefined" && console.debug) {
          console.debug(
            `[agent-store] 丢弃别的任务的 approval：requestId=${frame.requestId} 当前=${state.requestId}`,
          );
        }
        return null;
      }
      clearLocalError();
      if (frame.stepId && findStep(frame.stepId)) {
        const step = findStep(frame.stepId);
        step.status = "awaiting";
        if (typeof frame.command === "string" && frame.command) step.command = frame.command;
        if (typeof frame.why === "string" && frame.why) step.why = frame.why;
      }
      if (state.pendingApprovals.some((item) => item.approvalId === frame.approvalId)) {
        return null;
      }
      const approval = {
        approvalId: frame.approvalId,
        stepId: typeof frame.stepId === "string" ? frame.stepId : "",
        command: typeof frame.command === "string" ? frame.command : "",
        why: typeof frame.why === "string" ? frame.why : "",
        risk: ["safe", "caution", "danger"].includes(frame.risk) ? frame.risk : null,
        reviewWhy: typeof frame.reviewWhy === "string" ? frame.reviewWhy : null,
        reversible: typeof frame.reversible === "boolean" ? frame.reversible : null,
      };
      state.pendingApprovals.push(approval);
      state.status = "awaiting";
      notify();
      return approval;
    },

    /**
     * 用户点了审批按钮：立刻把该条从未决列表移除，并把对应 step 的状态改掉（修复 D4）。
     * - approved=true → step 立刻 "running"（不等内核补帧）
     * - approved=false → step 立刻 "denied"（内核随后也会推 denied，重复推送无害）
     * 帧失败也只是少了角标，状态最多被内核下一帧纠正。
     */
    removeApproval(approvalId, approved) {
      const index = state.pendingApprovals.findIndex((item) => item.approvalId === approvalId);
      if (index === -1) return false;
      const [removed] = state.pendingApprovals.splice(index, 1);
      const step = removed && removed.stepId ? findStep(removed.stepId) : null;
      // 只改还停在 awaiting 的 step：内核可能已经先推了 running/denied，别把它倒回去。
      if (step && step.status === "awaiting") {
        step.status = approved === false ? "denied" : "running";
      }
      if (state.pendingApprovals.length === 0 && state.status === "awaiting") {
        state.status = "running";
      }
      notify();
      return true;
    },

    /** agent.done：写总结、清待确认、收尾所有未完成 step、清掉错误框（修复 D3/D9）。 */
    onDone(frame) {
      if (!frameBelongsToCurrent(frame)) {
        if (typeof console !== "undefined" && console.debug) {
          console.debug(
            `[agent-store] 丢弃别的任务的 done：requestId=${frame.requestId} 当前=${state.requestId}`,
          );
        }
        return false;
      }
      if (typeof frame.taskId === "string" && frame.taskId.length > 0 && !state.taskId) {
        state.taskId = frame.taskId;
      }
      state.summary = frame && typeof frame.text === "string" ? frame.text : "";
      state.pendingApprovals = [];
      closeOpenSteps();
      // 成功结束就是成功：错误框（包括看门狗伪造的）必须消失。
      state.error = null;
      state.status = frame && frame.stopped === true ? "stopped" : "done";
      pendingRun = null;
      notify();
      return true;
    },

    /**
     * agent.error：只接受当前活动任务的错误（修复 C）。
     * - 别的 requestId 的 BUSY 等一律丢弃，不动当前审批。
     * - 接受时：记错误、把仍在跑的 step 收尾（awaiting/running → failed，pending → skipped）、清待确认。
     */
    onError(frame) {
      if (!frameBelongsToCurrent(frame)) {
        if (typeof console !== "undefined" && console.debug) {
          console.debug(
            `[agent-store] 丢弃别的任务的 error：code=${frame && frame.code} requestId=${frame && frame.requestId} 当前=${state.requestId}`,
          );
        }
        return { applied: false, reason: "scope-mismatch" };
      }
      if (typeof frame.taskId === "string" && frame.taskId.length > 0 && !state.taskId) {
        state.taskId = frame.taskId;
      }
      state.error = {
        code: frame && typeof frame.code === "string" ? frame.code : "AGENT_ERROR",
        userText:
          frame && typeof frame.userText === "string" && frame.userText
            ? frame.userText
            : "AI 内核出错了，但终端本身照常可用。",
      };
      for (const step of state.steps) {
        if (step.status === "awaiting" || step.status === "running") step.status = "failed";
        else if (step.status === "pending") step.status = "skipped";
      }
      state.pendingApprovals = [];
      state.status = "error";
      pendingRun = null;
      notify();
      return { applied: true, reason: "ok" };
    },

    /**
     * 本地置错（例如 ws 没连上、5 秒没有任何 agent.* 帧）。
     * local:true 是明确标记：收到任何真实 agent.* 帧就自动清掉（修复 E）。
     */
    failLocally({ code, userText }) {
      state.error = {
        code: code || "LOCAL_ERROR",
        userText: userText || "AI 内核没有响应。",
        local: true,
      };
      state.status = "error";
      notify();
    },

    /** agent.stop 发出去后：清掉待确认，但保留步骤（用户要看停在哪）。 */
    markStopped() {
      state.pendingApprovals = [];
      pendingRun = null;
      if (state.status === "running" || state.status === "awaiting") {
        state.status = "stopped";
        notify();
      }
    },

    /** 清成空态（换任务或用户手动清空）。 */
    reset() {
      state = emptyState();
      pendingRun = null;
      notify();
    },

    setStatus(value) {
      setStatus(value);
    },
  };
}
