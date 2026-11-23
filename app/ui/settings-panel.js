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

const AUTONOMY_OPTIONS = [
  {
    value: "strict",
    title: "严格",
    desc: "只有只读命令和你白名单里的会自动跑，其余都要你点确认。",
  },
  {
    value: "balanced",
    title: "平衡（默认）",
    desc: "只读命令 + 第二个 AI 判为安全的，自动跑；其余要你确认。",
  },
  {
    value: "loose",
    title: "宽松",
    desc: "连可撤销的写操作（比如新建目录、复制到新路径）也自动跑；删除、覆盖、提权仍然问你。",
  },
];

const DEFAULT_BASE_PROMPT_HINT =
  "你是一个内置在终端里的 AI 助手。你的服务对象是不太懂命令行的普通用户。你的工作是理解他想达成什么，然后自己动手在终端里把这件事做完，最后用他自己的语言告诉他结果。";

const REVIEW_OFF = "__off__";
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
    reviewSelect.appendChild(el("option", { value: REVIEW_OFF }, "关闭审阅（不推荐）"));
    reviewSelect.appendChild(el("option", { value: REVIEW_SAME }, "与对话模型相同"));
    for (const model of models) {
      reviewSelect.appendChild(el("option", { value: model.id }, model.label || model.id));
    }
    // current: null = 与对话模型相同；"" = 关闭；其它 = 具体模型 id
    let wanted = REVIEW_SAME;
    if (current === "") wanted = REVIEW_OFF;
    else if (typeof current === "string" && current.length > 0) {
      wanted = models.some((model) => model.id === current) ? current : REVIEW_SAME;
    }
    reviewSelect.value = wanted;
  }

  function selectedReviewModel() {
    const value = reviewSelect.value;
    if (value === REVIEW_OFF) return "";
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

    /* 3. 审阅模型 */
    const blockReview = el("section", { className: "settings-block", "data-block": "review" });
    blockReview.appendChild(el("h3", { className: "settings-block-title" }, "审阅模型"));
    blockReview.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "第二个 AI 只负责判断「这条命令安不安全」，不执行命令。关掉以后就等于严格档。",
      ),
    );
    reviewSelect = el("select", { "data-role": "review-model-select", "aria-label": "审阅模型" });
    blockReview.appendChild(reviewSelect);
    body.appendChild(blockReview);

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
    const [configResult, modelsResult] = await Promise.all([api.config(), api.models()]);
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
      renderGateway();
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
    renderGateway();
    setStatus("", null);
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

  function open() {
    if (opened) return;
    opened = true;
    focusBefore = document.activeElement;
    if (!backdrop) build();
    backdrop.hidden = false;
    document.addEventListener("keydown", onGlobalKeydown, true);
    void load();
    const focusTarget = backdrop.querySelector('[data-role="autonomy-option"]');
    if (focusTarget) requestAnimationFrame(() => focusTarget.focus());
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
