// TASK-FIX17-G 验收探针（真浏览器 + 真服务）：设置页「关于 / 更新」block。
//
// 用法（仓库根）：node scripts/probe-update.mjs [--json]
//
// 覆盖：
//   AC1  真服务 /api/version：version 与 package.json 一致、本机裸路径 → local-path、
//        无 repository、updateSupported:false。
//   AC2  真 Chrome：设置页出现「关于 / 更新」block；版本 / 本地路径 / 未配置仓库；
//        「检查更新」禁用并给出原因；「如何更新」含 git pull 与重启提示。
//   AC3  registry + repository（注入 packageInfo，不改 package.json）→ 按钮可点，
//        点击后走 /api/update/check（fetch 注入）显示「发现新版本」+ 发布页链接。
//   AC4  同一个服务切到超时 → 点击后显示「检查失败：…超时」，不是「已是最新」。
//   AC5  「如何更新」按 installKind 给不同命令（local-path / registry 都验）。
//
// 隔离：配置与 plugins.json 都在 mkdtemp；端口随机；更新检查不真连 GitHub。
// 产物：.dispatch/fix17-g/evidence/probe-update*.png / .json

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { startServer } from "../src/server/http.mjs";
import { PLUGINS_PATH_ENV, PLUGIN_ROOT } from "../src/config/install-kind.mjs";
import { CONFIG_PATH_ENV } from "../src/config/store.mjs";
import { UPDATE_CACHE_TTL_MS } from "../src/config/update-check.mjs";
import { openBrowser, sleep } from "./lib/cdp.mjs";

const json = process.argv.includes("--json");
const evidenceDir = path.resolve(".dispatch/fix17-g/evidence");
await mkdir(evidenceDir, { recursive: true });

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass), detail });
  if (!json) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    console.log(`      ${JSON.stringify(detail)}`);
  }
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

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
}

