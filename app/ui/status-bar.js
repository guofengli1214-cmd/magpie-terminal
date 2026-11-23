// 状态栏：连接状态、shell / PTY 模式、当前 cwd。错误三要素里「怎么办」也走这里。

export default function createStatusBar(elements) {
  const host = elements.host;
  const store = elements.store;
  const onRetry = typeof elements.onRetry === "function" ? elements.onRetry : () => {};

  let healthInfo = null;
  let waitingSince = 0;
  let timer = null;
  let unsubscribe = null;
  // 一次性提示（「模型偏好没存住」之类）：显示到下次 render 后自动过期。
  let notice = null;
  let noticeTimer = null;

  function setHealth(info) {
    healthInfo = info;
    waitingSince = 0;
    render(store.getSnapshot());
  }

  function setNotice(text, tone) {
    notice = text ? { text, tone: tone || "warn" } : null;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    if (notice) {
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        notice = null;
        render(store.getSnapshot());
      }, 4000);
    }
    render(store.getSnapshot());
  }

  function statusText(snapshot) {
    if (snapshot.connection === "open") return "已连接本地服务";
    if (snapshot.connection === "closed") {
      const waited = waitingSince ? Math.round((Date.now() - waitingSince) / 1000) : 0;
      if (waited >= Math.ceil(5000 / 1000)) {
        return "连接已断开：本地服务可能没在运行。点「重连」再试一次。";
      }
      return "与本地服务的连接已断开，正在重连…";
    }
    const waited = waitingSince ? Math.round((Date.now() - waitingSince) / 1000) : 0;
    if (waited >= 5) return "连接超时：本地服务没有响应。点「重连」再试一次。";
    return `正在连接本地服务…（已等 ${waited} 秒）`;
  }

  function render(snapshot) {
    host.textContent = "";
    if (!waitingSince && snapshot.connection !== "open") waitingSince = Date.now();

    const connection = document.createElement("span");
    connection.setAttribute("data-role", "status-item");
    connection.setAttribute("data-status", "connection");
    connection.setAttribute("data-tone", snapshot.connection === "open" ? "ok" : "warn");
    connection.textContent = statusText(snapshot);
    host.appendChild(connection);

    if (healthInfo) {
      const pty = document.createElement("span");
      pty.setAttribute("data-role", "status-item");
      pty.setAttribute("data-status", "pty");
      pty.setAttribute("data-tone", healthInfo.pty === "native" ? "ok" : "warn");
      pty.textContent =
        healthInfo.pty === "native"
          ? `PTY：原生（node-pty ${healthInfo.nodePtyVersion || "未知"}）`
          : "PTY：降级（哨兵法）";
      host.appendChild(pty);

      const shell = document.createElement("span");
      shell.setAttribute("data-role", "status-item");
      shell.setAttribute("data-status", "shell");
      const fallback = healthInfo.shell && healthInfo.shell.fallback ? "（回退）" : "";
      shell.textContent = `shell：${healthInfo.shell ? healthInfo.shell.name : "未知"} ${healthInfo.shell ? healthInfo.shell.version : ""}${fallback}`;
      host.appendChild(shell);
    }

    // 任务一栏（TASK-V3-C §6.6）：显示当前 AI 任务状态：空闲 / 执行中 / 待确认 N。
    // 模型名已移到抽屉标题栏的下拉里，状态栏不再重复。
    const task = document.createElement("span");
    task.setAttribute("data-role", "status-item");
    task.setAttribute("data-status", "agent");
    const pending = Number(snapshot.pendingCount) || 0;
    if (pending > 0) {
      task.textContent = `待确认 ${pending}`;
      task.setAttribute("data-tone", "warn");
      task.setAttribute("data-agent-state", "awaiting");
    } else {
      const status = snapshot.agentStatus || "idle";
      const label =
        status === "running"
          ? "执行中"
          : status === "done"
            ? "已完成"
            : status === "error"
              ? "出错"
              : status === "stopped"
                ? "已停止"
                : "空闲";
      task.textContent = `AI：${label}`;
      if (status === "error") task.setAttribute("data-tone", "error");
      task.setAttribute("data-agent-state", status);
    }
    host.appendChild(task);

    if (notice) {
      const flash = document.createElement("span");
      flash.setAttribute("data-role", "status-item");
      flash.setAttribute("data-status", "notice");
      flash.setAttribute("data-tone", notice.tone);
      flash.textContent = notice.text;
      host.appendChild(flash);
    }

    const active = snapshot.sessions.find((s) => s.id === snapshot.activeId);
    if (active) {
      const cwd = document.createElement("span");
      cwd.setAttribute("data-role", "status-item");
      cwd.setAttribute("data-status", "cwd");
      cwd.textContent = `cwd：${active.cwd || "未知"}`;
      host.appendChild(cwd);
    }

    const retry = document.createElement("button");
    retry.type = "button";
    retry.setAttribute("data-role", "status-retry");
    retry.textContent = snapshot.connection === "closed" ? "重连" : "立即重连";
    retry.addEventListener("click", () => onRetry());
    host.appendChild(retry);
  }

  return {
    init() {
      unsubscribe = store.subscribe(render);
      timer = setInterval(() => render(store.getSnapshot()), 1000);
      render(store.getSnapshot());
    },
    setHealth,
    setNotice,
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (timer) clearInterval(timer);
      timer = null;
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = null;
      notice = null;
      host.textContent = "";
    },
  };
}
