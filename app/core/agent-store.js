// Agent 状态模型（docs/PROTOCOL-AGENT.md §7 + TASK-V4-H §5.5，多会话）。
//
// 只持有 agent.* 帧带来的状态，不碰会话/终端状态（那是 core/session-store.js）。
// 视图只订阅，所有变更走具名方法；subscribers 出错不互相影响。
//
// TASK-V4-H 的结构变化：**从「单会话状态机」变成「每终端一个会话 + 全局会话列表」**。
//
//   state = {
//     currentSessionId: "s-1a2b3c4d" | "draft:<terminalId>" | null,
//     list: [ {id,title,updatedAt,terminalId,terminalKind,shell,hostName,hostAddr,messageCount,current} ],
//     sessions: Map<sessionKey, {
//       id, title, terminalId, terminalKind, shell, hostName, hostAddr,
//       status, taskId, requestId, error,
//       turns: [ { round, question, summary, reasoning, streamText,
//                  steps: [{stepId,index,kind,status,command,why,output,exitCode,durationMs,userText}] } ],
//       pendingApprovals: [ {approvalId, stepId, round, command, why, risk, effect, confirmWhy, reversible} ],
//     }>
//   }
//
// 对外的 getSnapshot() 同时给出「当前会话的扁平视图」（status/question/summary/steps/
// pendingApprovals/error，老调用方 app.js / toast.js 直接读）+ 新增的 turns/sessions/
// currentSessionId，避免视图层为了多轮再拆一层。
//
// 关键不变量：
// - steps 按 stepId upsert；pendingApprovals 按 approvalId 去重
// - pendingApprovals（快照里）是**所有会话的并集**：把手角标与 toast 要看到别的标签的待确认
// - 作用域隔离（V3-C-FIX1 修复 A）：只有属于当前活动任务的帧能改状态
// - 草稿会话（还没落盘）在 agent.start 拿到真实 sessionId 后就地升级，不丢步骤

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

/** 草稿会话的 key（还没落盘，第一次发消息才换成真实 id）。 */
export function draftKey(terminalId) {
  return `draft:${terminalId || ""}`;
}

function isDraftKey(key) {
  return typeof key === "string" && key.startsWith("draft:");
}

function emptySession(overrides = {}) {
  return {
    id: null,
    title: "",
    terminalId: "",
    terminalKind: "local",
    shell: "",
    hostId: null,
    hostName: null,
    hostAddr: null,
    status: "idle",
    taskId: null,
    requestId: null,
    error: null,
    turns: [],
    pendingApprovals: [],
    ...overrides,
  };
}

function cloneTurn(turn) {
  return {
    round: turn.round,
    question: turn.question,
    summary: turn.summary,
    reasoning: turn.reasoning,
    streamText: turn.streamText,
    steps: turn.steps.map((step) => ({ ...step })),
  };
}

function cloneSession(session) {
  return {
    id: session.id,
    title: session.title,
    terminalId: session.terminalId,
    terminalKind: session.terminalKind,
    shell: session.shell,
    hostId: session.hostId,
    hostName: session.hostName,
    hostAddr: session.hostAddr,
    status: session.status,
    taskId: session.taskId,
    requestId: session.requestId,
    error: session.error ? { ...session.error } : null,
    turns: session.turns.map(cloneTurn),
    pendingApprovals: session.pendingApprovals.map((item) => ({ ...item })),
  };
}

