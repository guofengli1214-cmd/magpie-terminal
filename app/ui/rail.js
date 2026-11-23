// 左侧图标栏：终端 / 主机 / AI / 设置。
//
// TASK-V3-C 起：
// - rail-term     默认 active；点击只切「视图名」，为下一张卡的分屏留钩子。
// - rail-hosts    HTML 里带 hidden，由 app.js 在 init 时解锁并接到主机面板。
// - rail-ai       开合右侧 AI 抽屉；有待确认时 data-pending>0 并显示小圆点。
// - rail-settings 真正打开设置模态（V2-A 遗留的空监听体已补上）。
//
// 视图只订阅 store，不直接改字段。

export default function createRail(elements) {
  const host = elements.host;
  const store = elements.store;
  const onToggleAi = typeof elements.onToggleAi === "function" ? elements.onToggleAi : () => {};
  const onOpenSettings =
    typeof elements.onOpenSettings === "function" ? elements.onOpenSettings : () => {};

  let unsubscribe = null;

  function button(role) {
    return host.querySelector(`[data-role="${role}"]`);
  }

  function render(snapshot) {
    const aiOpen = snapshot.aiOpen === true;
    const aiButton = button("rail-ai");
    if (aiButton) {
      aiButton.setAttribute("aria-pressed", aiOpen ? "true" : "false");
      // 有未读回答或待确认时点小圆点（V3 的待确认另有把手角标 + toast）。
      const pending = Number(snapshot.pendingCount) || 0;
      const unread = snapshot.aiUnread === true || pending > 0;
      aiButton.setAttribute("data-unread", unread ? "true" : "false");
      aiButton.setAttribute("data-pending", String(pending));
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
          onOpenSettings();
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
