// 远程主机面板（TASK-V2-B §2.6）：主机列表 + 连接表单 + 首次连接指纹核对卡 + 文件 tab。
//
// 布局约束：面板是 `.hosts`（212px），**覆盖**在终端之上（position: absolute），
// 不参与 .main 的 flex 计算 —— 打开面板时 xterm 的 cols 必须不变（验收 E8）。
//
// 不直接发 WS 帧：建远程标签交给 app.js 的 onCreateSession(host)（那里才知道 wsClient）。

import createFileTree from "./file-tree.js";

const AUTH_LABELS = { password: "密码", privateKey: "私钥" };

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 模态浮层的公共壳：遮罩 + 卡片 + Esc 关闭 + 焦点陷阱。 */
function createModal({ role, title }) {
  const backdrop = el("div", { "data-role": "confirm-backdrop", hidden: "" });
  const card = el("div", { "data-role": role, tabindex: "-1", role: "dialog", "aria-modal": "true" });
  const heading = el("h2", {}, title);
  card.appendChild(heading);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  let onEscape = null;
  let focusBefore = null;

  function keydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = card.querySelectorAll(
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
  }

  function close() {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    document.removeEventListener("keydown", keydown, true);
    card.textContent = "";
    if (onEscape) onEscape();
    if (focusBefore && typeof focusBefore.focus === "function") {
      try {
        focusBefore.focus();
      } catch {
        // 忽略。
      }
    }
  }

  return {
    card,
    heading,
    open(options = {}) {
      focusBefore = options.focus || document.activeElement;
      backdrop.hidden = false;
      onEscape = typeof options.onClose === "function" ? options.onClose : null;
      document.addEventListener("keydown", keydown, true);
      const target = card.querySelector("input, button, select");
      if (target) requestAnimationFrame(() => target.focus());
      else card.focus();
    },
    close,
    get isOpen() {
      return !backdrop.hidden;
    },
  };
}

