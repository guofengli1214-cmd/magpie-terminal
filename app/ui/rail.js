// 左侧图标栏：终端 / 主机 / 设置。
//
// V4-E：AI 入口已从图标栏删除（rail-ai / rail-unread 不再存在），
// 开合只由主区右边缘的 ai-handle 负责。
// - rail-term     默认 active；点击只切「视图名」，为下一张卡的分屏留钩子。
// - rail-hosts    HTML 里带 hidden，由 app.js 在 init 时解锁并接到主机面板。
// - rail-settings 真正打开设置模态（V2-A 遗留的空监听体已补上）。
//
// 视图只订阅 store，不直接改字段。

export default function createRail(elements) {
  const host = elements.host;
  const store = elements.store;
  const onOpenSettings =
    typeof elements.onOpenSettings === "function" ? elements.onOpenSettings : () => {};

  let unsubscribe = null;

  function button(role) {
    return host.querySelector(`[data-role="${role}"]`);
  }

  function render() {
    // 图标栏只保留终端 / 主机 / 设置；没有 AI 待确认小圆点。
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

      const settings = button("rail-settings");
      if (settings) {
        settings.addEventListener("click", () => {
          onOpenSettings();
        });
      }

      unsubscribe = store.subscribe(render);
      render();
    },
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
  };
}
