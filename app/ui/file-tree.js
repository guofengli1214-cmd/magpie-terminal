// 远程文件树（TASK-V2-B §2.6）：只读列表 + 进入目录 + 双击文件名插入到终端输入。
//
// 不挤压终端宽度：这个视图只负责把内容画进调用方给的容器，
// 容器本身是 `.hosts` 面板里的一个 tab，面板是覆盖层（见 components.css）。

function formatSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTime(mtime) {
  const n = Number(mtime);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function iconFor(type) {
  if (type === "dir") return "📁";
  if (type === "link") return "🔗";
  return "📄";
}

export default function createFileTree(elements) {
  const host = elements.host;
  const api = elements.api;
  // 双击文件 → 把完整路径交给调用方（只填不执行）。
  const onPickFile = typeof elements.onPickFile === "function" ? elements.onPickFile : () => {};
  const onNotice = typeof elements.onNotice === "function" ? elements.onNotice : () => {};

  let hostId = null;
  let currentPath = ".";
  let busy = false;

  function renderHeader(pathText) {
    const bar = document.createElement("div");
    bar.className = "file-tree-bar";

    const up = document.createElement("button");
    up.type = "button";
    up.setAttribute("data-role", "file-up");
    up.setAttribute("aria-label", "上一级");
    up.textContent = "↑";
    up.disabled = !hostId || pathText === ".." || pathText.endsWith("/");
    up.addEventListener("click", () => {
      if (!hostId) return;
      const trimmed = pathText.replace(/[\\/]+$/, "");
      if (!trimmed) return;
      const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      if (index <= 0) {
        // 已经是根（`/` 或 `C:`）：回到当前路径本身，不往上跳到主机外。
        void load(trimmed);
        return;
      }
      void load(trimmed.slice(0, index) || "/");
    });
    bar.appendChild(up);

    const pathLabel = document.createElement("span");
    pathLabel.setAttribute("data-role", "file-path");
    pathLabel.title = pathText;
    pathLabel.textContent = pathText || "-";
    bar.appendChild(pathLabel);

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.setAttribute("data-role", "file-refresh");
    refresh.setAttribute("aria-label", "刷新");
    refresh.textContent = "⟳";
    refresh.disabled = !hostId;
    refresh.addEventListener("click", () => void load(currentPath));
    bar.appendChild(refresh);

    return bar;
  }

  function renderList(entries) {
    const list = document.createElement("div");
    list.className = "file-tree-list";
    list.setAttribute("data-role", "file-list");

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "file-tree-empty";
      empty.textContent = "这个目录是空的。";
      list.appendChild(empty);
      return list;
    }

    for (const entry of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "file-tree-row";
      row.setAttribute("data-role", "file-row");
      row.setAttribute("data-type", entry.type);
      row.setAttribute("data-path", entry.path);
      row.title = `${entry.path}\n${entry.type} · ${formatSize(entry.size)} · ${formatTime(entry.mtime)}`;

      const icon = document.createElement("span");
      icon.className = "file-tree-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = iconFor(entry.type);
      row.appendChild(icon);

      const name = document.createElement("span");
      name.className = "file-tree-name";
      name.textContent = entry.name;
      row.appendChild(name);

      const meta = document.createElement("span");
      meta.className = "file-tree-meta";
      meta.textContent = entry.type === "dir" ? "" : formatSize(entry.size);
      row.appendChild(meta);

      row.addEventListener("click", () => {
        // 单击目录 = 进入；单击文件不做任何事（§2.6 要求双击才插入，
        // 「往终端里填东西」这种带副作用的动作不该被一次误点触发）。
        if (entry.type === "dir") void load(entry.path);
      });
      // 双击文件 = 只填路径不执行；目录双击不重复进入（单击已进入）。
      row.addEventListener("dblclick", (event) => {
        event.preventDefault();
        if (entry.type === "dir") return;
        onPickFile(entry.path, entry);
      });
      list.appendChild(row);
    }
    return list;
  }

  async function load(remotePath) {
    if (!hostId || busy) return;
    busy = true;
    const wanted = typeof remotePath === "string" && remotePath.length > 0 ? remotePath : currentPath;
    host.textContent = "";
    const loading = document.createElement("p");
    loading.className = "file-tree-empty";
    loading.textContent = "正在读取远程目录…";
    host.appendChild(loading);

    const result = await api.hostFiles(hostId, wanted);
    busy = false;
    if (!result.ok) {
      host.textContent = "";
      host.appendChild(renderHeader(currentPath));
      const error = document.createElement("p");
      error.className = "file-tree-empty";
      error.setAttribute("data-tone", "error");
      error.textContent = result.userText || `读取失败（${result.code}）`;
      host.appendChild(error);
      onNotice(result.userText || "列不出远程目录。", "warn");
      return;
    }

    const data = result.data || {};
    currentPath = typeof data.path === "string" && data.path.length > 0 ? data.path : wanted;
    host.textContent = "";
    host.appendChild(renderHeader(currentPath));
    host.appendChild(renderList(Array.isArray(data.entries) ? data.entries : []));
  }

  return {
    /** 绑定到某台主机；hostId 为空时清空视图。 */
    setHost(id) {
      hostId = typeof id === "string" && id.length > 0 ? id : null;
      currentPath = ".";
      host.textContent = "";
      if (!hostId) {
        const hint = document.createElement("p");
        hint.className = "file-tree-empty";
        hint.textContent = "先在「主机」里连一台，文件树才有内容。";
        host.appendChild(hint);
        return;
      }
      void load(".");
    },
    refresh() {
      if (!hostId) return;
      void load(currentPath);
    },
    get path() {
      return currentPath;
    },
    get hostId() {
      return hostId;
    },
  };
}
