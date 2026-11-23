// 唯一的可变状态持有者。视图只订阅，所有变更走具名方法。

const connectionValues = new Set(["connecting", "open", "closed"]);

export default function createSessionStore() {
  const state = {
    sessions: [],
    activeId: null,
    connection: "connecting",
    // V2-A 新增（不改现有字段语义）：
    // model      —— 模型下拉当前选中的 id（null 表示还没拉到清单）
    // aiOpen     —— AI 输入条 / 浮层是否展开，对应 #root[data-ai-open]
    // aiUnread   —— 有没有「用户没看过的 AI 回复」，驱动图标栏小圆点
    model: null,
    aiOpen: true,
    aiUnread: false,
  };
  const subscribers = new Set();
  let scheduled = false;

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

  function snapshotOf() {
    return {
      sessions: state.sessions.map((s) => ({ ...s })),
      activeId: state.activeId,
      connection: state.connection,
      model: state.model,
      aiOpen: state.aiOpen,
      aiUnread: state.aiUnread,
    };
  }

  return {
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    getSnapshot: snapshotOf,
    getSession(id) {
      return state.sessions.find((s) => s.id === id) || null;
    },
    getActive() {
      return state.sessions.find((s) => s.id === state.activeId) || null;
    },
    addSession(session) {
      if (!session || typeof session.id !== "string") return;
      if (state.sessions.some((s) => s.id === session.id)) return;
      state.sessions.push({
        id: session.id,
        title: session.title || "shell",
        cwd: session.cwd || "",
        shell: session.shell || "bash",
        status: session.status || "running",
        exitCode: session.exitCode === undefined ? null : session.exitCode,
        cols: session.cols || 80,
        rows: session.rows || 24,
        // TASK-V2-B：本地/远程。默认 "local"，老调用方不用改。
        kind: session.kind === "remote" ? "remote" : "local",
        hostId: typeof session.hostId === "string" ? session.hostId : null,
        hostName: typeof session.hostName === "string" ? session.hostName : null,
      });
      if (!state.activeId) state.activeId = session.id;
      notify();
    },
    removeSession(id) {
      const index = state.sessions.findIndex((s) => s.id === id);
      if (index === -1) return;
      state.sessions.splice(index, 1);
      if (state.activeId === id) {
        const next = state.sessions[index] || state.sessions[index - 1] || null;
        state.activeId = next ? next.id : null;
      }
      notify();
    },
    setActive(id) {
      if (state.activeId === id) return;
      if (!state.sessions.some((s) => s.id === id)) return;
      state.activeId = id;
      notify();
    },
    patchSession(id, partial) {
      const session = state.sessions.find((s) => s.id === id);
      if (!session || !partial || typeof partial !== "object") return;
      let changed = false;
      for (const [key, value] of Object.entries(partial)) {
        if (key === "id") continue;
        if (session[key] === value) continue;
        session[key] = value;
        changed = true;
      }
      if (changed) notify();
    },
    setConnection(value) {
      if (!connectionValues.has(value)) return;
      if (state.connection === value) return;
      state.connection = value;
      notify();
    },
    /** 模型下拉选中的 id；空串/null 一律归一为 null。 */
    setModel(id) {
      const next = typeof id === "string" && id.length > 0 ? id : null;
      if (state.model === next) return;
      state.model = next;
      notify();
    },
    setAiOpen(open) {
      const next = Boolean(open);
      if (state.aiOpen === next) return;
      state.aiOpen = next;
      notify();
    },
    setAiUnread(value) {
      const next = Boolean(value);
      if (state.aiUnread === next) return;
      state.aiUnread = next;
      notify();
    },
  };
}
