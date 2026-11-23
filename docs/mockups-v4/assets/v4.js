/* V4 设计稿交互：图标 sprite + 抽屉/菜单/折叠/主机面板/文件面板。
   纯原生 JS，无依赖；所有状态都是页面内的真实 DOM 状态，截图时可用查询参数预置。 */

(() => {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* 1. 图标 sprite                                                    */
  /* ---------------------------------------------------------------- */

  const ICONS = {
    "chevron-down": '<path d="M6 9.5l6 6 6-6"/>',
    "chevron-up": '<path d="M18 14.5l-6-6-6 6"/>',
    "chevron-left": '<path d="M15 18l-6-6 6-6"/>',
    "chevron-right": '<path d="M9 6l6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    terminal: '<path d="M4 7l5 5-5 5M12 19h8"/>',
    server:
      '<rect x="3" y="4" width="18" height="6.5" rx="1.6"/><rect x="3" y="13.5" width="18" height="6.5" rx="1.6"/><path d="M7 7.2h.01M7 16.8h.01"/>',
    settings:
      '<circle cx="12" cy="12" r="3.1"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5"/>',
    folder:
      '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.2h8.5A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
    "folder-plus":
      '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.2h8.5A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M12 12.2v5M9.5 14.7h5"/>',
    "folder-open":
      '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H9l2 2h7.5A1.5 1.5 0 0 1 20 10.5V12"/><path d="M3 18.5l2.4-6.2A1.5 1.5 0 0 1 6.8 11.3H21l-2.6 6.4a1.5 1.5 0 0 1-1.4.8H3z"/>',
    file: '<path d="M6 2.8h7.4L18.8 8v13.2H6z"/><path d="M13.2 3v5.2h5.2"/>',
    "file-text":
      '<path d="M6 2.8h7.4L18.8 8v13.2H6z"/><path d="M13.2 3v5.2h5.2M9 12h6M9 15.4h6M9 18.8h3.6"/>',
    image:
      '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.6" cy="10" r="1.5"/><path d="M4 18l4.8-5 3.2 3 2.6-2.6L20 18"/>',
    braces:
      '<path d="M9.2 3.5c-1.8 0-2.6 1-2.6 2.7v2.2c0 1.2-.7 1.8-1.6 1.8.9 0 1.6.6 1.6 1.8v2.2c0 1.7.8 2.7 2.6 2.7M14.8 3.5c1.8 0 2.6 1 2.6 2.7v2.2c0 1.2.7 1.8 1.6 1.8-.9 0-1.6.6-1.6 1.8v2.2c0 1.7-.8 2.7-2.6 2.7"/>',
    upload: '<path d="M12 16.5V4M7 9l5-5 5 5M4.5 20h15"/>',
    download: '<path d="M12 4v12.5M7 11.5l5 5 5-5M4.5 20h15"/>',
    refresh:
      '<path d="M20 11.5a8 8 0 1 1-2.4-5.7"/><path d="M20 3.5v5h-5"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.8 15.8L20.5 20.5"/>',
    grid:
      '<rect x="4" y="4" width="6.4" height="6.4" rx="1.2"/><rect x="13.6" y="4" width="6.4" height="6.4" rx="1.2"/><rect x="4" y="13.6" width="6.4" height="6.4" rx="1.2"/><rect x="13.6" y="13.6" width="6.4" height="6.4" rx="1.2"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    "more-v":
      '<circle cx="12" cy="5.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="18.6" r="1.1" fill="currentColor" stroke="none"/>',
    "more-h":
      '<circle cx="5.4" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
    "arrow-up": '<path d="M12 19V5M6 11l6-6 6 6"/>',
    sparkle:
      '<path d="M12 3.2l1.7 5.1 5.1 1.7-5.1 1.7L12 16.8l-1.7-5.1L5.2 10l5.1-1.7z"/><path d="M18.4 16.2l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    check: '<path d="M20 6.5L9.2 17.3 4 12.1"/>',
    "check-circle": '<circle cx="12" cy="12" r="8.6"/><path d="M8.2 12.3l2.6 2.6 5-5.2"/>',
    "alert-triangle":
      '<path d="M12 3.6L21.2 20H2.8z"/><path d="M12 9v4.6M12 16.8h.01"/>',
    /* 审阅角标四态：盾形轮廓一致，内芯换勾 / 叹号 / 叉 / 横线 */
    "shield-check":
      '<path d="M12 3.1l7.3 2.9v5.2c0 4.4-3.1 7.6-7.3 10-4.2-2.4-7.3-5.6-7.3-10V6z"/><path d="M8.6 11.9l2.5 2.5 4.4-4.6"/>',
    "shield-alert":
      '<path d="M12 3.1l7.3 2.9v5.2c0 4.4-3.1 7.6-7.3 10-4.2-2.4-7.3-5.6-7.3-10V6z"/><path d="M12 8.4v4.3M12 15.7h.01"/>',
    "shield-x":
      '<path d="M12 3.1l7.3 2.9v5.2c0 4.4-3.1 7.6-7.3 10-4.2-2.4-7.3-5.6-7.3-10V6z"/><path d="M9.4 9.7l5.2 5.2M14.6 9.7l-5.2 5.2"/>',
    "shield-none":
      '<path d="M12 3.1l7.3 2.9v5.2c0 4.4-3.1 7.6-7.3 10-4.2-2.4-7.3-5.6-7.3-10V6z" stroke-dasharray="2.6 2.4"/><path d="M9.4 12h5.2"/>',
    play: '<path d="M8 4.8l10.5 7.2L8 19.2z"/>',
    skip: '<path d="M5 5l9 7-9 7z"/><path d="M19 5v14"/>',
    edit: '<path d="M4 20l4.2-.9L20 7.3 16.7 4 4.9 15.8z"/><path d="M14.8 5.9l3.3 3.3"/>',
    trash:
      '<path d="M4.5 6.5h15M9.5 6.5V4.2h5v2.3M6.5 6.5l.9 13.3h9.2l.9-13.3"/><path d="M10.2 10v6.2M13.8 10v6.2"/>',
    eye: '<path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.8"/>',
    lock:
      '<rect x="5" y="10.5" width="14" height="9.5" rx="1.8"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/>',
    cpu:
      '<rect x="7" y="7" width="10" height="10" rx="1.6"/><path d="M10 2.8v2.4M14 2.8v2.4M10 18.8v2.4M14 18.8v2.4M2.8 10h2.4M2.8 14h2.4M18.8 10h2.4M18.8 14h2.4"/>',
    clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.2 2"/>',
    copy:
      '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.8"/><path d="M15.5 5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5"/>',
    "git-branch":
      '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="9.5" r="2"/><path d="M6.5 7.5v9M17.5 11.5c0 3.4-4.2 3.2-8 4"/>',
    filter: '<path d="M3.5 5.5h17l-6.6 7.6v6.4l-3.8-2v-4.4z"/>',
    panel: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M14.5 4.5v15"/>',
    zap: '<path d="M13.2 2.8L5.4 13.6h5l-1.6 7.6 7.8-10.8h-5z"/>',
    keyboard:
      '<rect x="2.8" y="6.5" width="18.4" height="11" rx="1.8"/><path d="M6.2 10h.01M9.4 10h.01M12.6 10h.01M15.8 10h.01M18 10h.01M8 13.8h8"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.4 1.4"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.4-1.4"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 3.8v5h5"/><path d="M12 7.8V12l3 1.8"/>',
    dots: '<circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  };

  const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  sprite.setAttribute("aria-hidden", "true");
  sprite.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  sprite.innerHTML = Object.entries(ICONS)
    .map(([id, body]) => `<symbol id="i-${id}" viewBox="0 0 24 24">${body}</symbol>`)
    .join("");
  document.body.prepend(sprite);

  /* ---------------------------------------------------------------- */
  /* 2. 小工具                                                         */
  /* ---------------------------------------------------------------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const params = new URLSearchParams(location.search);

  const app = $(".app");

  function setDrawer(open) {
    if (!app) return;
    app.dataset.ai = open ? "open" : "closed";
    $$("[data-drawer-toggle]").forEach((b) =>
      b.setAttribute("aria-expanded", String(open))
    );
    if (open) {
      const list = $(".ai-msgs");
      if (list) requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
    }
  }

  /* ---------------------------------------------------------------- */
  /* 3. 抽屉开合：唯一入口是右侧把手，没有别的收起按钮                   */
  /* ---------------------------------------------------------------- */

  $$("[data-drawer-toggle]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      setDrawer(app.dataset.ai !== "open");
    });
  });

  /* ---------------------------------------------------------------- */
  /* 4. 菜单：+ 新建标签、模型、会话选择、文件右键共用一套               */
  /* ---------------------------------------------------------------- */

  let openMenuEl = null;

  function closeMenus(except) {
    $$(".menu").forEach((m) => {
      if (m === except) return;
      m.hidden = true;
      const id = m.id;
      if (id) {
        $$(`[data-menu-toggle="${id}"]`).forEach((b) =>
          b.setAttribute("aria-expanded", "false")
        );
      }
    });
    if (openMenuEl && openMenuEl !== except) openMenuEl = null;
  }

  function openMenu(menu, btn) {
    closeMenus(menu);
    menu.hidden = false;
    openMenuEl = menu;
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (!menu.dataset.positioned) {
      menu.dataset.positioned = "1";
      const wrap = menu.parentElement;
      if (wrap && getComputedStyle(wrap).position === "static") {
        wrap.style.position = "relative";
      }
    }
  }

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-menu-toggle]");
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.getElementById(toggle.dataset.menuToggle);
      if (!menu) return;
      if (menu.hidden) openMenu(menu, toggle);
      else {
        menu.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }
      return;
    }

    const item = e.target.closest(".menu-item");
    if (item) {
      const menu = item.closest(".menu");
      if (menu) {
        menu.hidden = true;
        $$(`[data-menu-toggle="${menu.id}"]`).forEach((b) =>
          b.setAttribute("aria-expanded", "false")
        );
      }
      return;
    }

    if (!e.target.closest(".menu")) closeMenus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMenus();
      hideCtx();
      if (hostsLayer && !hostsLayer.hidden) showHosts(false);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 5. 折叠块：思考链、工具输出、文件面板                               */
  /* ---------------------------------------------------------------- */

  document.addEventListener("click", (e) => {
    const acc = e.target.closest("[data-acc]");
    if (acc) {
      const target = document.getElementById(acc.dataset.acc);
      if (!target) return;
      const expanded = acc.getAttribute("aria-expanded") === "true";
      acc.setAttribute("aria-expanded", String(!expanded));
      target.hidden = expanded;
      return;
    }

    const collapse = e.target.closest("[data-files-collapse]");
    if (collapse) {
      const files = $(".files");
      if (!files) return;
      files.dataset.collapsed = files.dataset.collapsed === "true" ? "false" : "true";
      collapse.setAttribute(
        "aria-expanded",
        files.dataset.collapsed === "true" ? "false" : "true"
      );
      syncFilesHeight();
    }
  });

  /* 文件面板实际高度写进变量，toast 才能避开它。 */
  function syncFilesHeight() {
    const files = $(".files");
    if (!files || !app) return;
    if (files.dataset.collapsed === "true") {
      app.style.setProperty("--v4-files-cur", "38px");
      return;
    }
    const h = Math.round(files.getBoundingClientRect().height);
    app.style.setProperty("--v4-files-cur", h + "px");
  }
  syncFilesHeight();
  addEventListener("resize", syncFilesHeight);

  /* 文件面板上下拖拽 */
  (() => {
    const files = $(".files");
    const grip = $(".files-grip");
    const work = $(".workarea");
    if (!files || !grip || !work) return;

    let startY = 0;
    let startH = 0;

    grip.addEventListener("pointerdown", (e) => {
      startY = e.clientY;
      startH = files.getBoundingClientRect().height;
      grip.setPointerCapture(e.pointerId);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    grip.addEventListener("pointermove", (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      const workBottom = work.getBoundingClientRect().bottom;
      const next = Math.min(420, Math.max(150, workBottom - e.clientY));
      files.style.height = next + "px";
      if (app) app.style.setProperty("--v4-files-cur", next + "px");
    });

    const end = (e) => {
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  })();

  /* ---------------------------------------------------------------- */
  /* 6. 主机面板                                                       */
  /* ---------------------------------------------------------------- */

  const hostsLayer = $(".hosts-layer");

  function showHosts(show) {
    if (!hostsLayer) return;
    hostsLayer.hidden = !show;
    $$("[data-hosts-open]").forEach((b) => b.setAttribute("aria-expanded", String(show)));
    if (show) {
      const first = $(".hosts [data-autofocus]");
      if (first) first.focus({ preventScroll: true });
    }
  }

  $$("[data-hosts-open]").forEach((b) =>
    b.addEventListener("click", () => showHosts(true))
  );
  $$("[data-hosts-close]").forEach((b) =>
    b.addEventListener("click", () => showHosts(false))
  );
  const scrim = $(".hosts-scrim");
  if (scrim) scrim.addEventListener("click", () => showHosts(false));

  /* shell 单选 */
  $$(".shell-grid").forEach((grid) => {
    grid.addEventListener("click", (e) => {
      const opt = e.target.closest(".shell-opt");
      if (!opt) return;
      $$(".shell-opt", grid).forEach((o) =>
        o.setAttribute("aria-checked", String(o === opt))
      );
    });
  });

  /* 主机行选中 */
  $$(".hosts-body").forEach((body) => {
    body.addEventListener("click", (e) => {
      const row = e.target.closest(".host-row");
      if (!row || e.target.closest(".hmore")) return;
      $$(".host-row", body).forEach((r) =>
        r.setAttribute("data-active", String(r === row))
      );
    });
  });

  /* ---------------------------------------------------------------- */
  /* 7. 文件：选中、右键菜单、视图切换                                   */
  /* ---------------------------------------------------------------- */

  const ctx = $("#file-ctx");

  function hideCtx() {
    if (ctx) ctx.hidden = true;
  }

  function showCtx(x, y, name) {
    if (!ctx) return;
    ctx.hidden = false;
    const label = $("[data-ctx-name]", ctx);
    if (label) label.textContent = name || "项目";
    const pad = 8;
    const w = ctx.getBoundingClientRect().width || 196;
    const h = ctx.getBoundingClientRect().height || 220;
    ctx.style.left = Math.min(x, innerWidth - w - pad) + "px";
    ctx.style.top = Math.min(y, innerHeight - h - pad) + "px";
  }

  $$(".file-grid").forEach((grid) => {
    grid.addEventListener("click", (e) => {
      const file = e.target.closest(".file");
      if (!file) return;
      if (e.target.closest(".fmore")) {
        const r = file.getBoundingClientRect();
        showCtx(r.right - 190, r.bottom - 4, file.dataset.name || "项目");
        return;
      }
      $$(".file", grid).forEach((f) =>
        f.setAttribute("data-selected", String(f === file))
      );
    });

    grid.addEventListener("contextmenu", (e) => {
      const file = e.target.closest(".file");
      if (!file) return;
      e.preventDefault();
      $$(".file", grid).forEach((f) =>
        f.setAttribute("data-selected", String(f === file))
      );
      showCtx(e.clientX, e.clientY, file.dataset.name || "项目");
    });

    grid.addEventListener("dblclick", (e) => {
      const file = e.target.closest(".file");
      if (!file) return;
      const crumb = $(".crumb[data-current='true']");
      if (crumb) crumb.textContent = file.dataset.name || crumb.textContent;
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#file-ctx") && !e.target.closest(".fmore")) hideCtx();
  });
  if (ctx) {
    $$(".menu-item", ctx).forEach((i) => i.addEventListener("click", hideCtx));
  }

  /* 规格页视图切换 */
  $$("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      $$("[data-view]").forEach((b) =>
        b.setAttribute("aria-selected", String(b === btn))
      );
      $$("[data-spec-panel]").forEach((p) => {
        p.hidden = p.dataset.specPanel !== view;
      });
    });
  });

  /* toast 关闭 */
  $$(".toast-x").forEach((b) =>
    b.addEventListener("click", () => {
      const t = b.closest(".toast");
      if (t) t.hidden = true;
    })
  );

  /* 会话下拉：分组行可展开 / 折叠（当前组默认展开，其余默认折叠） */
  $$(".sess-group-head").forEach((head) => {
    head.addEventListener("click", () => {
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", open ? "false" : "true");
      const items = head.nextElementSibling;
      if (items && items.classList.contains("sess-items")) items.hidden = open;
    });
  });

  /* 设置页开关：常显效果评估（默认关） */
  const setEffect = (on) => {
    $$('[data-toggle="effect"]').forEach((sw) => sw.setAttribute("aria-checked", on ? "true" : "false"));
    $$(".approval-effect").forEach((p) => (p.hidden = !on));
  };
  $$("[data-toggle]").forEach((sw) => {
    sw.addEventListener("click", () => {
      const on = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", on ? "true" : "false");
      if (sw.dataset.toggle === "effect") setEffect(on);
    });
  });

  /* 审批卡：点按钮后收敛成一行结果，避免误以为还能重复点 */
  $$(".approval-acts").forEach((acts) => {
    acts.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const card = acts.closest(".approval");
      const label =
        btn.dataset.approve === "all"
          ? "已批准全部"
          : btn.dataset.approve === "skip"
          ? "已跳过"
          : "已执行";
      if (!card) return;
      card.dataset.state = "done";
      const head = $(".approval-head", card);
      if (head) {
        const dot = document.createElement("span");
        dot.className = "dot " + (btn.dataset.approve === "skip" ? "dot-warn" : "dot-ok");
        head.textContent = "";
        head.append(dot, document.createTextNode(label + " · 等待终端输出"));
      }
      acts.remove();
    });
  });

  /* 输入框：默认自动增高 1→6 行；拖顶部把手可拉到抽屉高度的 40%；高度记 localStorage */
  const LH = 12.5 * 1.55;          /* 与 CSS 的 font-size / line-height 保持一致 */
  const MAX_AUTO = Math.round(LH * 6);
  const H_KEY = "v4-composer-h";

  const growOne = (ta) => {
    const manual = parseFloat(ta.dataset.manual || "0");
    ta.style.height = "auto";
    const auto = Math.min(MAX_AUTO, ta.scrollHeight);
    ta.style.height = Math.max(manual || 0, Math.max(LH, auto)) + "px";
  };

  const savedH = parseInt(localStorage.getItem(H_KEY) || "0", 10);
  $$(".composer-box textarea").forEach((ta) => {
    if (savedH > 0) ta.dataset.manual = String(savedH);
    ta.addEventListener("input", () => {
      ta.dataset.manual = "";     /* 用户重新打字就回到自动增高 */
      growOne(ta);
    });
    growOne(ta);
  });

  $$("[data-composer-grip]").forEach((grip) => {
    const box = grip.closest(".composer-box");
    const composer = grip.closest(".composer");
    const ta = box && $("textarea", box);
    const host = box && (box.closest(".drawer") || box.closest(".drawer-zoom"));
    if (!ta) return;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = ta.getBoundingClientRect().height;
      const cap = Math.max(MAX_AUTO, Math.round((host ? host.clientHeight : 760) * 0.4));
      grip.setPointerCapture(e.pointerId);
      if (composer) composer.dataset.resizing = "true";
      const move = (ev) => {
        const h = Math.round(Math.min(cap, Math.max(LH, startH - (ev.clientY - startY))));
        ta.dataset.manual = String(h);
        ta.style.height = h + "px";
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        if (composer) composer.dataset.resizing = "false";
        localStorage.setItem(H_KEY, ta.dataset.manual || "");
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
  });

  $$("[data-send]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const composer = btn.closest(".composer");
      const ta = composer && $("textarea", composer);
      const list = $(".ai-msgs");
      if (!ta || !list) return;
      const text = ta.value.trim();
      if (!text) {
        ta.focus();
        return;
      }
      const bubble = document.createElement("div");
      bubble.className = "msg-user";
      bubble.textContent = text;
      list.append(bubble);
      ta.value = "";
      ta.dataset.manual = "";
      ta.style.height = "";
      list.scrollTop = list.scrollHeight;
    });
  });

  $$(".composer-box textarea").forEach((ta) => {
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const btn = ta.closest(".composer") && $("[data-send]", ta.closest(".composer"));
        if (btn) btn.click();
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* 8. 查询参数预置状态（截图用）                                       */
  /* ---------------------------------------------------------------- */

  if (app) {
    if (params.get("ai") === "open") setDrawer(true);
    if (params.get("hosts") === "1" && hostsLayer) hostsLayer.hidden = false;
    if (params.get("menu") === "1") {
      const btn = $("[data-menu-toggle]");
      const menu = btn && document.getElementById(btn.dataset.menuToggle);
      if (menu) {
        menu.hidden = false;
        btn.setAttribute("aria-expanded", "true");
      }
    }
    if (params.get("toast") === "0") {
      const t = $(".toast");
      if (t) t.hidden = true;
    }
  }

  const initialView = params.get("view");
  if (initialView) {
    const btn = $('[data-view="' + initialView + '"]');
    if (btn) btn.click();
  }

  /* 文件细节页预置右键菜单：切换视图的 click 会触发全局 hideCtx，这里恢复一次 */
  if (initialView === "files" && ctx) ctx.hidden = false;

  /* 规格页里常驻展开的菜单：视图切换会触发全局 hideMenus，这里恢复 */
  $$("[data-static-open]").forEach((m) => {
    m.hidden = false;
    const t = $('[data-menu-toggle="' + m.id + '"]');
    if (t) t.setAttribute("aria-expanded", "true");
  });

  /* 规格页也能用 ?menu=1 预展开第一个菜单（会话选择） */
  if (!app && params.get("menu") === "1") {
    const btn = $("[data-menu-toggle]");
    const menu = btn && document.getElementById(btn.dataset.menuToggle);
    if (menu) {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
  }

  /* 会话分组展开到第 N 组（截图用：?sess=2 展示「非当前组也能点开」） */
  const sessN = parseInt(params.get("sess") || "0", 10);
  if (sessN > 0) {
    /* 只数当前可见的会话列表（同一页有多个面板，隐藏面板里的组不算） */
    const groups = $$(".sess-group").filter((el) => el.offsetParent !== null);
    const g = groups[sessN - 1];
    const head = g && $(".sess-group-head", g);
    if (head && head.getAttribute("aria-expanded") !== "true") head.click();
  }

  /* 确认卡常显效果评估（?effect=1 打开开关并显示） */
  if (params.get("effect") === "1") setEffect(true);

  /* 角标悬停态（?tip=1 让第一个可见角标展开 tooltip，近景截图用） */
  if (params.get("tip") === "1") {
    const mark = $$(".review-mark").find((m) => m.offsetParent !== null);
    if (mark) mark.dataset.open = "true";
  }

  /* 输入框放大态（?grow=1 灌一段多行草稿并增高，展示默认 6 行上限） */
  if (params.get("grow") === "1") {
    const ta = $(".drawer .composer-box textarea") || $(".composer-box textarea");
    if (ta) {
      ta.value =
        "把 test/fixtures 下的 .log 先移到 .trash/ 再删除，保留 7 天。\n" +
        "顺便把这条规则写进 AGENTS.md 的「文件操作」一节，写成一句话就行。\n" +
        "改完跑一遍 npm test，只跑 files 相关的那几个用例。\n" +
        "如果快照断言失败，先别改断言，把失败项贴给我。";
      growOne(ta);
    }
  }

  /* 聊天区默认滚到底 */
  const msgs = $(".ai-msgs");
  if (msgs) requestAnimationFrame(() => (msgs.scrollTop = msgs.scrollHeight));
})();
