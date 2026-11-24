// 文件面板（TASK-V4-G §5.5）：终端下方的常驻区域，跟随当前终端目录，
// 支持 列表 / 新建 / 查看 / 编辑 / 重命名 / 删除 / 上传 / 下载。
//
// 三件事必须记住：
// 1. 面板只依赖 api + store 的**只读**快照，不发 WS 帧（上行帧本卡不新增）。
// 2. 高度只写 localStorage（key `magpie.term.filePanelHeight`），范围 150–520px。
// 3. 分界必须同时有三样：1px 亮线 + `inset 0 7px 14px` 内投影 + 常显 46×4 把手
//    （CHANGES-V4 §4 第 15 条）。CSS 在 components.css 的 `.file-panel*` 段。
//
// 跟随规则：收到 `session.cwd` 且该会话就是面板当前绑定的会话、且用户没有手动
// 切过目录（manualPath=false）→ 自动跳过去。手动进目录后停止跟随，工具条给
// 「回到终端目录」按钮恢复。

const HEIGHT_KEY = "magpie.term.filePanelHeight";
const OPEN_KEY = "magpie.term.filePanelOpen";
export const MIN_HEIGHT = 150;
export const MAX_HEIGHT = 520;
export const DEFAULT_HEIGHT = 224;

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "hidden") node.hidden = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatTime(mtime) {
  const n = Number(mtime);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 条目图标（与旧 file-tree.js 的语义一致：目录/链接/文件三态）。 */
function iconFor(entry) {
  if (entry.type === "dir") return { kind: "dir", text: "📁" };
  if (entry.type === "link") return { kind: "link", text: "🔗" };
  const name = String(entry.name || "");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const kind =
    ["js", "mjs", "cjs", "jsx"].includes(ext) ? "js"
    : ["ts", "tsx"].includes(ext) ? "ts"
    : ext === "json" ? "json"
    : ["md", "markdown"].includes(ext) ? "md"
    : ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext) ? "img"
    : "file";
  return { kind, text: "📄" };
}

