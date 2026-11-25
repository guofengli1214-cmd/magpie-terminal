// 设置模态（TASK-V3-C §6.4）：自动执行档位 / 命令白名单 / 审阅模型 / 基础提示词 / 网关信息。
//
// 数据流：
//   打开 → GET /api/config + GET /api/models（并行）→ 初始化控件
//   保存 → PUT /api/config { autonomy, allowlist, reviewModel, basePrompt }
//        成功 → settings-status「已保存」+ 3 秒后淡出 + 关模态
//        失败 → settings-status 显示服务端 userText，**保留用户输入不清空**
//
// 服务端未就绪（D 卡没合入）时 PUT 会返回 UNKNOWN_FIELD/400：
// 这里照实显示，不静默吞掉，也不假装保存成功。
//
// data-role 名单（验收探针逐字用）：
//   settings-modal / autonomy-group / autonomy-option / allowlist-input /
//   allowlist-mode / allowlist-add / allowlist-list / allowlist-item /
//   allowlist-toggle / allowlist-remove / review-model-select / base-prompt /
//   gateway-info / settings-save / settings-cancel / settings-status
//   TASK-FIX17-G 新增：about-version / about-repository / about-install-kind /
//   update-check / update-status / update-howto / update-howto-text

const AUTONOMY_OPTIONS = [
  {
    value: "strict",
    title: "严格",
    desc: "只自动放行内置只读命令，其余全部要你确认（审阅照跑，只用于展示）。",
  },
  {
    value: "balanced",
    title: "平衡（默认）",
    desc: "审阅判定安全且可撤销的命令自动跑；其余要你确认。",
  },
  {
    value: "loose",
    title: "宽松",
    desc: "连可撤销的写操作（比如新建目录、复制到新路径）也自动跑；danger 仍然问你。",
  },
];

const DEFAULT_BASE_PROMPT_HINT =
  "你是一个内置在终端里的 AI 助手。你的服务对象是不太懂命令行的普通用户。你的工作是理解他想达成什么，然后自己动手在终端里把这件事做完，最后用他自己的语言告诉他结果。";

// TASK-V4-H §5.3：审阅是全档位强制执行的一步，设置页不再提供「关闭审阅」。
// 保留这个常量只为兼容老配置（reviewModel === "" 仍然能让 judge 一律确认）。
const REVIEW_SAME = "__same__";

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "className") node.className = value;
    else node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

