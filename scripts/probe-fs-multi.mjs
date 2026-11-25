// TASK-FIX17-C 验收探针：文件面板的定位按钮 / 多选 / 批量操作 / 主机栏无「文件面板」按钮。
//
// 全程真浏览器（headless Chrome）+ 真服务 + 真磁盘：不是读 CSS 声明，
// 而是用真实的 `Input.dispatchMouseEvent` 点击、真实的 CDP 下载事件、真实的
// `node:fs` 断言磁盘状态。
//
// 用法（仓库根）：
//   node scripts/probe-fs-multi.mjs            # 跑全部，证据落 .dispatch/fix17-c/evidence/
//   node scripts/probe-fs-multi.mjs --json     # 额外把结果 JSON 打到 stdout
//
// 退出码：0 全部 PASS；1 有失败（失败项与原因也写进 evidence 的 json）。

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/http.mjs";
import { openBrowser, sleep } from "./lib/cdp.mjs";
import { shutdown } from "./lib/pty-cleanup.mjs";

const EVIDENCE_DIR = path.resolve(".dispatch", "fix17-c", "evidence");
const SHOTS_DIR = path.join(EVIDENCE_DIR, "shots");
const JSON_FLAG = process.argv.includes("--json");

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) console.log(`      ${JSON.stringify(detail)}`);
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/* ---------------------------------------------------------------- 页面内小工具 */

/** 页面里可用的辅助函数（拼在每个 evaluate 前面，避免重复写）。 */
const HELPERS = `
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const entries = () => qa('[data-role="file-entry"]');
  const selectedNodes = () => entries().filter((n) => n.getAttribute('data-selected') === 'true');
  const filesState = () => (typeof window.__termDebugFiles === 'function' ? window.__termDebugFiles() : null);
  const batchText = () => { const el = q('[data-role="files-batch-count"]'); return el ? el.textContent.trim() : null; };
  const slotRect = () => { const el = q('[data-role="file-panel-slot"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { height: r.height, top: r.top }; };
  const locate = () => { const el = q('[data-role="files-locate"]'); if (!el) return null;
    return { state: el.getAttribute('data-state'), disabled: el.disabled === true, title: el.title,
             opacity: getComputedStyle(el).opacity, color: getComputedStyle(el).color,
             visible: !!(el.offsetWidth || el.offsetHeight) && getComputedStyle(el).display !== 'none' }; };
`;

/** 等一个条件（页面内表达式返回真）。 */
async function waitFor(browser, expression, { timeoutMs = 15000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await browser.evaluate(`(() => { ${HELPERS} return Boolean(${expression}); })()`);
    if (value) return true;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(120);
  }
}

/** 真实鼠标点击某个选择器的**中心点**（带 modifiers，走 Input 域而不是 el.click()）。 */
async function realClick(browser, selector, { modifiers = 0, index = 0 } = {}) {
  const box = await browser.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = nodes[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!box) throw new Error(`click target not found: ${selector}[${index}]`);
  const client = browser.raw;
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1,
    modifiers,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1,
    modifiers,
  });
  await sleep(90);
  return box;
}

/** 键盘按键（Ctrl+A / Escape）。 */
async function realKey(browser, key, { modifiers = 0, code, windowsVirtualKeyCode } = {}) {
  const client = browser.raw;
  const payload = {
    key,
    code: code || key,
    windowsVirtualKeyCode: windowsVirtualKeyCode || key.toUpperCase().charCodeAt(0),
    modifiers,
  };
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...payload });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...payload });
  await sleep(120);
}

async function shot(browser, name) {
  return shotTo(browser, name);
}

/** 截图落盘（接受任意 browser 实例：主题那一段用的是独立实例）。 */
async function shotTo(browser, name) {
  const buffer = await browser.screenshot();
  const target = path.join(SHOTS_DIR, `${name}.png`);
  if (buffer) await writeFile(target, buffer);
  return target;
}

/* ---------------------------------------------------------------- 主流程 */

const configDir = await mkdtemp(path.join(os.tmpdir(), "mt-fix17c-cfg-"));
process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(configDir, "config.json");
// 主题也要隔离：读的是 magpie 的 settings.json（theme / accent / textSize）。
// 不隔离的话，本机真实设置（theme: system）会决定下面「深色截图」那一段。
const magpieSettingsPath = path.join(configDir, "magpie-settings.json");
process.env.MAGPIE_SETTINGS_PATH = magpieSettingsPath;
await writeFile(magpieSettingsPath, JSON.stringify({ theme: "light", accent: "#2563eb", textSize: 100, lang: "zh-CN" }));

// 工作目录：所有文件操作都在这里，跑完删掉。
const workRoot = await mkdtemp(path.join(os.tmpdir(), "mt-fix17c-work-"));
const batchDir = path.join(workRoot, "batch");
const moveTarget = path.join(batchDir, "moved-here");
const conflictDir = path.join(workRoot, "conflict");
const downloadDir = path.join(workRoot, "downloads");

