// 终端底部悬浮球输入（TASK-FIX17-L2 / 用户问题清单第 2 条）。
//
// 用户原话：「我想在终端的下方的中间做一个悬浮半透明的球形，当鼠标移过去就往右展开为
// 输入框，只要输入了内容鼠标移开不会变回球，只会变半透明，输入框输入和 ai 栏打开的输入
// 是一样的，只是不需要打开 ai 栏再输入。」
//
// 三条**不可自作聪明**的行为（PRD §R3，逐条落在这里）：
//   1. 鼠标移上去**必定**展开，不管有没有文字；
//   2. 有文字时移开 → 保持展开、只把不透明度降到 .55（绝不收回成球）；
//   3. 球里发送**不打开** AI 栏（由 app.js 的 onAsk 第三参 {openDrawer:false} 保证）。
//
// 本文件只做「一个 DOM 容器 + 一组事件 + 一个状态机」，不发任何网络帧：
// 发送 / 停止都通过注入的回调交给 app.js（与抽屉同一条链路），因此两处的
// 校验、门禁、忙碌判定天然一致。
//
// 状态（挂在根节点的属性上，CSS 只按属性切换形态）：
//   data-state = "ball" | "open" | "open-muted"
//   data-busy  = "true" | "false"
//   ball     收起：38×38 圆球，opacity .72
//   open     展开：360×40 胶囊，opacity 1
//   open-muted 展开但有内容且鼠标/焦点都不在上面：opacity .55（不收回）
//   busy     球/动作按钮变「红环 + 深色圆心」的停止形态（颜色全走 --term-* 变量）

import constants from "../core/constants.js";

/** 与抽屉同文案（R4 逐字；共用常量避免两处漂移，见 core/constants.js）。 */
const EMPTY_QUESTION_TEXT = constants.EMPTY_QUESTION_TEXT;
const BLOCKED_PENDING_TEXT = constants.BLOCKED_PENDING_TEXT;

/** 输入框 placeholder（R4：Enter 发送、Shift+Enter 换行，与抽屉一致）。 */
const ORB_PLACEHOLDER = "问点什么…（Enter 发送 · Shift+Enter 换行）";

/** 收起态图标：`›_` 风格的内联描边 SVG（F-11：不许用 emoji）。 */
const ORB_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 7.5l4.6 4.5L6 16.5"/><path d="M13 16.5h5.2"/></svg>';

/** 展开态动作按钮：发送（↑）/ 停止（■），与抽屉 composer-action 同一套视觉语言。 */
const SEND_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const STOP_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="7" y="7" width="10" height="10" rx="1.6"/></svg>';

/** 极小的 DOM 工厂（同 ai-drawer 的 el，不引依赖）。 */
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

/**
 * 创建终端底部悬浮球。
 *
 * @param {object} [options]
 * @param {Element} [options.mount] 父节点（默认 document.body）
 * @param {(payload: {question: string, model: string|null}, opts: {openDrawer: boolean}) => string} [options.onAsk]
 *   与抽屉同一个发送入口，返回 "sent" | "blocked-pending" | "no-active" | "send-failed"
 * @param {() => void} [options.onStop] 停止当前任务（复用 app.js 的 onStop）
 * @param {() => (string|null)} [options.getModel] 当前模型 id（与抽屉选中的一致）
 * @param {() => boolean} [options.getBusy] 是否忙碌（与 agentStore 同源）
 * @param {() => number} [options.getPendingCount] 待确认条数（门禁与抽屉同一判断）
 * @param {(text: string, kind: string) => void} [options.onNotice] 状态栏提示
 * @returns {{ setBusy(busy: boolean): boolean, destroy(): void, get state(): string }}
 */
