// 标签栏：渲染、切换、关闭、新建。只订阅 store，不直接连网络。

export default function createTabBar(elements) {
  const host = elements.host;
  const onCreate = typeof elements.onCreate === "function" ? elements.onCreate : () => {};
  const store = elements.store;

  let unsubscribe = null;

  function titleFor(session) {
    const shell = String(session.shell || "shell").split(" ")[0];
    const cwd = String(session.cwd || "");
    let tail = cwd;
    if (!tail) tail = "";
    else {
      const parts = tail.split(/[\\/]/).filter(Boolean);
      tail = parts.length > 0 ? parts[parts.length - 1] : tail;
    }
    return tail ? `${shell}: ${tail}` : shell;
  }

  function render(snapshot) {
    host.textContent = "";

    for (const session of snapshot.sessions) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.setAttribute("data-role", "tab");
      tab.setAttribute("data-tab-id", session.id);
      tab.setAttribute("role", "tab");
      const selected = session.id === snapshot.activeId;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;

      const title = document.createElement("span");
      title.setAttribute("data-role", "tab-title");
      title.textContent = titleFor(session);
      if (session.status === "exited") title.textContent += "（已结束）";
      if (session.status === "error") title.textContent += "（错误）";
      tab.appendChild(title);

      const close = document.createElement("button");
      close.type = "button";
      close.setAttribute("data-role", "tab-close");
      close.setAttribute("aria-label", `关闭标签 ${titleFor(session)}`);
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        store.removeSession(session.id);
        if (elements.onClose) elements.onClose(session.id);
      });
      tab.appendChild(close);

      tab.addEventListener("click", () => store.setActive(session.id));
      tab.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          store.setActive(session.id);
        }
      });
      host.appendChild(tab);
    }

    const add = document.createElement("button");
    add.type = "button";
    add.setAttribute("data-role", "tab-new");
    add.setAttribute("aria-label", "新建终端标签");
    add.textContent = "+";
    add.addEventListener("click", () => onCreate());
    host.appendChild(add);
  }

  return {
    init() {
      unsubscribe = store.subscribe(render);
      render(store.getSnapshot());
    },
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      host.textContent = "";
    },
  };
}