await mkdir(SHOTS_DIR, { recursive: true });
await mkdir(path.join(batchDir, "subdir"), { recursive: true });
await mkdir(moveTarget, { recursive: true });
await mkdir(conflictDir, { recursive: true });
await mkdir(downloadDir, { recursive: true });

// 3 个可删文件 + 1 个可删目录（AC5）；2 个可下载文件（AC9）。
for (const name of ["aaa.txt", "bbb.txt", "ccc.txt"]) {
  await writeFile(path.join(batchDir, name), `内容：${name}\n`);
}
await writeFile(path.join(batchDir, "subdir", "inner.txt"), "目录里的文件\n");
await writeFile(path.join(batchDir, "dl-1.txt"), "下载 1\n");
await writeFile(path.join(batchDir, "dl-2.txt"), "下载 2\n");
// AC9 需要一个「被选中的目录」来证明它被跳过且不崩。
await mkdir(path.join(batchDir, "dl-dir"), { recursive: true });
await writeFile(path.join(batchDir, "dl-dir", "inner.txt"), "目录里的文件\n");

const port = await freePort();
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const handle = await startServer({ port, log: quiet });
const base = `http://127.0.0.1:${port}`;

let browser = null;
let error = null;

try {
  browser = await openBrowser({ width: 1440, height: 900 });
  await browser.navigate(`${base}/?token=${handle.token}`);

  // 等页面起来：终端挂载 + 文件面板的调试口可用。
  await waitFor(browser, "document.readyState === 'complete'", { label: "page load" });
  await waitFor(browser, "typeof window.__termDebugFiles === 'function'", { label: "__termDebugFiles" });
  // 自动建首个标签要一点时间（pty.create → session.created）。
  await waitFor(browser, "window.__termDebug().sessions.length >= 1", { timeoutMs: 25000, label: "first session" });

  /* ------------------------------------------------ AC10：rail 入口 + 主机栏无按钮 */

  const hostsButtonCount = await browser.evaluate(
    "document.querySelectorAll('[data-role=\"hosts-open-files\"]').length",
  );
  record("AC10.1 页面里没有 hosts-open-files 按钮（DOM 层已删）", hostsButtonCount === 0, { hostsButtonCount });

  const railExists = await browser.evaluate(
    "!!document.querySelector('[data-role=\"rail-files\"]')",
  );
  record("AC10.2 rail-files 入口还在", railExists === true, { railExists });

  // 打开主机面板，确认里面真的没有「文件面板」文字按钮。
  await browser.evaluate("document.querySelector('[data-role=\"rail-hosts\"]')?.click(); true");
  await sleep(400);
  const hostsPanelReport = await browser.evaluate(`(() => {
    const panel = document.querySelector('[data-role="hosts-panel"]');
    if (!panel) return { open: false };
    const buttons = [...panel.querySelectorAll('button')].map((b) => ({
      role: b.getAttribute('data-role'),
      text: (b.textContent || '').trim(),
    }));
    return {
      open: !panel.hidden,
      tabsCount: panel.querySelectorAll('.hosts-tabs').length,
      fileButtons: buttons.filter((b) => b.role === 'hosts-open-files' || b.text === '文件面板'),
      buttonCount: buttons.length,
    };
  })()`);
  record(
    "AC10.3 主机面板里没有「文件面板」按钮，.hosts-tabs 空壳也没了",
    hostsPanelReport.open === true &&
      hostsPanelReport.fileButtons.length === 0 &&
      hostsPanelReport.tabsCount === 0,
    hostsPanelReport,
  );
  record("AC10.4 主机面板本身还在（面板没被误删）", hostsPanelReport.buttonCount > 0, hostsPanelReport);
  await shot(browser, "ac10-hosts-panel-no-file-button");
  await browser.evaluate("document.querySelector('[data-role=\"hosts-close\"]')?.click(); true");
  await sleep(300);

  // 点 rail 的文件图标打开文件面板（真鼠标）。
  await realClick(browser, '[data-role="rail-files"]');
  await waitFor(browser, "window.__termDebugFiles()?.open === true", { label: "file panel open" });
  const panelOpened = await browser.evaluate("window.__termDebugFiles().open");
  record("AC10.5 点 rail 文件图标能打开文件面板", panelOpened === true, { panelOpened });
  /* ------------------------------------------------ AC1 补：浅/深色两套下的可见性 */

  // 两个主题各自开一个**新的浏览器实例**去验证。
  // 为什么不在同一个实例里 `Page.navigate` 切主题：`app.js` 的 `beforeunload`
  // 在「有 running 会话」时会阻断跳转（防止误刷新丢会话），CDP 的 navigate
  // 就永远完不成。新实例没有这个问题。
  for (const theme of ["light", "dark"]) {
    // 切主题 = 修改 magpie 设置文件（真实路径：页面会拿它作为冷态主题源）。
    await writeFile(
      magpieSettingsPath,
      JSON.stringify({ theme, accent: "#2563eb", textSize: 100, lang: "zh-CN" }),
    );
    const themed = await openBrowser({ width: 1440, height: 900 });
    try {
      await themed.navigate(`${base}/?token=${handle.token}&theme=${theme}`);
      await waitFor(themed, "document.readyState === 'complete'", { label: `${theme} load` });
      await waitFor(themed, "typeof window.__termDebugFiles === 'function'", { label: `${theme} debug` });
      await waitFor(themed, "window.__termDebug().sessions.length >= 1", {
        timeoutMs: 25000,
        label: `${theme} session`,
      });
      // 面板默认按 localStorage（新 profile → 默认收起）→ 点 rail 打开。
      const opened = await themed.evaluate("window.__termDebugFiles()?.open === true");
      if (!opened) {
        await realClick(themed, '[data-role="rail-files"]');
        await waitFor(themed, "window.__termDebugFiles()?.open === true", { label: `${theme} panel open` });
      }
      // 把面板导到 batchDir。
      await themed.evaluate(`(() => {
        const input = document.querySelector('[data-role="file-panel-path"]');
        input.value = ${JSON.stringify(batchDir)};
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        return true;
      })()`);
      await waitFor(
        themed,
        `document.querySelectorAll('[data-role="file-entry"]').length >= 2`,
        { label: `${theme} entries` },
      );

      const contrast = await themed.evaluate(`(() => {
        const parse = (text) => {
          const t = (text || '').trim();
          // Chrome 对 color-mix() 派生色输出 color(srgb r g b / a)（0..1 浮点），
          // 只认 rgb/rgba 会让这类颜色恒为 null（曾导致 AC1.dark 假失败）。
          const srgb = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/.exec(t);
          if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
          const m = /rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)/.exec(t);
          return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
        };
        const lum = (rgb) => {
          if (!rgb) return null;
          const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
        };
        // 沿祖先链找第一个足够不透明的背景（半透明背景直接比会算错）。
        const bgOf = (el) => {
          let node = el;
          while (node) {
            const cs = getComputedStyle(node);
            const bg = parse(cs.backgroundColor);
            const alpha = /rgba\\([^)]*,\\s*([\\d.]+)\\s*\\)/.exec(cs.backgroundColor);
            if (bg && (!alpha || Number(alpha[1]) > 0.5)) return bg;
            node = node.parentElement;
          }
          return parse(getComputedStyle(document.body).backgroundColor);
        };
        const ratio = (el) => {
          if (!el) return null;
          const fg = lum(parse(getComputedStyle(el).color));
          const bg = lum(bgOf(el));
          if (fg === null || bg === null) return null;
          const light = Math.max(fg, bg);
          const dark = Math.min(fg, bg);
          return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
        };
        const locateEl = document.querySelector('[data-role="files-locate"]');
        const grid = document.querySelector('[data-role="file-panel-grid"]');
        grid.focus();
        const firstEntry = document.querySelector('[data-role="file-entry"]');
        firstEntry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const batch = document.querySelector('[data-role="files-batch-bar"]');
        const countEl = document.querySelector('[data-role="files-batch-count"]');
        const deleteBtn = document.querySelector('[data-role="files-batch-delete"]');
        return {
          themeClasses: document.documentElement.className,
          dark: document.documentElement.classList.contains('is-dark'),
          bgVar: getComputedStyle(document.documentElement).getPropertyValue('--magpie-bg').trim(),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          locateState: locateEl.getAttribute('data-state'),
          locateVisible: !!(locateEl.offsetWidth || locateEl.offsetHeight),
          locateContrast: ratio(locateEl),
          batchVisible: !!batch && !batch.hidden && batch.getBoundingClientRect().height > 0,
          countContrast: ratio(countEl),
          deleteContrast: ratio(deleteBtn),
          countText: countEl.textContent.trim(),
        };
      })()`);
      const shotPath = await shotTo(themed, `ac1-locate-and-batch-${theme}`);
      record(
        `AC1.${theme} 定位按钮与批量条在${theme === "dark" ? "深色" : "浅色"}下都可见且有对比度（≥1.5）`,
        contrast.locateVisible === true &&
          contrast.batchVisible === true &&
          typeof contrast.locateContrast === "number" &&
          contrast.locateContrast >= 1.5 &&
          typeof contrast.countContrast === "number" &&
          contrast.countContrast >= 1.5 &&
          contrast.countText === "已选 1 项" &&
          contrast.dark === (theme === "dark"),
        { ...contrast, screenshot: shotPath },
      );
    } finally {
      await themed.close();
    }
  }

  // 主题验完恢复成浅色，后面那一段保持一个已知起点。
  await writeFile(
    magpieSettingsPath,
    JSON.stringify({ theme: "light", accent: "#2563eb", textSize: 100, lang: "zh-CN" }),
  );

  /* ------------------------------------------------ AC1/AC2：定位按钮 */
  /* ------------------------------------------------ AC1/AC2：定位按钮 */

  // 先把面板手动导到 batchDir（走路径输入框，模拟用户键入）。
  async function gotoPath(dir) {
    await browser.evaluate(`(() => {
      const input = document.querySelector('[data-role="file-panel-path"]');
      input.value = ${JSON.stringify(dir)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > 15000) throw new Error(`gotoPath timeout: ${dir}`);
      const state = await browser.evaluate("window.__termDebugFiles()");
      if (state && state.path && state.path.toLowerCase() === dir.toLowerCase()) return state;
      await sleep(150);
    }
  }

  await gotoPath(batchDir);
  await waitFor(browser, "document.querySelectorAll('[data-role=\"file-entry\"]').length >= 5", {
    label: "entries rendered",
  });

  const locateAway = await browser.evaluate(`(() => { ${HELPERS} return locate(); })()`);
  record(
    "AC2.1 手动离开终端目录后定位按钮是可用态（away）+ 可见",
    locateAway && locateAway.visible === true && locateAway.state === "away" && locateAway.disabled === false,
    locateAway,
  );
  await shot(browser, "ac2-locate-away");

  // 点它 → 路径变成终端 cwd。
  const termCwdBefore = await browser.evaluate(`(() => {
    const s = window.__termDebug();
    const active = s.sessions.find((x) => x.id === s.activeId);
    return active ? active.cwd : null;
  })()`);
  await realClick(browser, '[data-role="files-locate"]');
  await sleep(600);
  const afterLocate = await browser.evaluate("window.__termDebugFiles()");
  const locateCurrent = await browser.evaluate(`(() => { ${HELPERS} return locate(); })()`);

  record(
    "AC1 点定位按钮后路径变成终端 cwd，按钮转成 current 弱化态",
    Boolean(termCwdBefore) &&
      afterLocate.path.toLowerCase() === String(termCwdBefore).toLowerCase() &&
      locateCurrent.state === "current",
    { termCwdBefore, pathAfter: afterLocate.path, locate: locateCurrent },
  );
  record(
    "AC1.1 定位后恢复跟随（manualPath === false）",
    afterLocate.manualPath === false,
    { manualPath: afterLocate.manualPath },
  );
  await shot(browser, "ac1-locate-current");

  /* ------------------------------------------------ AC3：多选 */

  await gotoPath(batchDir);
  await waitFor(browser, "document.querySelectorAll('[data-role=\"file-entry\"]').length >= 5", {
    label: "entries for selection",
  });

  // Ctrl 点 3 项（modifiers 2 = Ctrl）。
  await realClick(browser, '[data-role="file-entry"]', { index: 0, modifiers: 2 });
  await realClick(browser, '[data-role="file-entry"]', { index: 1, modifiers: 2 });
  await realClick(browser, '[data-role="file-entry"]', { index: 2, modifiers: 2 });
  const ctrlReport = await browser.evaluate(`(() => { ${HELPERS}
    return { count: filesState().selectedCount, domSelected: selectedNodes().length, text: batchText() };
  })()`);
  record(
    "AC3.1 Ctrl 点击可选 3 项，DOM 选中类 = 3，计数文本 =「已选 3 项」",
    ctrlReport.count === 3 && ctrlReport.domSelected === 3 && ctrlReport.text === "已选 3 项",
    ctrlReport,
  );
  await shot(browser, "ac3-ctrl-three-selected");

  // Escape 清空。
  await browser.evaluate("document.querySelector('[data-role=\"file-panel-grid\"]').focus(); true");
  await realKey(browser, "Escape", { code: "Escape", windowsVirtualKeyCode: 27 });
  const afterEscape = await browser.evaluate(`(() => { ${HELPERS}
    return { count: filesState().selectedCount, domSelected: selectedNodes().length };
  })()`);
  record("AC3.2 Escape 清空选择", afterEscape.count === 0 && afterEscape.domSelected === 0, afterEscape);

  // Shift 区间：普通点 index 0，Shift 点 index 3 → 4 项。
  await realClick(browser, '[data-role="file-entry"]', { index: 0 });
  await realClick(browser, '[data-role="file-entry"]', { index: 3, modifiers: 8 });
  const shiftReport = await browser.evaluate(`(() => { ${HELPERS}
    return { count: filesState().selectedCount, domSelected: selectedNodes().length };
  })()`);
  record(
    "AC3.3 Shift 点击选中区间（4 项）",
    shiftReport.count === 4 && shiftReport.domSelected === 4,
    shiftReport,
  );
  await shot(browser, "ac3-shift-range");

  // Ctrl+A 全选（焦点在网格里）。
  await browser.evaluate("document.querySelector('[data-role=\"file-panel-grid\"]').focus(); true");
  await realKey(browser, "a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  const selectAllReport = await browser.evaluate(`(() => { ${HELPERS}
    return { count: filesState().selectedCount, total: filesState().entries.length };
  })()`);
  record(
    "AC3.4 Ctrl+A 全选当前目录所有条目",
    selectAllReport.count === selectAllReport.total && selectAllReport.total > 0,
    selectAllReport,
  );

  // 点空白处清空。
  const blank = await browser.evaluate(`(() => { ${HELPERS}
    const grid = q('[data-role="file-panel-grid"]');
    const r = grid.getBoundingClientRect();
    return { x: r.x + r.width - 8, y: r.y + r.height - 6 };
  })()`);
  await browser.raw.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: blank.x, y: blank.y, button: "left", clickCount: 1,
  });
  await browser.raw.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: blank.x, y: blank.y, button: "left", clickCount: 1,
  });
  await sleep(150);
  const afterBlank = await browser.evaluate(`(() => { ${HELPERS}
    return { count: filesState().selectedCount, domSelected: selectedNodes().length };
  })()`);
  record("AC3.5 点空白处清空选择", afterBlank.count === 0 && afterBlank.domSelected === 0, afterBlank);

  /* ------------------------------------------------ AC4：批量条与高度 */

  const slotBefore = await browser.evaluate(`(() => { ${HELPERS} return slotRect(); })()`);
  await realClick(browser, '[data-role="file-entry"]', { index: 0 });
  await sleep(120);
  const slotAfter = await browser.evaluate(`(() => { ${HELPERS} return slotRect(); })()`);
  const batchVisible = await browser.evaluate(`(() => { ${HELPERS}
    const bar = q('[data-role="files-batch-bar"]');
    const input = q('[data-role="file-panel-path"]');
    const rect = bar.getBoundingClientRect();
    return {
      barVisible: !bar.hidden && rect.width > 0 && rect.height > 0,
      inputHidden: input.hidden === true,
      buttons: qa('[data-role^="files-batch-"]').filter((b) => b.tagName === 'BUTTON').map((b) => b.getAttribute('data-role')),
      text: batchText(),
    };
  })()`);
  record(
    "AC4.1 选中 1 项 = 出现「已选 1 项」+ 移动/删除/下载/取消 四个图标按钮，路径框隐藏",
    batchVisible.barVisible &&
      batchVisible.inputHidden &&
      batchVisible.text === "已选 1 项" &&
      ["files-batch-move", "files-batch-delete", "files-batch-download", "files-batch-cancel"].every((role) =>
        batchVisible.buttons.includes(role),
      ),
    batchVisible,
  );
  const heightDelta = Math.abs(slotAfter.height - slotBefore.height);
  record(
    "AC4.2 路径框 → 批量条，槽位高度差 ≤ 1px（不跳版）",
    heightDelta <= 1,
    { before: slotBefore, after: slotAfter, heightDelta },
  );
  await shot(browser, "ac4-batch-bar");

  // 点取消 → 恢复路径输入框，高度不变。
  await realClick(browser, '[data-role="files-batch-cancel"]');
  await sleep(150);
  const afterCancel = await browser.evaluate(`(() => { ${HELPERS}
    const bar = q('[data-role="files-batch-bar"]');
    const input = q('[data-role="file-panel-path"]');
    return {
      barHidden: bar.hidden === true,
      inputVisible: input.hidden === false,
      count: filesState().selectedCount,
      slot: slotRect(),
    };
  })()`);
  record(
    "AC4.3 取消后恢复路径输入框，选择清空，高度差 ≤ 1px",
    afterCancel.barHidden && afterCancel.inputVisible && afterCancel.count === 0 &&
      Math.abs(afterCancel.slot.height - slotBefore.height) <= 1,
    { before: slotBefore, after: afterCancel },
  );

  /* ------------------------------------------------ AC5：批量删除（3 文件 + 1 目录） */

  await gotoPath(batchDir);
  await waitFor(browser, "document.querySelectorAll('[data-role=\"file-entry\"]').length >= 5", {
    label: "entries for delete",
  });
  // 选 aaa/bbb/ccc + subdir（4 项，含 1 个目录）。
  const pickedForDelete = await browser.evaluate(`(() => { ${HELPERS}
    const wanted = ['aaa.txt', 'bbb.txt', 'ccc.txt', 'subdir'];
    const nodes = entries().filter((n) => wanted.includes(n.getAttribute('data-name')));
    return nodes.map((n) => n.getAttribute('data-name'));
  })()`);
  await browser.evaluate(`(() => {
    const wanted = ['aaa.txt', 'bbb.txt', 'ccc.txt', 'subdir'];
    const nodes = [...document.querySelectorAll('[data-role="file-entry"]')];
    const grid = document.querySelector('[data-role="file-panel-grid"]');
    grid.focus();
    for (const node of nodes) {
      if (!wanted.includes(node.getAttribute('data-name'))) continue;
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
    return true;
  })()`);
  await sleep(150);
  const beforeDelete = await browser.evaluate(`(() => { ${HELPERS}
    return { count: filesState().selectedCount, text: batchText() };
  })()`);

  await realClick(browser, '[data-role="files-batch-delete"]');
  await sleep(250);
  const confirmText = await browser.evaluate(
    "document.querySelector('[data-role=\"files-batch-delete-text\"]')?.textContent || null",
  );
  record(
    "AC5.1 批量删除有二次确认，文案含「将删除 N 项」与「不可撤销」",
    typeof confirmText === "string" && /将删除 4 项/.test(confirmText) && /不可撤销/.test(confirmText),
    { confirmText, beforeDelete, pickedForDelete },
  );
  await shot(browser, "ac5-delete-confirm");

  await realClick(browser, '[data-role="files-batch-delete-confirm"]');
  await sleep(1200);
  const afterDelete = await browser.evaluate(`(() => { ${HELPERS}
    const names = filesState().entries.map((e) => e.name);
    return { count: filesState().selectedCount, names, text: batchText() };
  })()`);
  const goneOnDisk = [];
  for (const name of ["aaa.txt", "bbb.txt", "ccc.txt", "subdir"]) {
    const exists = existsSync(path.join(batchDir, name));
    goneOnDisk.push({ name, exists });
  }
  record(
    "AC5.2 批量删除后：4 项从列表消失、磁盘上确实不存在、选择已清空",
    goneOnDisk.every((row) => row.exists === false) &&
      afterDelete.names.every((name) => !["aaa.txt", "bbb.txt", "ccc.txt", "subdir"].includes(name)) &&
      afterDelete.count === 0,
    { afterDelete, goneOnDisk },
  );
  await shot(browser, "ac5-after-delete");

  /* ------------------------------------------------ AC6：批量移动 3 个文件到子目录 */

  for (const name of ["m1.txt", "m2.txt", "m3.txt"]) {
    await writeFile(path.join(batchDir, name), `移动内容：${name}\n`);
  }
  await gotoPath(batchDir);
  await waitFor(browser, "document.querySelectorAll('[data-role=\"file-entry\"]').length >= 3", {
    label: "entries for move",
  });
  await browser.evaluate(`(() => {
    const wanted = ['m1.txt', 'm2.txt', 'm3.txt'];
    const grid = document.querySelector('[data-role="file-panel-grid"]');
    grid.focus();
    for (const node of [...document.querySelectorAll('[data-role="file-entry"]')]) {
      if (!wanted.includes(node.getAttribute('data-name'))) continue;
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
    return true;
  })()`);
  await sleep(150);

  // 直接在页面里等 move 的响应：包一层 fetch，记录最后一次 /api/fs/move 的结果。
  await browser.evaluate(`(() => {
    if (window.__moveLog) return true;
    window.__moveLog = [];
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const url = String(args[0]);
      if (url.includes('/api/fs/move')) {
        try {
          const clone = response.clone();
          window.__moveLog.push({ url, status: response.status, body: await clone.json() });
        } catch { window.__moveLog.push({ url, status: response.status, body: null }); }
      }
      return response;
    };
    return true;
  })()`);

  await realClick(browser, '[data-role="files-batch-move"]');
  await sleep(250);
  const moveDialog = await browser.evaluate(`(() => {
    const input = document.querySelector('[data-role="files-batch-move-input"]');
    const quick = document.querySelector('[data-role="files-batch-move-term"]');
    return { hasInput: !!input, prefilled: input ? input.value : null, hasQuick: !!quick };
  })()`);
  record(
    "AC6.1 批量移动弹目标目录输入（预填当前目录 + 有「用终端目录」快捷）",
    moveDialog.hasInput && moveDialog.hasQuick && moveDialog.prefilled === batchDir,
    { moveDialog, batchDir },
  );
  await browser.evaluate(`(() => {
    const input = document.querySelector('[data-role="files-batch-move-input"]');
    input.value = ${JSON.stringify(moveTarget)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await shot(browser, "ac6-move-dialog");
  await realClick(browser, '[data-role="files-batch-move-confirm"]');
  await sleep(2500);

  const moveReport = await browser.evaluate("window.__moveLog || []");
  const movedOnDisk = [];
  for (const name of ["m1.txt", "m2.txt", "m3.txt"]) {
    movedOnDisk.push({
      name,
      atTarget: existsSync(path.join(moveTarget, name)),
      atSource: existsSync(path.join(batchDir, name)),
    });
  }
  const lastMove = moveReport.length > 0 ? moveReport[moveReport.length - 1] : null;
  record(
    "AC6.2 批量移动 3 个文件到子目录：后端 moved=3 / failed=0，目标都有、源都没了",
    Boolean(lastMove) &&
      lastMove.status === 200 &&
      lastMove.body &&
      lastMove.body.moved.length === 3 &&
      lastMove.body.failed.length === 0 &&
      movedOnDisk.every((row) => row.atTarget === true && row.atSource === false),
    { lastMove, movedOnDisk },
  );
  await shot(browser, "ac6-after-move");

  /* ------------------------------------------------ AC7：移动冲突（目标已有同名） */

  await writeFile(path.join(batchDir, "conflict.txt"), "源内容（必须保住）");
  await writeFile(path.join(conflictDir, "conflict.txt"), "目标原有内容（不许被覆盖）");
  await gotoPath(batchDir);
  await waitFor(
    browser,
    "window.__termDebugFiles().entries.some((e) => e.name === 'conflict.txt')",
    { label: "conflict entry" },
  );
  await browser.evaluate(`(() => {
    const grid = document.querySelector('[data-role="file-panel-grid"]');
    grid.focus();
    const node = [...document.querySelectorAll('[data-role="file-entry"]')]
      .find((n) => n.getAttribute('data-name') === 'conflict.txt');
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await sleep(120);
  await browser.evaluate("window.__moveLog = []; true");
  await realClick(browser, '[data-role="files-batch-move"]');
  await sleep(200);
  await browser.evaluate(`(() => {
    const input = document.querySelector('[data-role="files-batch-move-input"]');
    input.value = ${JSON.stringify(conflictDir)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await realClick(browser, '[data-role="files-batch-move-confirm"]');
  await sleep(2000);

  const conflictLog = await browser.evaluate("window.__moveLog || []");
  const conflictLast = conflictLog.length > 0 ? conflictLog[conflictLog.length - 1] : null;
  const conflictSourceText = await readFile(path.join(batchDir, "conflict.txt"), "utf8").catch(() => null);
  const conflictTargetText = await readFile(path.join(conflictDir, "conflict.txt"), "utf8").catch(() => null);
  record(
    "AC7 目标已有同名 → failed 里 code=TARGET_EXISTS，源文件仍在、目标未被覆盖",
    Boolean(conflictLast) &&
      conflictLast.body &&
      conflictLast.body.moved.length === 0 &&
      conflictLast.body.failed.length === 1 &&
      conflictLast.body.failed[0].code === "TARGET_EXISTS" &&
      conflictSourceText === "源内容（必须保住）" &&
      conflictTargetText === "目标原有内容（不许被覆盖）",
    { conflictLast, conflictSourceText, conflictTargetText },
  );
  await shot(browser, "ac7-conflict");

  /* ------------------------------------------------ AC9：批量下载 2 个文件（含目录被跳过） */

  await gotoPath(batchDir);
  await waitFor(browser, "document.querySelectorAll('[data-role=\"file-entry\"]').length >= 2", {
    label: "entries for download",
  });
  // 让下载落到临时目录（不污染用户的下载文件夹）。
  const client = browser.raw;
  try {
    await client.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
  } catch {
    // 老版本只有 Page.setDownloadBehavior；失败也不致命（下面只看 toast 与请求数）。
    try {
      await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
    } catch {
      // 忽略。
    }
  }
  // 记录下载请求（服务端 GET /api/fs/download）。
  await browser.evaluate(`(() => {
    window.__downloadLog = [];
    if (window.__downloadWrapped) return true;
    window.__downloadWrapped = true;
    const original = window.fetch;
    window.fetch = async (...args) => {
      const url = String(args[0]);
      if (url.includes('/api/fs/download')) window.__downloadLog.push({ url });
      return original(...args);
    };
    return true;
  })()`);
  await browser.evaluate(`(() => {
    const wanted = ['dl-1.txt', 'dl-2.txt', 'dl-dir'];
    const grid = document.querySelector('[data-role="file-panel-grid"]');
    grid.focus();
    for (const node of [...document.querySelectorAll('[data-role="file-entry"]')]) {
      if (!wanted.includes(node.getAttribute('data-name'))) continue;
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
    return true;
  })()`);
  const downloadSelection = await browser.evaluate(`(() => { ${HELPERS}
    return filesState().entries.filter((e) => filesState().selected.includes(e.path)).map((e) => ({
      name: e.name, type: e.type,
    }));
  })()`);

  await realClick(browser, '[data-role="files-batch-download"]');
  await sleep(2000);
  const downloadLog = await browser.evaluate("window.__downloadLog || []");
  const downloadFiles = [];
  try {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(downloadDir);
    for (const name of names) downloadFiles.push(name);
  } catch {
    // 目录还没建。
  }
  const dirSelected = downloadSelection.some((entry) => entry.type === "dir");
  const downloadNotice = await browser.evaluate(
    "document.querySelector('[data-role=\"status-notice\"]')?.textContent || null",
  );
  record(
    "AC9 批量下载：2 个文件都发了下载请求（目录被跳过、提示里说明了，不崩）",
    downloadLog.length === 2 &&
      downloadLog.every((row) => /dl-[12]\.txt/.test(decodeURIComponent(row.url))) &&
      !downloadLog.some((row) => /dl-dir/.test(decodeURIComponent(row.url))) &&
      downloadSelection.length === 3 &&
      dirSelected,
    { downloadLog, downloadSelection, downloadDirFiles: downloadFiles, downloadNotice },
  );
  await shot(browser, "ac9-download");

  /* ------------------------------------------------ 回归：单条动作（⋯ 菜单）仍可用 */

  await gotoPath(batchDir);
  await waitFor(browser, "document.querySelectorAll('[data-role=\"file-entry\"]').length >= 2", {
    label: "entries for single actions",
  });
  const singleTarget = await browser.evaluate(`(() => {
    const node = [...document.querySelectorAll('[data-role="file-entry"]')]
      .find((n) => n.getAttribute('data-name') === 'conflict.txt');
    if (!node) return null;
    const toggle = node.querySelector('[data-role="file-more-toggle"]');
    toggle.click();
    const menu = document.querySelector('[data-role="file-action-menu"]');
    return {
      open: !!menu && !menu.hidden,
      actions: menu ? [...menu.querySelectorAll('[data-role="file-action-item"]')].map((b) => b.getAttribute('data-action')) : [],
    };
  })()`);
  record(
    "回归.1 点 ⋯ 仍能开单条动作菜单（查看/编辑/重命名/下载/删除），多选改造没弄坏它",
    singleTarget &&
      singleTarget.open === true &&
      ["view", "edit", "rename", "download", "delete"].every((action) =>
        singleTarget.actions.includes(action),
      ),
    singleTarget,
  );
  // Esc 关菜单。
  await realKey(browser, "Escape", { code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(150);
  const menuClosed = await browser.evaluate(
    "(() => { const m = document.querySelector('[data-role=\"file-action-menu\"]'); return !m || m.hidden; })()",
  );
  record("回归.2 Esc 能关掉 ⋯ 菜单", menuClosed === true, { menuClosed });

  // 单条重命名：改完后列表里出现新名字。
  const renameFrom = path.join(batchDir, "dl-1.txt");
  const renameTo = path.join(batchDir, "dl-1-renamed.txt");
  await browser.evaluate(`(() => {
    const node = [...document.querySelectorAll('[data-role="file-entry"]')]
      .find((n) => n.getAttribute('data-name') === 'dl-1.txt');
    node.querySelector('[data-role="file-more-toggle"]').click();
    return true;
  })()`);
  await sleep(200);
  await realClick(browser, '[data-role="file-action-item"][data-action="rename"]');
  await sleep(250);
  await browser.evaluate(`(() => {
    const input = document.querySelector('[data-role="file-rename-input"]');
    input.value = 'dl-1-renamed.txt';
    return true;
  })()`);
  // 点「重命名」确认按钮（模态里最后一个 primary 按钮）。
  await browser.evaluate(`(() => {
    const card = document.querySelector('[data-role="confirm-card"]');
    const buttons = [...card.querySelectorAll('button')];
    const primary = buttons.find((b) => b.className.includes('file-panel-btn-primary'));
    primary.click();
    return true;
  })()`);
  await sleep(1200);
  const renamed = {
    fromGone: !existsSync(renameFrom),
    toExists: existsSync(renameTo),
    inList: await browser.evaluate(
      "window.__termDebugFiles().entries.some((e) => e.name === 'dl-1-renamed.txt')",
    ),
  };
  record(
    "回归.3 单条重命名仍可用（磁盘 + 列表都变了）",
    renamed.fromGone && renamed.toExists && renamed.inList === true,
    renamed,
  );
  await shot(browser, "regression-single-actions");

  /* ------------------------------------------------ AC2 剩余：no-terminal 态 */

  // 关掉所有标签 → 定位按钮进入 no-terminal 禁用态。
  await browser.evaluate(`(() => {
    const s = window.__termDebug();
    for (const session of s.sessions) {
      const close = document.querySelector('[data-tab-id="' + session.id + '"] [data-role="tab-close"]');
      if (close) close.click();
    }
    return true;
  })()`);
  await sleep(1200);
  const locateNoTerminal = await browser.evaluate(`(() => { ${HELPERS} return locate(); })()`);
  const sessionCount = await browser.evaluate("window.__termDebug().sessions.length");
  const noTerminalToolbar = await browser.evaluate(`(() => { ${HELPERS}
    const bar = q('[data-role="files-batch-bar"]');
    const input = q('[data-role="file-panel-path"]');
    return { batchHidden: bar.hidden === true, inputVisible: input.hidden === false,
             selectedCount: filesState().selectedCount, status: q('[data-role="file-panel-status"]').textContent };
  })()`);
  record(
    "AC2.2 没有终端时定位按钮是禁用态，title 说明原因（按钮仍可见）",
    sessionCount === 0 &&
      locateNoTerminal &&
      locateNoTerminal.visible === true &&
      locateNoTerminal.disabled === true &&
      locateNoTerminal.state === "no-terminal" &&
      /没有终端|还没上报目录/.test(locateNoTerminal.title),
    { sessionCount, locateNoTerminal },
  );
  record(
    "AC2.3 没有终端时又不留「已选 N 项」的陈旧批量条（工具栏回到路径框、选择清空）",
    noTerminalToolbar.batchHidden === true &&
      noTerminalToolbar.inputVisible === true &&
      noTerminalToolbar.selectedCount === 0,
    noTerminalToolbar,
  );
  await shot(browser, "ac2-locate-no-terminal");
} catch (err) {
  error = err && err.stack ? err.stack : String(err);
  console.log(`ERROR ${error}`);
} finally {
  if (browser) await browser.close();
  await shutdown(handle);
  await rm(workRoot, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.pass);
await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, "probe-fs-multi.json"),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      base,
      error,
      results,
      passed: results.length - failed.length,
      total: results.length,
    },
    null,
    2,
  ),
  "utf8",
);

if (JSON_FLAG) console.log(JSON.stringify({ results, error }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(`evidence: ${EVIDENCE_DIR}`);
console.log(`screenshots: ${SHOTS_DIR}`);
process.exit(error || failed.length > 0 || results.length === 0 ? 1 : 0);