export default function createCommandOrb(options = {}) {
  const {
    mount = document.body,
    onAsk = () => "no-active",
    onStop = () => {},
    getModel = () => null,
    getBusy = () => false,
    getPendingCount = () => 0,
    onNotice = () => {},
  } = options || {};

  const host = mount || document.body;

  let destroyed = false;
  let hover = false;
  let focused = false;
  let busy = Boolean(safeCall(getBusy, false));

  /* ---------------- DOM ---------------- */

  const root = el("div", {
    "data-role": "command-orb",
    className: "command-orb",
    "data-state": "ball",
    "data-busy": "false",
  });

  // 收起态：一个圆球按钮（触屏 / 键盘都能点到）。
  const ball = el("button", {
    type: "button",
    "data-role": "orb-ball",
    className: "orb-ball",
    "aria-label": "AI 输入",
    title: "AI 输入（Enter 发送）",
  });
  ball.innerHTML = ORB_ICON;

  // 展开态：单行输入 + 右侧动作按钮（发送/停止同一节点，同 D 批的视觉语言）。
  const form = el("div", { className: "orb-form" });
  const input = el("textarea", {
    "data-role": "orb-input",
    className: "orb-input",
    rows: "1",
    placeholder: ORB_PLACEHOLDER,
    "aria-label": "AI 输入",
    spellcheck: "false",
    autocomplete: "off",
  });
  const action = el("button", {
    type: "button",
    "data-role": "orb-action",
    className: "orb-action",
    "aria-label": "发送",
    title: "发送（Enter）",
  });
  action.innerHTML = SEND_ICON;
  form.append(input, action);

  root.append(ball, form);
  host.appendChild(root);

  /* ---------------- 状态机 ---------------- */

  function safeCall(fn, fallback) {
    try {
      return typeof fn === "function" ? fn() : fallback;
    } catch {
      return fallback;
    }
  }

  function hasContent() {
    return input.value.trim().length > 0;
  }

  /** Esc 之后的一次「压住」：鼠标不先离开再回来，就不自动展开（R3 的 Esc 要能收回）。 */
  let suppressExpand = false;

  /**
   * 单一同步点：所有事件都只改三个原始量（hover / focused / busy），
   * 由这里算出 data-state / data-busy / 按钮形态。这样任何路径都不会漏更新。
   */
  function sync() {
    if (destroyed) return;
    const content = hasContent();
    // 用户原话 1：鼠标移上去**必定**展开（不管有没有文字）；
    // 有内容或有焦点也保持展开（用户原话 2：有内容移开不收回）。
    const wantExpanded = !suppressExpand && (hover || focused || content);
    // 用户原话 2 的精确落点：**只看鼠标**。有内容 + 鼠标移开 → open-muted（.55），
    // 与焦点在哪无关 —— 用户的描述就是「输入了内容鼠标移开只会变半透明」。
    // （焦点只在「输入框为空」时单独维持展开，见 R3：有焦点但为空 → 展开到失焦。）
    const nextState = !wantExpanded ? "ball" : content && !hover ? "open-muted" : "open";
    if (root.getAttribute("data-state") !== nextState) root.setAttribute("data-state", nextState);

    root.setAttribute("data-busy", busy ? "true" : "false");
    ball.setAttribute("aria-label", busy ? "停止" : "AI 输入");
    ball.title = busy ? "停止当前任务" : "AI 输入（Enter 发送）";
    action.setAttribute("aria-label", busy ? "停止" : "发送");
    action.title = busy ? "停止（现在就能停）" : "发送（Enter）";
    action.setAttribute("data-state", busy ? "busy" : "idle");
    const icon = busy ? STOP_ICON : SEND_ICON;
    // 只在真变了才写 innerHTML（避免每帧重建 SVG 导致子节点闪烁）。
    const iconKey = busy ? "stop" : "send";
    if (action.dataset.icon !== iconKey) {
      action.dataset.icon = iconKey;
      action.innerHTML = icon;
    }
  }

  /** 展开 + 把焦点给输入框（点球 / 键盘激活都走这里）。 */
  function expandAndFocus() {
    suppressExpand = false;
    focused = true;
    sync();
    try {
      // preventScroll 是硬要求：裸 focus() 会让浏览器把元素滚进可视区（FIX17-D 问题 7）。
      input.focus({ preventScroll: true });
    } catch {
      try {
        input.focus();
      } catch {
        // 老内核：忽略。
      }
    }
  }

  function collapse() {
    suppressExpand = true;
    focused = false;
    sync();
  }

  /* ---------------- 发送 / 停止 ---------------- */

  /**
   * 发送（R4）：空内容 / 有待确认时只提示；成功后清空输入并收回（鼠标还在上面则保持展开）。
   * @returns {"sent"|"blocked-pending"|"empty"|"stopped"|string}
   */
  function send() {
    const question = input.value.trim();
    if (!question) {
      safeNotice(EMPTY_QUESTION_TEXT, "warn");
      return "empty";
    }
    // 忙碌态：动作按钮就是停止按钮（R5「点发送等于停止」）。不带内容进来时不误伤：
    // 用户真的在这个球里按了发送，语义就是「停下，我要说别的」。
    if (busy || safeCall(getBusy, false)) {
      doStop();
      return "stopped";
    }
    // 门禁与抽屉同一句提示（BLOCKED_PENDING_TEXT）；app.js 的 askAgent 里还会再判一次。
    if (Number(safeCall(getPendingCount, 0)) > 0) {
      safeNotice(BLOCKED_PENDING_TEXT, "warn");
      return "blocked-pending";
    }
    let result = "send-failed";
    try {
      // 第三条硬要求：**不打开** AI 栏（第三个参数由 app.js 消费，默认仍是打开）。
      result = onAsk({ question, model: safeCall(getModel, null) }, { openDrawer: false });
    } catch {
      result = "send-failed";
    }
    if (result !== "sent") {
      // 具体原因 app.js 已经在状态栏说过了（no-active / send-failed / blocked-pending）。
      return result || "send-failed";
    }
    input.value = "";
    try {
      input.blur();
    } catch {
      // 忽略。
    }
    focused = false;
    // 鼠标还在球上 → 保持展开；否则收回成球（R4 逐字）。
    if (!hover) collapse();
    else sync();
    return "sent";
  }

  function doStop() {
    try {
      onStop();
    } catch {
      // 忽略。
    }
    sync();
  }

  function safeNotice(text, kind) {
    try {
      onNotice(text, kind);
    } catch {
      // 忽略。
    }
  }

  /* ---------------- 事件 ---------------- */

  // 1) 球：忙碌 = 停止；否则展开并聚焦。
  ball.addEventListener("click", () => {
    if (busy) {
      doStop();
      return;
    }
    expandAndFocus();
  });

  // 2) 动作按钮：忙碌 = 停止；否则发送。
  action.addEventListener("click", () => {
    if (busy || safeCall(getBusy, false)) {
      doStop();
      return;
    }
    send();
  });

  // 3) 输入框键盘：Esc 收回；Enter 发送；Shift+Enter 换行（不拦默认行为）。
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return; // 中文输入法选词中的回车不发送（与抽屉一致）
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (hasContent()) input.value = "";
      try {
        input.blur();
      } catch {
        // 忽略。
      }
      collapse();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  });

  // 4) 输入变化：按钮形态 / 展开态要跟着「有没有内容」走。
  input.addEventListener("input", () => {
    suppressExpand = false;
    // 「清空后移开 → 收回 38px」（AC3）：鼠标不在球上时把内容删干净，就真的收回，
    // 连焦点一起交出去 —— 否则焦点会把它一直撑开着，用户看到的是「清空了还不走」。
    // 鼠标还在球上时不收（用户正在改字，收走等于抢焦点）。
    if (!hasContent() && !hover) {
      collapse();
      return;
    }
    sync();
  });

  // 5) 焦点进出一律同步（有焦点但为空 = 保持展开到失焦）。
  root.addEventListener("focusin", (event) => {
    // 只有**输入框**拿到焦点才展开。球自己拿到焦点（Tab / 键盘）时不许展开 ——
    // 展开会 display:none 掉球，焦点当场丢给 body，键盘用户就再也点不到了。
    // 球上的 Enter/Space 走原生 click → expandAndFocus()，那条路径是对的。
    focused = event.target === input;
    if (focused) suppressExpand = false;
    sync();
  });
  root.addEventListener("focusout", () => {
    // relatedTarget 还在容器里（在球与输入框之间移动）不算失焦。
    focused = false;
    setTimeout(() => {
      if (destroyed) return;
      if (root.contains(document.activeElement)) {
        focused = true;
      }
      sync();
    }, 0);
  });

  /**
   * 6) 悬停：用 document 上的捕获监听做命中测试，而不是只靠 pointerenter/leave。
   *
   * 为什么三个监听：pointerenter/leave 在真浏览器里最准，但合成输入（自动化探针、
   * 老 WebView2）有时只发 mousemove；命中测试用 container.contains(target) 判定，
   * 天然不会因为「移到子元素上」被误判成离开（mouseleave 也一样不会，但双保险）。
   */
  function onPointerMove(event) {
    const inside = root.contains(event.target);
    if (inside === hover) return;
    hover = inside;
    if (inside) {
      suppressExpand = false;
      sync();
      return;
    }
    // 移出：空内容 → 收回（连焦点一起交出去）；有内容 → 只降不透明度。
    if (!hasContent()) {
      collapse();
      return;
    }
    sync();
  }

  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("mousemove", onPointerMove, true);
  root.addEventListener("pointerenter", () => {
    if (hover) return;
    hover = true;
    suppressExpand = false;
    sync();
  });
  root.addEventListener("pointerleave", (event) => {
    // 移到子元素上不算离开（pointerleave 本身不会，但合成输入可能给错 relatedTarget）。
    if (event.relatedTarget && root.contains(event.relatedTarget)) return;
    hover = false;
    // 空内容时鼠标一走就收回（含交出焦点）；有内容只降不透明度（R3 逐字）。
    if (!hasContent()) {
      collapse();
      return;
    }
    sync();
  });
  function onDocumentLeave() {
    if (!hover) return;
    hover = false;
    if (!hasContent()) {
      collapse();
      return;
    }
    sync();
  }
  document.addEventListener("mouseleave", onDocumentLeave);

  // 7) 外部（其它模块）改了忙碌态时，下一次交互前也能对上。
  sync();

  /* ---------------- 对外接口 ---------------- */

  return {
    /**
     * 忙碌态（与抽屉的 agentStore.status 同源，由 app.js 在帧分发处调用）。
     * @param {boolean} value
     */
    setBusy(value) {
      const next = Boolean(value);
      if (next === busy) return busy;
      busy = next;
      sync();
      return busy;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("mousemove", onPointerMove, true);
      document.removeEventListener("mouseleave", onDocumentLeave);
      root.remove();
    },
    /** 只读：给探针 / 测试看当前几何态（"ball" | "open" | "open-muted"）。 */
    get state() {
      return root.getAttribute("data-state");
    },
    /** 只读：根节点（供 app.js 之外需要挂事件的地方用，正常不用）。 */
    get element() {
      return root;
    },
    /** 测试用：读/写输入框的值（不参与业务逻辑）。 */
    get value() {
      return input.value;
    },
  };
}
