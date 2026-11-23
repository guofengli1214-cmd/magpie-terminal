// 状态栏：连接状态、shell / PTY 模式、当前 cwd。错误三要素里「怎么办」也走这里。

export default function createStatusBar(elements) {
  const host = elements.host;
  const store = elements.store;
  const onRetry = typeof elements.onRetry === "function" ? elements.onRetry : () => {};
  const onToggleAi = typeof elements.onToggleAi === "function" ? elements.onToggleAi : () => {};

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

    // 模型一栏：显示当前下拉选中的 id 尾段（完整 id 太长，状态栏放不下）。
    const model = document.createElement("span");
    model.setAttribute("data-role", "status-item");
    model.setAttribute("data-status", "model");
    if (typeof snapshot.model === "string" && snapshot.model.length > 0) {
      const parts = String(snapshot.model).split("/").filter(Boolean);
      const tail = parts.length > 0 ? parts[parts.length - 1] : snapshot.model;
      model.textContent = `模型：${tail}`;
      model.setAttribute("title", snapshot.model);
    } else {
      model.textContent = "模型：未选";
      model.setAttribute("data-tone", "warn");
    }
    host.appendChild(model);

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

    const aiToggle = document.createElement("button");
    aiToggle.type = "button";
    aiToggle.setAttribute("data-role", "status-ai-toggle");
    aiToggle.textContent = "AI 栏";
    aiToggle.addEventListener("click", () => onToggleAi());
    host.appendChild(aiToggle);
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
