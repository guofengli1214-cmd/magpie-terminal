// 底部 AI 输入条：模型下拉 + 单行输入 + 「问」按钮。
//
// 职责边界（TASK-V2-A §2.2 / §2.3）：
// - 启动时并行拉 GET /api/models 与 GET /api/config；下拉默认选中 config.model，
//   配置里没有（或不在清单里）就选 /api/models 的 default。
// - 切换即 PUT /api/config；PUT 失败保留本地选择，由调用方在状态栏闪现提示。
// - 提问帧带 model；空输入拦截与 Enter 提交不许退化。
// - available===false 的项仍可选，但标灰 + 尾注「（上次失败）」，选中时在下方
//   一行小字提示 note。
// - 网关不可达时下拉只有一个「网关不可用，点重试」项（不是空白下拉），
//   选中它即重新拉 /api/models。
//
// 结果渲染归 app/ui/ai-panel.js；这里只发问题。

const RETRY_VALUE = "__retry__";

export default function createAiBar(elements) {
  const store = elements.store;
  const select = elements.select;
  const input = elements.input;
  const submitButton = elements.submit;
  const note = elements.note;
  const api = elements.api;
  const onAsk = typeof elements.onAsk === "function" ? elements.onAsk : () => false;
  const onNotice = typeof elements.onNotice === "function" ? elements.onNotice : () => {};

  let models = [];
  let reachable = false;
  let loading = false;
  let disposeFns = [];

  function setNote(text) {
    if (!note) return;
    if (text) {
      note.textContent = text;
      note.hidden = false;
    } else {
      note.textContent = "";
      note.hidden = true;
    }
  }

  function current() {
    return models.find((model) => model.id === select.value) || null;
  }

  function renderOptions(chosenId) {
    select.textContent = "";
    if (!reachable || models.length === 0) {
      const option = document.createElement("option");
      option.value = RETRY_VALUE;
      option.textContent = "网关不可用，点重试";
      select.appendChild(option);
      select.value = RETRY_VALUE;
      select.setAttribute("data-gateway", "down");
      setNote("AI 网关不可用：模型清单拉不到。点下拉重试。");
      return;
    }
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.available === false ? `${model.label}（上次失败）` : model.label;
      option.setAttribute("data-available", model.available === false ? "false" : "true");
      select.appendChild(option);
    }
    const target = models.some((model) => model.id === chosenId)
      ? chosenId
      : models[0]
        ? models[0].id
        : "";
    select.value = target;
    select.removeAttribute("data-gateway");
    updateModelNote();
  }

  function updateModelNote() {
    const model = current();
    if (model && model.available === false) {
      setNote(model.note ? `这个模型上次失败：${model.note}` : "这个模型上次失败了，可能仍不可用。");
      return;
    }
    setNote("");
  }

  function syncStoreModel() {
    const model = current();
    store.setModel(model ? model.id : null);
  }

  async function load() {
    if (loading) return;
    loading = true;
    select.setAttribute("aria-busy", "true");
    // 并行：两个都不阻塞对方，任一失败不拖死另一个。
    const [modelsResult, configResult] = await Promise.all([
      api.models(),
      api.config(),
    ]);
    loading = false;
    select.removeAttribute("aria-busy");

    if (!modelsResult.ok) {
      reachable = false;
      models = [];
      renderOptions(null);
      return;
    }
    const payload = modelsResult.data || {};
    reachable = Boolean(payload.gateway && payload.gateway.reachable);
    models = Array.isArray(payload.models) ? payload.models : [];
    const configured = configResult.ok && configResult.data ? configResult.data.model : null;
    const defaultId =
      typeof payload.default === "string" && payload.default.length > 0
        ? payload.default
        : models[0]
          ? models[0].id
          : null;
    // 配置优先，其次 default。config.model 不在清单里时退回 default。
    const wanted =
      configured && models.some((model) => model.id === configured) ? configured : defaultId;
    renderOptions(wanted);
    syncStoreModel();
  }

  async function persist(modelId) {
    const result = await api.saveConfig({ model: modelId });
    if (!result.ok) {
      // 保留本地选择，只提示没存住（下一张卡可能给出重试入口）。
      onNotice("模型偏好没存住", "warn");
      if (elements.onPersistFailed) elements.onPersistFailed(result);
    }
    return result;
  }

  // PUT 必须串行：用户快速连切两个模型时，两个 PUT 会在服务端并发执行，
  // 落盘顺序可能与点击顺序相反（实测：最后落盘的是先选的那个）。
  // 这里维护一个写链，且只写「最新一次选择」，过期的排队项直接跳过。
  let writeChain = Promise.resolve();
  let latestWanted = null;

  function persistLatest(modelId) {
    latestWanted = modelId;
    writeChain = writeChain.then(async () => {
      if (latestWanted !== modelId) return null; // 已被更新的一次选择取代
      return persist(modelId);
    });
    return writeChain;
  }

  function submit() {
    const question = input.value.trim();
    if (!question) {
      onNotice("请先输入要做什么。", "warn");
      return;
    }
    const active = store.getActive();
    if (!active) {
      onNotice("还没有可用的终端标签：先点「+」新建一个。", "warn");
      return;
    }
    const model = current();
    const sent = onAsk({ question, model: model ? model.id : null });
    if (!sent) {
      onNotice("AI 请求没发出去：连接还没就绪。点状态栏「重连」后重试。", "error");
      return;
    }
    input.value = "";
  }

  function bind() {
    const onSelectChange = () => {
      if (select.value === RETRY_VALUE) {
        void load();
        return;
      }
      updateModelNote();
      syncStoreModel();
      void persistLatest(select.value);
    };
    select.addEventListener("change", onSelectChange);
    disposeFns.push(() => select.removeEventListener("change", onSelectChange));

    const onSubmitClick = () => submit();
    submitButton.addEventListener("click", onSubmitClick);
    disposeFns.push(() => submitButton.removeEventListener("click", onSubmitClick));

    const onKeyDown = (event) => {
      if (event.key !== "Enter") return;
      if (event.shiftKey) {
        // 单行输入没有换行：按设计吞掉，绝不能变成提交。
        event.preventDefault();
        return;
      }
      if (event.isComposing) return;
      event.preventDefault();
      submit();
    };
    input.addEventListener("keydown", onKeyDown);
    disposeFns.push(() => input.removeEventListener("keydown", onKeyDown));
  }

  return {
    init() {
      bind();
      void load();
    },
    /** 供外部（状态栏 / 重试入口）重新拉清单。 */
    reload() {
      return load();
    },
    /** 当前选中的模型 id（null 表示还没有清单）。 */
    selectedModel() {
      const model = current();
      return model ? model.id : null;
    },
    focusInput() {
      try {
        input.focus();
      } catch {
        // 忽略。
      }
    },
    dispose() {
      for (const fn of disposeFns) {
        try {
          fn();
        } catch {
          // 忽略。
        }
      }
      disposeFns = [];
    },
  };
}
