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
//   TASK-FIX17-L4 新增：review-reasoning（审阅模型的推理强度下拉）/
//   review-reasoning-hint（「这个模型不支持推理强度」的说明行）
//   TASK-FIX17-G 新增：about-version / about-repository / about-install-kind /
//   update-check / update-status / update-howto / update-howto-text
//   TASK-FIX17-I 新增：builtin-allowlist-list / builtin-allowlist-item /
//   builtin-allowlist-rule / builtin-input / builtin-add / builtin-edit /
//   builtin-remove / builtin-save-edit / builtin-cancel-edit / builtin-edit-input /
//   builtin-reset / builtin-allowlist-count / builtin-allowlist-status /
//   builtin-allowlist-empty

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

/**
 * 服务端 `REASONING_LEVELS`（src/config/store.mjs）的镜像；只用于过滤
 * （真网关会给出 `none` / `ultra`，服务端的固定枚举会 400 —— 不能摆进下拉）。
 */
const REASONING_ACCEPTED = Object.freeze(["off", "low", "medium", "high", "xhigh", "max"]);

/**
 * 推理档位的中文名（TASK-FIX17-L4 R5）。
 *
 * 只是显示层翻译：选项**只能**来自 `/api/models` 的 `reasoningLevels`，
 * 这里不参与「有哪些档位」的决定（网关没给的档位永远不出现）。
 */
const REASONING_LABELS = Object.freeze({
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
});

