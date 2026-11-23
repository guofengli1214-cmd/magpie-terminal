// 左侧图标栏：终端 / 主机 / AI / 设置。
//
// 本卡范围（TASK-V2-A §2.1）：
// - rail-term   默认 active；点击只切「视图名」，为下一张卡的分屏留钩子。
// - rail-hosts  只渲染，HTML 里带 hidden；点击 no-op，绝不报错。
// - rail-ai     切换 AI 输入条 + 浮层；有未读回复时 data-unread="true" 并显示小圆点。
// - rail-settings 只渲染，点击无副作用。
//
// 视图只订阅 store，不直接改字段。

export default function createRail(elements) {
  const host = elements.host;
  const store = elements.store;
  const onToggleAi = typeof elements.onToggleAi === "function" ? elements.onToggleAi : () => {};

  let unsubscribe = null;

  function button(role) {
    return host.querySelector(`[data-role="${role}"]`);
  }

  function render(snapshot) {
    const aiOpen = snapshot.aiOpen !== false;
    const aiButton = button("rail-ai");
    if (aiButton) {
      aiButton.setAttribute("aria-pressed", aiOpen ? "true" : "false");
      const unread = snapshot.aiUnread === true;
      aiButton.setAttribute("data-unread", unread ? "true" : "false");
      const dot = aiButton.querySelector('[data-role="rail-unread"]');
      if (dot) dot.hidden = !unread;
    }
  }

  return {
    init() {
      const term = button("rail-term");
      if (term) {
        term.addEventListener("click", () => {
          // 目前只有一个视图：保持 active 即可。按钮本身是 no-op 的安全实现。
          term.setAttribute("data-active", "true");
        });
      }

      const hosts = button("rail-hosts");
      if (hosts) {
        // TASK-V2-A 明确要求：本卡只渲染按钮并 hidden，点击 no-op 且不报错。
        hosts.addEventListener("click", () => {
          // 下一张卡接管：主机面板从左侧滑出。
        });
      }

      const ai = button("rail-ai");
      if (ai) {
        ai.addEventListener("click", () => {
          onToggleAi();
        });
      }

      const settings = button("rail-settings");
      if (settings) {
        settings.addEventListener("click", () => {
          // 本卡只渲染，点击无副作用。
        });
      }

      unsubscribe = store.subscribe(render);
      render(store.getSnapshot());
    },
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
  };
}