export default function createHostsPanel(elements) {
  const api = elements.api;
  const store = elements.store;
  const onCreateSession = typeof elements.onCreateSession === "function" ? elements.onCreateSession : () => {};
  const onNotice = typeof elements.onNotice === "function" ? elements.onNotice : () => {};
  // TASK-V4-G：文件面板搬去终端下方后，主机面板只留一个跳转钩子。
  const onOpenFiles = typeof elements.onOpenFiles === "function" ? elements.onOpenFiles : null;
  // TASK-V4-F：点「本机」条目 = 用当前默认 shell 新开一个本机标签（不给 shellId）。
  const onCreateLocal =
    typeof elements.onCreateLocal === "function" ? elements.onCreateLocal : () => {};
  // 面板从「标签栏下方」开始，到「AI 条 / 状态栏上方」结束：只覆盖终端区。
  // 不盖标签栏（否则用户点不到自己的标签），不盖 AI 条，也不盖状态栏。
  const anchor = elements.anchor || null;
  const bottomAnchors = Array.isArray(elements.bottomAnchors) ? elements.bottomAnchors : [];

  const panel = el("aside", {
    "data-role": "hosts-panel",
    "aria-label": "主机",
    hidden: "",
  });
  // 面板挂在 #root 之外？——不，挂到 body 是 fixed 覆盖层，能保证不挤压终端。
  document.body.appendChild(panel);

  let hosts = [];
  let currentSessionId = null;
  let opened = false;

  /* ---------------- 本机条目 + shell 下拉（TASK-V4-F §5.4） ---------------- */

  // /api/shells 的缓存：只在打开面板 / 切换后刷新。
  let shellsInfo = null;
  let shellBusy = false;

  async function refreshShells() {
    const result = await api.shells();
    if (!result.ok) {
      shellsInfo = null;
      return null;
    }
    shellsInfo = result.data || null;
    return shellsInfo;
  }

  /** 当前生效的 shell（下拉的 value）：配置值优先，否则服务端给的 default。 */
  function currentShellId() {
    if (!shellsInfo) return null;
    const configured = shellsInfo.configured;
    if (typeof configured === "string" && configured.length > 0) return configured;
    return typeof shellsInfo.default === "string" ? shellsInfo.default : null;
  }

  function shellRecordById(id) {
    if (!shellsInfo || !Array.isArray(shellsInfo.shells)) return null;
    return shellsInfo.shells.find((item) => item.id === id) || null;
  }

  /** 「bash 5.2.37」这样的展示文字（一律用实测版本，不自吹）。 */
  function shellSummaryText() {
    const id = currentShellId();
    const record = shellRecordById(id);
    if (!record) return "正在读取…";
    if (record.available === false) return `${record.id}（未安装）`;
    return `${record.id} ${record.version || "unknown"}`;
  }

  function renderLocalRow() {
    const row = el("div", { "data-role": "host-local", "data-shell-id": currentShellId() || "" });

    const main = el("button", { type: "button", className: "host-item-main", "data-role": "host-local-open" });
    const icon = el("span", { className: "host-local-icon", "aria-hidden": "true" }, "▣");
    main.appendChild(icon);
    const text = el("span", { className: "host-item-text" });
    text.appendChild(el("span", { className: "host-name" }, "本机"));
    text.appendChild(el("span", { className: "host-addr", "data-role": "host-local-shell" }, shellSummaryText()));
    main.appendChild(text);
    main.addEventListener("click", () => {
      onCreateLocal(null);
    });
    row.appendChild(main);

    const select = el("select", {
      "data-role": "host-local-shell-select",
      "aria-label": "本机默认 shell",
      title: "本机默认 shell（只影响之后新开的标签）",
    });
    const list = shellsInfo && Array.isArray(shellsInfo.shells) ? shellsInfo.shells : [];
    const selected = currentShellId();
    for (const item of list) {
      const label = item.available === false ? `${item.name || item.id}（未安装）` : `${item.name || item.id} ${item.version || ""}`.trim();
      const option = el("option", { value: item.id }, label);
      if (item.available === false) option.disabled = true;
      if (item.id === selected) option.selected = true;
      select.appendChild(option);
    }
    if (list.length === 0) select.disabled = true;
    select.addEventListener("change", () => {
      void changeDefaultShell(select.value, select);
    });
    row.appendChild(select);
    return row;
  }

  async function changeDefaultShell(shellId, select) {
    if (shellBusy) return;
    shellBusy = true;
    if (select) select.disabled = true;
    try {
      const result = await api.saveConfig({ defaultShell: shellId });
      if (!result.ok) {
        onNotice(result.userText || `切换默认 shell 失败（${result.code}）`, "warn");
        return;
      }
      await refreshShells();
      // 只影响之后新开的标签：不重建已有会话（卡片 §5.4）。
      onNotice(`本机默认 shell 已改为 ${shellId}。只影响之后新开的标签。`, "ok");
    } finally {
      shellBusy = false;
      if (select) select.disabled = false;
      render();
    }
  }

  /** 面板范围 = 标签栏底边 → 状态栏顶边（覆盖层，但绝不遮这两条）。 */
  function syncPanelTop() {
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      panel.style.top = `${Math.max(0, Math.round(rect.bottom))}px`;
    }
    let gap = 0;
    for (const node of bottomAnchors) {
      if (!node || node.hidden) continue;
      const rect = node.getBoundingClientRect();
      // display:none 的元素 rect 全是 0，跳过。
      if (rect.height <= 0) continue;
      gap = Math.max(gap, Math.round(window.innerHeight - rect.top));
    }
    panel.style.bottom = `${gap}px`;
  }

  window.addEventListener("resize", () => {
    if (opened) syncPanelTop();
  });

  /** 面板打开时点外部收起（第 11 条）：捕获阶段挂在 document 上。
   *  不干扰设置模态、AI 抽屉、确认卡与文件面板里的点击。 */
  function onDocumentPointerDown(event) {
    if (!opened) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const exempt = target.closest(
      '[data-role="hosts-panel"], [data-role="rail-hosts"], [data-role="ai-drawer"], ' +
        '[data-role="settings-host"], [data-role="confirm-backdrop"]',
    );
    if (exempt) return;
    close();
  }


  /* ---------------- 连接表单（模态） ---------------- */

  const formModal = createModal({ role: "host-form-card", title: "添加主机" });
  let editingHost = null;
  let formError = null;

  function field(labelText, input, hint) {
    const wrap = el("label", { className: "host-field" });
    wrap.appendChild(el("span", { className: "host-field-label" }, labelText));
    wrap.appendChild(input);
    if (hint) wrap.appendChild(el("span", { className: "host-field-hint" }, hint));
    return wrap;
  }

  function buildForm() {
    const { card } = formModal;
    card.textContent = "";
    card.appendChild(el("h2", {}, editingHost ? "编辑主机" : "添加主机"));

    const nameInput = el("input", {
      type: "text",
      "data-role": "host-name",
      maxlength: "64",
      autocomplete: "off",
    });
    nameInput.value = editingHost ? editingHost.name : "";

    const hostInput = el("input", {
      type: "text",
      "data-role": "host-host",
      maxlength: "253",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "10.0.0.12 或 example.com",
    });
    hostInput.value = editingHost ? editingHost.host : "";

    const portInput = el("input", {
      type: "number",
      "data-role": "host-port",
      min: "1",
      max: "65535",
      step: "1",
    });
    portInput.value = editingHost ? String(editingHost.port) : "22";

    const userInput = el("input", {
      type: "text",
      "data-role": "host-username",
      maxlength: "64",
      autocomplete: "off",
      spellcheck: "false",
    });
    userInput.value = editingHost ? editingHost.username : "";

    const authSelect = el("select", { "data-role": "host-auth" });
    for (const type of ["password", "privateKey"]) {
      const option = el("option", { value: type }, AUTH_LABELS[type]);
      if (editingHost && editingHost.authType === type) option.selected = true;
      authSelect.appendChild(option);
    }
    if (!editingHost) authSelect.value = "password";

    const passwordWrap = el("div", { "data-role": "host-auth-password" });
    const passwordInput = el("input", {
      type: "password",
      "data-role": "host-password",
      autocomplete: "new-password",
      spellcheck: "false",
    });
    passwordInput.value = "";
    passwordInput.placeholder = editingHost && editingHost.hasSecret ? "留空 = 不改" : "";
    passwordWrap.appendChild(field("密码", passwordInput, editingHost && editingHost.hasSecret ? "已保存密码；留空表示不修改。" : undefined));

    const keyWrap = el("div", { "data-role": "host-auth-key", hidden: "" });
    const keyPathInput = el("input", {
      type: "text",
      "data-role": "host-key-path",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "C:/Users/me/.ssh/id_ed25519",
    });
    keyPathInput.value = editingHost && editingHost.privateKeyPath ? editingHost.privateKeyPath : "";
    const browse = el("button", { type: "button", "data-role": "host-key-browse" }, "浏览…");
    browse.addEventListener("click", () => {
      // 本卡不要求文件选择器：路径手填即可。这里只把焦点交给输入框。
      keyPathInput.focus();
    });
    const keyRow = el("div", { className: "host-key-row" });
    keyRow.appendChild(keyPathInput);
    keyRow.appendChild(browse);
    keyWrap.appendChild(field("私钥路径", keyRow, "绝对路径；服务端会检查文件是否存在。"));

    const inlineKeyInput = el("textarea", {
      "data-role": "host-inline-key",
      rows: "3",
      spellcheck: "false",
      placeholder: "或者把私钥内容粘贴到这里（加密存储；留空 = 不改）",
    });
    inlineKeyInput.value = "";
    keyWrap.appendChild(field("粘贴私钥（可选）", inlineKeyInput));

    const passphraseInput = el("input", {
      type: "password",
      "data-role": "host-passphrase",
      autocomplete: "new-password",
      spellcheck: "false",
      placeholder: "私钥有口令时填这里（可选）",
    });
    passphraseInput.value = "";
    keyWrap.appendChild(field("私钥口令（可选）", passphraseInput));

    function syncAuthVisibility() {
      const mode = authSelect.value;
      passwordWrap.hidden = mode !== "password";
      keyWrap.hidden = mode !== "privateKey";
    }
    authSelect.addEventListener("change", syncAuthVisibility);

    const statusLine = el("p", { "data-role": "host-form-status", hidden: "" });
    if (formError) {
      statusLine.hidden = false;
      statusLine.setAttribute("data-tone", "error");
      statusLine.textContent = formError;
    }

    const actions = el("div", { className: "host-form-actions" });
    const testButton = el("button", { type: "button", "data-role": "host-test" }, "测试连接");
    const saveButton = el("button", { type: "button", "data-role": "host-save" }, "保存");
    const saveConnectButton = el("button", { type: "button", "data-role": "host-save-connect" }, "保存并连接");
    const cancelButton = el("button", { type: "button", "data-role": "host-cancel" }, "取消");
    actions.append(testButton, saveButton, saveConnectButton, cancelButton);

    card.append(
      field("名称", nameInput),
      field("主机", hostInput),
      field("端口", portInput),
      field("用户名", userInput),
      field("认证方式", authSelect),
      passwordWrap,
      keyWrap,
      statusLine,
      actions,
    );
    syncAuthVisibility();

    function setStatus(text, tone) {
      if (!text) {
        statusLine.hidden = true;
        statusLine.textContent = "";
        return;
      }
      statusLine.hidden = false;
      statusLine.setAttribute("data-tone", tone || "info");
      statusLine.textContent = text;
    }

    function collect() {
      const payload = {
        name: nameInput.value.trim(),
        host: hostInput.value.trim(),
        port: Number(portInput.value),
        username: userInput.value.trim(),
        authType: authSelect.value,
      };
      if (authSelect.value === "password") {
        if (passwordInput.value.length > 0) payload.password = passwordInput.value;
      } else {
        if (keyPathInput.value.trim().length > 0) payload.privateKeyPath = keyPathInput.value.trim();
        if (inlineKeyInput.value.trim().length > 0) payload.privateKey = inlineKeyInput.value;
        if (passphraseInput.value.length > 0) payload.passphrase = passphraseInput.value;
      }
      return payload;
    }

    async function persist() {
      const payload = collect();
      if (editingHost) return await api.updateHost(editingHost.id, payload);
      return await api.createHost(payload);
    }

    async function save({ connect }) {
      formError = null;
      const result = await persist();
      if (!result.ok) {
        setStatus(result.userText || `保存失败（${result.code}）`, "error");
        return;
      }
      const saved = result.data && result.data.host ? result.data.host : null;
      formModal.close();
      await refreshHosts();
      if (saved) {
        onNotice(`已保存主机 ${saved.name}。`, "ok");
        if (connect) await connectHost(saved);
      }
    }

    saveButton.addEventListener("click", () => void save({ connect: false }));
    saveConnectButton.addEventListener("click", () => void save({ connect: true }));
    cancelButton.addEventListener("click", () => formModal.close());

    testButton.addEventListener("click", async () => {
      setStatus("正在测试连接…", "info");
      testButton.disabled = true;
      try {
        // 测试的是「已存的那条」：先存再测，否则新主机没有 id。
        const payload = collect();
        if (!payload.password && editingHost && editingHost.authType === "password") {
          // 编辑时没重填密码：已存密码测得到；新主机则必须先填。
          if (!editingHost.hasSecret) {
            setStatus("测试需要密码（新建主机时请先填一次）。", "error");
            return;
          }
        }
        if (!payload.privateKey && !payload.privateKeyPath && payload.authType === "privateKey") {
          if (!editingHost || !(editingHost.privateKeyPath || editingHost.hasInlineKey)) {
            setStatus("测试需要私钥路径或私钥内容。", "error");
            return;
          }
        }
        const saved = await persist();
        if (!saved.ok) {
          setStatus(saved.userText || `保存失败（${saved.code}）`, "error");
          return;
        }
        const host = saved.data && saved.data.host ? saved.data.host : null;
        if (host) {
          editingHost = host;
          await refreshHosts();
        }
        if (!host) {
          setStatus("保存后没拿到主机 id。", "error");
          return;
        }
        const probe = await api.testHost(host.id);
        if (!probe.ok) {
          setStatus(probe.userText || `测试失败（${probe.code}）`, "error");
          return;
        }
        const body = probe.data || {};
        if (body.ok) {
          setStatus(`成功 ${body.durationMs}ms`, "ok");
          return;
        }
        // TASK-V3-C §6.5：首次连接（known_hosts 里没有这条主机）时不再只说「失败」，
        // 而是把指纹核对卡弹出来引导用户信任一次，信任成功后自动重跑测试。
        if (body.code === "UNKNOWN_HOST_KEY") {
          await guideUnknownHostKey(host, setStatus);
          return;
        }
        setStatus(`失败：${body.userText || body.code}`, "error");
      } finally {
        testButton.disabled = false;
      }
    });

    formModal.open({ onClose: () => {} });
  }

  function openHostForm(host) {
    editingHost = host || null;
    formError = null;
    buildForm();
  }

  /* ---------------- 指纹核对（首次连接） ---------------- */

  /**
   * 「测试连接」遇到 UNKNOWN_HOST_KEY 的引导（TASK-V3-C §6.5）：
   * 1. 不显示「失败：…」
   * 2. 取 /api/hosts/:id/fingerprint 拿 algo + fingerprint
   * 3. 复用 buildTrustCard 弹卡（onTrusted 覆盖默认 onCreateSession）
   * 4. 信任成功后自动重跑一次 testHost，把结果写回表单的状态行
   * 5. 用户取消 → 什么都不做（主机已存住，只是没信任指纹）
   */
  async function guideUnknownHostKey(host, setStatus) {
    setStatus("第一次连这台主机，正在取它的指纹…", "info");
    const info = await api.hostFingerprint(host.id);
    if (!info.ok) {
      setStatus(info.userText || `取不到指纹（${info.code}）`, "error");
      return;
    }
    const data = info.data || {};
    if (!data.fingerprint) {
      setStatus("取不到这台主机的指纹，请确认主机地址与端口是对的。", "error");
      return;
    }
    setStatus("", null);
    const mismatch = Boolean(
      data.recorded && data.recorded.fingerprint && data.recorded.fingerprint !== data.fingerprint,
    );
    buildTrustCard({
      host,
      algo: data.algo || "unknown",
      fingerprint: data.fingerprint,
      mismatch,
      knownFingerprint: mismatch ? data.recorded.fingerprint : undefined,
      knownAlgo: mismatch ? data.recorded.algo : undefined,
      onTrusted: async () => {
        // 信任成功 → 自动重跑一次测试（不是建会话：用户点的是「测试连接」）。
        setStatus("指纹已记住，正在重新测试…", "info");
        const retry = await api.testHost(host.id);
        if (!retry.ok) {
          setStatus(retry.userText || `测试失败（${retry.code}）`, "error");
          return;
        }
        const body = retry.data || {};
        if (body.ok) setStatus(`成功 ${body.durationMs}ms（指纹已记住）`, "ok");
        else setStatus(`失败：${body.userText || body.code}`, "error");
      },
    });
  }

  const trustModal = createModal({ role: "host-trust-card", title: "首次连接，请核对指纹" });

  function buildTrustCard({
    host,
    algo,
    fingerprint,
    mismatch,
    knownFingerprint,
    knownAlgo,
    onTrusted,
  }) {
    const { card } = trustModal;
    card.textContent = "";
    card.setAttribute("data-mismatch", mismatch ? "true" : "false");
    card.appendChild(el("h2", {}, mismatch ? "主机指纹变了，连接已中止" : "首次连接，请核对指纹"));
    card.appendChild(
      el(
        "p",
        { className: "host-trust-lead" },
        mismatch
          ? "这台主机现在给出的指纹与上次记录的不一样。可能是换过系统，也可能是中间人。为安全起见不接受连接，也没有「忽略」按钮 —— 确认无误后自己去删掉那条记录。"
          : `即将连接 ${host.username}@${host.host}:${host.port}。第一次连，请与主机管理员核对下面的 SHA256 指纹。`,
      ),
    );

    if (mismatch) {
      const old = el("div", { "data-role": "host-trust-old" });
      old.appendChild(el("span", { className: "host-trust-label" }, `已记录（${knownAlgo || "unknown"}）`));
      old.appendChild(el("code", { className: "host-trust-fingerprint" }, knownFingerprint || "-"));
      card.appendChild(old);
    }

    const current = el("div", { "data-role": "host-trust-current" });
    current.appendChild(
      el("span", { className: "host-trust-label" }, mismatch ? `现在收到（${algo}）` : `指纹（${algo}）`),
    );
    current.appendChild(el("code", { className: "host-trust-fingerprint" }, fingerprint));
    card.appendChild(current);

    const actions = el("div", { className: "host-form-actions" });
    if (mismatch) {
      const closeButton = el("button", { type: "button", "data-role": "host-trust-cancel" }, "关闭");
      closeButton.addEventListener("click", () => trustModal.close());
      actions.appendChild(closeButton);
    } else {
      const trustButton = el("button", { type: "button", "data-role": "host-trust-accept" }, "信任并记住");
      trustButton.addEventListener("click", async () => {
        trustButton.disabled = true;
        const result = await api.trustHost(host.id, fingerprint);
        trustButton.disabled = false;
        if (!result.ok) {
          onNotice(result.userText || `记指纹失败（${result.code}）`, "warn");
          return;
        }
        trustModal.close();
        await refreshHosts();
        // 调用方给了 onTrusted 就用它（例如「测试连接」里只重跑测试，不建会话）。
        if (typeof onTrusted === "function") await onTrusted(host);
        else onCreateSession(host);
      });
      const cancelButton = el("button", { type: "button", "data-role": "host-trust-cancel" }, "取消");
      cancelButton.addEventListener("click", () => trustModal.close());
      actions.append(trustButton, cancelButton);
    }
    card.appendChild(actions);
    trustModal.open({ onClose: () => {} });
  }

  async function checkFingerprint(host) {
    const result = await api.hostFingerprint(host.id);
    if (!result.ok) {
      onNotice(result.userText || `取不到指纹（${result.code}）`, "warn");
      return;
    }
    const info = result.data || {};
    if (info.known) {
      // 已记录且一致：直接连（不弹卡）。
      onCreateSession(host);
      return;
    }
    if (info.recorded && info.recorded.fingerprint && info.recorded.fingerprint !== info.fingerprint) {
      // 有记录但对不上：必须失败并显示新旧两个指纹，**不给「忽略」按钮**。
      buildTrustCard({
        host,
        algo: info.algo || "unknown",
        fingerprint: info.fingerprint || "",
        mismatch: true,
        knownFingerprint: info.recorded.fingerprint,
        knownAlgo: info.recorded.algo,
      });
      return;
    }
    buildTrustCard({
      host,
      algo: info.algo || "unknown",
      fingerprint: info.fingerprint || "",
      mismatch: false,
    });
  }
  async function connectHost(host) {
    // 只要服务端有可用凭据才去连；没有凭据先让用户编辑。
    if (!host.hasSecret && !(host.authType === "privateKey" && host.privateKeyPath)) {
      onNotice("这条主机还没有可用凭据，先编辑主机填一次。", "warn");
      openHostForm(host);
      return;
    }
    await checkFingerprint(host);
  }

  /* ---------------- 主机列表 ---------------- */

  async function refreshHosts() {
    const result = await api.hosts();
    if (!result.ok) {
      onNotice(result.userText || `读不到主机清单（${result.code}）`, "warn");
      hosts = [];
      render();
      return;
    }
    hosts = Array.isArray(result.data && result.data.hosts) ? result.data.hosts : [];
    render();
  }

  function connectedHostIds(snapshot) {
    const ids = new Set();
    for (const session of snapshot.sessions) {
      if (session.kind === "remote" && session.hostId && session.status === "running") {
        ids.add(session.hostId);
      }
    }
    return ids;
  }

  function renderHostList(snapshot) {
    const connected = connectedHostIds(snapshot);
    const list = el("div", { "data-role": "host-list" });

    if (hosts.length === 0) {
      const empty = el("p", { className: "hosts-empty" }, "还没有主机。点下面「+ 添加主机」建一条。");
      list.appendChild(empty);
      return list;
    }

    for (const host of hosts) {
      const item = el("div", {
        "data-role": "host-item",
        "data-host-id": host.id,
        "data-connected": connected.has(host.id) ? "true" : "false",
      });

      const main = el("button", { type: "button", className: "host-item-main", "data-role": "host-open" });
      const dot = el("span", { className: "host-dot", "aria-hidden": "true" });
      main.appendChild(dot);
      const text = el("span", { className: "host-item-text" });
      text.appendChild(el("span", { className: "host-name" }, host.name));
      // L1-09：地址行被 212px 面板截断时，title 提供完整 user@host:port · 认证方式。
      const addressText = `${host.username}@${host.host}:${host.port} · ${
        AUTH_LABELS[host.authType] || host.authType
      }${host.hasSecret || host.privateKeyPath ? "" : "（无凭据）"}`;
      text.appendChild(el("span", { className: "host-addr", title: addressText }, addressText));
      main.appendChild(text);
      main.addEventListener("click", () => {
        void connectHost(host);
      });
      item.appendChild(main);

      const tools = el("span", { className: "host-item-tools" });
      const edit = el("button", { type: "button", "data-role": "host-edit", "aria-label": `编辑 ${host.name}` }, "编辑");
      edit.addEventListener("click", (event) => {
        event.stopPropagation();
        openHostForm(host);
      });
      const remove = el("button", { type: "button", "data-role": "host-delete", "aria-label": `删除 ${host.name}` }, "删除");
      remove.addEventListener("click", async (event) => {
        event.stopPropagation();
        const result = await api.deleteHost(host.id);
        if (!result.ok) {
          onNotice(result.userText || `删不掉（${result.code}）`, "warn");
          return;
        }
        await refreshHosts();
        onNotice(`已删除主机 ${host.name}。`, "ok");
      });
      // 右键也能出「编辑 / 删除」：直接把工具按钮显示出来（CSS 靠 hover/focus 显示）。
      main.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        item.setAttribute("data-tools", "true");
        item.querySelector('[data-role="host-edit"]')?.focus();
      });
      tools.append(edit, remove);
      item.appendChild(tools);
      list.appendChild(item);
    }
    return list;
  }

  function render() {
    if (!opened) return;
    const snapshot = store.getSnapshot();
    panel.textContent = "";

    const header = el("div", { className: "hosts-header" });
    header.appendChild(el("strong", { className: "hosts-title" }, "主机"));
    const addButton = el("button", { type: "button", "data-role": "host-add" }, "+ 添加");
    addButton.addEventListener("click", () => openHostForm(null));
    header.appendChild(addButton);
    const closeButton = el("button", { type: "button", "data-role": "hosts-close", "aria-label": "收起主机面板" }, "×");
    closeButton.addEventListener("click", () => close());
    header.appendChild(closeButton);
    panel.appendChild(header);

    // TASK-V4-G：主机与文件分家。文件不再作为主机面板里的一个 tab ——
    // 文件面板是终端下方的常驻区域（rail-files 开合）。这里只留一个按钮
    // 把用户送过去，避免同一个信息出现两个入口两份实现。
    const tabs = el("div", { className: "hosts-tabs", role: "tablist" });
    const filesButton = el("button", {
      type: "button",
      "data-role": "hosts-open-files",
      "data-tab": "files",
      title: "文件在终端下方的文件面板里",
    }, "文件面板");
    filesButton.addEventListener("click", () => {
      close();
      if (typeof onOpenFiles === "function") onOpenFiles();
    });
    tabs.appendChild(filesButton);
    panel.appendChild(tabs);

    const body = el("div", { className: "hosts-body" });
    // 固定在最顶上的「本机」条目（TASK-V4-F §5.4）。
    body.appendChild(renderLocalRow());
    body.appendChild(renderHostList(snapshot));
    panel.appendChild(body);

    const footer = el("div", { className: "hosts-footer" });
    const addHost = el("button", { type: "button", "data-role": "host-add-footer" }, "+ 添加主机");
    addHost.addEventListener("click", () => openHostForm(null));
    footer.appendChild(addHost);
    panel.appendChild(footer);
  }

  function syncCurrentSession(snapshot) {
    const active = snapshot.sessions.find((s) => s.id === snapshot.activeId) || null;
    const nextId = active && active.kind === "remote" ? active.id : null;
    if (nextId === currentSessionId) return;
    currentSessionId = nextId;
    const host = nextId ? snapshot.sessions.find((s) => s.id === nextId) : null;
  }

  return {
    init() {
      store.subscribe((snapshot) => {
        if (!opened) return;
        syncCurrentSession(snapshot);
        render();
      });
    },
    get isOpen() {
      return opened;
    },
    open() {
      if (opened) return;
      opened = true;
      panel.hidden = false;
      panel.setAttribute("data-open", "true");
      syncPanelTop();
      syncCurrentSession(store.getSnapshot());
      // 先拉 shell 清单再画，避免下拉先空后填的抖动；拉不到也要把面板画出来。
      void refreshShells().then(() => {
        if (opened) render();
      });
      render();
      void refreshHosts();
      document.addEventListener("mousedown", onDocumentPointerDown, true);
    },
    close,
    toggle() {
      if (opened) close();
      else this.open();
    },
    refreshHosts,
    /** TASK-V4-F：shell 清单可能变了（装了 pwsh / 改了配置），打开面板前刷一次。 */
    refreshShells,
    /** 远程标签建立 / 关闭后由 app.js 调用：刷新绿点与文件树绑定。 */
    sync() {
      if (opened) syncPanelTop();
      syncCurrentSession(store.getSnapshot());
      if (opened) render();
    },
  };

  function close() {
    if (!opened) return;
    opened = false;
    panel.hidden = true;
    panel.setAttribute("data-open", "false");
    document.removeEventListener("mousedown", onDocumentPointerDown, true);
    formModal.close();
    trustModal.close();
  }
}