function reasoningLabel(level) {
  const key = typeof level === "string" ? level : "";
  return REASONING_LABELS[key] || key;
}

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
  /**
   * 状态行被写过的次数（TASK-FIX17-L1 自查发现）。
   *
   * `load()` 是异步的，结尾会把状态行清空。用户手快（设置页一打开就点「导出日志」）
   * 时，`load()` 可能在导出之后才回来 —— 那句「已导出到 C:\…」会被凭空抹掉，
   * 用户以为没成功。所以清空只能是「这期间没有任何人写过状态行」时才做。
   */
  let statusVersion = 0;

  let autonomyGroup = null;
  let allowlistInput = null;
  let allowlistMode = null;
  let allowlistList = null;
  // TASK-FIX17-I R3：内置只读白名单（与用户白名单平行的一组状态）。
  // `builtinAllowlist` 是页内副本，`builtinDefaults` 是服务端下发的默认清单，
  // `builtinDirty` 只表示「用户真的动过」—— 没动过就不往回写，
  // 否则老配置（缺字段）第一次打开设置页就被静默改写了。
  let builtinAllowlist = [];
  let builtinDefaults = [];
  let builtinDirty = false;
  let builtinEditing = null;
  let builtinInput = null;
  let builtinList = null;
  let builtinCountLine = null;
  let builtinStatusLine = null;
  /** 内置白名单状态行被写过的次数（见 `setBuiltinStatus` 的说明）。 */
  let builtinStatusVersion = 0;
  let reviewSelect = null;
  // TASK-FIX17-L4 R5：审阅模型的推理强度。
  let reviewReasoningSelect = null;
  let reviewReasoningHint = null;
  // 配置里的真值（null = 默认 = 不传 reasoning_effort）。
  let reviewReasoning = null;
  // 「与对话模型相同」时要知道对话用的是哪个模型（选项按它的档位算）。
  let conversationModelId = null;
  // GET /api/models 的 default（配置里没存模型时，服务端会给它算一个真正生效的）。
  let defaultModelId = null;
  let basePromptInput = null;
  let gatewayInfo = null;
  let statusLine = null;
  let saveButton = null;
  let effectToggle = null;
  let showApprovalEffect = false;
  // TASK-FIX17-L1 R4：下载与导出目录（属于配置字段，跟其它字段一起 PUT）。
  let downloadDirInput = null;
  let downloadDirDefaultButton = null;
  let downloadDirHint = null;
  let downloadDirDefault = null;
  // TASK-FIX17-E：日志 block 的两个按钮与状态行（不是表单字段，不参与保存）。
  let logExportButton = null;
  let logClearButton = null;
  let logStatusLine = null;
  // TASK-FIX17-L1：日志导出到目录后回显路径 + 「打开所在文件夹」。
  let logRevealButton = null;
  let lastExportedPath = null;
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
    statusVersion += 1;
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

  /* ---------------- 内置只读白名单（TASK-FIX17-I R3） ---------------- */

  /**
   * 与服务端 `checkBuiltinAllowlistEntry`（src/config/store.mjs）**同口径**的前端预校验。
   *
   * 为什么前端也要有一份：服务端仍会再校验一次（前端可绕过），这里只为了
   * 「输错了立刻告诉我」—— 拖到点保存才报错太晚。两份规则必须一致：
   * 字符集 `[A-Za-z0-9_.:+/@-]`、单词间单空格、≤ 64 字符、≤ 3 段。
   *
   * @returns {{ok:boolean, text?:string, error?:string}}
   */
  function checkBuiltinRule(raw) {
    if (typeof raw !== "string") return { ok: false, error: "规则必须是一段文本。" };
    const text = raw.trim();
    if (text.length === 0) return { ok: false, error: "规则不能是空的，例如 free 或 docker volume ls。" };
    if (text.length > 64) return { ok: false, error: `每条规则最长 64 个字符（这条 ${text.length} 个）。` };
    if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: "规则里不能混入换行或制表符。" };
    if (/\s{2,}/.test(text)) return { ok: false, error: "单词之间只能有一个空格。" };
    const parts = text.split(" ");
    if (parts.length > 3) return { ok: false, error: "一条规则最多 3 段（命令头 + 最多两个只读子命令词）。" };
    for (const part of parts) {
      if (!/^[A-Za-z0-9_.:+/@-]+$/.test(part)) {
        return { ok: false, error: `「${part}」里有不允许的字符：只能使用字母、数字和 _ . : + / @ -。` };
      }
    }
    return { ok: true, text };
  }

  /** 内置白名单的页内状态行（与底部全局状态行分开，因为要就地报错）。
   *
   * `builtinStatusVersion` 是与 `statusVersion` 同一套防抖制度：`load()` 是异步的，
   * 结尾会清空状态行。用户手快（一打开就去点了删除/恢复默认）时，`load()` 可能
   * 在这些操作之后才回来 —— 那句「已删除，点底部保存后生效」会被凭空抹掉。
   * 所以清空只能是「这期间没有任何人写过状态行」时才做。
   */
  function setBuiltinStatus(text, tone) {
    builtinStatusVersion += 1;
    if (!builtinStatusLine) return;
    builtinStatusLine.textContent = text || "";
    if (tone) builtinStatusLine.setAttribute("data-tone", tone);
    else builtinStatusLine.removeAttribute("data-tone");
  }

  function markBuiltinDirty() {
    builtinDirty = true;
    renderBuiltinAllowlist();
  }

  /**
   * 渲染内置清单（每行 = 一条规则 + 编辑 / 删除）。
   *
   * 编辑态存的是**索引**（`builtinEditing`）：重渲染时按索引把那一行换成
   * input + 保存 / 取消，不另开弹层（PRD R3：「把那一行变成 input」）。
   */
  function renderBuiltinAllowlist() {
    if (!builtinList) return;
    builtinList.textContent = "";
    if (builtinAllowlist.length === 0) {
      builtinList.appendChild(
        el(
          "div",
          { className: "builtin-allowlist-empty", "data-role": "builtin-allowlist-empty" },
          "清单是空的：所有命令都会先问你。",
        ),
      );
    }
    builtinAllowlist.forEach((rule, index) => {
      const item = el("div", {
        "data-role": "builtin-allowlist-item",
        "data-index": String(index),
        className: "builtin-allowlist-item",
      });
      if (builtinEditing === index) {
        const input = el("input", {
          type: "text",
          "data-role": "builtin-edit-input",
          className: "builtin-edit-input",
          value: rule,
          autocomplete: "off",
          spellcheck: "false",
          maxlength: "64",
          "aria-label": "编辑规则",
        });
        const commit = () => {
          const checked = checkBuiltinRule(input.value);
          if (!checked.ok) {
            setBuiltinStatus(checked.error, "error");
            return;
          }
          const others = builtinAllowlist.filter((_, i) => i !== index);
          if (others.includes(checked.text)) {
            setBuiltinStatus(`「${checked.text}」已经在清单里了。`, "error");
            return;
          }
          builtinAllowlist[index] = checked.text;
          builtinEditing = null;
          setBuiltinStatus("已修改，点底部「保存」后生效。", "info");
          markBuiltinDirty();
        };
        input.addEventListener("keydown", (event) => {
          if (event.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            builtinEditing = null;
            setBuiltinStatus("", null);
            renderBuiltinAllowlist();
          }
        });
        const actions = el("div", { className: "builtin-allowlist-actions" });
        const saveEdit = el("button", { type: "button", "data-role": "builtin-save-edit" }, "保存");
        saveEdit.addEventListener("click", commit);
        const cancelEdit = el("button", { type: "button", "data-role": "builtin-cancel-edit" }, "取消");
        cancelEdit.addEventListener("click", () => {
          builtinEditing = null;
          setBuiltinStatus("", null);
          renderBuiltinAllowlist();
        });
        actions.append(saveEdit, cancelEdit);
        item.append(input, actions);
        builtinList.appendChild(item);
        return;
      }

      item.appendChild(el("code", { className: "builtin-allowlist-rule", "data-role": "builtin-allowlist-rule" }, rule));
      const actions = el("div", { className: "builtin-allowlist-actions" });
      const edit = el("button", { type: "button", "data-role": "builtin-edit" }, "编辑");
      edit.addEventListener("click", () => {
        builtinEditing = index;
        setBuiltinStatus("", null);
        renderBuiltinAllowlist();
        const input = builtinList.querySelector('[data-role="builtin-edit-input"]');
        if (input && typeof input.focus === "function") input.focus();
      });
      const remove = el("button", { type: "button", "data-role": "builtin-remove" }, "删除");
      remove.addEventListener("click", () => {
        // 先退出编辑态再改数组：否则 `builtinEditing` 会指到错的一行。
        const wasEditing = builtinEditing;
        builtinAllowlist.splice(index, 1);
        if (wasEditing !== null && wasEditing !== undefined) {
          if (wasEditing === index) builtinEditing = null;
          else if (wasEditing > index) builtinEditing = wasEditing - 1;
        }
        setBuiltinStatus("已删除，点底部「保存」后生效。", "info");
        markBuiltinDirty();
      });
      actions.append(edit, remove);
      item.appendChild(actions);
      builtinList.appendChild(item);
    });
    if (builtinCountLine) {
      const total = builtinAllowlist.length;
      builtinCountLine.textContent = `共 ${total} 条`;
    }
  }

  function addBuiltinRule() {
    const checked = checkBuiltinRule(builtinInput ? builtinInput.value : "");
    if (!checked.ok) {
      setBuiltinStatus(checked.error, "error");
      return;
    }
    if (builtinAllowlist.includes(checked.text)) {
      setBuiltinStatus(`「${checked.text}」已经在清单里了。`, "error");
      return;
    }
    if (builtinAllowlist.length >= 300) {
      setBuiltinStatus("内置白名单最多 300 条。", "error");
      return;
    }
    builtinAllowlist.push(checked.text);
    builtinInput.value = "";
    setBuiltinStatus("已添加，点底部「保存」后生效。", "info");
    markBuiltinDirty();
  }

  function resetBuiltinRules() {
    // 默认清单由服务端一并下发（`builtinAllowlistDefaults`）：前端**不拄一份**，
    // 否则与服务端漂移就成了两个真相。
    builtinAllowlist = builtinDefaults.slice();
    builtinEditing = null;
    setBuiltinStatus("已恢复默认，点保存后生效。", "info");
    builtinDirty = true;
    renderBuiltinAllowlist();
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

  /* ---------------- 审阅推理强度（TASK-FIX17-L4 R5） ---------------- */

  /** 下拉实际对应的模型：「与对话模型相同」= 配置里的对话模型。 */
  function reviewTargetModel() {
    if (!reviewSelect) return null;
    const value = reviewSelect.value;
    if (value !== REVIEW_SAME) return models.find((model) => model.id === value) || null;
    const wanted = typeof conversationModelId === "string" ? conversationModelId : null;
    return wanted ? models.find((model) => model.id === wanted) || null : null;
  }

  /**
   * 按当前审阅模型重建「推理强度」下拉。
   *
   * 规则（PRD R5）：
   *   - 选项 = 所选模型的 reasoningLevels，首项「默认」value=""；
   *   - 换审阅模型时重算：原值仍合法就保留，否则回落「默认」并把配置值清成 null；
   *   - 模型不支持推理 → select 禁用 + 写「这个模型不支持推理强度」。
   */
  function renderReviewReasoning() {
    if (!reviewReasoningSelect) return;
    const model = reviewTargetModel();
    const levels =
      model && Array.isArray(model.reasoningLevels)
        ? model.reasoningLevels.filter(
            (level) => typeof level === "string" && REASONING_ACCEPTED.includes(level),
          )
        : [];
    const supported = Boolean(model) && model.supportsReasoning === true && levels.length > 0;
    reviewReasoningSelect.textContent = "";
    if (!supported) {
      reviewReasoningSelect.appendChild(el("option", { value: "" }, "默认"));
      reviewReasoningSelect.value = "";
      reviewReasoningSelect.disabled = true;
      if (reviewReasoningHint) reviewReasoningHint.textContent = "这个模型不支持推理强度。";
      return;
    }
    reviewReasoningSelect.disabled = false;
    reviewReasoningSelect.appendChild(el("option", { value: "" }, "默认"));
    for (const level of levels) {
      reviewReasoningSelect.appendChild(
        el("option", { value: level }, `推理：${reasoningLabel(level)}`),
      );
    }
    // 原值仍合法 → 保留；否则回落「默认」（同时把待保存的值也清掉，
    // 不能让「界面显示默认、保存却写回旧档位」这种错位存在）。
    if (!(typeof reviewReasoning === "string" && levels.includes(reviewReasoning))) {
      reviewReasoning = null;
    }
    reviewReasoningSelect.value = reviewReasoning || "";
    if (reviewReasoningHint) {
      reviewReasoningHint.textContent = "可选档位由所选模型决定；「默认」= 用网关自己的默认强度。";
    }
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
   * TASK-FIX17-L1 R4/R5：先调 `POST /api/logs/export-to-dir`把日志写进下载目录；
   * 未设目录（400 `NO_DOWNLOAD_DIR`）才回落原来的「fetch 拿 blob + `<a download>`」。
   *
   * 为什么回落而不是报错：本卡不能把已经有导出能力的人弄丢——没设目录时的
   * 行为必须与改前逐字一致。
   */
  async function exportLogs() {
    if (logExportButton) logExportButton.disabled = true;
    setStatus("正在导出日志…", "info");

    const toDir = await exportLogsToDir();
    if (toDir === "saved") {
      if (logExportButton) logExportButton.disabled = false;
      await refreshLogStatus();
      return;
    }
    if (toDir === "failed") {
      if (logExportButton) logExportButton.disabled = false;
      return;
    }

    if (!api || typeof api.logsExport !== "function") {
      if (logExportButton) logExportButton.disabled = false;
      setStatus("这个版本的本地服务不支持导出日志。", "error");
      return;
    }
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

  /**
   * 导出到下载目录。
   *
   * @returns {Promise<"saved"|"fallback"|"failed">}
   *   `saved` = 已落盘；`fallback` = 没设目录 / 服务端太旧，调用方走 blob 下载；
   *   `failed` = 已给用户报错，调用方不要再走第二条路径。
   */
  async function exportLogsToDir() {
    if (!api || typeof api.logsExportToDir !== "function") return "fallback";
    const result = await api.logsExportToDir();
    if (!result.ok) {
      if (result.code === "NO_DOWNLOAD_DIR" || result.code === "NOT_FOUND" || result.code === "NETWORK") {
        return "fallback";
      }
      setStatus(result.userText || "导出失败", "error");
      return "failed";
    }
    const data = result.data || {};
    if (data.ok === true && typeof data.savedPath === "string" && data.savedPath.length > 0) {
      lastExportedPath = data.savedPath;
      if (logRevealButton) logRevealButton.hidden = false;
      // AC7：提示里必须是完整路径（用户要能直接照着去找）。
      setStatus(`已导出到 ${data.savedPath}`, "ok");
      return "saved";
    }
    if (data.code === "NO_DOWNLOAD_DIR") return "fallback";
    setStatus(data.userText || "导出失败", "error");
    return "failed";
  }

  /** 调 `/api/fs/reveal` 打开刚导出的日志所在文件夹。 */
  async function revealExported() {
    if (!lastExportedPath) return;
    if (!api || typeof api.revealPath !== "function") {
      setStatus("这个版本的本地服务不支持打开文件夹。", "error");
      return;
    }
    const result = await api.revealPath(lastExportedPath);
    if (!result.ok) {
      setStatus(result.userText || "打不开文件夹。", "error");
      return;
    }
    setStatus(`已打开所在文件夹：${dirOf(lastExportedPath)}`, "ok");
  }

  /** 取路径里的目录部分（Windows / POSIX 分隔符都算）。 */
  function dirOf(targetPath) {
    const text = String(targetPath || "");
    const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
    return index > 0 ? text.slice(0, index) : "";
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

  /**
   * 渲染下载目录 block（TASK-FIX17-L1 R4）：当前值 + 「用默认目录」的占位符。
   *
   * `downloadDirDefault` 来自 GET /api/config（服务端用 `os.homedir()` 算），
   * 前端不自己拼路径：前端拿不到家目录，拼出来的只会是写死用户名。
   */
  function renderDownloadDir(config) {
    if (!downloadDirInput) return;
    const payload = config && typeof config === "object" ? config : {};
    downloadDirDefault =
      typeof payload.downloadDirDefault === "string" && payload.downloadDirDefault.length > 0
        ? payload.downloadDirDefault
        : null;
    downloadDirInput.value = typeof payload.downloadDir === "string" ? payload.downloadDir : "";
    downloadDirInput.placeholder = downloadDirDefault || "留空则用浏览器默认下载目录";
    if (downloadDirDefaultButton) downloadDirDefaultButton.disabled = !downloadDirDefault;
    if (downloadDirHint) {
      downloadDirHint.textContent = downloadDirDefault
        ? `留空时不会自动建目录；点「用默认目录」会填入 ${downloadDirDefault}（保存后生效）。`
        : "留空则每次下载都交给浏览器。";
    }
  }

  /** 把默认目录填进输入框（不自动保存：用户还要自己点保存）。 */
  function fillDefaultDownloadDir() {
    if (!downloadDirInput || !downloadDirDefault) return;
    downloadDirInput.value = downloadDirDefault;
    downloadDirInput.focus();
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

    /* 2.5 内置只读白名单（TASK-FIX17-I R3）
       PRD 要求：默认展示全部内置条目，可增 / 删 / 改 / 恢复默认。
       放在「命令白名单」之后：两者都是「哪些命令不用问我」，
       但这一块的条目是**系统给的默认值**，用户白名单是**自己加的**。 */
    const blockBuiltin = el("section", { className: "settings-block", "data-block": "builtin-allowlist" });
    blockBuiltin.appendChild(el("h3", { className: "settings-block-title" }, "内置只读白名单"));
    blockBuiltin.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "这些命令是只读的，AI 可以不问就直接执行。删掉你不想让它自动跑的，也可以加自己的（例如 docker volume ls）。改动点保存后生效。",
      ),
    );
    const builtinAddRow = el("div", { className: "builtin-allowlist-add-row" });
    builtinInput = el("input", {
      type: "text",
      "data-role": "builtin-input",
      placeholder: "例如 docker volume ls",
      autocomplete: "off",
      spellcheck: "false",
      maxlength: "64",
      "aria-label": "新增一条内置只读白名单",
    });
    const builtinAddButton = el("button", { type: "button", "data-role": "builtin-add" }, "添加");
    builtinAddButton.addEventListener("click", () => addBuiltinRule());
    builtinInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      addBuiltinRule();
    });
    builtinAddRow.append(builtinInput, builtinAddButton);
    blockBuiltin.appendChild(builtinAddRow);
    builtinList = el("div", {
      "data-role": "builtin-allowlist-list",
      className: "builtin-allowlist-list",
    });
    blockBuiltin.appendChild(builtinList);
    // 页内状态行（添加 / 编辑 / 恢复默认的校验提示）
    builtinStatusLine = el("p", {
      className: "settings-block-hint",
      "data-role": "builtin-allowlist-status",
      role: "status",
      "aria-live": "polite",
    });
    blockBuiltin.appendChild(builtinStatusLine);
    const builtinFoot = el("div", { className: "builtin-allowlist-foot" });
    builtinCountLine = el(
      "span",
      { className: "builtin-allowlist-count", "data-role": "builtin-allowlist-count" },
      "共 0 条",
    );
    const resetButton = el("button", { type: "button", "data-role": "builtin-reset" }, "恢复默认");
    resetButton.addEventListener("click", () => resetBuiltinRules());
    builtinFoot.append(builtinCountLine, resetButton);
    blockBuiltin.appendChild(builtinFoot);
    body.appendChild(blockBuiltin);

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
    // 换审阅模型 → 档位列表跟着换（保留仍合法的旧值，否则回落默认）。
    reviewSelect.addEventListener("change", () => renderReviewReasoning());
    blockReview.appendChild(reviewSelect);

    // TASK-FIX17-L4 R5：模型选择下方一行 label「推理强度」+ select。
    const reasoningRow = el("div", { className: "settings-row settings-reasoning-row" });
    const reasoningLabelEl = el(
      "label",
      { className: "settings-reasoning-label", for: "review-reasoning-select" },
      "推理强度",
    );
    reviewReasoningSelect = el("select", {
      id: "review-reasoning-select",
      "data-role": "review-reasoning",
      "aria-label": "审阅模型的推理强度",
    });
    // 保存时随其它字段一起 PUT（沿用这一节的保存按钮，不单独提交）。
    reviewReasoningSelect.addEventListener("change", () => {
      reviewReasoning = reviewReasoningSelect.value || null;
    });
    reasoningRow.append(reasoningLabelEl, reviewReasoningSelect);
    blockReview.appendChild(reasoningRow);
    reviewReasoningHint = el("p", { className: "settings-block-hint", "data-role": "review-reasoning-hint" });
    blockReview.appendChild(reviewReasoningHint);
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

    /* 5. 下载与导出目录（TASK-FIX17-L1 R4）
       放在「AI 网关」之前：它属于日常会改的设置，而不是只读的网关信息。
       持久化在 config.json 的 downloadDir；留空 = null = 回落浏览器下载。 */
    const blockDownloads = el("section", { className: "settings-block", "data-block": "downloads" });
    blockDownloads.appendChild(el("h3", { className: "settings-block-title" }, "下载与导出"));
    blockDownloads.appendChild(
      el(
        "p",
        { className: "settings-block-hint" },
        "下载的文件、导出的日志都会存到这个目录。留空则用浏览器默认下载目录。",
      ),
    );
    const downloadRow = el("div", { className: "settings-row settings-download-row" });
    downloadDirInput = el("input", {
      type: "text",
      "data-role": "download-dir",
      className: "settings-download-input",
      placeholder: "例如 C:\\Users\\你\\Downloads\\magpie-terminal",
      autocomplete: "off",
      spellcheck: "false",
      maxlength: "512",
      "aria-label": "下载与导出目录",
    });
    downloadDirDefaultButton = el(
      "button",
      { type: "button", "data-role": "download-dir-default", className: "settings-download-default" },
      "用默认目录",
    );
    downloadDirDefaultButton.disabled = true;
    downloadDirDefaultButton.addEventListener("click", () => fillDefaultDownloadDir());
    downloadRow.append(downloadDirInput, downloadDirDefaultButton);
    blockDownloads.appendChild(downloadRow);
    downloadDirHint = el(
      "p",
      { className: "settings-block-hint", "data-role": "download-dir-hint" },
      "留空则每次下载都交给浏览器。",
    );
    blockDownloads.appendChild(downloadDirHint);
    body.appendChild(blockDownloads);

    /* 6. AI 网关 */
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
    // TASK-FIX17-L1 R4：导出到目录后才有意义（未导出时隐藏）。
    logRevealButton = el(
      "button",
      { type: "button", "data-role": "logs-reveal", hidden: true },
      "打开所在文件夹",
    );
    logRevealButton.addEventListener("click", () => void revealExported());
    logRow.append(logExportButton, logClearButton, logRevealButton);
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
    const versionAtStart = statusVersion;
    const builtinVersionAtStart = builtinStatusVersion;
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
      defaultModelId = typeof payload.default === "string" ? payload.default : null;
    } else {
      gateway = null;
      models = [];
      defaultModelId = null;
    }
    if (!configResult.ok) {
      setStatus(`${configResult.userText}（${configResult.code}）`, "error");
      renderAutonomy("balanced");
      allowlist = [];
      renderAllowlist();
      builtinAllowlist = [];
      builtinDefaults = [];
      builtinDirty = false;
      builtinEditing = null;
      renderBuiltinAllowlist();
      renderReviewModels(null);
      renderReviewReasoning();
      basePromptInput.value = "";
      setShowEffect(false);
      renderDownloadDir(null);
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
    // 对话模型：GET /api/config 的 model 在「从没保存过」时是服务端兜底的 DEFAULT_MODEL，
    // 不一定在清单里。按「清单里存在 → 用；否则用 /api/models 的 default → 再否则 models[0]」
    // 解析，才能和抽屉实际选中的那个模型对上（档位按它算）。
    const known = (id) => typeof id === "string" && id.length > 0 && models.some((model) => model.id === id);
    const configuredModel = typeof config.model === "string" ? config.model : null;
    conversationModelId = known(configuredModel)
      ? configuredModel
      : known(defaultModelId)
        ? defaultModelId
        : models[0]
          ? models[0].id
          : null;
    reviewReasoning =
      typeof config.reviewReasoning === "string" && config.reviewReasoning.length > 0
        ? config.reviewReasoning
        : null;
    renderReviewModels(typeof config.reviewModel === "string" ? config.reviewModel : null);
    renderReviewReasoning();
    basePromptInput.value = typeof config.basePrompt === "string" ? config.basePrompt : "";
    setShowEffect(config.showApprovalEffect === true);
    renderDownloadDir(config);
    renderGateway();
    // TASK-FIX17-I R3：内置只读白名单（放在这里而不是更早，是为了不让 load() 中途
    // 的渲染把用户在等待期间的点搮捧掉 —— 下面的 `builtinDirty` 判断才是真正的保险）。
    //
    // 缺字段（老配置）→ 用服务端下发的默认清单，并且**不标 dirty**：
    // 用户没动过就不往回写，否则老配置文件会在无人知情时被改一次。
    // `builtinAllowlistDefaults` 是 `GET /api/config` 带回来的默认值（单一数据源在
    // 内核的 `DEFAULT_BUILTIN_ALLOWLIST`，前端不拄第二份）。
    const rawDefaults = Array.isArray(config.builtinAllowlistDefaults) ? config.builtinAllowlistDefaults : [];
    builtinDefaults = rawDefaults.filter((rule) => typeof rule === "string" && rule.length > 0);
    // 用户已经动过了（load() 在飞的时候点了增/删/改/恢复默认）就不拿服务端值覆盖：
    // 那一瞬间的输入是用户的明确意图，抹掉比缺省值可怕。
    if (!builtinDirty) {
      builtinAllowlist = Array.isArray(config.builtinAllowlist)
        ? config.builtinAllowlist.filter((rule) => typeof rule === "string" && rule.length > 0)
        : builtinDefaults.slice();
      builtinEditing = null;
      renderBuiltinAllowlist();
      // 这期间没有更新的状态（比如用户已经点了「删除」）才清空。
      if (builtinStatusVersion === builtinVersionAtStart) setBuiltinStatus("", null);
    }
    // 这期间没有更新的状态（比如用户已经点了「导出日志」）才清空。
    if (statusVersion === versionAtStart + 1) setStatus("", null);
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
      // TASK-FIX17-L4 R5：空串 = 默认 → null（服务端再归一，但这里语义更直接）。
      reviewReasoning: reviewReasoning || null,
      basePrompt: basePromptInput.value.trim().length > 0 ? basePromptInput.value : null,
      showApprovalEffect,
      // TASK-FIX17-L1 R1：空串交给服务端归一成 null（这里 trim 后为空就送 null，
      // 语义更直接：“没填” = 用浏览器默认目录）。
      downloadDir: downloadDirInput && downloadDirInput.value.trim().length > 0
        ? downloadDirInput.value.trim()
        : null,
    };
    // TASK-FIX17-I R3：内置清单只在用户真的动过时发送。
    // 没动过就不发 —— 老配置（缺字段）不会被「顺手写回默认值」，
    // 用户也不会因为打开过设置页就多出一份大数组。
    // 也顺便检查：还在编辑态时不能直接保存（否则未提交的编辑被默默丢掉）。
    if (builtinEditing !== null && builtinEditing !== undefined) {
      if (saveButton) saveButton.disabled = false;
      setStatus("内置白名单有一行还在编辑中：先点「保存」或「取消」。", "error");
      return;
    }
    if (builtinDirty) patch.builtinAllowlist = builtinAllowlist.slice();
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
    // 保存成功后重新 GET /api/config 对齐一次（PRD R3 的「保存后对齐」）：
    // 服务端会去重 / 归一，页内显示必须与它一致，不能变成两套真相。
    try {
      const fresh = await api.config();
      if (fresh && fresh.ok && fresh.data && Array.isArray(fresh.data.builtinAllowlist)) {
        builtinAllowlist = fresh.data.builtinAllowlist.filter((rule) => typeof rule === "string");
        if (Array.isArray(fresh.data.builtinAllowlistDefaults)) {
          builtinDefaults = fresh.data.builtinAllowlistDefaults.filter((rule) => typeof rule === "string");
        }
        builtinDirty = false;
        builtinEditing = null;
        renderBuiltinAllowlist();
      }
    } catch {
      // 对齐失败不影响已经落盘的配置，保留页内值。
    }
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
