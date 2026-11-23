// 标签栏：渲染、切换、关闭、新建。只订阅 store，不直接连网络。
//
// TASK-V4-F §5.5：`+` 变成一个下拉菜单（本机三 shell + 已配置主机）。
// 菜单数据由 app.js 注入的 `loadMenu()` 提供（它才知道 api / 主机面板），
// 菜单项点击也只回调 app.js（onCreate({shellId}) / onConnectHost(host)），
// 这里不复制任何建会话逻辑。

export default function createTabBar(elements) {
  const host = elements.host;
  const onCreate = typeof elements.onCreate === "function" ? elements.onCreate : () => {};
  const onConnectHost =
    typeof elements.onConnectHost === "function" ? elements.onConnectHost : () => {};
  const onOpenHosts = typeof elements.onOpenHosts === "function" ? elements.onOpenHosts : () => {};
  const loadMenu = typeof elements.loadMenu === "function" ? elements.loadMenu : null;
  const store = elements.store;

  let unsubscribe = null;
  // 菜单是 body 级浮层（不能裁在 tabbar 的 overflow 里）。
  let menu = null;
  let menuOpen = false;
  let menuAnchor = null;
  let menuToken = 0;

  function titleFor(session) {
    // 远程标签：标题就是主机名（TASK-V2-B §2.6）。
    if (session && session.kind === "remote") {
      return session.hostName || session.hostId || "远程主机";
    }
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

  /* ---------------- `+` 下拉菜单（TASK-V4-F §5.5） ---------------- */

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuToken += 1;
    document.removeEventListener("mousedown", onDocumentDown, true);
    document.removeEventListener("keydown", onDocumentKey, true);
    window.removeEventListener("resize", closeMenu);
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
    menuAnchor = null;
  }

  function onDocumentDown(event) {
    if (!menuOpen) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (menu && menu.contains(target)) return;
    if (menuAnchor && menuAnchor.contains(target)) return;
    closeMenu();
  }

  function onDocumentKey(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeMenu();
    if (menuAnchor) menuAnchor.focus();
  }

  function positionMenu() {
    if (!menu || !menuAnchor) return;
    const rect = menuAnchor.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.round(rect.left))}px`;
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  }

  /** 「未安装」的 shell 置灰但保留（让用户知道本机没有，而不是看不到）。 */
  function renderShellItem(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-role", "tab-new-local");
    button.setAttribute("data-shell-id", item.id);
    if (item.available === false) {
      button.disabled = true;
      button.setAttribute("data-available", "false");
    } else {
      button.setAttribute("data-available", "true");
    }
    const name = document.createElement("span");
    name.className = "tab-new-name";
    name.textContent = item.name || item.id;
    button.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "tab-new-meta";
    meta.textContent =
      item.available === false ? "未安装" : `${item.id} ${item.version || ""}`.trim();
    button.appendChild(meta);
    button.addEventListener("click", () => {
      if (item.available === false) return;
      closeMenu();
      onCreate({ shellId: item.id });
    });
    return button;
  }

  function renderHostItem(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-role", "tab-new-host");
    button.setAttribute("data-host-id", item.id);
    const name = document.createElement("span");
    name.className = "tab-new-name";
    name.textContent = item.name;
    button.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "tab-new-meta";
    meta.textContent = `${item.username}@${item.host}:${item.port}`;
    button.appendChild(meta);
    button.addEventListener("click", () => {
      closeMenu();
      onConnectHost(item);
    });
    return button;
  }

  function fillMenu(data) {
    if (!menu) return;
    const shells = Array.isArray(data && data.shells) ? data.shells : [];
    const hosts = Array.isArray(data && data.hosts) ? data.hosts : [];

    const localGroup = document.createElement("div");
    localGroup.className = "tab-new-group";
    localGroup.setAttribute("data-group", "local");
    localGroup.appendChild(createGroupLabel("本机"));
    for (const item of shells) localGroup.appendChild(renderShellItem(item));
    if (shells.length === 0) {
      localGroup.appendChild(createHint("读不到本机 shell 清单。"));
    }
    menu.appendChild(localGroup);

    const hostGroup = document.createElement("div");
    hostGroup.className = "tab-new-group";
    hostGroup.setAttribute("data-group", "host");
    hostGroup.appendChild(createGroupLabel("主机"));
    if (hosts.length === 0) {
      hostGroup.appendChild(createHint("还没有配置主机"));
      const go = document.createElement("button");
      go.type = "button";
      go.setAttribute("data-role", "tab-new-hosts-open");
      go.textContent = "去添加";
      go.addEventListener("click", () => {
        closeMenu();
        onOpenHosts();
      });
      hostGroup.appendChild(go);
    } else {
      for (const item of hosts) hostGroup.appendChild(renderHostItem(item));
    }
    menu.appendChild(hostGroup);
    positionMenu();
  }

  function createGroupLabel(text) {
    const label = document.createElement("div");
    label.className = "tab-new-group-label";
    label.textContent = text;
    return label;
  }

  function createHint(text) {
    const hint = document.createElement("p");
    hint.className = "tab-new-hint";
    hint.textContent = text;
    return hint;
  }

  async function openMenu(anchor) {
    closeMenu();
    menuOpen = true;
    const token = ++menuToken;
    menuAnchor = anchor;
    menu = document.createElement("div");
    menu.setAttribute("data-role", "tab-new-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "新建标签");
    menu.appendChild(createHint("正在读取…"));
    document.body.appendChild(menu);
    positionMenu();
    document.addEventListener("mousedown", onDocumentDown, true);
    document.addEventListener("keydown", onDocumentKey, true);
    window.addEventListener("resize", closeMenu);

    if (!loadMenu) {
      fillMenu({ shells: [], hosts: [] });
      return;
    }
    let data = null;
    try {
      data = await loadMenu();
    } catch {
      data = null;
    }
    // 期间用户关掉 / 又开了一次：这份结果作废。
    if (!menuOpen || token !== menuToken) return;
    menu.textContent = "";
    fillMenu(data || { shells: [], hosts: [] });
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
      // 本地 / 远程的小图标（TASK-V2-B §2.6：`data-kind="remote"`）。
      tab.setAttribute("data-kind", session.kind === "remote" ? "remote" : "local");
      if (session.kind === "remote") tab.title = `${titleFor(session)}（远程）`;

      const kindIcon = document.createElement("span");
      kindIcon.setAttribute("data-role", "tab-kind");
      kindIcon.setAttribute("aria-hidden", "true");
      kindIcon.textContent = session.kind === "remote" ? "🖧" : "▣";
      kindIcon.title = session.kind === "remote" ? "远程主机" : "本地终端";
      tab.appendChild(kindIcon);

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
      // 中键关闭：TASK-V2-A §2.1 把它列为回归锁，但基线里从未实现过。
      // 用 auxclick（button===1）而不是 mousedown：前者只在完整的「按下+抬起」后触发，
      // 中键拖动滚屏不会误关标签。
      tab.addEventListener("auxclick", (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        store.removeSession(session.id);
        if (elements.onClose) elements.onClose(session.id);
      });
      // 中键在部分环境里会先触发 mousedown 的默认「自动滚动」，preventDefault 掉。
      tab.addEventListener("mousedown", (event) => {
        if (event.button === 1) event.preventDefault();
      });
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
    add.setAttribute("aria-haspopup", "menu");
    add.textContent = "+";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      // 菜单已经开着 → 再点一次关掉（与普通下拉一致）。
      if (menuOpen && menuAnchor === add) {
        closeMenu();
        return;
      }
      void openMenu(add);
    });
    host.appendChild(add);
  }

  return {
    init() {
      unsubscribe = store.subscribe(render);
      render(store.getSnapshot());
    },
    dispose() {
      closeMenu();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      host.textContent = "";
    },
    get isMenuOpen() {
      return menuOpen;
    },
    closeMenu,
  };
}
