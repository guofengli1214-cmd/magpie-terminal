// TASK-FIX17-I 真浏览器探针（AC3 / AC5 / AC6 / AC7 的浏览器一半）。
//
// 用法（仓库根）：node scripts/probe-allowlist-ui.mjs [--out result.json] [--port 3921]
//
// 全部真跑，不 mock：
//   1. 起一个隔离服务（`MAGPIE_TERMINAL_CONFIG_PATH` 指到
//      `.dispatch/fix17-i/cfg/config.json`，绝不碰用户真配置）；
//   2. 真 Chrome（headless + CDP）打开应用页 → 点 rail 的设置按钮打开设置页；
//   3. AC5 默认态：新 block 存在，条数 === DEFAULT_BUILTIN_ALLOWLIST.length，
//      且「共 N 条」文案与之一致 → 截图；
//   4. 真点「删除」删掉第一条（free）→ 真点「保存」→ 用 GET /api/config 断言少了一条
//      → 同一进程内 import { classify } + builtinRulesFrom 判级，断言被删的
//      `free -h` 变 confirm、其它条目仍 auto → 截图；
//   5. 真点「恢复默认」→ 真点「保存」→ 断言条数与默认一致、判级恢复 auto → 截图；
//   6. 添加行真的能用：输入非法值 → 页内状态行报错且列表不变；输入合法值 → 加进去；
//      就地「编辑」也真跑一遍；
//   7. 全程 `window.__probeErrors` 必须为 0。
//
// 退出码：全过 0，任一失败 1。结果 JSON 落盘（--out 可改）。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { openBrowser, sleep } from "./lib/cdp.mjs";
import { CONFIG_PATH_ENV, publicConfig } from "../src/config/store.mjs";
import { DEFAULT_BUILTIN_ALLOWLIST, builtinRulesFrom } from "../src/policy/allowlist.mjs";
import { classify } from "../src/policy/classify.mjs";
import { startServer, makeLogger } from "../src/server/http.mjs";

const LOG_DIR_ENV = "MAGPIE_TERMINAL_LOG_DIR";

const ROOT = path.resolve(".");
const DISPATCH = path.join(ROOT, ".dispatch", "fix17-i");
const CFG_DIR = path.join(DISPATCH, "cfg");
const LOG_DIR = path.join(DISPATCH, "probe-logs");
const EVIDENCE = path.join(DISPATCH, "evidence");
const SHOTS = path.join(EVIDENCE, "ui");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  const value = index > -1 ? process.argv[index + 1] : null;
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const results = [];
function record(name, pass, detail, expected) {
  results.push({ name, pass: Boolean(pass), detail: detail ?? null, expected: expected ?? null });
  if (pass) console.log(`PASS  ${name}`);
  else console.log(`FAIL  ${name}\n      got=${JSON.stringify(detail)}\n      expected=${JSON.stringify(expected)}`);
}

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

/** 用一份内置清单判级（与 judge 传 opts.allowlist 的形态完全相同）。 */
function decide(command, list) {
  return classify(command, { allowlist: builtinRulesFrom(list) });
}

/* ---------------------------------- 主流程 ---------------------------------- */

const outPath = argValue("--out", path.join(EVIDENCE, "probe-allowlist-ui.json"));
const forcedPort = argValue("--port", null);