/** 父路径（按分隔符风格）；到根返回 null。 */
function parentOf(target) {
  const text = String(target || "").replace(/[\\/]+$/, "");
  if (!text) return null;
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (index < 0) return null;
  if (index === 0) return "/";
  const parent = text.slice(0, index);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

function joinPath(dir, name) {
  const base = String(dir || "");
  if (!base) return name;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  return `${base}${sep}${name}`;
}

export default function createFilePanel(elements) {
  const api = elements.api;
  const store = elements.store;
  const host = elements.host;
  const onNotice = typeof elements.onNotice === "function" ? elements.onNotice : () => {};

  const state = {
    open: false,
    height: DEFAULT_HEIGHT,
    // 面板绑定的会话（id / kind / hostId / cwd）
    sessionId: null,
    kind: "local",
    hostId: null,
    termCwd: null,
    path: null,
    parent: null,
    entries: [],
    selected: new Set(),
    manualPath: false,
    busy: false,
    uploads: [],
  };

  let root = null;
  let toolbar = null;
  let pathInput = null;
  let followButton = null;
  let grid = null;
  let statusLine = null;
  let uploadHost = null;
  let backdrop = null;
  let modal = null;
  let unsubscribe = null;
  let lastActiveId = null;

  /* ---------------------------- 存储 ---------------------------- */

  function readStoredHeight() {
    try {
      const raw = Number(localStorage.getItem(HEIGHT_KEY));
      if (Number.isFinite(raw) && raw > 0) {
        return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(raw)));
      }
    } catch {
      // localStorage 不可用（沙箱里也可能被拒）：用默认值。
    }
    return DEFAULT_HEIGHT;
  }

  function storeHeight(value) {
    try {
      localStorage.setItem(HEIGHT_KEY, String(value));
    } catch {
      // 忽略。
    }
  }

  function readStoredOpen() {
    try {
      const raw = localStorage.getItem(OPEN_KEY);
      return raw === null ? false : raw === "1";
    } catch {
      return false;
    }
  }

  function storeOpen(value) {
    try {
      localStorage.setItem(OPEN_KEY, value ? "1" : "0");
    } catch {
      // 忽略。
    }
  }

  /* ---------------------------- 布局 ---------------------------- */

  function applyHeight(value) {
    state.height = value;
    if (root) root.style.height = `${value}px`;
    if (root) root.setAttribute("data-height", String(value));
    // 供 CSS 算把手位置：AI 把手只在上方的终端区域垂直居中，
    // 不能压在文件面板工具条（关闭按钮）上。
    try {
      document.documentElement.style.setProperty("--file-panel-h", `${value}px`);
    } catch {
      // 忽略。
    }
  }

  function applyOpen() {
    if (!root) return;
    root.hidden = !state.open;
    document.documentElement.setAttribute("data-files-open", state.open ? "true" : "false");
    const railButton = document.querySelector('[data-role="rail-files"]');
    if (railButton) {
      railButton.setAttribute("aria-pressed", state.open ? "true" : "false");
      railButton.setAttribute("data-active", state.open ? "true" : "false");
    }
    if (state.open) {
      // 打开面板会改变终端可用高度：让 xterm 重新 fit（走常规 resize 管道）。
      window.dispatchEvent(new CustomEvent("magpie:file-panel-toggle", { detail: { open: true } }));
    } else {
      window.dispatchEvent(new CustomEvent("magpie:file-panel-toggle", { detail: { open: false } }));
    }
  }

  /* ---------------------------- 数据 ---------------------------- */

  function target() {
    return state.kind === "remote" && state.hostId ? { hostId: state.hostId } : null;
  }

  async function load(pathValue, opts = {}) {
    if (state.busy) return;
    state.busy = true;
    renderGridMessage("正在读取目录…");
    const wanted = typeof pathValue === "string" && pathValue.length > 0 ? pathValue : state.path || ".";
    const result = await api.fsList(target(), wanted);
    state.busy = false;
    if (!result.ok) {
      state.entries = [];
      renderGridMessage(result.userText || `读取失败（${result.code}）`, true);
      onNotice(result.userText || "列不出这个目录。", "warn");
      return;
    }
    const data = result.data || {};
    state.path = typeof data.path === "string" && data.path.length > 0 ? data.path : wanted;
    state.parent = typeof data.parent === "string" ? data.parent : parentOf(state.path);
    state.entries = Array.isArray(data.entries) ? data.entries : [];
    if (!opts.keepSelection) state.selected.clear();
    render();
  }

  /** 当前会话的终端目录 → 面板目录（跟随开关打开时才动）。 */
  async function followTerminalCwd(cwd) {
    if (typeof cwd !== "string" || cwd.length === 0) return;
    state.termCwd = cwd;
    renderFollowButton();
    if (state.manualPath) return;
    if (state.path === cwd) return;
    await load(cwd);
  }

  /* ---------------------------- 渲染 ---------------------------- */

  function renderPathBar() {
    if (!pathInput) return;
    pathInput.value = state.path || "";
    pathInput.title = state.path || "";
  }

  function renderFollowButton() {
    if (!followButton) return;
    const canReturn =
      state.manualPath &&
      typeof state.termCwd === "string" &&
      state.termCwd.length > 0 &&
      state.termCwd !== state.path;
    followButton.hidden = !canReturn;
    followButton.title = canReturn ? `回到终端目录：${state.termCwd}` : "跟随终端目录";
  }

  function renderGridMessage(text, isError) {
    if (!grid) return;
    grid.textContent = "";
    const note = el("p", { className: "file-panel-empty" }, text);
    if (isError) note.setAttribute("data-tone", "error");
    grid.appendChild(note);
  }

  function render() {
    renderPathBar();
    renderFollowButton();
    if (!grid) return;
    grid.textContent = "";
    if (state.entries.length === 0) {
      renderGridMessage("这个目录是空的。");
      renderStatus();
      return;
    }
    for (const entry of state.entries) {
      grid.appendChild(renderEntry(entry));
    }
    renderStatus();
  }

  function renderEntry(entry) {
    const icon = iconFor(entry);
    const card = el("button", {
      type: "button",
      className: "file-panel-entry",
      "data-role": "file-entry",
      "data-type": entry.type,
      "data-name": entry.name,
      "data-path": entry.path,
      title: `${entry.path}\n${entry.type} · ${formatSize(entry.size)} · ${formatTime(entry.mtime)}`,
    });
    if (state.selected.has(entry.path)) card.setAttribute("data-selected", "true");

    const type = el("span", {
      className: "file-panel-ftype",
      "data-kind": icon.kind,
      "aria-hidden": "true",
    }, icon.text);
    card.appendChild(type);

    const name = el("span", { className: "file-panel-fname" }, entry.name);
    card.appendChild(name);

    const meta = el(
      "span",
      { className: "file-panel-fmeta" },
      entry.type === "dir" ? formatTime(entry.mtime) : `${formatSize(entry.size)} · ${formatTime(entry.mtime)}`,
    );
    card.appendChild(meta);

    // 悬浮操作：查看 / 编辑 / 重命名 / 下载 / 删除（目录只有重命名/删除）。
    const more = el("span", { className: "file-panel-fmore", "aria-hidden": "false" });
    const actions = entry.type === "dir"
      ? [["打开", "open"], ["重命名", "rename"], ["删除", "delete"]]
      : [["查看", "view"], ["编辑", "edit"], ["重命名", "rename"], ["下载", "download"], ["删除", "delete"]];
    for (const [label, action] of actions) {
      const button = el("button", {
        type: "button",
        className: "file-panel-action",
        "data-action": action,
        title: `${label}：${entry.name}`,
      }, label);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void runAction(action, entry);
      });
      more.appendChild(button);
    }
    // L1-03：每行常显一个「⋯」入口（弱化配色），点开才露出具体动作；
    // hover / 选中仍可直接展开，保持原有快捷路径。
    const moreToggle = el("button", {
      type: "button",
      className: "file-panel-more-toggle",
      "data-role": "file-more-toggle",
      title: `更多操作：${entry.name}`,
      "aria-label": `更多操作：${entry.name}`,
      "aria-expanded": "false",
    }, "⋯");
    moreToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = card.getAttribute("data-more-open") === "true";
      // 同时只展开一行：再点自己关闭，点别的行先收起旧行。
      for (const other of grid.querySelectorAll('[data-more-open="true"]')) {
        if (other !== card) other.removeAttribute("data-more-open");
      }
      if (open) card.removeAttribute("data-more-open");
      else card.setAttribute("data-more-open", "true");
      moreToggle.setAttribute("aria-expanded", open ? "false" : "true");
    });
    card.appendChild(moreToggle);
    card.appendChild(more);

    card.addEventListener("click", (event) => {
      if (event.target && event.target.closest && event.target.closest(".file-panel-action")) return;
      if (event.target && event.target.closest && event.target.closest(".file-panel-more-toggle")) return;
      state.selected.clear();
      state.selected.add(entry.path);
      card.removeAttribute("data-more-open");
      moreToggle.setAttribute("aria-expanded", "false");
      for (const node of grid.querySelectorAll('[data-role="file-entry"]')) {
        node.setAttribute("data-selected", node.getAttribute("data-path") === entry.path ? "true" : "false");
      }
      renderStatus();
    });
    card.addEventListener("dblclick", (event) => {
      event.preventDefault();
      if (event.target && event.target.closest && event.target.closest(".file-panel-more-toggle")) return;
      if (entry.type === "dir") void enterDirectory(entry.path);
      else void openViewer(entry);
    });
    return card;
  }

  function renderStatus() {
    if (!statusLine) return;
    const count = state.entries.length;
    const selectedCount = state.selected.size;
    const suffix = selectedCount > 0 ? ` · 已选 ${selectedCount} 项` : "";
    statusLine.textContent = `${state.kind === "remote" ? "远程" : "本地"} · ${count} 项${suffix}`;
  }

  async function enterDirectory(pathValue) {
    state.manualPath = true;
    await load(pathValue);
    renderFollowButton();
  }

  /* ---------------------------- 操作 ---------------------------- */

  async function runAction(action, entry) {
    switch (action) {
      case "open":
        await enterDirectory(entry.path);
        return;
      case "view":
        await openViewer(entry);
        return;
      case "edit":
        await openEditor(entry);
        return;
      case "rename":
        await promptRename(entry);
        return;
      case "download":
        await downloadFile(entry);
        return;
      case "delete":
        await confirmDelete(entry);
        return;
      default:
        return;
    }
  }

  async function openViewer(entry) {
    const result = await api.fsRead(target(), entry.path);
    if (!result.ok) {
      onNotice(result.userText || "打不开这个文件。", "warn");
      showNoticeModal("查看失败", result.userText || `读取失败（${result.code}）`);
      return;
    }
    showTextModal({
      role: "file-viewer",
      title: entry.name,
      content: result.data && typeof result.data.content === "string" ? result.data.content : "",
      readOnly: true,
      path: entry.path,
    });
  }

  async function openEditor(entry) {
    const result = await api.fsRead(target(), entry.path);
    if (!result.ok) {
      onNotice(result.userText || "打不开这个文件。", "warn");
      showNoticeModal("编辑失败", result.userText || `读取失败（${result.code}）`);
      return;
    }
    showTextModal({
      role: "file-editor",
      title: entry.name,
      content: result.data && typeof result.data.content === "string" ? result.data.content : "",
      readOnly: false,
      path: entry.path,
    });
  }

  /* ---------------------------- 模态 ---------------------------- */

  function ensureBackdrop() {
    if (backdrop) return backdrop;
    backdrop = el("div", { "data-role": "confirm-backdrop", hidden: true });
    const card = el("div", {
      "data-role": "confirm-card",
      role: "dialog",
      "aria-modal": "true",
    });
    modal = card;
    backdrop.appendChild(card);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal();
    });
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function closeModal() {
    if (!backdrop) return;
    backdrop.hidden = true;
    modal.textContent = "";
    modal.removeAttribute("data-role");
    modal.setAttribute("data-role", "confirm-card");
  }

  function openModalShell() {
    ensureBackdrop();
    modal.textContent = "";
    modal.setAttribute("data-role", "confirm-card");
    backdrop.hidden = false;
    return modal;
  }

  function showNoticeModal(title, text) {
    const card = openModalShell();
    card.appendChild(el("h2", {}, title));
    card.appendChild(el("p", { className: "file-panel-modal-text" }, text));
    const actions = el("div", { className: "file-panel-modal-actions" });
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "知道了");
    ok.addEventListener("click", () => closeModal());
    actions.appendChild(ok);
    card.appendChild(actions);
    ok.focus();
  }

  function showTextModal({ role, title, content, readOnly, path }) {
    // 外层保持 confirm-card（复用它的卡片壳 / 遮罩 / 层级），
    // 内层带契约要求的 data-role（file-viewer / file-editor）。
    const card = openModalShell();
    card.setAttribute("data-role", "confirm-card");
    card.setAttribute("data-tone", "neutral");
    const body = el("div", { "data-role": role, className: "file-panel-modal" });
    card.appendChild(body);
    const head = el("div", { className: "file-panel-modal-head" });
    head.appendChild(el("h2", {}, title));
    head.appendChild(el("span", { className: "file-panel-modal-path" }, path));
    body.appendChild(head);

    const editor = el("textarea", {
      className: "file-panel-textarea",
      spellcheck: "false",
      readonly: readOnly ? "readonly" : null,
      "data-role": readOnly ? "file-viewer-body" : "file-editor-body",
    });
    editor.value = content;
    body.appendChild(editor);

    const actions = el("div", { className: "file-panel-modal-actions" });
    const hint = el(
      "span",
      { className: "file-panel-modal-hint" },
      readOnly ? "只读预览 · Ctrl+A 全选可复制" : "Ctrl+S 保存 · Esc 关闭",
    );
    actions.appendChild(hint);

    const close = el("button", { type: "button", className: "file-panel-btn" }, "关闭");
    close.addEventListener("click", () => closeModal());
    actions.appendChild(close);

    if (!readOnly) {
      const save = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "保存");
      save.setAttribute("data-role", "file-editor-save");
      const doSave = async () => {
        save.disabled = true;
        const result = await api.fsWrite(target(), path, editor.value);
        save.disabled = false;
        if (!result.ok) {
          onNotice(result.userText || "保存失败。", "error");
          return;
        }
        onNotice("已保存。", "ok");
        closeModal();
        await load(state.path, { keepSelection: true });
      };
      save.addEventListener("click", () => void doSave());
      editor.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
          event.preventDefault();
          void doSave();
        }
      });
      actions.appendChild(save);
    }
    body.appendChild(actions);
    editor.focus();
  }

  async function promptRename(entry) {
    const card = openModalShell();
    card.setAttribute("data-tone", "neutral");
    card.appendChild(el("h2", {}, "重命名"));
    card.appendChild(el("p", { className: "file-panel-modal-text" }, entry.path));
    const input = el("input", { type: "text", className: "file-panel-input", "data-role": "file-rename-input" });
    input.value = entry.name;
    card.appendChild(input);
    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "重命名");
    const submit = async () => {
      const name = input.value.trim();
      if (!name || name === entry.name) {
        closeModal();
        return;
      }
      const parent = entry.path.slice(0, entry.path.length - entry.name.length);
      const to = `${parent}${name}`;
      const result = await api.fsRename(target(), entry.path, to);
      if (!result.ok) {
        onNotice(result.userText || "重命名失败。", "error");
        return;
      }
      closeModal();
      onNotice(`已重命名为 ${name}`, "ok");
      await load(state.path);
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
      if (event.key === "Escape") closeModal();
    });
    cancel.addEventListener("click", () => closeModal());
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    input.focus();
    input.select();
  }

  async function confirmDelete(entry) {
    const card = openModalShell();
    card.appendChild(el("h2", {}, "确认删除"));
    // 目录要先知道里面有多少项，「N 项」才是真的。
    let count = 1;
    if (entry.type === "dir") {
      const listing = await api.fsList(target(), entry.path);
      if (listing.ok && listing.data && Array.isArray(listing.data.entries)) {
        count = listing.data.entries.length;
      }
    }
    const isRemote = state.kind === "remote";
    const message = el(
      "p",
      { className: "file-panel-modal-text" },
      isRemote
        ? `将从远程永久删除 ${entry.path}${entry.type === "dir" ? `（目录里现有 ${count} 项，远程只能删空目录）` : ""}`
        : `将永久删除 ${entry.path}${entry.type === "dir" ? `（${count} 项）` : ""}`,
    );
    card.appendChild(message);
    if (entry.type === "dir" && !isRemote) {
      const label = el("label", { className: "file-panel-check" });
      const box = el("input", { type: "checkbox", "data-role": "file-delete-recursive" });
      label.appendChild(box);
      label.appendChild(document.createTextNode(`连同目录里的 ${count} 项一起删除`));
      card.appendChild(label);
      card._recursiveBox = box;
    }
    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-danger" }, "永久删除");
    ok.setAttribute("data-role", "file-delete-confirm");
    ok.addEventListener("click", async () => {
      const recursive = Boolean(card._recursiveBox && card._recursiveBox.checked);
      const result = await api.fsDelete(target(), entry.path, recursive);
      if (!result.ok) {
        onNotice(result.userText || "删除失败。", "error");
        closeModal();
        return;
      }
      closeModal();
      onNotice(`已删除 ${entry.name}`, "ok");
      await load(state.path, { keepSelection: true });
    });
    cancel.addEventListener("click", () => closeModal());
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    // 默认焦点在取消上（危险操作不能靠误回车触发）。
    cancel.focus();
  }

  async function downloadFile(entry) {
    const url = api.fsDownloadUrl(target(), entry.path);
    try {
      const headers = api.fsAuthHeader();
      const response = await fetch(url, { headers, credentials: "omit" });
      if (!response.ok) {
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        onNotice(
          (body && body.userText) || `下载失败（HTTP ${response.status}）。`,
          "error",
        );
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = entry.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
      onNotice(`已下载 ${entry.name}（${formatSize(blob.size)}）`, "ok");
    } catch (err) {
      onNotice(`下载失败：${err && err.message ? err.message : "网络错误"}`, "error");
    }
  }

  /* ---------------------------- 上传 ---------------------------- */

  function renderUploads() {
    if (!uploadHost) return;
    uploadHost.textContent = "";
    if (state.uploads.length === 0) {
      uploadHost.hidden = true;
      return;
    }
    uploadHost.hidden = false;
    for (const item of state.uploads) {
      const row = el("div", { className: "file-panel-upload", "data-role": "file-upload-row", "data-state": item.state });
      const name = el("span", { className: "file-panel-upload-name" }, item.name);
      row.appendChild(name);
      const bar = el("span", { className: "file-panel-upload-bar" });
      const fill = el("i");
      fill.style.width = `${Math.round(item.percent * 100)}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
      const pct = el(
        "span",
        { className: "file-panel-upload-pct" },
        item.state === "done" ? "已写入" : item.state === "error" ? "失败" : `${Math.round(item.percent * 100)}%`,
      );
      row.appendChild(pct);
      uploadHost.appendChild(row);
    }
  }

  function uploadFiles(files) {
    if (!files || files.length === 0) return;
    const dir = state.path;
    if (!dir) {
      onNotice("先选一个目录再上传。", "warn");
      return;
    }
    for (const file of files) {
      void uploadOne(file, dir);
    }
  }

  function uploadOne(file, dir) {
    const item = { name: file.name, percent: 0, state: "uploading" };
    state.uploads.push(item);
    renderUploads();
    const { url, token } = api.fsUploadEndpoint(target(), dir);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("x-magpie-term-token", token);
    xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        item.percent = Math.min(0.99, event.loaded / event.total);
        renderUploads();
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        item.percent = 1;
        item.state = "done";
        renderUploads();
        onNotice(`已上传 ${file.name}`, "ok");
        void load(state.path, { keepSelection: true });
        setTimeout(() => {
          state.uploads = state.uploads.filter((row) => row !== item);
          renderUploads();
        }, 4000);
        return;
      }
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      item.state = "error";
      renderUploads();
      onNotice((body && body.userText) || `上传失败（HTTP ${xhr.status}）。`, "error");
    });
    xhr.addEventListener("error", () => {
      item.state = "error";
      renderUploads();
      onNotice(`上传失败：连不上本地服务。`, "error");
    });
    xhr.send(file);
  }

  /* ---------------------------- 工具栏动作 ---------------------------- */

  async function newDirectory() {
    if (!state.path) return;
    const card = openModalShell();
    card.setAttribute("data-tone", "neutral");
    card.appendChild(el("h2", {}, "新建文件夹"));
    card.appendChild(el("p", { className: "file-panel-modal-text" }, state.path));
    const input = el("input", { type: "text", className: "file-panel-input", "data-role": "file-newdir-input" });
    input.value = "新建文件夹";
    card.appendChild(input);
    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "创建");
    const submit = async () => {
      const name = input.value.trim();
      if (!name) {
        closeModal();
        return;
      }
      const result = await api.fsMkdir(target(), joinPath(state.path, name));
      if (!result.ok) {
        onNotice(result.userText || "新建文件夹失败。", "error");
        return;
      }
      closeModal();
      onNotice(`已创建文件夹 ${name}`, "ok");
      await load(state.path);
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
      if (event.key === "Escape") closeModal();
    });
    cancel.addEventListener("click", () => closeModal());
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    input.focus();
    input.select();
  }

  async function newFile() {
    if (!state.path) return;
    const card = openModalShell();
    card.setAttribute("data-tone", "neutral");
    card.appendChild(el("h2", {}, "新建文件"));
    card.appendChild(el("p", { className: "file-panel-modal-text" }, state.path));
    const input = el("input", { type: "text", className: "file-panel-input", "data-role": "file-newfile-input" });
    input.value = "新建文件.txt";
    card.appendChild(input);
    const actions = el("div", { className: "file-panel-modal-actions" });
    const cancel = el("button", { type: "button", className: "file-panel-btn" }, "取消");
    const ok = el("button", { type: "button", className: "file-panel-btn file-panel-btn-primary" }, "创建");
    const submit = async () => {
      const name = input.value.trim();
      if (!name) {
        closeModal();
        return;
      }
      const result = await api.fsNewFile(target(), joinPath(state.path, name));
      if (!result.ok) {
        onNotice(result.userText || "新建文件失败。", "error");
        return;
      }
      closeModal();
      onNotice(`已创建 ${name}`, "ok");
      await load(state.path);
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
      if (event.key === "Escape") closeModal();
    });
    cancel.addEventListener("click", () => closeModal());
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    input.focus();
    input.select();
  }

  /* ---------------------------- 骨架 ---------------------------- */

  function build() {
    root = host;
    root.textContent = "";
    root.className = "file-panel";
    root.setAttribute("data-role", "file-panel");

    // 拖拽把手（常显；分界线与内投影在 CSS 上由 .file-panel 提供）。
    const grip = el("div", {
      className: "file-panel-grip",
      "data-role": "file-panel-grow",
      role: "separator",
      "aria-orientation": "horizontal",
      "aria-valuemin": String(MIN_HEIGHT),
      "aria-valuemax": String(MAX_HEIGHT),
      title: "拖动调整文件面板高度（150–520px）",
    });
    root.appendChild(grip);

    toolbar = el("div", { className: "file-panel-toolbar" });

    const up = el("button", {
      type: "button",
      className: "file-panel-icon-btn",
      title: "上一级",
      "data-role": "file-panel-up",
    }, "↑");
    up.addEventListener("click", () => {
      if (!state.parent) return;
      void enterDirectory(state.parent);
    });
    toolbar.appendChild(up);

    const title = el("span", { className: "file-panel-title" }, "文件");
    toolbar.appendChild(title);

    pathInput = el("input", {
      type: "text",
      className: "file-panel-path",
      "data-role": "file-panel-path",
      "aria-label": "当前路径",
      spellcheck: "false",
    });
    pathInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const value = pathInput.value.trim();
      if (!value) return;
      state.manualPath = true;
      void load(value).then(renderFollowButton);
    });
    pathInput.addEventListener("blur", () => {
      // 编辑后没回车就失焦：回填真实路径，不偷偷跳目录。
      if (pathInput.value !== (state.path || "")) pathInput.value = state.path || "";
    });
    toolbar.appendChild(pathInput);

    followButton = el("button", {
      type: "button",
      className: "file-panel-btn file-panel-btn-quiet",
      "data-role": "file-panel-follow",
      hidden: true,
    }, "回到终端目录");
    followButton.addEventListener("click", () => {
      state.manualPath = false;
      renderFollowButton();
      if (state.termCwd) void load(state.termCwd);
    });
    toolbar.appendChild(followButton);

    const tools = el("div", { className: "file-panel-tools" });

    const refresh = el("button", {
      type: "button",
      className: "file-panel-btn file-panel-btn-quiet",
      "data-role": "file-panel-refresh",
      title: "刷新（F5）",
    }, "刷新");
    refresh.addEventListener("click", () => void load(state.path));
    tools.appendChild(refresh);

    const newdir = el("button", {
      type: "button",
      className: "file-panel-btn file-panel-btn-quiet",
      "data-role": "file-panel-newdir",
      title: "新建文件夹",
    }, "新建文件夹");
    newdir.addEventListener("click", () => void newDirectory());
    tools.appendChild(newdir);

    const newfile = el("button", {
      type: "button",
      className: "file-panel-btn file-panel-btn-quiet",
      "data-role": "file-panel-newfile",
      title: "新建文件",
    }, "新建文件");
    newfile.addEventListener("click", () => void newFile());
    tools.appendChild(newfile);

    const upload = el("button", {
      type: "button",
      className: "file-panel-btn file-panel-btn-accent",
      "data-role": "file-panel-upload",
      title: "上传文件（支持多选）",
    }, "上传");
    tools.appendChild(upload);

    // 文件选择框（必须有：拖拽只是锦上添花）。
    const picker = el("input", {
      type: "file",
      multiple: "multiple",
      "data-role": "file-panel-picker",
      className: "file-panel-picker",
      tabindex: "-1",
    });
    picker.addEventListener("change", () => {
      uploadFiles(picker.files);
      picker.value = "";
    });
    tools.appendChild(picker);
    upload.addEventListener("click", () => picker.click());

    const close = el("button", {
      type: "button",
      className: "file-panel-icon-btn",
      "data-role": "file-panel-close",
      title: "关闭文件面板",
      "aria-label": "关闭文件面板",
    }, "✕");
    close.addEventListener("click", () => setOpen(false));
    tools.appendChild(close);

    toolbar.appendChild(tools);
    root.appendChild(toolbar);

    uploadHost = el("div", { className: "file-panel-uploads", "data-role": "file-panel-uploads", hidden: true });
    root.appendChild(uploadHost);

    grid = el("div", { className: "file-panel-grid", "data-role": "file-panel-grid" });
    root.appendChild(grid);

    statusLine = el("div", { className: "file-panel-status", "data-role": "file-panel-status" });
    root.appendChild(statusLine);

    // 拖拽调高。
    let dragging = false;
    let startY = 0;
    let startHeight = 0;
    const onMove = (event) => {
      if (!dragging) return;
      const delta = startY - event.clientY;
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(startHeight + delta)));
      if (next !== state.height) applyHeight(next);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      root.removeAttribute("data-drag");
      storeHeight(state.height);
      window.dispatchEvent(new CustomEvent("magpie:file-panel-resize"));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dragging = true;
      startY = event.clientY;
      startHeight = state.height;
      root.setAttribute("data-drag", "true");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    grip.addEventListener("dblclick", () => {
      // 双击把手：在默认高与最大值之间切换（设计稿的「双击折叠」在此不适用，
      // 折叠改由 rail 开关负责 —— 见 REPORT 的待人类决策）。
      const next = state.height >= MAX_HEIGHT - 4 ? DEFAULT_HEIGHT : MAX_HEIGHT;
      applyHeight(next);
      storeHeight(next);
      window.dispatchEvent(new CustomEvent("magpie:file-panel-resize"));
    });

    // 拖放上传。
    root.addEventListener("dragover", (event) => {
      event.preventDefault();
      root.setAttribute("data-drop", "true");
    });
    root.addEventListener("dragleave", () => root.removeAttribute("data-drop"));
    root.addEventListener("drop", (event) => {
      event.preventDefault();
      root.removeAttribute("data-drop");
      if (event.dataTransfer && event.dataTransfer.files) uploadFiles(event.dataTransfer.files);
    });
  }

  /* ---------------------------- 会话绑定 ---------------------------- */

  function bindSession(session) {
    if (!session) {
      state.sessionId = null;
      state.kind = "local";
      state.hostId = null;
      state.termCwd = null;
      state.manualPath = false;
      return false;
    }
    const changed =
      session.id !== state.sessionId ||
      session.kind !== state.kind ||
      (session.hostId || null) !== state.hostId;
    state.sessionId = session.id;
    state.kind = session.kind === "remote" ? "remote" : "local";
    state.hostId = session.kind === "remote" ? session.hostId || null : null;
    state.termCwd = typeof session.cwd === "string" && session.cwd.length > 0 ? session.cwd : state.termCwd;
    if (changed) {
      // 换会话 = 重新跟随（用户上次的手动路径属于上一个会话）。
      state.manualPath = false;
      state.path = null;
      state.entries = [];
      state.selected.clear();
    }
    return changed;
  }

  async function syncToSession(session, { force = false } = {}) {
    const changed = bindSession(session);
    if (!state.open) return;
    if (!session) {
      renderGridMessage("当前没有终端标签：先开一个标签，文件面板会跟着它的目录走。");
      return;
    }
    if (changed || force) {
      const start = state.termCwd || (state.kind === "remote" ? "." : null);
      if (start) await load(start);
      else renderGridMessage("这个终端还没报告目录，等它出现第一个提示符。");
      renderFollowButton();
    }
  }

  /* ---------------------------- 对外接口 ---------------------------- */

  /** 打开 / 收起。收放都不改终端列数（只改高度，fit 由 terminal-view 自己做）。 */
  function setOpen(value) {
    state.open = Boolean(value);
    storeOpen(state.open);
    applyOpen();
    if (state.open) {
      const snapshot = store.getSnapshot();
      const active = snapshot.sessions.find((s) => s.id === snapshot.activeId) || null;
      void syncToSession(active, { force: true });
    }
  }

  return {
    init() {
      build();
      state.height = readStoredHeight();
      applyHeight(state.height);
      state.open = readStoredOpen();
      applyOpen();
      render();

      const railButton = document.querySelector('[data-role="rail-files"]');
      if (railButton) {
        railButton.addEventListener("click", () => setOpen(!state.open));
        railButton.setAttribute("aria-pressed", state.open ? "true" : "false");
      }

      // 会话切换 / cwd 变化都从 store 快照推；不新增上行帧。
      unsubscribe = store.subscribe((snapshot) => {
        const active = snapshot.sessions.find((s) => s.id === snapshot.activeId) || null;
        if (!active) {
          if (lastActiveId !== null) {
            lastActiveId = null;
            void syncToSession(null);
          }
          return;
        }
        if (active.id !== lastActiveId) {
          lastActiveId = active.id;
          void syncToSession(active);
          return;
        }
        // 同一个会话：cwd 变了就走跟随逻辑。
        if (active.cwd && active.cwd !== state.termCwd) {
          state.termCwd = active.cwd;
          void followTerminalCwd(active.cwd);
        }
      });
    },

    /** 打开 / 收起。 */
    setOpen,
    toggle() {
      setOpen(!state.open);
    },
    /** WS 帧 session.cwd 的入口（app.js 调）。 */
    onSessionCwd(id, cwd) {
      if (!state.open) {
        // 面板收着也记下来，重新打开时直接跳到最新目录。
        if (id === state.sessionId) state.termCwd = cwd;
        return;
      }
      if (id !== state.sessionId) return;
      void followTerminalCwd(cwd);
    },
    /** 暴露给验收探针 / 提交用。 */
    get state() {
      return {
        open: state.open,
        height: state.height,
        path: state.path,
        kind: state.kind,
        hostId: state.hostId,
        entries: state.entries.slice(),
        manualPath: state.manualPath,
      };
    },
    refresh() {
      if (state.open) void load(state.path);
    },
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
  };
}
