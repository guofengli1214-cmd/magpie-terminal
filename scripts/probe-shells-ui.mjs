// AC10 证据脚本（浏览器侧）：老前端（只认 3 个 id 的 tab-bar）在新清单下不会崩。
//
// 用法（仓库根）：node scripts/probe-shells-ui.mjs [--json]
//
// 做法：真 Chrome 打开应用页 → 点「+」开菜单 → 读回菜单里每一项的
// data-shell-id / 文案 / 是否 disabled，并检查控制台没有未捕获错误。
// 判定：
//   - 菜单渲染出清单里的每一项（老的 3 个 + cmd + wsl:*）
//   - 没有 JS 异常（Runtime.exceptionThrown）
//   - 点 bash（老 id）能真的建出会话
//   - 点 cmd（新 id）能真的建出会话（老 UI 不认识新 id 也不会崩，因为 id 是透传的）

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { startServer } from "../src/server/http.mjs";
import { openBrowser, sleep } from "./lib/cdp.mjs";

const json = process.argv.includes("--json");
const results = [];
const record = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });

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

async function openMenu(browser) {
  // 「+」按钮在 tab-bar 里（data-role="tab-new"）；点它开菜单。
  return browser.evaluate(`
    (() => {
      const anchor = document.querySelector('[data-role="tab-new"]');
      if (!anchor) return { ok: false, reason: "no tab-new anchor" };
      anchor.click();
      return { ok: true };
    })()
  `);
}

async function readMenu(browser) {
  return browser.evaluate(`
    (() => {
      const menu = document.querySelector('[data-role="tab-new-menu"]');
      if (!menu) return null;
      const items = Array.from(menu.querySelectorAll('[data-role="tab-new-local"]')).map((el) => ({
        id: el.getAttribute('data-shell-id'),
        available: el.getAttribute('data-available'),
        disabled: el.disabled === true,
        name: (el.querySelector('.tab-new-name') || {}).textContent || null,
        meta: (el.querySelector('.tab-new-meta') || {}).textContent || null,
      }));
      return { exists: true, items, html: menu.innerHTML.length };
    })()
  `);
}

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-shells-ui-"));
process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
const port = await freePort();
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const handle = await startServer({ port, log: quiet });

let error = null;
let browser = null;
try {
  browser = await openBrowser({ width: 1400, height: 900 });
  await browser.navigate(`http://127.0.0.1:${port}/?token=${handle.token}&theme=light`);
  await sleep(4000);

  // 页面错误通过 window.onerror / unhandledrejection 收（不依赖 CDP 事件通道）。
  await browser.evaluate(`
    (() => {
      window.__probeErrors = window.__probeErrors || [];
      window.addEventListener('error', (event) => {
        window.__probeErrors.push(String(event.message || 'error'));
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__probeErrors.push('unhandledrejection: ' + String(event.reason));
      });
      return true;
    })()
  `);

  // 服务端清单（真值）。
  const listResponse = await fetch(`http://127.0.0.1:${port}/api/shells`, {
    headers: { "x-magpie-term-token": handle.token },
  });
  const listPayload = await listResponse.json();
  const serverIds = listPayload.shells.map((item) => item.id);

  const opened = await openMenu(browser);
  record("AC10.c 「+」菜单能被打开（老 UI 入口仍可用）", opened && opened.ok === true, opened);
  await sleep(800);
  const menu = await readMenu(browser);
  record(
    "AC10.d 菜单渲染出清单里的每一项（含新 id cmd / wsl:*），没有崩",
    menu && menu.exists === true && serverIds.every((id) => menu.items.some((item) => item.id === id)),
    {
      menuItems: menu ? menu.items : null,
      serverIds,
      missing: menu ? serverIds.filter((id) => !menu.items.some((item) => item.id === id)) : null,
    },
  );

  // 点 bash（老 id）→ 建会话。
  const beforeBash = await browser.evaluate(
    "typeof window.__termDebug === 'function' ? window.__termDebug().sessions.length : -1",
  );
  await browser.evaluate(`
    (() => {
      const el = document.querySelector('[data-role="tab-new-local"][data-shell-id="bash"]');
      if (!el) return false;
      el.click();
      return true;
    })()
  `);
  await sleep(3000);
  const afterBash = await browser.evaluate(
    "typeof window.__termDebug === 'function' ? window.__termDebug().sessions.length : -1",
  );
  record("AC10.e 点老 id（bash）能建出新会话", afterBash === beforeBash + 1, { beforeBash, afterBash });

  // 点 cmd（新 id）→ 也建得出会话。
  await openMenu(browser);
  await sleep(600);
  const beforeCmd = afterBash;
  await browser.evaluate(`
    (() => {
      const el = document.querySelector('[data-role="tab-new-local"][data-shell-id="cmd"]');
      if (!el) return false;
      el.click();
      return true;
    })()
  `);
  await sleep(3500);
  const afterCmd = await browser.evaluate(
    "typeof window.__termDebug === 'function' ? window.__termDebug().sessions.length : -1",
  );
  const snapshot = await browser.evaluate(
    "typeof window.__termDebug === 'function' ? window.__termDebug() : null",
  );
  const shellNames = (snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : []).map(
    (session) => session.shell && session.shell.name,
  );
  record("AC10.f 点新 id（cmd）也能建出会话（老 UI 不认识新 id 但不会崩）", afterCmd === beforeCmd + 1, {
    beforeCmd,
    afterCmd,
    shellNames,
  });

  // 页面级异常检查。
  const pageErrors = await browser.evaluate("window.__probeErrors || []");
  record("AC10.g 整个过程中页面没有未捕获异常", Array.isArray(pageErrors) && pageErrors.length === 0, {
    pageErrors,
  });
} catch (err) {
  error = err && err.message ? err.message : String(err);
} finally {
  if (browser) await browser.close();
  try {
    await handle.close();
  } catch {
    // 忽略。
  }
}

const failed = results.filter((item) => !item.pass);
if (json) {
  console.log(JSON.stringify({ results, error }, null, 2));
} else {
  for (const item of results) {
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}`);
    console.log(`      ${JSON.stringify(item.detail)}`);
  }
  if (error) console.log(`ERROR ${error}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
}
process.exit(error || failed.length > 0 ? 1 : 0);
