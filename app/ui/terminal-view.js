// xterm 实例的创建 / attach / fit / dispose。每个标签一个 Terminal。
// resize 管道：去抖 → fit() → 发 pty.resize → 本地输入封锁并排队。

import constants from "../core/constants.js";

function readVar(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

// 颜色只来自 tokens.css 里的 CSS 变量；这里不写任何颜色字面量。
function buildTheme() {
  const pick = (name) => readVar(name) || undefined;
  return {
    background: pick("--term-bg"),
    foreground: pick("--term-fg"),
    cursor: pick("--term-fg"),
    cursorAccent: pick("--term-bg"),
    selectionBackground: pick("--term-selection"),
    black: pick("--term-ansi-black"),
    red: pick("--term-ansi-red"),
    green: pick("--term-ansi-green"),
    yellow: pick("--term-ansi-yellow"),
    blue: pick("--term-ansi-blue"),
    magenta: pick("--term-ansi-magenta"),
    cyan: pick("--term-ansi-cyan"),
    white: pick("--term-ansi-white"),
    brightBlack: pick("--term-ansi-bright-black"),
    brightRed: pick("--term-ansi-bright-red"),
    brightGreen: pick("--term-ansi-bright-green"),
    brightYellow: pick("--term-ansi-bright-yellow"),
    brightBlue: pick("--term-ansi-bright-blue"),
    brightMagenta: pick("--term-ansi-bright-magenta"),
    brightCyan: pick("--term-ansi-bright-cyan"),
    brightWhite: pick("--term-ansi-bright-white"),
  };
}

export default function createTerminalView(elements) {
  const host = elements.host;
  const onInput = typeof elements.onInput === "function" ? elements.onInput : () => {};
  const onResize = typeof elements.onResize === "function" ? elements.onResize : () => {};

  const views = new Map();

  function ensure(id) {
    if (views.has(id)) return views.get(id);
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    pane.setAttribute("data-role", "terminal-pane");
    pane.setAttribute("data-pane-id", id);
    pane.hidden = true;
    host.appendChild(pane);

    const fontSize = Number.parseInt(readVar("--term-font-size"), 10) || 13;
    const lineHeightRaw = Number.parseFloat(readVar("--term-line-height")) || 1.2;
    const fontFamily = `${readVar("--term-mono") || "ui-monospace, Menlo, Consolas, monospace"}, ui-monospace, Menlo, Consolas, monospace`;

    const terminal = new window.Terminal({
      fontFamily,
      fontSize,
      lineHeight: lineHeightRaw,
      scrollback: constants.SCROLLBACK_LINES,
      theme: buildTheme(),
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: true,
    });
    const fit = new window.FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(pane);

    const view = {
      id,
      pane,
      terminal,
      fit,
      lastCols: terminal.cols,
      lastRows: terminal.rows,
      debounceTimer: null,
      lockTimer: null,
      inputQueue: [],
      locked: false,
      observer: null,
      disposers: [],
    };

    const dataDisposable = terminal.onData((data) => {
      if (view.locked) {
        view.inputQueue.push(data);
        return;
      }
      onInput(id, data);
    });
    view.disposers.push(() => dataDisposable.dispose());

    if (typeof terminal.onBinary === "function") {
      const binaryDisposable = terminal.onBinary((data) => {
        if (view.locked) {
          view.inputQueue.push(data);
          return;
        }
        onInput(id, data);
      });
      view.disposers.push(() => binaryDisposable.dispose());
    }

    if (typeof ResizeObserver === "function") {
      view.observer = new ResizeObserver(() => scheduleFit(id));
      view.observer.observe(pane);
    }

    views.set(id, view);
    return view;
  }

  function scheduleFit(id) {
    const view = views.get(id);
    if (!view) return;
    if (view.debounceTimer) clearTimeout(view.debounceTimer);
    view.debounceTimer = setTimeout(() => {
      view.debounceTimer = null;
      fitNow(id);
    }, constants.RESIZE_DEBOUNCE_MS);
  }

  function fitNow(id) {
    const view = views.get(id);
    if (!view) return;
    if (!view.pane.isConnected || view.pane.offsetWidth <= 0 || view.pane.offsetHeight <= 0) return;
    let cols;
    let rows;
    try {
      cols = view.fit.proposeDimensions()?.cols;
      rows = view.fit.proposeDimensions()?.rows;
    } catch {
      return;
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols === view.lastCols && rows === view.lastRows) return;
    try {
      view.fit.fit();
    } catch {
      return;
    }
    view.lastCols = view.terminal.cols;
    view.lastRows = view.terminal.rows;
    onResize(id, view.lastCols, view.lastRows);

    // 输入封锁窗口：排队 onData，窗口结束后按序冲刷。
    view.locked = true;
    if (view.lockTimer) clearTimeout(view.lockTimer);
    view.lockTimer = setTimeout(() => {
      view.lockTimer = null;
      view.locked = false;
      const queued = view.inputQueue.slice();
      view.inputQueue.length = 0;
      for (const chunk of queued) onInput(id, chunk);
    }, constants.INPUT_LOCK_MS);
  }

  return {
    ensure,
    attach(id) {
      const view = ensure(id);
      for (const [otherId, other] of views) {
        const active = otherId === id;
        other.pane.hidden = !active;
        if (active) {
          other.pane.removeAttribute("inert");
          other.pane.setAttribute("aria-hidden", "false");
        } else {
          other.pane.setAttribute("inert", "");
          other.pane.setAttribute("aria-hidden", "true");
        }
      }
      // 等一帧，让容器有尺寸后再 fit。
      requestAnimationFrame(() => {
        fitNow(id);
        try {
          view.terminal.focus();
        } catch {
          // 忽略。
        }
      });
      return view;
    },
    write(id, data) {
      const view = views.get(id);
      if (!view) return;
      if (view.pane.hidden) {
        view.terminal.write(data);
        return;
      }
      view.terminal.write(data);
    },
    /** 重连后重建滚动缓冲：先清屏，再把服务端缓冲的最后一段输出写回去。 */
    replay(id, text) {
      const view = ensure(id);
      if (!text) return;
      try {
        view.terminal.reset();
      } catch {
        // 旧版本没有 reset 时忽略。
      }
      view.terminal.write(text);
    },
    writeln(id, text) {
      const view = views.get(id);
      if (!view) return;
      view.terminal.writeln(text);
    },
    clear(id) {
      const view = views.get(id);
      if (!view) return;
      view.terminal.clear();
    },
    resizeAll() {
      for (const id of views.keys()) scheduleFit(id);
    },
    refreshTheme() {
      for (const view of views.values()) {
        view.terminal.options.theme = buildTheme();
        scheduleFit(view.id);
      }
    },
    recentOutput(id, lines) {
      const view = views.get(id);
      if (!view) return "";
      const buffer = view.terminal.buffer.active;
      const wanted = Math.max(1, lines || constants.RECENT_OUTPUT_LINES);
      const start = Math.max(0, buffer.length - wanted);
      const collected = [];
      for (let i = start; i < buffer.length; i += 1) {
        const line = buffer.getLine(i);
        if (line) collected.push(line.translateToString(true));
      }
      let text = collected.join("\n").trim();
      if (text.length > constants.RECENT_OUTPUT_CHARS) {
        text = text.slice(-constants.RECENT_OUTPUT_CHARS);
      }
      return text;
    },
    colsRows(id) {
      const view = views.get(id);
      if (!view) return { cols: 80, rows: 24 };
      return { cols: view.terminal.cols, rows: view.terminal.rows };
    },
    dispose(id) {
      const view = views.get(id);
      if (!view) return;
      if (view.debounceTimer) clearTimeout(view.debounceTimer);
      if (view.lockTimer) clearTimeout(view.lockTimer);
      if (view.observer) view.observer.disconnect();
      for (const fn of view.disposers) {
        try {
          fn();
        } catch {
          // 忽略。
        }
      }
      try {
        view.terminal.dispose();
      } catch {
        // 忽略。
      }
      view.pane.remove();
      views.delete(id);
    },
    disposeAll() {
      for (const id of [...views.keys()]) this.dispose(id);
    },
  };
}