mkdirSync(CFG_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const configFile = path.join(CFG_DIR, "config.json");
// 从干净的 config.json 开始：老配置升级路径单独由单测覆盖，
// 探针要断言的是「第一次打开设置页看到默认清单」。
rmSync(configFile, { force: true });
writeFileSync(configFile, `${JSON.stringify({ version: 1 }, null, 2)}\n`, "utf8");

process.env[CONFIG_PATH_ENV] = configFile;
process.env[LOG_DIR_ENV] = LOG_DIR;

const port = forcedPort ? Number(forcedPort) : await freePort();
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const handle = await startServer({ port, log: makeLogger({ log() {}, warn() {} }, { file: false }) });
const base = `http://127.0.0.1:${port}`;
const apiHeaders = { "x-magpie-term-token": handle.token };

async function getConfig() {
  const response = await fetch(`${base}/api/config`, { headers: apiHeaders });
  const body = await response.json();
  return body;
}

let browser = null;
let failure = null;
try {
  const initial = await getConfig();
  record(
    "AC3.a 隔离服务的 GET /api/config 带默认清单（条数与 DEFAULT_BUILTIN_ALLOWLIST 一致）",
    Array.isArray(initial.builtinAllowlist) && initial.builtinAllowlist.length === DEFAULT_BUILTIN_ALLOWLIST.length,
    { actual: Array.isArray(initial.builtinAllowlist) ? initial.builtinAllowlist.length : null },
    { expected: DEFAULT_BUILTIN_ALLOWLIST.length },
  );

  browser = await openBrowser({ width: 1400, height: 940 });
  await browser.navigate(`${base}/?token=${handle.token}`);
  const evaluate = (expression, opts) => browser.evaluate(expression, opts);

  // 等应用起来（终端首个会话 + 帧函数），再装错误收集器。
  for (let waited = 0; ; waited += 200) {
    const ready = await evaluate("document.readyState === 'complete' && typeof window.__termDebugFrame === 'function'");
    if (ready) break;
    if (waited > 30000) throw new Error("页面加载超时（__termDebugFrame 没出现）");
    await sleep(200);
  }
  await evaluate(`
    (() => {
      window.__probeErrors = [];
      window.addEventListener('error', (event) => window.__probeErrors.push(String(event.message || 'error')));
      window.addEventListener('unhandledrejection', (event) => {
        window.__probeErrors.push('unhandledrejection: ' + String(event.reason));
      });
      return true;
    })()
  `);

  const waitFor = async (expression, timeoutMs, label) => {
    for (let waited = 0; ; waited += 150) {
      const value = await evaluate(expression);
      if (value) return value;
      if (waited > timeoutMs) throw new Error(`等待超时：${label}`);
      await sleep(150);
    }
  };

  const shot = async (name) => {
    const buffer = await browser.screenshot();
    const file = path.join(SHOTS, name);
    if (buffer) writeFileSync(file, buffer);
    return buffer ? file : null;
  };

  /* ------------------------------ 打开设置页 ------------------------------ */

  await evaluate("document.querySelector('[data-role=\"rail-settings\"]').click()");
  await waitFor("!!document.querySelector('[data-role=\"settings-modal\"]')", 10000, "设置页打开");
  await waitFor(
    "document.querySelectorAll('[data-role=\"builtin-allowlist-item\"]').length > 0",
    15000,
    "内置白名单列表渲染",
  );

  const DEFAULT_COUNT = DEFAULT_BUILTIN_ALLOWLIST.length;
  const readRows = () =>
    evaluate(`
      (() => {
        const nodes = [...document.querySelectorAll('[data-role="builtin-allowlist-item"]')];
        return nodes.map((node) => {
          const rule = node.querySelector('[data-role="builtin-allowlist-rule"]');
          return rule ? rule.textContent : null;
        });
      })()
    `);

  /* ------------------------------ AC5 默认态 ------------------------------ */

  const initialRows = await readRows();
  const initialCountText = await evaluate(
    "document.querySelector('[data-role=\"builtin-allowlist-count\"]')?.textContent || ''",
  );
  await evaluate(`
    (() => {
      const block = document.querySelector('[data-block="builtin-allowlist"]');
      if (block && typeof block.scrollIntoView === 'function') block.scrollIntoView({ block: 'center' });
      return true;
    })()
  `);
  await sleep(400);
  const defaultShot = await shot("settings-builtin-allowlist.png");

  record(
    "AC5.a 设置页默认显示全部内置条目（条数 === DEFAULT_BUILTIN_ALLOWLIST.length，内容逐项一致）",
    initialRows.length === DEFAULT_COUNT &&
      initialRows.every((rule, index) => rule === DEFAULT_BUILTIN_ALLOWLIST[index]),
    { count: initialRows.length, first: initialRows.slice(0, 3), last: initialRows.slice(-2) },
    { count: DEFAULT_COUNT },
  );
  record(
    "AC5.b 底部「共 N 条」文案与实际条数一致",
    initialCountText.replace(/\s+/g, "") === `共${DEFAULT_COUNT}条`,
    { actual: initialCountText },
    { expected: `共 ${DEFAULT_COUNT} 条` },
  );
  record("AC5.c 列表区域自身可滚动（max-height + overflow:auto），不撑高设置模态", await evaluate(`
    (() => {
      const list = document.querySelector('[data-role="builtin-allowlist-list"]');
      if (!list) return false;
      const style = getComputedStyle(list);
      const overflow = style.overflowY;
      const scrolls = list.scrollHeight > list.clientHeight;
      return (overflow === 'auto' || overflow === 'scroll') && scrolls;
    })()
  `), await evaluate(`(() => {
    const list = document.querySelector('[data-role="builtin-allowlist-list"]');
    if (!list) return null;
    const style = getComputedStyle(list);
    return { overflowY: style.overflowY, maxHeight: style.maxHeight, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
  })()`));

  /* -------------------------- 添加行：校验 + 真添加 -------------------------- */

  const invalidAttempt = await evaluate(`
    (() => {
      const input = document.querySelector('[data-role="builtin-input"]');
      const before = document.querySelectorAll('[data-role="builtin-allowlist-item"]').length;
      input.value = 'ls; rm -rf /';
      document.querySelector('[data-role="builtin-add"]').click();
      const status = document.querySelector('[data-role="builtin-allowlist-status"]');
      return {
        before,
        after: document.querySelectorAll('[data-role="builtin-allowlist-item"]').length,
        status: status ? status.textContent : '',
        tone: status ? status.getAttribute('data-tone') : null,
      };
    })()
  `);
  record(
    "AC5.d 添加非法值 → 页内状态行报错（error tone），列表不变",
    invalidAttempt.after === invalidAttempt.before &&
      invalidAttempt.tone === "error" &&
      invalidAttempt.status.length > 0,
    invalidAttempt,
    { tone: "error", unchanged: true },
  );

  const added = await evaluate(`
    (() => {
      const input = document.querySelector('[data-role="builtin-input"]');
      input.value = 'tree';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const rows = [...document.querySelectorAll('[data-role="builtin-allowlist-rule"]')].map((n) => n.textContent);
      return { count: rows.length, last: rows[rows.length - 1] };
    })()
  `);
  record(
    "AC5.e 回车等同点「添加」：合法值进了列表（就地渲染，尚未落盘）",
    added.count === DEFAULT_COUNT + 1 && added.last === "tree",
    added,
    { count: DEFAULT_COUNT + 1, last: "tree" },
  );

  /* ---------------------- 就地编辑：把刚加的那条改掉 ---------------------- */

  const edited = await evaluate(`
    (() => {
      const items = [...document.querySelectorAll('[data-role="builtin-allowlist-item"]')];
      const target = items[items.length - 1];
      target.querySelector('[data-role="builtin-edit"]').click();
      const input = document.querySelector('[data-role="builtin-edit-input"]');
      if (!input) return { ok: false, why: 'no edit input' };
      const prefilled = input.value;
      input.value = 'du';
      document.querySelector('[data-role="builtin-save-edit"]').click();
      const rows = [...document.querySelectorAll('[data-role="builtin-allowlist-rule"]')].map((n) => n.textContent);
      return {
        ok: true,
        prefilled,
        count: rows.length,
        last: rows[rows.length - 1],
        status: document.querySelector('[data-role="builtin-allowlist-status"]')?.textContent || '',
      };
    })()
  `);
  record(
    "AC5.f 「编辑」把行变成预填 input，保存后就地替换（不新增行）",
    edited.ok === true &&
      edited.prefilled === "tree" &&
      edited.count === DEFAULT_COUNT + 1 &&
      edited.last === "du",
    edited,
    { prefilled: "tree", count: DEFAULT_COUNT + 1, last: "du" },
  );

  // 把编辑过的那条删掉，回到「默认 + 删一条」的干净局面。
  await evaluate(`
    (() => {
      const items = [...document.querySelectorAll('[data-role="builtin-allowlist-item"]')];
      items[items.length - 1].querySelector('[data-role="builtin-remove"]').click();
      return document.querySelectorAll('[data-role="builtin-allowlist-item"]').length;
    })()
  `);

  /* ------------------- 删掉第一条（free）→ 保存 → 判级 ------------------- */

  const REMOVED_RULE = "free";
  const EXPECTED_AFTER_REMOVE = DEFAULT_COUNT - 1;
  const removedUi = await evaluate(`
    (() => {
      const items = [...document.querySelectorAll('[data-role="builtin-allowlist-item"]')];
      const target = items.find((node) => {
        const rule = node.querySelector('[data-role="builtin-allowlist-rule"]');
        return rule && rule.textContent === 'free';
      });
      if (!target) return { removed: null, count: items.length, why: 'no free row' };
      target.querySelector('[data-role="builtin-remove"]').click();
      return {
        removed: 'free',
        count: document.querySelectorAll('[data-role="builtin-allowlist-item"]').length,
        countText: document.querySelector('[data-role="builtin-allowlist-count"]')?.textContent || '',
        status: document.querySelector('[data-role="builtin-allowlist-status"]')?.textContent || '',
      };
    })()
  `);
  record(
    "AC5.g 点「删除」删掉 free 那一行，页内条数 -1，状态行提示点保存后生效",
    removedUi.removed === REMOVED_RULE &&
      removedUi.count === EXPECTED_AFTER_REMOVE &&
      /保存.*后生效/.test(removedUi.status),
    removedUi,
    { removed: REMOVED_RULE, count: EXPECTED_AFTER_REMOVE },
  );
  const removedShot = await shot("settings-builtin-allowlist-removed.png");

  await evaluate("document.querySelector('[data-role=\"settings-save\"]').click()");
  await waitFor(
    "(document.querySelector('[data-role=\"settings-status\"]')?.textContent || '').includes('已保存')",
    15000,
    "设置保存成功",
  );
  await waitFor(
    "!document.querySelector('[data-role=\"settings-modal\"]') || document.querySelector('[data-role=\"settings-modal\"]').closest('[data-role=\"settings-backdrop\"]').hidden",
    10000,
    "设置页关闭",
  );

  const afterRemove = await getConfig();
  const afterRemoveList = Array.isArray(afterRemove.builtinAllowlist) ? afterRemove.builtinAllowlist : null;
  const expectedAfterRemove = DEFAULT_BUILTIN_ALLOWLIST.filter((rule) => rule !== REMOVED_RULE);
  record(
    "AC5.h 保存后 GET /api/config 少了一条，且少的正是 free（其它条目顺序不变）",
    afterRemoveList !== null &&
      afterRemoveList.length === EXPECTED_AFTER_REMOVE &&
      !afterRemoveList.includes(REMOVED_RULE) &&
      afterRemoveList.every((rule, index) => rule === expectedAfterRemove[index]),
    {
      count: afterRemoveList ? afterRemoveList.length : null,
      hasFree: afterRemoveList ? afterRemoveList.includes(REMOVED_RULE) : null,
    },
    { count: EXPECTED_AFTER_REMOVE, hasFree: false },
  );

  // 同一进程内用保存后的配置判级：被删的那条变 confirm，其它仍 auto。
  const freeVerdict = decide("free -h", afterRemoveList);
  const others = [
    ["ls -la", "allow:ls"],
    ["cat a.txt", "allow:cat"],
    ["git status", "allow:git status"],
    ["docker volume ls", "allow:docker volume ls"],
  ];
  const otherVerdicts = others.map(([command]) => ({ command, ...decide(command, afterRemoveList) }));
  record(
    "AC5.i 用保存后的配置判级：free -h 变 confirm（default:free），其它条目仍 auto",
    freeVerdict.decision === "confirm" &&
      freeVerdict.hit === "default:free" &&
      otherVerdicts.every((item) => item.decision === "auto"),
    { freeVerdict, otherVerdicts },
    { freeVerdict: { decision: "confirm", hit: "default:free" }, others: "auto" },
  );
  // 安全不变式在真服务上再确认一次：删了清单也不会让 rm 变得可自动执行。
  const rmAfter = decide("rm -rf x", afterRemoveList);
  record(
    "AC4 真服务侧复核：清单被改后 rm -rf x 仍 deny:rm（黑名单不可配置）",
    rmAfter.decision === "confirm" && rmAfter.hit === "deny:rm",
    rmAfter,
    { decision: "confirm", hit: "deny:rm" },
  );
  // 顺手用服务端归一后的配置跑一遍（publicConfig 的形态，与 judge 拿到的一致）。
  const serverView = publicConfig(afterRemove);
  record(
    "AC5.j GET /api/config 的归一结果与落盘一致（publicConfig 读回同一条数）",
    Array.isArray(serverView.builtinAllowlist) && serverView.builtinAllowlist.length === EXPECTED_AFTER_REMOVE,
    { count: serverView.builtinAllowlist ? serverView.builtinAllowlist.length : null },
    { count: EXPECTED_AFTER_REMOVE },
  );

  /* ------------------- 恢复默认 → 保存 → 条数/判级恢复 ------------------- */

  await evaluate("document.querySelector('[data-role=\"rail-settings\"]').click()");
  await waitFor(
    "document.querySelectorAll('[data-role=\"builtin-allowlist-item\"]').length > 0",
    15000,
    "设置页重开（列表带已保存的清单）",
  );
  const reopenedCount = await evaluate(
    "document.querySelectorAll('[data-role=\"builtin-allowlist-item\"]').length",
  );
  record(
    "AC5.k 重新打开设置页，列表是已保存的清单（少 free，条数 -1）",
    reopenedCount === EXPECTED_AFTER_REMOVE,
    { actual: reopenedCount },
    { expected: EXPECTED_AFTER_REMOVE },
  );

  const resetUi = await evaluate(`
    (() => {
      document.querySelector('[data-role="builtin-reset"]').click();
      return {
        count: document.querySelectorAll('[data-role="builtin-allowlist-item"]').length,
        countText: document.querySelector('[data-role="builtin-allowlist-count"]')?.textContent || '',
        status: document.querySelector('[data-role="builtin-allowlist-status"]')?.textContent || '',
        first: document.querySelector('[data-role="builtin-allowlist-rule"]')?.textContent || '',
      };
    })()
  `);
  record(
    "AC5.l 点「恢复默认」→ 条数回到默认、状态行提示「点保存后生效」",
    resetUi.count === DEFAULT_COUNT &&
      resetUi.first === DEFAULT_BUILTIN_ALLOWLIST[0] &&
      /保存/.test(resetUi.status),
    resetUi,
    { count: DEFAULT_COUNT, first: DEFAULT_BUILTIN_ALLOWLIST[0] },
  );
  await evaluate(`
    (() => {
      const block = document.querySelector('[data-block="builtin-allowlist"]');
      if (block && typeof block.scrollIntoView === 'function') block.scrollIntoView({ block: 'center' });
      return true;
    })()
  `);
  await sleep(400);
  const resetStatusBeforeShot = await evaluate(
    "document.querySelector('[data-role=\"builtin-allowlist-status\"]')?.textContent || ''",
  );
  record(
    "AC5.l2 截图时点「恢复默认」的提示行仍然可见（没有被异步 load() 抹掉）",
    /保存/.test(resetStatusBeforeShot),
    { actual: resetStatusBeforeShot },
    { contains: "保存" },
  );
  const resetShot = await shot("settings-builtin-allowlist-reset.png");

  await evaluate("document.querySelector('[data-role=\"settings-save\"]').click()");
  await waitFor(
    "(document.querySelector('[data-role=\"settings-status\"]')?.textContent || '').includes('已保存')",
    15000,
    "恢复默认后保存成功",
  );

  const afterReset = await getConfig();
  const afterResetList = Array.isArray(afterReset.builtinAllowlist) ? afterReset.builtinAllowlist : null;
  record(
    "AC5.m 恢复默认 + 保存后：条数与内容与默认清单逐项一致",
    afterResetList !== null &&
      afterResetList.length === DEFAULT_COUNT &&
      afterResetList.every((rule, index) => rule === DEFAULT_BUILTIN_ALLOWLIST[index]),
    { count: afterResetList ? afterResetList.length : null },
    { count: DEFAULT_COUNT },
  );
  const restoredFree = decide("free -h", afterResetList);
  record(
    "AC5.n 判级恢复：free -h 又变回 auto（allow:free）",
    restoredFree.decision === "auto" && restoredFree.hit === "allow:free",
    restoredFree,
    { decision: "auto", hit: "allow:free" },
  );

  /* ------------- R5 老配置升级：缺字段不标 dirty、不写回默认值 ------------- */

  // 把 config.json 重置成「老配置」（没有 builtinAllowlist 字段），重载页面。
  writeFileSync(configFile, `${JSON.stringify({ version: 1 }, null, 2)}\n`, "utf8");
  await browser.navigate(`${base}/?token=${handle.token}`);
  for (let waited = 0; ; waited += 200) {
    const ready = await evaluate("document.readyState === 'complete' && typeof window.__termDebugFrame === 'function'");
    if (ready) break;
    if (waited > 30000) throw new Error("页面重载超时");
    await sleep(200);
  }
  await evaluate(`
    (() => {
      window.__probeErrors = [];
      window.addEventListener('error', (event) => window.__probeErrors.push(String(event.message || 'error')));
      window.addEventListener('unhandledrejection', (event) => {
        window.__probeErrors.push('unhandledrejection: ' + String(event.reason));
      });
      // 记下每一次 PUT /api/config 的 body（用来断言「没动过就不发这个字段」）。
      window.__putBodies = [];
      const originalFetch = window.fetch;
      window.fetch = function patched(input, init) {
        try {
          const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
          if (init && init.method === 'PUT' && url.includes('/api/config')) {
            window.__putBodies.push(init.body ? String(init.body) : null);
          }
        } catch {}
        return originalFetch.apply(this, arguments);
      };
      return true;
    })()
  `);

  await evaluate("document.querySelector('[data-role=\"rail-settings\"]').click()");
  await waitFor(
    "document.querySelectorAll('[data-role=\"builtin-allowlist-item\"]').length > 0",
    15000,
    "老配置打开设置页：列表显示默认清单",
  );
  const legacyCount = await evaluate("document.querySelectorAll('[data-role=\"builtin-allowlist-item\"]').length");
  record(
    "R5.a 老配置（无 builtinAllowlist 字段）打开设置页：显示全部默认条目（按默认值工作）",
    legacyCount === DEFAULT_COUNT,
    { actual: legacyCount },
    { expected: DEFAULT_COUNT },
  );

  // 不动内置清单，只点保存 → PUT body 里不应该出现 builtinAllowlist。
  await evaluate("document.querySelector('[data-role=\"settings-save\"]').click()");
  await waitFor(
    "(document.querySelector('[data-role=\"settings-status\"]')?.textContent || '').includes('已保存')",
    15000,
    "老配置直接保存成功",
  );
  const putBodies = await evaluate("window.__putBodies.map((body) => { try { return JSON.parse(body); } catch { return { unparsable: body }; } })");
  const sentBuiltin = Array.isArray(putBodies)
    ? putBodies.some((body) => body && Object.prototype.hasOwnProperty.call(body, "builtinAllowlist"))
    : true;
  record(
    "R5.b 老配置「未动过就不标 dirty」：直接点保存时 PUT body 里没有 builtinAllowlist（不会把默认值写回）",
    Array.isArray(putBodies) && putBodies.length > 0 && sentBuiltin === false,
    { putCount: Array.isArray(putBodies) ? putBodies.length : null, keys: Array.isArray(putBodies[0]) ? null : Object.keys(putBodies[0] || {}), sentBuiltin },
    { sentBuiltin: false },
  );
  const legacyAfter = await getConfig();
  record(
    "R5.c 老配置保存后仍是默认 59 条（按默认值工作，行为无变化）",
    Array.isArray(legacyAfter.builtinAllowlist) && legacyAfter.builtinAllowlist.length === DEFAULT_COUNT,
    { actual: Array.isArray(legacyAfter.builtinAllowlist) ? legacyAfter.builtinAllowlist.length : null },
    { expected: DEFAULT_COUNT },
  );

  /* ------------------------------ 页面错误 0 ------------------------------ */

  const errors = await evaluate("window.__probeErrors || []");
  record(
    "AC3.b 全程 window.__probeErrors 为 0（没有 JS 异常）",
    Array.isArray(errors) && errors.length === 0,
    { errors },
    { errors: [] },
  );

  const final = await getConfig();
  const payload = {
    ok: results.every((item) => item.pass),
    passed: results.filter((item) => item.pass).length,
    total: results.length,
    configFile,
    port,
    screenshots: { default: defaultShot, removed: removedShot, reset: resetShot },
    config: {
      initialCount: Array.isArray(initial.builtinAllowlist) ? initial.builtinAllowlist.length : null,
      afterRemoveCount: afterRemoveList ? afterRemoveList.length : null,
      afterResetCount: Array.isArray(final.builtinAllowlist) ? final.builtinAllowlist.length : null,
      removed: REMOVED_RULE,
      classify: { afterRemove: freeVerdict, afterReset: restoredFree, rmAfterRemove: rmAfter, others: otherVerdicts },
    },
    results,
  };
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log("");
  console.log(
    `${payload.ok ? "PASS" : "FAIL"} ${payload.passed}/${payload.total}  → ${path.relative(ROOT, outPath)}`,
  );
  if (!payload.ok) process.exitCode = 1;
} catch (err) {
  failure = err;
  console.error(`探针异常：${err && err.message ? err.message : err}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await handle.close();
  if (failure) {
    try {
      writeFileSync(
        outPath,
        `${JSON.stringify(
          { ok: false, error: String(failure && failure.message ? failure.message : failure), results },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } catch {
      // 写不进去就只在 stdout 里留痕。
    }
  }
}

// 只读引用一下 readFileSync，避免「导入了没用」的假告警（有些 lint 配置会抱怨）。
void readFileSync;
