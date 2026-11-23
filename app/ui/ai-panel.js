// AI 结果浮层 + 确认卡。
//
// V2-A 起这里不再是常驻右栏：提问输入归 app/ui/ai-bar.js（底部 44px 输入条），
// 本模块只负责「把回答渲染在 #ai-layer 里」以及确认卡的完整逻辑。
//
// 规则（不许退化）：
// - ai.reply 的 decision==="auto" 直接写入当前 PTY；否则弹确认卡，不点不动。
// - 确认卡可 Esc 关闭、焦点困在内部、关闭后焦点回到触发点。
// - 展示的命令字符串与实际写入 PTY 的字符串是同一个变量。

export default function createAiPanel(elements) {
  const host = elements.host;
  const store = elements.store;
  const onExecute = typeof elements.onExecute === "function" ? elements.onExecute : () => {};
  const onClose = typeof elements.onClose === "function" ? elements.onClose : () => {};

  let lastFocus = null;
  let backdrop = null;
  let unsub = null;

  function layer() {
    return host;
  }

  function message(text, tone) {
    const el = document.createElement("div");
    el.setAttribute("data-role", "ai-message");
    if (tone) el.setAttribute("data-tone", tone);
    el.textContent = text;
    return el;
  }

  function buildShell() {
    host.textContent = "";

    const header = document.createElement("div");
    header.className = "ai-header";
    const title = document.createElement("span");
    title.textContent = "AI 助手";
    header.appendChild(title);
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("data-role", "ai-close");
    close.textContent = "收起";
    close.addEventListener("click", () => onClose());
    header.appendChild(close);
    host.appendChild(header);

    const body = document.createElement("div");
    body.className = "ai-body";

    const label = document.createElement("div");
    label.className = "ai-label";
    label.textContent = "只读命令自动执行，其余需要你确认。问题在下方输入条里打，Enter 发送。";
    body.appendChild(label);

    const log = document.createElement("div");
    log.className = "ai-log";
    log.setAttribute("data-role", "ai-log");
    log.setAttribute("aria-live", "polite");
    body.appendChild(log);

    host.appendChild(body);
  }

  function appendMessage(text, tone) {
    const log = host.querySelector('[data-role="ai-log"]');
    if (!log) return null;
    const el = message(text, tone);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function appendQuestion(question) {
    const el = appendMessage(`已发送：${question}`, null);
    if (el) el.setAttribute("data-role-question", question);
  }

  function appendReply(reply) {
    const log = host.querySelector('[data-role="ai-log"]');
    if (!log) return;
    const box = document.createElement("div");
    box.setAttribute("data-role", "ai-message");
    box.setAttribute("data-decision", reply.decision);

    const summary = document.createElement("div");
    summary.textContent =
      reply.decision === "auto" ? "只读命令，已自动执行：" : "需要确认后才会执行：";
    box.appendChild(summary);

    const code = document.createElement("code");
    code.className = "ai-command";
    code.textContent = reply.command;
    box.appendChild(code);

    if (reply.reason) {
      const reason = document.createElement("div");
      reason.className = "ai-meta";
      reason.textContent = `理由：${reply.reason}`;
      box.appendChild(reason);
    }

    if (reply.policyHit) {
      const hit = document.createElement("div");
      hit.className = "ai-meta";
      hit.textContent = `分级命中：${reply.policyHit}`;
      box.appendChild(hit);
    }

    // 回答头显示实际用了哪个模型（frame.model 存在才有）。
    if (reply.model) {
      const model = document.createElement("div");
      model.className = "ai-message-model";
      model.setAttribute("data-role", "ai-message-model");
      model.textContent = `模型：${reply.model}`;
      box.appendChild(model);
    }

    const actions = document.createElement("div");
    actions.className = "ai-actions";
    const run = document.createElement("button");
    run.type = "button";
    run.textContent = "执行";
    run.addEventListener("click", () => execute(reply.command, run));
    actions.appendChild(run);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.addEventListener("click", () => copyCommand(reply.command, copy));
    actions.appendChild(copy);
    box.appendChild(actions);

    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
    return box;
  }

  function copyCommand(command, button) {
    const done = () => {
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = "复制";
      }, 1500);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(command).then(done).catch(() => fallbackCopy(command, done));
      return;
    }
    fallbackCopy(command, done);
  }

  function fallbackCopy(text, done) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      // 复制失败：让用户手动选中。
    }
    area.remove();
  }

  function execute(command, trigger) {
    const active = store.getActive();
    if (!active) {
      appendMessage("当前没有活动终端标签，命令没有执行。", "error");
      return;
    }
    // 展示的字符串与实际写入的字符串是同一个变量。
    onExecute(active.id, command);
    appendMessage(`已写入当前标签：${command}`, null);
    if (trigger) trigger.disabled = true;
  }

  function openConfirm(reply) {
    if (backdrop) closeConfirm({ restoreFocus: false });
    lastFocus = document.activeElement;

    backdrop = document.createElement("div");
    backdrop.setAttribute("data-role", "confirm-backdrop");
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "confirm-title");

    const card = document.createElement("div");
    card.setAttribute("data-role", "confirm-card");

    const heading = document.createElement("h2");
    heading.id = "confirm-title";
    heading.textContent = "确认要执行这条命令吗？";
    card.appendChild(heading);

    const where = document.createElement("p");
    where.className = "ai-meta";
    where.textContent = "将在当前标签执行（与手敲命令共用同一个 shell）。";
    card.appendChild(where);

    const code = document.createElement("code");
    code.className = "ai-command";
    code.setAttribute("data-role", "confirm-command");
    code.textContent = reply.command;
    card.appendChild(code);

    if (reply.reason) {
      const reason = document.createElement("p");
      reason.className = "ai-meta";
      reason.textContent = `理由：${reply.reason}`;
      card.appendChild(reason);
    }

    if (reply.model) {
      const model = document.createElement("p");
      model.className = "ai-meta";
      model.setAttribute("data-role", "confirm-model");
      model.textContent = `模型：${reply.model}`;
      card.appendChild(model);
    }

    const actions = document.createElement("div");
    actions.className = "ai-actions";

    const run = document.createElement("button");
    run.type = "button";
    run.setAttribute("data-role", "confirm-run");
    run.textContent = "执行";
    run.addEventListener("click", () => {
      const command = reply.command;
      closeConfirm({ restoreFocus: false });
      execute(command, null);
    });
    actions.appendChild(run);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.setAttribute("data-role", "confirm-copy");
    copy.textContent = "复制";
    copy.addEventListener("click", () => copyCommand(reply.command, copy));
    actions.appendChild(copy);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.setAttribute("data-role", "confirm-cancel");
    cancel.textContent = "取消（Esc）";
    cancel.addEventListener("click", () => closeConfirm({ restoreFocus: true }));
    actions.appendChild(cancel);

    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirm({ restoreFocus: true });
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = card.querySelectorAll("button, [href], input, textarea, [tabindex]:not([tabindex='-1'])");
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

    run.focus();
  }

  function closeConfirm({ restoreFocus }) {
    if (!backdrop) return;
    const target = lastFocus;
    backdrop.remove();
    backdrop = null;
    lastFocus = null;
    if (restoreFocus && target && typeof target.focus === "function") target.focus();
  }

  return {
    init() {
      buildShell();
      unsub = store.subscribe(() => {
        // 活动标签变化不影响浮层本身，这里只保证自身仍挂在 DOM 上。
      });
    },
    appendQuestion,
    onReply(frame) {
      if (!frame.command) {
        appendMessage("AI 没有给出命令，只回了说明。", "warn");
        return;
      }
      const reply = {
        command: frame.command,
        reason: frame.reason || "",
        decision: frame.decision === "auto" ? "auto" : "confirm",
        policyHit: frame.policyHit || "",
        model: typeof frame.model === "string" ? frame.model : "",
      };
      appendReply(reply);
      if (reply.decision === "auto") {
        execute(reply.command, null);
      } else {
        openConfirm(reply);
      }
    },
    onError(frame) {
      appendMessage(
        `${frame.userText || "AI 暂时不可用，命令仍可手动输入。"}（${frame.code || "AI_ERROR"}）`,
        "error",
      );
    },
    closeConfirm,
    dispose() {
      if (unsub) unsub();
      unsub = null;
      if (backdrop) closeConfirm({ restoreFocus: false });
      host.textContent = "";
    },
  };
}