/** 一个隔离的服务：临时 config + 临时 plugins.json + 随机端口。 */
async function startIsolated(name, { plugins, packageInfo, updateCheck }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `fix17g-${name}-`));
  const configFile = path.join(dir, "config.json");
  const pluginsFile = path.join(dir, "plugins.json");
  await writeFile(configFile, JSON.stringify({ version: 1, defaultShell: null }), "utf8");
  await writeFile(pluginsFile, JSON.stringify(plugins), "utf8");
  process.env[CONFIG_PATH_ENV] = configFile;
  process.env[PLUGINS_PATH_ENV] = pluginsFile;
  const port = await freePort();
  const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
  const handle = await startServer({
    port,
    log: quiet,
    ...(packageInfo ? { packageInfo } : {}),
    ...(updateCheck ? { updateCheck } : {}),
  });
  return {
    dir,
    port,
    handle,
    base: `http://127.0.0.1:${port}`,
    headers: { "x-magpie-term-token": handle.token },
    async close() {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function installErrorHooks(browser) {
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
}

async function collectErrors(browser) {
  return browser.evaluate("window.__probeErrors || []");
}

async function openSettings(browser) {
  const clicked = await browser.evaluate(`
    (() => {
      const button = document.querySelector('[data-role="rail-settings"]');
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!clicked) throw new Error("找不到 data-role=rail-settings");
  await waitFor(async () => {
    const text = await browser.evaluate(
      "(() => { const el = document.querySelector('[data-role=\"about-version\"]'); return el ? el.textContent : ''; })()",
    );
    return typeof text === "string" && text.length > 0 && !text.includes("读取中");
  }, 30000, "settings about block");
}

async function readAbout(browser) {
  return browser.evaluate(`
    (() => {
      const q = (selector) => document.querySelector(selector);
      const button = q('[data-role="update-check"]');
      const status = q('[data-role="update-status"]');
      const details = q('[data-role="update-howto"]');
      const link = status ? status.querySelector('a') : null;
      return {
        block: Boolean(q('[data-block="about"]')),
        version: (q('[data-role="about-version"]') || {}).textContent || '',
        repository: (q('[data-role="about-repository"]') || {}).textContent || '',
        repositoryHref: (q('[data-role="about-repository"] a') || {}).href || null,
        installKind: (q('[data-role="about-install-kind"]') || {}).textContent || '',
        checkDisabled: button ? button.disabled === true : null,
        checkText: button ? button.textContent : null,
        status: status ? status.textContent : '',
        statusTone: status ? status.getAttribute('data-tone') : null,
        statusHref: link ? link.href : null,
        howto: (q('[data-role="update-howto-text"]') || {}).textContent || '',
        detailsOpen: details ? details.open === true : null,
      };
    })()
  `);
}

async function scrollToAbout(browser) {
  await browser.evaluate(`
    (() => {
      const details = document.querySelector('[data-role="update-howto"]');
      if (details) details.open = true;
      const body = document.querySelector('.settings-body');
      if (body) body.scrollTop = body.scrollHeight;
      return true;
    })()
  `);
  await sleep(250);
}

async function shot(browser, filename) {
  const png = await browser.screenshot();
  if (png) await writeFile(path.join(evidenceDir, filename), png);
  return png ? path.join(evidenceDir, filename) : null;
}

async function clickCheck(browser) {
  const clicked = await browser.evaluate(`
    (() => {
      const button = document.querySelector('[data-role="update-check"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()
  `);
  if (!clicked) throw new Error("检查更新按钮不可点");
}

async function waitStatus(browser, predicate, label) {
  return waitFor(async () => {
    const about = await readAbout(browser);
    return predicate(about) ? about : null;
  }, 20000, label);
}

// 网关探活与本卡无关：指到不可达地址并缩短超时，避免设置页 load() 被拖慢。
process.env.MAGPIE_TERMINAL_GATEWAY_URL = "http://127.0.0.1:1";
process.env.MAGPIE_TERMINAL_GATEWAY_TIMEOUT_MS = "800";

let service = null;
let browser = null;
let error = null;
const pageErrors = [];

try {
  /* ---------------- AC1 / AC2 / AC5：本地路径安装 ---------------- */
  service = await startIsolated("local", {
    plugins: { plugins: [{ spec: PLUGIN_ROOT }] },
  });

  const versionResponse = await fetch(`${service.base}/api/version`, { headers: service.headers });
  const version = await versionResponse.json();
  record(
    "AC1 /api/version：version 与 package.json 一致、裸路径 → local-path、无 repository、updateSupported:false",
    versionResponse.status === 200 &&
      version.version === packageJson.version &&
      version.name === packageJson.name &&
      version.repository === null &&
      version.installKind === "local-path" &&
      version.updateSupported === false,
    version,
  );

  browser = await openBrowser({ width: 1400, height: 1000 });
  await browser.navigate(`${service.base}/?token=${service.handle.token}&theme=light`);
  await sleep(1500);
  await installErrorHooks(browser);
  await openSettings(browser);
  await scrollToAbout(browser);

  const localAbout = await readAbout(browser);
  record(
    "AC2 设置页出现「关于 / 更新」block，显示版本 0.1.0 / 本地路径 / 未配置仓库",
    localAbout.block === true &&
      localAbout.version.includes(packageJson.version) &&
      localAbout.installKind.includes("本地路径") &&
      localAbout.repository.includes("未配置仓库地址"),
    localAbout,
  );
  record(
    "AC2 无 repository 时「检查更新」禁用，并显示原因",
    localAbout.checkDisabled === true && localAbout.status.includes("未配置仓库地址"),
    { disabled: localAbout.checkDisabled, status: localAbout.status },
  );
  record(
    "AC5 local-path 的「如何更新」含 git pull 与重启提示",
    localAbout.howto.includes("git pull") && localAbout.howto.includes("重启 magpie"),
    { howto: localAbout.howto },
  );
  const localShot = await shot(browser, "probe-update-ac2-local.png");
  const localErrors = await collectErrors(browser);
  pageErrors.push(...localErrors);
  record("AC2 打开设置 / 查看关于块的过程中没有未捕获异常", localErrors.length === 0, { errors: localErrors });

  // 深色主题也要能读：用 CDP 模拟系统深色（app.js 的 matchMedia 会把它作为 prefer
  // 传给 /api/theme），本卡新增的 CSS 全部走变量，不在深色下另写一套颜色。
  await browser.raw.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await browser.navigate(`${service.base}/?token=${service.handle.token}&theme=dark`);
  await sleep(1500);
  await installErrorHooks(browser);
  await openSettings(browser);
  await scrollToAbout(browser);
  const darkAbout = await readAbout(browser);
  const darkClass = await browser.evaluate(
    "document.documentElement.classList.contains('is-dark')",
  );
  record(
    "AC2 深色主题下「关于 / 更新」仍可读，且页面确实是深色类",
    darkClass === true &&
      darkAbout.block === true &&
      darkAbout.version.includes(packageJson.version) &&
      darkAbout.checkDisabled === true,
    { darkClass, about: darkAbout },
  );
  const darkShot = await shot(browser, "probe-update-ac2-local-dark.png");
  const darkErrors = await collectErrors(browser);
  pageErrors.push(...darkErrors);
  record("AC2 深色主题下查看关于块没有未捕获异常", darkErrors.length === 0, { errors: darkErrors });

  // 后面的 registry 截图回到浅色，保持证据一致。
  await browser.raw.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });

  await service.close();
  service = null;

  /* ---------------- AC3 / AC4 / AC5：registry + 注入 repository ---------------- */
  let mode = "ok";
  let clock = 1000;
  const fetchImpl = async () => {
    if (mode === "timeout") {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    return new Response(
      JSON.stringify({
        tag_name: "v0.2.0",
        html_url: "https://github.com/acme/magpie-terminal/releases/tag/v0.2.0",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  service = await startIsolated("registry", {
    plugins: { plugins: [{ spec: "magpie-terminal@latest" }] },
    packageInfo: {
      version: packageJson.version,
      name: packageJson.name,
      repository: "https://github.com/acme/magpie-terminal",
    },
    updateCheck: { fetchImpl, cache: new Map(), now: () => clock },
  });

  const registryVersion = await (
    await fetch(`${service.base}/api/version`, { headers: service.headers })
  ).json();
  record(
    "AC3 /api/version：registry + repository → 可点地址 + updateSupported:true",
    registryVersion.installKind === "registry" &&
      registryVersion.repository === "https://github.com/acme/magpie-terminal" &&
      registryVersion.updateSupported === true,
    registryVersion,
  );

  await browser.navigate(`${service.base}/?token=${service.handle.token}&theme=light`);
  await sleep(1500);
  await installErrorHooks(browser);
  await openSettings(browser);
  await scrollToAbout(browser);

  const registryAbout = await readAbout(browser);
  record(
    "AC3 有 repository 时「检查更新」可点，安装方式显示版本包",
    registryAbout.checkDisabled === false && registryAbout.installKind.includes("版本包"),
    { disabled: registryAbout.checkDisabled, installKind: registryAbout.installKind },
  );
  record(
    "AC5 registry 的「如何更新」给出 magpie plugin update magpie-terminal",
    registryAbout.howto.includes("magpie plugin update magpie-terminal"),
    { howto: registryAbout.howto },
  );

  await clickCheck(browser);
  const success = await waitStatus(
    browser,
    (about) => about.status.includes("发现新版本") && about.status.includes("0.2.0"),
    "update success",
  );
  record(
    "AC3 点击「检查更新」→ 显示发现新版本 0.2.0 + 当前 0.1.0 + 发布页链接",
    success.status.includes("当前 0.1.0") &&
      success.statusHref === "https://github.com/acme/magpie-terminal/releases/tag/v0.2.0",
    { status: success.status, href: success.statusHref },
  );
  const successShot = await shot(browser, "probe-update-ac3-registry.png");

  // AC4：让下一次检查超时；把假时钟推过 5 分钟，避免命中上一条成功的缓存。
  mode = "timeout";
  clock += UPDATE_CACHE_TTL_MS;
  await clickCheck(browser);
  const failure = await waitStatus(
    browser,
    (about) => about.status.includes("检查失败"),
    "update failure",
  );
  record(
    "AC4 超时 → 显示「检查失败：连不上 GitHub（超时）」，不伪装已是最新",
    failure.status.includes("超时") &&
      failure.status.includes("检查失败") &&
      !failure.status.includes("已是最新") &&
      failure.statusTone === "error",
    { status: failure.status, tone: failure.statusTone },
  );
  const failureShot = await shot(browser, "probe-update-ac4-timeout.png");

  const registryErrors = await collectErrors(browser);
  pageErrors.push(...registryErrors);
  record(
    "AC3/AC4 检查更新的全过程中没有未捕获异常，设置页仍可交互",
    registryErrors.length === 0,
    { errors: registryErrors },
  );

  const summary = {
    ok: results.every((item) => item.pass),
    results,
    pageErrors,
    evidence: { local: localShot, localDark: darkShot, success: successShot, failure: failureShot },
    version,
    registryVersion,
  };
  await writeFile(path.join(evidenceDir, "probe-update.json"), JSON.stringify(summary, null, 2), "utf8");
} catch (err) {
  error = err && err.stack ? err.stack : String(err);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // 忽略。
    }
  }
  if (service) {
    try {
      await service.close();
    } catch {
      // 忽略。
    }
  }
}

if (json) {
  console.log(JSON.stringify({ results, pageErrors, error }, null, 2));
} else {
  if (error) console.log(`ERROR ${error}`);
  const failed = results.filter((item) => !item.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
}
process.exit(error || results.some((item) => !item.pass) ? 1 : 0);