export default function createAgentStore() {
  /** @type {Map<string, object>} */
  let sessions = new Map();
  let currentSessionId = null;
  let list = [];
  // 已经发出 agent.run、但内核还没回 agent.start 的「下一次」任务。
  let pendingRun = null;
  const subscribers = new Set();
  let scheduled = false;

  /* ---------------- 会话存取 ---------------- */

  function currentSession() {
    if (!currentSessionId) return null;
    return sessions.get(currentSessionId) || null;
  }

  function ensureSession(key, overrides) {
    let session = sessions.get(key);
    if (!session) {
      session = emptySession(overrides || {});
      sessions.set(key, session);
    }
    return session;
  }

  /** 所有会话的待确认并集（把手角标 / toast / 状态栏用）。 */
  function allApprovals() {
    const out = [];
    for (const [key, session] of sessions) {
      for (const approval of session.pendingApprovals) {
        out.push({ ...approval, sessionKey: key, sessionId: session.id });
      }
    }
    return out;
  }

  function currentTurns() {
    const session = currentSession();
    return session ? session.turns : [];
  }

  function currentSteps() {
    const out = [];
    for (const turn of currentTurns()) out.push(...turn.steps);
    return out;
  }

  function snapshotOf() {
    const session = currentSession();
    const unionApprovals = allApprovals();
    return {
      // 老字段（app.js / toast.js 直接读）——当前会话的扁平视图。
      taskId: session ? session.taskId : null,
      requestId: session ? session.requestId : null,
      status: session ? session.status : "idle",
      question: session && session.turns.length > 0 ? session.turns[session.turns.length - 1].question : "",
      summary: session && session.turns.length > 0 ? session.turns[session.turns.length - 1].summary : "",
      steps: currentSteps().map((step) => ({ ...step })),
      pendingApprovals: unionApprovals,
      error: session && session.error ? { ...session.error } : null,
      // 新字段（多会话 / 多轮）。
      currentSessionId,
      currentTitle: session ? session.title : "",
      currentTerminalId: session ? session.terminalId : "",
      turns: currentTurns().map(cloneTurn),
      sessions: list.map((item) => ({ ...item })),
      sessionPending: session ? session.pendingApprovals.map((item) => ({ ...item })) : [],
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

  function findStep(session, stepId) {
    for (const turn of session.turns) {
      const hit = turn.steps.find((step) => step.stepId === stepId);
      if (hit) return { step: hit, turn };
    }
    return { step: null, turn: null };
  }

  function hasActiveTask() {
    const session = currentSession();
    if (!session) return false;
    return (
      (session.status === "running" || session.status === "awaiting") &&
      typeof session.requestId === "string" &&
      session.requestId.length > 0
    );
  }

  /**
   * 作用域判定（V3-C-FIX1 修复 A）：帧是否属于当前活动任务。
   * 先按 sessionId 找到目标会话；找不到就用当前会话。
   */
  function targetSessionFor(frame) {
    const frameSessionId = pickString(frame && frame.sessionId);
    if (frameSessionId) {
      // 草稿会话 vs 真实 id：两端都试。
      if (sessions.has(frameSessionId)) return { key: frameSessionId, session: sessions.get(frameSessionId) };
      const current = currentSession();
      if (current && (current.id === frameSessionId || isDraftKey(currentSessionId))) {
        return { key: currentSessionId, session: current };
      }
    }
    const current = currentSession();
    return current ? { key: currentSessionId, session: current } : { key: null, session: null };
  }

  function frameBelongsTo(session, frame) {
    if (!session || !frame || typeof frame !== "object") return false;
    const requestId = pickString(frame.requestId);
    const taskId = pickString(frame.taskId);
    if (requestId) {
      if (!session.requestId) {
        session.requestId = requestId;
        return true;
      }
      return requestId === session.requestId;
    }
    if (taskId && session.taskId) return taskId === session.taskId;
    return true;
  }

  /** 修复 E：本地伪造的错误一旦收到真实 agent.* 帧就必须消失。 */
  function clearLocalError(session) {
    if (!session || !session.error || session.error.local !== true) return false;
    session.error = null;
    if (session.status === "error") {
      session.status = session.pendingApprovals.length > 0 ? "awaiting" : "running";
    }
    return true;
  }

  /** agent.done / agent.error 的收尾：不许留任何未完成状态（修复 D/D9）。 */
  function closeOpenSteps(session) {
    for (const turn of session.turns) {
      for (const step of turn.steps) {
        if (step.status === "awaiting" || step.status === "running") step.status = "done";
        else if (step.status === "pending") step.status = "skipped";
      }
    }
  }

  function newTurn(session, round, question) {
    const turn = {
      round,
      question: typeof question === "string" ? question : "",
      summary: "",
      reasoning: "",
      streamText: "",
      steps: [],
    };
    session.turns.push(turn);
    return turn;
  }

  function lastTurn(session) {
    return session && session.turns.length > 0 ? session.turns[session.turns.length - 1] : null;
  }

  return {
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    getSnapshot: snapshotOf,
    getCurrentSessionId() {
      return currentSessionId;
    },
    /** 当前会话的服务端 id（草稿返回 null：第一次发消息才落盘）。 */
    currentServerSessionId() {
      const session = currentSession();
      return session && typeof session.id === "string" && session.id.length > 0 ? session.id : null;
    },

    /** 服务端会话列表（GET /api/ai/sessions 的结果）。 */
    setSessionsList(items) {
      list = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
      // 给内部会话补标题/归属（标题来自服务端，前端不自己生成）。
      for (const item of list) {
        const session = sessions.get(item.id);
        if (!session) continue;
        if (typeof item.title === "string" && item.title.length > 0) session.title = item.title;
        if (typeof item.messageCount === "number") session.messageCount = item.messageCount;
      }
      // 草稿 → 已落的会话：列表到达时把当前草稿并到该终端最近的会话上
      // （否则用户刷新页面后一直停在一个空草稿上，历史看不见）。
      const current = currentSession();
      if (current && (isDraftKey(currentSessionId) || !current.id)) {
        const bound = current.terminalId
          ? list.find((item) => item.terminalId === current.terminalId)
          : null;
        if (bound) {
          sessions.delete(currentSessionId);
          if (current.turns.length > 0) {
            const landed = ensureSession(bound.id, { id: bound.id, terminalId: current.terminalId });
            landed.turns.push(...current.turns);
            landed.status = current.status;
            landed.requestId = current.requestId;
            landed.taskId = current.taskId;
          } else {
            ensureSession(bound.id, {
              id: bound.id,
              terminalId: bound.terminalId,
              terminalKind: bound.terminalKind,
              shell: bound.shell,
              hostId: bound.hostId,
              hostName: bound.hostName,
              hostAddr: bound.hostAddr,
            });
          }
          currentSessionId = bound.id;
        }
      }
      notify();
    },

    /**
     * 切终端标签 → 切该终端的会话（卡片 §5.5）。
     *
     * - 该终端已有会话（按 terminalId 匹配）→ 切过去；
     * - 没有 → 建一个空的本地草稿会话（第一次发消息才落盘）。
     *
     * @param {string} terminalId PTY 会话 id
     * @param {{shell?:string, terminalKind?:string, hostId?:string, hostName?:string, hostAddr?:string}} [meta]
     */
    focusTerminal(terminalId, meta) {
      const tid = typeof terminalId === "string" ? terminalId : "";
      const bound = list.find((item) => item.terminalId === tid);
      const key = bound ? bound.id : draftKey(tid);
      const overrides = {
        terminalId: tid,
        terminalKind: (meta && meta.terminalKind) === "remote" ? "remote" : "local",
        shell: meta && typeof meta.shell === "string" ? meta.shell : "",
        hostId: meta && typeof meta.hostId === "string" ? meta.hostId : null,
        hostName: meta && typeof meta.hostName === "string" ? meta.hostName : null,
        hostAddr: meta && typeof meta.hostAddr === "string" ? meta.hostAddr : null,
      };
      // 还没切的会话（草稿）不丢掉：同一个终端再切回来还要看得见。
      if (!sessions.has(key)) sessions.set(key, emptySession({ ...overrides, id: bound ? bound.id : null }));
      else if (meta) Object.assign(sessions.get(key), overrides);
      if (currentSessionId === key) {
        pendingRun = null;
        notify();
        return key;
      }
      currentSessionId = key;
      pendingRun = null;
      notify();
      return key;
    },

    /** 切到一条已有会话（下拉里点本机分组内的会话）。 */
    selectSession(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (!sessions.has(sessionId)) sessions.set(sessionId, emptySession({ id: sessionId }));
      if (currentSessionId === sessionId) return true;
      currentSessionId = sessionId;
      pendingRun = null;
      notify();
      return true;
    },

    /** 当前会话在列表里的标题 / 归属（下拉头部用）。 */
    currentMeta() {
      const session = currentSession();
      return session ? cloneSession(session) : null;
    },

    /** 用 GET /api/ai/sessions/:id 的全文恢复时间线（切回时用）。 */
    restoreSession(id, full) {
      if (!full || typeof full !== 'object') return false;
      const key = sessions.has(id) ? id : id;
      const session = ensureSession(key, {
        id,
        title: typeof full.title === "string" ? full.title : "",
        terminalId: typeof full.terminalId === "string" ? full.terminalId : "",
        terminalKind: full.terminalKind === "remote" ? "remote" : "local",
        shell: typeof full.shell === "string" ? full.shell : "",
        hostId: full.hostId || null,
        hostName: full.hostName || null,
        hostAddr: full.hostAddr || null,
      });
      session.id = id;
      session.title = typeof full.title === "string" ? full.title : session.title;
      const messages = Array.isArray(full.messages) ? full.messages : [];
      const steps = Array.isArray(full.steps) ? full.steps : [];
      const rounds = new Map();
      const roundOf = (value) => (Number.isFinite(value) && value > 0 ? value : 1);
      for (const message of messages) {
        const round = roundOf(message.round);
        if (!rounds.has(round)) rounds.set(round, newTurn(session, round, ""));
        const turn = rounds.get(round);
        if (message.role === "user") turn.question = typeof message.text === "string" ? message.text : turn.question;
        else if (message.role === "assistant") turn.summary = typeof message.text === "string" ? message.text : turn.summary;
        if (typeof message.reasoning === "string" && message.reasoning.length > 0) turn.reasoning = message.reasoning;
      }
      for (const step of steps) {
        const round = roundOf(step.round);
        if (!rounds.has(round)) rounds.set(round, newTurn(session, round, ""));
        rounds.get(round).steps.push({
          stepId: step.stepId,
          index: rounds.get(round).steps.length + 1,
          kind: "command",
          status: pickStepStatus(step.status),
          command: typeof step.command === "string" ? step.command : "",
          why: "",
          output: typeof step.output === "string" ? step.output : "",
          exitCode: null,
          durationMs: null,
          userText: "",
        });
      }
      if (rounds.size > 0) {
        session.turns = [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([, turn]) => turn);
        session.status = session.turns.some((turn) => turn.steps.some((step) => step.status === "awaiting"))
          ? "awaiting"
          : "done";
      } else {
        session.status = "idle";
      }
      if (full.status === "stopped") session.status = "stopped";
      if (currentSessionId !== key && !currentSessionId) currentSessionId = key;
      notify();
      return true;
    },

    /**
     * agent.run 发出后调用。
     * - 没有活动任务：在当前会话里开一轮新的，置 running。
     * - 已有任务在跑/待确认：**不清任何状态**，只记下这次请求，等 agent.start 到了再切换。
     */
    beginRun({ requestId, question }) {
      const session = currentSession();
      if (!session) return { adopted: false, pending: false };
      const nextRequestId = typeof requestId === "string" ? requestId : null;
      if (hasActiveTask()) {
        pendingRun = { requestId: nextRequestId, question };
        return { adopted: false, pending: true };
      }
      pendingRun = null;
      session.requestId = nextRequestId;
      session.taskId = null;
      session.error = null;
      session.status = "running";
      const round = session.turns.length + 1;
      newTurn(session, round, question);
      notify();
      return { adopted: true, pending: false };
    },

    /** agent.start：认领会话 id（草稿 → 真 id）、记 requestId / taskId。 */
    onStart(frame) {
      const frameSessionId = pickString(frame && frame.sessionId);
      const current = currentSession();
      // 草稿会话第一次拿到服务端 id：就地升级 key，不丢已渲染的步骤。
      if (frameSessionId && current && (!current.id || isDraftKey(currentSessionId))) {
        const draft = sessions.get(currentSessionId);
        sessions.delete(currentSessionId);
        draft.id = frameSessionId;
        sessions.set(frameSessionId, draft);
        currentSessionId = frameSessionId;
      } else if (frameSessionId && !sessions.has(frameSessionId)) {
        sessions.set(frameSessionId, emptySession({ id: frameSessionId, terminalId: pickString(frame.targetSessionId) || "" }));
        if (!currentSessionId) currentSessionId = frameSessionId;
      }
      const session = currentSession();
      if (!session) return { adopted: false, newTask: false };
      const frameRequestId = pickString(frame && frame.requestId);
      const requestId = frameRequestId || (pendingRun && pendingRun.requestId) || session.requestId || null;
      const taskId = pickString(frame && frame.taskId);
      const startingNewTask = !session.requestId || requestId !== session.requestId;
      session.requestId = requestId;
      if (taskId) session.taskId = taskId;
      if (typeof frame.sessionTitle === "string" && frame.sessionTitle.length > 0) session.title = frame.sessionTitle;
      clearLocalError(session);
      // 新一轮还没建 turn（例如 restore 后直接追问 / 测试注入的 start）→ 补一个。
      // 判定：没有 turn，或已有 turn 但那一轮已经“收尾”（有总结 或 已被置结束）。
      const round = Number.isFinite(Number(frame.round)) ? Number(frame.round) : session.turns.length + 1;
      if (!session.turns.some((turn) => turn.round === round)) {
        const tail = lastTurn(session);
        if (!tail || tail.summary || session.status === "idle" || session.status === "done" || session.status === "stopped") {
          newTurn(session, round, pendingRun && pendingRun.requestId === requestId ? pendingRun.question : "");
        }
      }
      session.status = session.pendingApprovals.length > 0 ? "awaiting" : "running";
      pendingRun = null;
      notify();
      return { adopted: true, newTask: startingNewTask };
    },

    /** agent.step：按 stepId upsert 到当前轮（别的任务的帧直接丢弃）。 */
    onStep(frame) {
      if (!frame || typeof frame.stepId !== "string") return null;
      const target = targetSessionFor(frame);
      const session = target.session;
      if (!session) return null;
      if (!frameBelongsTo(session, frame)) {
        if (typeof console !== "undefined" && console.debug) {
          console.debug(`[agent-store] 丢弃别的任务的 step：requestId=${frame.requestId} 当前=${session.requestId}`);
        }
        return null;
      }
      clearLocalError(session);
      const found = findStep(session, frame.stepId);
      const turn = found.turn || lastTurn(session) || newTurn(session, 1, "");
      const patch = {
        stepId: frame.stepId,
        index: Number.isFinite(Number(frame.index)) ? Number(frame.index) : turn.steps.length + 1,
        kind: frame.kind === "note" ? "note" : "command",
        status: pickStepStatus(frame.status),
        command: typeof frame.command === "string" ? frame.command : "",
        why: typeof frame.why === "string" ? frame.why : "",
        output: typeof frame.output === "string" ? frame.output : "",
        exitCode: frame.exitCode === undefined ? null : frame.exitCode,
        durationMs: frame.durationMs === undefined ? null : frame.durationMs,
        userText: typeof frame.userText === "string" ? frame.userText : "",
      };
      if (found.step) Object.assign(found.step, patch);
      else turn.steps.push(patch);
      const hasAwaiting = session.turns.some((item) => item.steps.some((step) => step.status === "awaiting"));
      if (hasAwaiting) session.status = "awaiting";
      else if (session.status === "idle" || session.status === "error") session.status = "running";
      notify();
      return patch;
    },

    /** agent.approval：插一条待确认（同一 approvalId 只保留一条）。 */
    onApproval(frame) {
      if (!frame || typeof frame.approvalId !== "string") return null;
      const target = targetSessionFor(frame);
      const session = target.session;
      if (!session) return null;
      if (!frameBelongsTo(session, frame)) {
        if (typeof console !== "undefined" && console.debug) {
          console.debug(`[agent-store] 丢弃别的任务的 approval：requestId=${frame.requestId} 当前=${session.requestId}`);
        }
        return null;
      }
      clearLocalError(session);
      const found = frame.stepId ? findStep(session, frame.stepId) : { step: null, turn: null };
      if (found.step) {
        found.step.status = "awaiting";
        if (typeof frame.command === "string" && frame.command) found.step.command = frame.command;
        if (typeof frame.why === "string" && frame.why) found.step.why = frame.why;
      }
      if (session.pendingApprovals.some((item) => item.approvalId === frame.approvalId)) return null;
      const approval = {
        approvalId: frame.approvalId,
        stepId: typeof frame.stepId === "string" ? frame.stepId : "",
        round: found.turn ? found.turn.round : (lastTurn(session) ? lastTurn(session).round : 1),
        command: typeof frame.command === "string" ? frame.command : "",
        why: typeof frame.why === "string" ? frame.why : "",
        risk: ["safe", "caution", "danger"].includes(frame.risk) ? frame.risk : null,
        effect: typeof frame.effect === "string" && frame.effect.length > 0 ? frame.effect : null,
        confirmWhy: typeof frame.confirmWhy === "string" && frame.confirmWhy.length > 0 ? frame.confirmWhy : null,
        reversible: typeof frame.reversible === "boolean" ? frame.reversible : null,
        reviewModel: typeof frame.reviewModel === "string" ? frame.reviewModel : null,
      };
      session.pendingApprovals.push(approval);
      session.status = "awaiting";
      notify();
      return approval;
    },

    /**
     * 用户点了审批按钮：立刻把该条从未决列表移除，并改对应 step 的状态。
     */
    removeApproval(approvalId, approved) {
      for (const session of sessions.values()) {
        const index = session.pendingApprovals.findIndex((item) => item.approvalId === approvalId);
        if (index === -1) continue;
        const [removed] = session.pendingApprovals.splice(index, 1);
        const found = removed && removed.stepId ? findStep(session, removed.stepId) : { step: null };
        if (found.step && found.step.status === "awaiting") {
          found.step.status = approved === false ? "denied" : "running";
        }
        if (session.pendingApprovals.length === 0 && session.status === "awaiting") session.status = "running";
        notify();
        return true;
      }
      return false;
    },

    /** agent.text：模型文本增量（AC13，逐字追加到当前轮）。 */
    onText(frame) {
      const target = targetSessionFor(frame);
      const session = target.session;
      if (!session) return false;
      if (!frameBelongsTo(session, frame)) return false;
      const turn = lastTurn(session);
      if (!turn) return false;
      const delta = typeof frame.text === "string" ? frame.text : "";
      if (!delta) return false;
      turn.streamText += delta;
      notify();
      return true;
    },

    /** agent.reasoning：思考过程（折叠块，卡片 §5.6）。 */
    onReasoning(frame) {
      const target = targetSessionFor(frame);
      const session = target.session;
      if (!session) return false;
      if (!frameBelongsTo(session, frame)) return false;
      const turn = lastTurn(session);
      if (!turn) return false;
      const text = typeof frame.text === "string" ? frame.text : "";
      if (!text) return false;
      turn.reasoning = turn.reasoning ? `${turn.reasoning}\n\n${text}` : text;
      notify();
      return true;
    },

    /** agent.done：写总结、清待确认、收尾所有未完成 step。 */
    onDone(frame) {
      const target = targetSessionFor(frame);
      const session = target.session;
      if (!session) return false;
      if (!frameBelongsTo(session, frame)) {
        if (typeof console !== "undefined" && console.debug) {
          console.debug(`[agent-store] 丢弃别的任务的 done：requestId=${frame.requestId} 当前=${session.requestId}`);
        }
        return false;
      }
      if (typeof frame.taskId === "string" && frame.taskId.length > 0) session.taskId = frame.taskId;
      const text = frame && typeof frame.text === "string" ? frame.text : "";
      const turn = lastTurn(session);
      if (turn) turn.summary = text || turn.streamText;
      session.pendingApprovals = [];
      closeOpenSteps(session);
      session.error = null;
      session.status = frame && frame.stopped === true ? "stopped" : "done";
      pendingRun = null;
      notify();
      return true;
    },

    /** agent.error：只接受当前活动任务的错误（修复 C）。 */
    onError(frame) {
      const target = targetSessionFor(frame);
      const session = target.session;
      if (!session) return { applied: false, reason: "no-session" };
      if (!frameBelongsTo(session, frame)) {
        if (typeof console !== "undefined" && console.debug) {
          console.debug(
            `[agent-store] 丢弃别的任务的 error：code=${frame && frame.code} requestId=${frame && frame.requestId} 当前=${session.requestId}`,
          );
        }
        return { applied: false, reason: "scope-mismatch" };
      }
      if (typeof frame.taskId === "string" && frame.taskId.length > 0) session.taskId = frame.taskId;
      session.error = {
        code: frame && typeof frame.code === "string" ? frame.code : "AGENT_ERROR",
        userText:
          frame && typeof frame.userText === "string" && frame.userText
            ? frame.userText
            : "AI 内核出错了，但终端本身照常可用。",
      };
      for (const turn of session.turns) {
        for (const step of turn.steps) {
          if (step.status === "awaiting" || step.status === "running") step.status = "failed";
          else if (step.status === "pending") step.status = "skipped";
        }
      }
      session.pendingApprovals = [];
      session.status = "error";
      pendingRun = null;
      notify();
      return { applied: true, reason: "ok" };
    },

    /**
     * 本地置错（例如 ws 没连上、5 秒没有任何 agent.* 帧）。
     * local:true 是明确标记：收到任何真实 agent.* 帧就自动清掉（修复 E）。
     */
    failLocally({ code, userText }) {
      const session = currentSession();
      if (!session) return;
      session.error = {
        code: code || "LOCAL_ERROR",
        userText: userText || "AI 内核没有响应。",
        local: true,
      };
      session.status = "error";
      notify();
    },

    /** agent.stop 发出去后：清掉待确认，但保留步骤（用户要看停在哪）。 */
    markStopped() {
      const session = currentSession();
      if (!session) return;
      session.pendingApprovals = [];
      pendingRun = null;
      if (session.status === "running" || session.status === "awaiting") {
        session.status = "stopped";
        notify();
      }
    },

    /** 新建空会话（「新会话」按钮）：切到该终端的新草稿。 */
    newDraft(terminalId, meta) {
      const tid = typeof terminalId === "string" ? terminalId : "";
      // 同一个终端只能有一个草稿：再点就换一个 key（加时间戳），旧的保留在内存里。
      const key = `${draftKey(tid)}#${Date.now()}`;
      sessions.set(
        key,
        emptySession({
          terminalId: tid,
          terminalKind: (meta && meta.terminalKind) === "remote" ? "remote" : "local",
          shell: meta && typeof meta.shell === "string" ? meta.shell : "",
          hostId: meta && typeof meta.hostId === "string" ? meta.hostId : null,
          hostName: meta && typeof meta.hostName === "string" ? meta.hostName : null,
          hostAddr: meta && typeof meta.hostAddr === "string" ? meta.hostAddr : null,
        }),
      );
      currentSessionId = key;
      pendingRun = null;
      notify();
      return key;
    },

    /** 删掉本地镜像（服务端删了会话）。 */
    dropSession(id) {
      if (!id) return false;
      const existed = sessions.delete(id);
      if (currentSessionId === id) currentSessionId = null;
      list = list.filter((item) => item.id !== id);
      notify();
      return existed;
    },

    /** 重命名后更新本地标题。 */
    renameSession(id, title) {
      if (!id || typeof title !== "string" || title.length === 0) return false;
      const session = sessions.get(id);
      if (session) session.title = title;
      list = list.map((item) => (item.id === id ? { ...item, title } : item));
      notify();
      return true;
    },

    /** 清成空态（换任务或用户手动清空）。 */
    reset() {
      sessions = new Map();
      currentSessionId = null;
      pendingRun = null;
      notify();
    },

    setStatus(value) {
      const session = currentSession();
      if (!session) return;
      const next = STATUS_VALUES.has(value) ? value : session.status;
      if (session.status === next) return;
      session.status = next;
      notify();
    },
  };
}