export default function createSettingsPanel(elements) {
  const host = elements.host;
  const api = elements.api;
  const onClose = typeof elements.onClose === "function" ? elements.onClose : () => {};
  const onSaved = typeof elements.onSaved === "function" ? elements.onSaved : () => {};

  // 本地白名单副本：添加/启停/删除都先改这里，保存时一起 PUT。
  let allowlist = [];
  let models = [];
  let gateway = null;
  let opened = false;
  let backdrop = null;
  let statusTimer = null;
  let focusBefore = null;

  let autonomyGroup = null;
  let allowlistInput = null;
  let allowlistMode = null;
  let allowlistList = null;
  let reviewSelect = null;
  let basePromptInput = null;
  let gatewayInfo = null;
  let statusLine = null;
  let saveButton = null;
  let effectToggle = null;
  let showApprovalEffect = false;
  // TASK-FIX17-E：日志 block 的两个按钮与状态行（不是表单字段，不参与保存）。
  let logExportButton = null;
  let logClearButton = null;
  let logStatusLine = null;
  // TASK-FIX17-G：关于/更新 block。只读 + 手动检查，不做自动下载安装。
  let aboutVersion = null;
  let aboutRepository = null;
  let aboutInstallKind = null;
  let updateButton = null;
  let updateStatus = null;
  let howtoPre = null;
  let versionInfo = null;
  let updateBusy = false;

  /** 开关的可视/可读状态唯一同步点（默认关）。 */
  function setShowEffect(value) {
    showApprovalEffect = value === true;
    if (!effectToggle) return showApprovalEffect;
    effectToggle.setAttribute("aria-checked", showApprovalEffect ? "true" : "false");
    effectToggle.setAttribute("data-on", showApprovalEffect ? "true" : "false");
    // 立刻反映到确认卡（不必等保存）。
    const cb = typeof elements.onShowEffectChange === "function" ? elements.onShowEffectChange : null;
    if (cb) cb(showApprovalEffect);
    return showApprovalEffect;
  }

  /* ---------------- 状态行 ---------------- */

  function setStatus(text, tone) {
    if (!statusLine) return;
    statusLine.textContent = text || "";
    if (tone) statusLine.setAttribute("data-tone", tone);
    else statusLine.removeAttribute("data-tone");
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    if (text && tone === "ok") {
      statusTimer = setTimeout(() => {
        statusTimer = null;
        if (!statusLine) return;
        statusLine.setAttribute("data-fading", "true");
        setTimeout(() => {
          if (!statusLine) return;
          statusLine.textContent = "";
          statusLine.removeAttribute("data-tone");
          statusLine.removeAttribute("data-fading");
        }, 600);
      }, 3000);
    }
  }

  /* ---------------- 档位 ---------------- */

  function renderAutonomy(value) {
    autonomyGroup.textContent = "";
    for (const option of AUTONOMY_OPTIONS) {
      const card = el("button", {
        type: "button",
        "data-role": "autonomy-option",
        "data-value": option.value,
        "data-selected": option.value === value ? "true" : "false",
        "aria-pressed": option.value === value ? "true" : "false",
        className: "autonomy-card",
      });
      card.appendChild(el("span", { className: "autonomy-title" }, option.title));
      card.appendChild(el("span", { className: "autonomy-desc" }, option.desc));
      card.addEventListener("click", () => renderAutonomy(option.value));
      autonomyGroup.appendChild(card);
    }
  }

  function selectedAutonomy() {
    const picked = autonomyGroup.querySelector('[data-role="autonomy-option"][data-selected="true"]');
    return picked ? picked.getAttribute("data-value") : "balanced";
  }

  /* ---------------- 白名单 ---------------- */

  function renderAllowlist() {
    allowlistList.textContent = "";
    if (allowlist.length === 0) {
      allowlistList.appendChild(
        el("div", { className: "allowlist-empty", "data-role": "allowlist-empty" }, "还没有白名单条目。加一条以后，命中它的命令就不再问你。"),
      );
      return;
    }
    allowlist.forEach((entry, index) => {
      const item = el("div", {
        "data-role": "allowlist-item",
        "data-enabled": entry.enabled ? "true" : "false",
        "data-index": String(index),
        className: "allowlist-item",
      });
      const text = el("div", { className: "allowlist-text" });
      text.appendChild(el("code", { className: "allowlist-pattern" }, entry.pattern));
      text.appendChild(
        el("span", { className: "allowlist-mode-badge" }, entry.mode === "exact" ? "整条匹配" : "前缀匹配"),
      );
      item.appendChild(text);

      const actions = el("div", { className: "allowlist-actions" });
      const toggle = el(
        "button",
        { type: "button", "data-role": "allowlist-toggle", className: "allowlist-toggle" },
        entry.enabled ? "停用" : "启用",
      );
      toggle.addEventListener("click", () => {
        allowlist[index] = { ...allowlist[index], enabled: !allowlist[index].enabled };
        renderAllowlist();
      });
      const remove = el(
        "button",
        { type: "button", "data-role": "allowlist-remove", className: "allowlist-remove" },
        "删除",
      );
      remove.addEventListener("click", () => {
        allowlist.splice(index, 1);
        renderAllowlist();
      });
      actions.append(toggle, remove);
      item.appendChild(actions);
      allowlistList.appendChild(item);
    });
  }

  function addAllowlistEntry() {
    const pattern = allowlistInput.value.trim();
    if (!pattern) {
      setStatus("白名单不能是空的：先写一条命令前缀或整条命令。", "error");
      return;
    }
    if (pattern.includes("\n") || pattern.length > 500) {
      setStatus("白名单每条要 1–500 字符、不能有换行。", "error");
      return;
    }
    if (allowlist.length >= 200) {
      setStatus("白名单最多 200 条。", "error");
      return;
    }
    const mode = allowlistMode.value === "exact" ? "exact" : "prefix";
    allowlist.push({ pattern, mode, enabled: true });
    allowlistInput.value = "";
    renderAllowlist();
    setStatus("", null);
  }

  /* ---------------- 审阅模型 ---------------- */

  function renderReviewModels(current) {
    reviewSelect.textContent = "";
    reviewSelect.appendChild(el("option", { value: REVIEW_SAME }, "与对话模型相同"));
    for (const model of models) {
      reviewSelect.appendChild(el("option", { value: model.id }, model.label || model.id));
    }
    // current: null = 与对话模型相同；其它 = 具体模型 id。
    // （旧配置里的 ""（关闭审阅）不再可选：按「与对话模型相同」显示，保存时写 null。）
    let wanted = REVIEW_SAME;
    if (typeof current === "string" && current.length > 0) {
      wanted = models.some((model) => model.id === current) ? current : REVIEW_SAME;
    }
    reviewSelect.value = wanted;
  }

  function selectedReviewModel() {
    const value = reviewSelect.value;
    if (value === REVIEW_SAME) return null;
    return value;
  }

  /* ---------------- 网关信息 ---------------- */

  function renderGateway() {
    gatewayInfo.textContent = "";
    if (!gateway) {
      gatewayInfo.appendChild(el("div", {}, "还没拿到网关信息（点开设置时会自动拉一次）。"));
      return;
    }
    const baseUrl = gateway.baseUrl || "未知";
    const reachable = gateway.reachable === true ? "可达" : "不可达";
    const count = Array.isArray(models) ? models.length : 0;
    gatewayInfo.appendChild(el("div", {}, `地址：${baseUrl}`));
    gatewayInfo.appendChild(el("div", {}, `可达性：${reachable}`));
    gatewayInfo.appendChild(el("div", {}, `模型数：${count}`));
    if (typeof gateway.durationMs === "number") {
      gatewayInfo.appendChild(el("div", {}, `探测耗时：${gateway.durationMs}ms`));
    }
  }

  /* ---------------- 日志（TASK-FIX17-E R4） ---------------- */

  /** 把字节数写成人类可读（不足 1KB 就写字节，避免显示「0.0 KB」）。 */
  function formatBytes(bytes) {
    const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** `2026-11-25T00:41:02.512Z` → `11-25 08:41:02`（本地时区，日志给人看）。 */
  function formatMtime(iso) {
    if (typeof iso !== "string" || iso.length === 0) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    const pad = (value) => String(value).padStart(2, "0");
    return (
      `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  function renderLogStatus(status) {
    if (!logStatusLine) return;
    if (!status) {
      logStatusLine.textContent = "日志状态读取失败（不影响终端使用）。";
      return;
    }
    const parts = [`当前 ${formatBytes(status.totalBytes ?? status.bytes)}`];
    const when = formatMtime(status.mtime);
    if (when) parts.push(`最后写入 ${when}`);
    else parts.push("还没有写入过");
    if (status.writable === false) parts.push("（写盘不可用，只在宿主日志里）");
    logStatusLine.textContent = parts.join(" · ");
  }

  async function refreshLogStatus() {
    if (!api || typeof api.logsStatus !== "function") return null;
    const result = await api.logsStatus();
    if (!result.ok) {
      renderLogStatus(null);
      return null;
    }
    renderLogStatus(result.data || null);
    return result.data || null;
  }

  /**
   * 导出日志。
   *
   * 走「先 fetch 拿 blob、再 `<a download>` 触发」而不是把 URL 丢给
   * `location.href`：导出接口要带 token 头，Navigation 请求发不了自定义头，
   * 直接跳过去只会得到一个 403 页面（同样模式见 file-panel 的下载）。
   */
  async function exportLogs() {
    if (!api || typeof api.logsExport !== "function") {
      setStatus("这个版本的本地服务不支持导出日志。", "error");
      return;
    }
    if (logExportButton) logExportButton.disabled = true;
    setStatus("正在导出日志…", "info");
    const result = await api.logsExport();
    if (logExportButton) logExportButton.disabled = false;
    if (!result.ok) {
      setStatus(result.userText || "导出失败", "error");
      return;
    }
    try {
      const blob = await result.response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = el("a", { href: objectUrl, download: result.filename });
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // 30 秒后才释放：太早释放会让某些浏览器取消下载。
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
      setStatus(`已导出 ${result.filename}（${formatBytes(blob.size)}）`, "ok");
    } catch (err) {
      setStatus(`导出失败：${err && err.message ? err.message : "下载未能开始"}`, "error");
    }
    await refreshLogStatus();
  }

  /** 清空日志。二次确认：日志删了就找不回来（排查现场通常只有一次机会）。 */
  async function clearLogs() {
    if (!api || typeof api.logsClear !== "function") {
      setStatus("这个版本的本地服务不支持清空日志。", "error");
      return;
    }
    const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
      ? true
      : window.confirm("清空本插件的日志文件？清空后无法恢复（导出过的副本不受影响）。");
    if (!confirmed) return;
    if (logClearButton) logClearButton.disabled = true;
    setStatus("正在清空日志…", "info");
    const result = await api.logsClear();
    if (logClearButton) logClearButton.disabled = false;
    if (!result.ok) {
      setStatus(result.userText || "清空失败", "error");
      return;
    }
    setStatus("日志已清空", "ok");
    await refreshLogStatus();
  }

  /* ---------------- 关于 / 更新（TASK-FIX17-G R2） ---------------- */

  /** 按安装方式给「如何更新」纯文本（不联网）。 */
  function buildHowtoText(kind, name) {
    const pluginName = typeof name === "string" && name.length > 0 ? name : "magpie-terminal";
    if (kind === "local-path") {
      // AC5：必须含 git pull 与重启提示，且这就是本机当前的装法。
      return [
        "这个插件是本地目录安装，git pull 后重启 magpie 即可。",
        "",
        "cd <插件目录>",
        "git pull",
        "# 然后完全退出并重新打开 magpie",
      ].join("\n");
    }
    if (kind === "registry") {
      return [
        "在 magpie 插件页点更新，或运行：",
        "",
        `magpie plugin update ${pluginName}`,
      ].join("\n");
    }
    return [
      "无法判断安装方式。两种可能都列出来：",
      "",
      "# 本地目录安装",
      "cd <插件目录> && git pull",
      "# 然后完全退出并重新打开 magpie",
      "",
      "# 版本包安装（registry）",
      `magpie plugin update ${pluginName}`,
    ].join("\n");
  }

  /** 更新结果行：支持「一句话 + 一个链接」，tone 与设置页状态行同一套语义。 */
  function setUpdateStatus(text, tone, link) {
    if (!updateStatus) return;
    updateStatus.textContent = "";
    if (typeof text === "string" && text.length > 0) updateStatus.append(text);
    if (link && typeof link.url === "string" && link.url.length > 0) {
      if (updateStatus.textContent.length > 0) updateStatus.append(" ");
      updateStatus.append(
        el("a", { href: link.url, target: "_blank", rel: "noopener noreferrer" }, link.text || "查看发布页"),
      );
    }
    if (tone) updateStatus.setAttribute("data-tone", tone);
    else updateStatus.removeAttribute("data-tone");
  }

  function updateSupported() {
    return Boolean(
      versionInfo &&
        versionInfo.updateSupported === true &&
        typeof versionInfo.repository === "string" &&
        versionInfo.repository.length > 0,
    );
  }

  function syncUpdateButton() {
    if (!updateButton) return;
    const supported = updateSupported();
    updateButton.disabled = !supported || updateBusy;
    updateButton.textContent = updateBusy ? "检查中…" : "检查更新";
    if (supported) updateButton.title = "";
    else {
      updateButton.title =
        versionInfo && typeof versionInfo.repository === "string" && versionInfo.repository.length > 0
          ? "当前安装方式无法检查更新"
          : "未配置仓库地址，无法检查更新";
    }
  }

  /** 渲染 /api/version 的结果。`info` 为 null 表示接口失败。 */
  function renderAbout(info) {
    versionInfo = info && typeof info === "object" ? info : null;
    if (!aboutVersion || !aboutRepository || !aboutInstallKind || !howtoPre) return;

    if (!versionInfo) {
      aboutVersion.textContent = "当前版本：读取失败";
      aboutRepository.textContent = "仓库：读取失败";
      aboutInstallKind.textContent = "安装方式：无法判断（版本信息读取失败）。";
      howtoPre.textContent = buildHowtoText("unknown", "magpie-terminal");
      setUpdateStatus("版本信息读取失败，暂时无法检查更新。", "error");
      syncUpdateButton();
      return;
    }

    const version = typeof versionInfo.version === "string" && versionInfo.version.length > 0
      ? versionInfo.version
      : "未知";
    const repository = typeof versionInfo.repository === "string" ? versionInfo.repository : null;
    const kind = typeof versionInfo.installKind === "string" ? versionInfo.installKind : "unknown";
    const name = typeof versionInfo.name === "string" ? versionInfo.name : "magpie-terminal";

    aboutVersion.textContent = `当前版本：${version}`;
    aboutRepository.textContent = "";
    aboutRepository.append("仓库：");
    if (repository) {
      aboutRepository.append(
        el("a", { href: repository, target: "_blank", rel: "noopener noreferrer" }, repository),
      );
    } else {
      aboutRepository.append(el("span", { className: "settings-about-muted" }, "未配置仓库地址"));
    }

    // 安装方式用一句话人话解释；「如何更新」的折叠说明再给可执行命令。
    if (kind === "local-path") {
      aboutInstallKind.textContent =
        "安装方式：本地路径。本地目录安装需要在仓库目录里 git pull 后重启 magpie。";
    } else if (kind === "registry") {
      aboutInstallKind.textContent =
        `安装方式：版本包（registry）。可以在 magpie 插件页点更新，或运行 magpie plugin update ${name}。`;
    } else {
      aboutInstallKind.textContent = "安装方式：未知。读不到 magpie 的 plugins.json，无法判断。";
    }

    howtoPre.textContent = buildHowtoText(kind, name);

    if (!updateSupported()) {
      setUpdateStatus(
        repository ? "当前安装方式无法检查更新。" : "未配置仓库地址，无法检查更新。",
        "info",
      );
    } else {
      setUpdateStatus("点「检查更新」向 GitHub 查询最近的发布版本。", "info");
    }
    syncUpdateButton();
  }

  /** 手动检查更新：失败照实显示原因，绝不把「查询失败」写成「已是最新」。 */
  async function checkUpdate() {
    if (updateBusy || !updateSupported()) return;
    if (!api || typeof api.updateCheck !== "function") {
      setUpdateStatus("这个版本的本地服务不支持检查更新。", "error");
      return;
    }
    updateBusy = true;
    syncUpdateButton();
    setUpdateStatus("正在向 GitHub 查询…", "info");

    let result;
    try {
      result = await api.updateCheck();
    } catch (err) {
      result = { ok: false, userText: err && err.message ? err.message : "网络错误" };
    }

    updateBusy = false;
    syncUpdateButton();

    if (!result || !result.ok) {
      const reason =
        result && (result.userText || result.code) ? result.userText || result.code : "未知原因";
      setUpdateStatus(`检查失败：${reason}`, "error");
      return;
    }

    const data = result.data && typeof result.data === "object" ? result.data : {};
    const current = typeof data.current === "string" && data.current.length > 0
      ? data.current
      : versionInfo && versionInfo.version
        ? versionInfo.version
        : "未知";

    if (typeof data.error === "string" && data.error.length > 0) {
      setUpdateStatus(`检查失败：${data.error}`, "error");
      return;
    }
    if (data.hasUpdate === true) {
      setUpdateStatus(`发现新版本 ${data.latest || "?"}（当前 ${current}）`, "ok", {
        url: data.url,
        text: "查看发布页",
      });
      return;
    }
    if (typeof data.note === "string" && data.note.length > 0) {
      setUpdateStatus(data.note, "info");
      return;
    }
    setUpdateStatus(`已是最新版本（${current}）`, "ok");
  }

  /* ---------------- 结构 ---------------- */

  function build() {
    backdrop = el("div", { "data-role": "settings-backdrop", className: "settings-backdrop" });
    const modal = el("div", {
      "data-role": "settings-modal",
      className: "settings-modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "设置",
      tabindex: "-1",
    });
    backdrop.appendChild(modal);

    const head = el("div", { className: "settings-head" });
    head.appendChild(el("h2", { className: "settings-title" }, "设置"));
    // 关闭按钮不使用 ai-close（那个名字留给抽屉），避免探针选到两个同名元素。
    const close = el("button", { type: "button", className: "settings-x", title: "关闭设置", "aria-label": "关闭设置" }, "×");
    close.addEventListener("click", () => closeModal());
    head.appendChild(close);
    modal.appendChild(head);

    const body = el("div", { className: "settings-body" });

    /* 1. 自动执行档位 */
    const blockAutonomy = el("section", { className: "settings-block", "data-block": "autonomy" });
    blockAutonomy.appendChild(el("h3", { className: "settings-block-title" }, "自动执行档位"));
    blockAutonomy.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "决定哪些命令 AI 可以直接动手、哪些要先问你。改了以后新任务立刻生效。",
      ),
    );
    autonomyGroup = el("div", { "data-role": "autonomy-group", className: "autonomy-group" });
    blockAutonomy.appendChild(autonomyGroup);
    body.appendChild(blockAutonomy);

    /* 2. 命令白名单 */
    const blockAllow = el("section", { className: "settings-block", "data-block": "allowlist" });
    blockAllow.appendChild(el("h3", { className: "settings-block-title" }, "命令白名单"));
    blockAllow.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "加进来的命令不再问你。前缀匹配：写 mkdir 就命中「mkdir a b」；整条匹配：必须一模一样。",
      ),
    );
    const addRow = el("div", { className: "allowlist-add-row" });
    allowlistInput = el("input", {
      type: "text",
      "data-role": "allowlist-input",
      placeholder: "比如 mkdir 或 npm test",
      autocomplete: "off",
      spellcheck: "false",
      maxlength: "500",
    });
    allowlistMode = el("select", { "data-role": "allowlist-mode", "aria-label": "匹配方式" });
    allowlistMode.appendChild(el("option", { value: "prefix" }, "前缀匹配"));
    allowlistMode.appendChild(el("option", { value: "exact" }, "完全相同"));
    const addButton = el("button", { type: "button", "data-role": "allowlist-add" }, "添加");
    addButton.addEventListener("click", () => addAllowlistEntry());
    allowlistInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      addAllowlistEntry();
    });
    addRow.append(allowlistInput, allowlistMode, addButton);
    blockAllow.appendChild(addRow);
    allowlistList = el("div", { "data-role": "allowlist-list", className: "allowlist-list" });
    blockAllow.appendChild(allowlistList);
    body.appendChild(blockAllow);

    /* 3. 审阅模型（TASK-V4-H §5.3：没有「关闭审阅」，只有选哪家模型） */
    const blockReview = el("section", { className: "settings-block", "data-block": "review" });
    blockReview.appendChild(el("h3", { className: "settings-block-title" }, "审阅模型"));
    blockReview.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "复审每条将被执行的命令，返回 risk / effect / confirmWhy / reversible。任何档位下都会先由它评审，档位只决定评审结果怎么用。",
      ),
    );
    reviewSelect = el("select", { "data-role": "review-model-select", "aria-label": "审阅模型" });
    blockReview.appendChild(reviewSelect);
    blockReview.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "审阅模型不可用（超过 8 秒 / 报错）时，所有命令都要求你确认；降级不会跳过审阅，也不会放行任何命令。",
      ),
    );
    body.appendChild(blockReview);

    /* 3.5 确认卡（TASK-V4-H §5.6 / §6：setting-show-effect） */
    const blockEffect = el("section", { className: "settings-block", "data-block": "effect" });
    blockEffect.appendChild(el("h3", { className: "settings-block-title" }, "确认卡"));
    const effectRow = el("div", { className: "settings-row" });
    const effectMain = el("span", { className: "settings-row-main" });
    effectMain.appendChild(el("b", {}, "在确认卡上常显 AI 的效果评估"));
    effectMain.appendChild(
      el(
        "small",
        {},
        "默认关。开启后确认卡在按钮上方多一行「执行后会发生什么：…」，不悬停也能读到影响。",
      ),
    );
    effectToggle = el("button", {
      type: "button",
      "data-role": "setting-show-effect",
      className: "settings-switch",
      role: "switch",
      "aria-checked": "false",
      "aria-label": "在确认卡上常显 AI 的效果评估",
    });
    effectToggle.appendChild(el("span", { className: "switch-knob", "aria-hidden": "true" }));
    effectToggle.addEventListener("click", () => {
      const next = effectToggle.getAttribute("aria-checked") !== "true";
      setShowEffect(next);
    });
    effectRow.append(effectMain, effectToggle);
    blockEffect.appendChild(effectRow);
    blockEffect.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "角标四态：绿=已审可放行 / 琥珀=需要注意 / 红=危险 / 灰=未审阅（审阅不可用）。鼠标悬停或键盘聚焦可看两段解释。",
      ),
    );
    body.appendChild(blockEffect);

    /* 4. 基础提示词 */
    const blockPrompt = el("section", { className: "settings-block", "data-block": "prompt" });
    blockPrompt.appendChild(el("h3", { className: "settings-block-title" }, "基础提示词"));
    blockPrompt.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "让 AI 扮演什么角色。留空就用内置默认（下面的灰字就是默认值）。",
      ),
    );
    basePromptInput = el("textarea", {
      "data-role": "base-prompt",
      rows: "5",
      maxlength: "8000",
      placeholder: DEFAULT_BASE_PROMPT_HINT,
      "aria-label": "基础提示词",
    });
    blockPrompt.appendChild(basePromptInput);
    body.appendChild(blockPrompt);

    /* 5. AI 网关 */
    const blockGateway = el("section", { className: "settings-block", "data-block": "gateway" });
    blockGateway.appendChild(el("h3", { className: "settings-block-title" }, "AI 网关"));
    blockGateway.appendChild(
      el("p", { className: "settings-block-hint" }, "只读信息：AI 从哪个网关取模型。"),
    );
    gatewayInfo = el("div", { "data-role": "gateway-info", className: "gateway-info" });
    blockGateway.appendChild(gatewayInfo);
    body.appendChild(blockGateway);

    /* 6. 日志（TASK-FIX17-E R4）：导出 / 清空 / 状态。
       放在末位：前面全是「决定 AI 怎么动」的设置，日志是事后排查用的，
       不该抢在第一屏。两个按钮都不是表单字段，与「保存」无关，
       所以切完这个 block 直接点取消退出也不会丢掉什么。 */
    const blockLogs = el("section", { className: "settings-block", "data-block": "logs" });
    blockLogs.appendChild(el("h3", { className: "settings-block-title" }, "日志"));
    blockLogs.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "日志只保存在本机。导出前会自动去掉 token、密码与完整路径，不含你在终端里输入的内容。",
      ),
    );
    const logRow = el("div", { className: "settings-row settings-log-actions" });
    logExportButton = el(
      "button",
      { type: "button", "data-role": "logs-export" },
      "导出日志",
    );
    logExportButton.addEventListener("click", () => void exportLogs());
    logClearButton = el(
      "button",
      { type: "button", "data-role": "logs-clear" },
      "清空日志",
    );
    logClearButton.addEventListener("click", () => void clearLogs());
    logRow.append(logExportButton, logClearButton);
    blockLogs.appendChild(logRow);
    logStatusLine = el(
      "p",
      { className: "settings-block-hint", "data-role": "logs-status" },
      "正在读取日志状态…",
    );
    blockLogs.appendChild(logStatusLine);
    body.appendChild(blockLogs);

    /* 8. 关于 / 更新（TASK-FIX17-G R2）：版本、仓库、安装方式、手动检查更新。
       放在最后：前面是日常设置，这一块只在「想升级 / 报版本号」时看。
       不提供自动下载安装：magpie 没有这个 API，写了只会把 plugins.json 弄脏。 */
    const blockAbout = el("section", { className: "settings-block", "data-block": "about" });
    blockAbout.appendChild(el("h3", { className: "settings-block-title" }, "关于 / 更新"));
    blockAbout.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "只显示当前这份插件是怎么装的；检查更新只向 GitHub 查询发布版本，不会自动下载或安装。",
      ),
    );
    aboutVersion = el(
      "div",
      { className: "settings-about-row", "data-role": "about-version" },
      "当前版本：读取中…",
    );
    aboutRepository = el(
      "div",
      { className: "settings-about-row", "data-role": "about-repository" },
      "仓库：读取中…",
    );
    aboutInstallKind = el(
      "p",
      { className: "settings-block-hint", "data-role": "about-install-kind" },
      "安装方式：读取中…",
    );
    blockAbout.append(aboutVersion, aboutRepository, aboutInstallKind);

    const updateRow = el("div", { className: "settings-row settings-update-row" });
    updateButton = el("button", { type: "button", "data-role": "update-check" }, "检查更新");
    updateButton.disabled = true;
    updateButton.addEventListener("click", () => void checkUpdate());
    updateStatus = el("span", {
      "data-role": "update-status",
      role: "status",
      "aria-live": "polite",
    });
    updateRow.append(updateButton, updateStatus);
    blockAbout.appendChild(updateRow);

    const howto = el("details", { className: "settings-howto", "data-role": "update-howto" });
    howto.appendChild(el("summary", {}, "如何更新"));
    howtoPre = el("pre", { className: "settings-howto-text", "data-role": "update-howto-text" });
    howto.appendChild(howtoPre);
    blockAbout.appendChild(howto);
    body.appendChild(blockAbout);

    modal.appendChild(body);

    const foot = el("div", { className: "settings-foot" });
    statusLine = el("span", { "data-role": "settings-status", className: "settings-status" });
    foot.appendChild(statusLine);
    const cancel = el("button", { type: "button", "data-role": "settings-cancel" }, "取消");
    cancel.addEventListener("click", () => closeModal());
    saveButton = el("button", { type: "button", "data-role": "settings-save", className: "settings-save" }, "保存");
    saveButton.addEventListener("click", () => void save());
    foot.append(cancel, saveButton);
    modal.appendChild(foot);

    host.textContent = "";
    host.appendChild(backdrop);

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal();
    });
    modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = modal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  /* ---------------- 打开 / 关闭 ---------------- */

  async function load() {
    setStatus("正在读取当前设置…", "info");
    const versionPromise =
      api && typeof api.version === "function"
        ? api.version()
        : Promise.resolve({ ok: false, code: "UNSUPPORTED", userText: "这个版本的本地服务不支持版本信息" });
    const [configResult, modelsResult, versionResult] = await Promise.all([
      api.config(),
      api.models(),
      versionPromise,
    ]);
    // 关于/更新块与 config 无关：即使 config 读不到也要如实显示版本与更新指引。
    renderAbout(versionResult && versionResult.ok ? versionResult.data || null : null);
    if (modelsResult.ok) {
      const payload = modelsResult.data || {};
      gateway = payload.gateway || null;
      models = Array.isArray(payload.models) ? payload.models : [];
    } else {
      gateway = null;
      models = [];
    }
    if (!configResult.ok) {
      setStatus(`${configResult.userText}（${configResult.code}）`, "error");
      renderAutonomy("balanced");
      allowlist = [];
      renderAllowlist();
      renderReviewModels(null);
      basePromptInput.value = "";
      setShowEffect(false);
      renderGateway();
      // 配置读不到也要把日志状态拉回来：这两条链路互不依赖（一个是 config.json，
      // 一个是日志文件），一起失败时用户至少还能导出日志去查为什么。
      await refreshLogStatus();
      return;
    }
    const config = configResult.data || {};
    renderAutonomy(["strict", "balanced", "loose"].includes(config.autonomy) ? config.autonomy : "balanced");
    allowlist = Array.isArray(config.allowlist)
      ? config.allowlist.map((entry) => ({
          pattern: String(entry.pattern || ""),
          mode: entry.mode === "exact" ? "exact" : "prefix",
          enabled: entry.enabled !== false,
        }))
      : [];
    renderAllowlist();
    renderReviewModels(typeof config.reviewModel === "string" ? config.reviewModel : null);
    basePromptInput.value = typeof config.basePrompt === "string" ? config.basePrompt : "";
    setShowEffect(config.showApprovalEffect === true);
    renderGateway();
    setStatus("", null);
    // 日志 block 的状态单独拉：它读的是文件 stat，和 config/models 无关。
    await refreshLogStatus();
  }

  async function save() {
    if (saveButton) saveButton.disabled = true;
    setStatus("正在保存…", "info");
    const patch = {
      autonomy: selectedAutonomy(),
      allowlist: allowlist.map((entry) => ({
        pattern: entry.pattern,
        mode: entry.mode,
        enabled: entry.enabled !== false,
      })),
      reviewModel: selectedReviewModel(),
      basePrompt: basePromptInput.value.trim().length > 0 ? basePromptInput.value : null,
      showApprovalEffect,
    };
    const result = await api.saveConfig(patch);
    if (saveButton) saveButton.disabled = false;
    if (!result.ok) {
      // 服务端不认识这些字段（TASK-V3-D 未合入）或校验失败：照实说，别清空用户输入。
      const hint =
        result.code === "UNKNOWN_FIELD" || result.code === "HTTP_400"
          ? "（AI 内核还没就绪，TASK-V3-D 未合入；这次改动没有生效）"
          : "";
      setStatus(`${result.userText || "保存失败"}${hint}`, "error");
      return;
    }
    setStatus("已保存", "ok");
    onSaved(result.data || null);
    setTimeout(() => closeModal(), 500);
  }

  /**
   * 设置页打开时要把「设置以外的东西」关死。
   *
   * 为什么要 inert：设置面板是 `role="dialog"`，但以前打开后 `document.activeElement`
   * 仍是终端的 `TEXTAREA.xterm-helper-textarea` —— 用户以为自己在设置页，手一打字
   * 命令就真的跑进 shell（VERIFY-V4-G §7 P0-焦点-a 用 CDP 真敲命令验证过）。
   *
   * 这三个容器都是 `#root`（data-role="app"）的直接子元素。
   * 绝对不能给 `[data-role="settings-host"]` 设 inert：设置页自己就在里面。
   */
  const INERT_SELECTORS = ['[data-role="rail"]', '[data-role="main"]', '[data-role="statusbar"]'];

  function setBackgroundInert(on) {
    for (const selector of INERT_SELECTORS) {
      const node = document.querySelector(selector);
      if (!node) continue;
      if (on) node.setAttribute("inert", "");
      else node.removeAttribute("inert");
    }
  }

  function open() {
    if (opened) return;
    opened = true;
    focusBefore = document.activeElement;
    if (!backdrop) build();
    backdrop.hidden = false;
    setBackgroundInert(true);
    document.addEventListener("keydown", onGlobalKeydown, true);
    void load().then(() => {
      // 焦点必须等 load() 建完 DOM 再进：autonomy-option 是 async load 里才渲染的，
      // 之前用 rAF 时元素还不存在（实测焦点留在终端，打字直接跑进 shell）。
      if (!opened) return;
      const target =
        backdrop.querySelector('[data-role="autonomy-option"]') ||
        backdrop.querySelector("button, [href], input, select, textarea");
      if (target && typeof target.focus === "function") {
        try {
          target.focus();
        } catch {
          // 忽略：焦点不是安全边界，失败也不该让设置页打不开。
        }
      }
    });
  }

  function onGlobalKeydown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeModal();
  }

  function closeModal() {
    if (!opened) return;
    opened = false;
    document.removeEventListener("keydown", onGlobalKeydown, true);
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    if (backdrop) backdrop.hidden = true;
    // 先解除 inert，再把焦点还回去：inert 还在时 focus() 会被忽略。
    setBackgroundInert(false);
    if (focusBefore && typeof focusBefore.focus === "function") {
      try {
        focusBefore.focus();
      } catch {
        // 忽略。
      }
    }
    onClose();
  }

  return {
    init() {
      // 首次打开时才 build（不做无用 DOM）。
    },
    open,
    close: closeModal,
    isOpen() {
      return opened;
    },
  };
}
