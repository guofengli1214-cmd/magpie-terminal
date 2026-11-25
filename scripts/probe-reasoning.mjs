// TASK-FIX17-L4 真浏览器探针（AC5 / AC6 的浏览器一半；AC3/AC4 的请求体由
// test/ai/reasoning.test.mjs 用本地 stub 网关断言，这里不碰真模型）。
//
// 用法：node scripts/probe-reasoning.mjs [--chrome <path>] [--port 3910] [--devtools-port 9356]
//
// 做的事（全部本机、全部隔离）：
//   1. 起一个本地 stub 网关（只实现 GET /v1/models）：一个支持推理的模型
//      （low/high/max）+ 一个不支持的模型；
//   2. 起隔离服务（MAGPIE_TERMINAL_CONFIG_PATH / MAGPIE_TERMINAL_LOG_DIR /
//      MAGPIE_TERMINAL_GATEWAY_URL 全指到 `.dispatch/fix17-l4/probe/` 与 stub，
//      绝不碰用户真配置、真网关）；
//   3. 真 Chrome（headless + CDP）打开应用页：
//        AC5：AI 栏出现 [data-role="conversation-reasoning"]，选项 = 当前模型
//             reasoningLevels；切到「高」→ GET /api/config 变 high；刷新后仍显示「高」；
//        AC6：设置页 [data-role="review-reasoning"] 同步；换审阅模型后选项随之变化；
//             不支持 reasoning 的模型 → 禁用 + 「这个模型不支持推理强度」。
//
// 退出码：两组全过 0，任一失败 1。结果 JSON 落 `.dispatch/fix17-l4/evidence/`。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

import { startServer, makeLogger } from "../src/server/http.mjs";
import { CONFIG_PATH_ENV } from "../src/config/store.mjs";

const HERE = path.resolve(".");
const PROBE_ROOT = path.join(HERE, ".dispatch", "fix17-l4", "probe");
const EVIDENCE = path.join(HERE, ".dispatch", "fix17-l4", "evidence");

const REASON_MODEL = {
  id: "probe/reason-model",
  magpie_label: "Probe Reason Model",
  context_length: 1000000,
  reasoning: true,
  reasoning_levels: ["low", "high", "max"],
  supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
};

const PLAIN_MODEL = {
  id: "probe/plain-model",
  magpie_label: "Probe Plain Model",
  context_length: 200000,
};

const DEFAULT_CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function findChrome(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------ stub 网关 ------------------------------ */

function startStubGateway(models) {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      const body = JSON.stringify({ data: models });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const body = JSON.stringify({ error: { message: "not found" } });
    res.writeHead(404, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/* ------------------------------ CDP 客户端 ------------------------------ */

function httpJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("devtools http timeout")));
    req.end();
  });
}

async function waitForDevtools(port, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      const info = await httpJson(`http://127.0.0.1:${port}/json/version`);
      if (info && info.webSocketDebuggerUrl) return info;
    } catch {
      // 还没起来。
    }
    if (Date.now() - started > timeoutMs) throw new Error("devtools endpoint never came up");
    await sleep(150);
  }
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          nextId += 1;
          const id = nextId;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP timeout: ${method}`));
              }
            }, 20000);
          });
        },
        close() {
          try {
            socket.close();
          } catch {
            // 忽略。
          }
        },
      });
    });
    socket.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!msg.id || !pending.has(msg.id)) return;
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message || "CDP error"));
      else res(msg.result || {});
    });
    socket.addEventListener("error", (event) => {
      reject(new Error(`CDP socket error: ${event && event.message ? event.message : "unknown"}`));
    });
  });
}

/* -------------------------------- 主体 -------------------------------- */

const results = {
  ac5: null,
  ac6: null,
  errors: [],
  stubModels: [REASON_MODEL.id, PLAIN_MODEL.id],
};

function fail(where, message, extra) {
  results.errors.push({ where, message, extra: extra || null });
  console.error(`FAIL  ${where}: ${message}`, extra ? JSON.stringify(extra) : "");
}

async function main() {
  const chrome = findChrome(argValue("--chrome", null));
  if (!chrome) throw new Error("找不到 Chrome / Edge，无法跑真浏览器探针");
  const port = Number(argValue("--port", "3910"));
  const devtoolsPort = Number(argValue("--devtools-port", "9356"));

  rmSync(PROBE_ROOT, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  mkdirSync(path.join(PROBE_ROOT, "config"), { recursive: true });
  mkdirSync(path.join(PROBE_ROOT, "logs"), { recursive: true });

  process.env[CONFIG_PATH_ENV] = path.join(PROBE_ROOT, "config", "config.json");
  process.env["MAGPIE_TERMINAL_LOG_DIR"] = path.join(PROBE_ROOT, "logs");

  const stub = await startStubGateway([REASON_MODEL, PLAIN_MODEL]);
  process.env["MAGPIE_TERMINAL_GATEWAY_URL"] = stub.url;

  const log = makeLogger({ log() {}, warn() {} }, { file: true, dedupeWindowMs: 0 });
  const handle = await startServer({ port, log });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-magpie-term-token": handle.token, "content-type": "application/json" };
  const api = async (pathname, init = {}) => {
    const response = await fetch(`${base}${pathname}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  };
  const configNow = async () => {
    const got = await api("/api/config");
    return got.body || {};
  };

  const profileDir = mkdtempSync(path.join(tmpdir(), "magpie-term-reasoning-"));
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${devtoolsPort}`,
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let client = null;

  try {
    await waitForDevtools(devtoolsPort, 15000);
    const target = await httpJson(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, "PUT");
    client = await cdpConnect(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    const evaluate = async (expression, { awaitPromise = false } = {}) => {
      const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
      if (result && result.exceptionDetails) {
        throw new Error(`页面脚本报错：${result.exceptionDetails.text || "unknown"}`);
      }
      return result && result.result ? result.result.value : undefined;
    };
    const waitFor = async (expression, timeoutMs, label) => {
      const started = Date.now();
      for (;;) {
        const value = await evaluate(expression);
        if (value) return value;
        if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
        await sleep(150);
      }
    };
    const shot = async (name) => {
      const { data } = await client.send("Page.captureScreenshot", { format: "png" });
      const file = path.join(EVIDENCE, name);
      writeFileSync(file, Buffer.from(data, "base64"));
      return file;
    };
    const reload = async () => {
      await client.send("Page.navigate", { url: base });
      await waitFor("document.readyState === 'complete'", 20000, "页面加载");
      await sleep(1200);
    };

    await reload();

    /* ------------------------------- AC5 ------------------------------- */

    // 打开 AI 抽屉（把手在右边缘）。
    await evaluate("document.querySelector('[data-role=\"ai-handle\"]').click()");
    await waitFor(
      "document.querySelector('[data-role=\"app\"]').getAttribute('data-ai-open') === 'true'",
      10000,
      "AI 抽屉打开",
    );
    await waitFor("!!document.querySelector('[data-role=\"conversation-reasoning\"]')", 15000, "推理下拉存在");
    // 等 /api/models 回来（模型按钮不再是「网关不可用」）。
    await waitFor(
      "!document.querySelector('[data-role=\"model-select\"]').hasAttribute('data-gateway')",
      15000,
      "模型清单到位",
    );

    const ac5Initial = await evaluate(`
      (() => {
        const select = document.querySelector('[data-role="conversation-reasoning"]');
        const options = [...select.options].map((o) => ({ value: o.value, text: o.textContent }));
        const model = document.querySelector('[data-role="model-select"]').textContent.trim();
        return {
          exists: !!select,
          hidden: select.hidden,
          value: select.value,
          options,
          model,
          inTopbar: !!select.closest('.composer-topbar'),
          inComposerBox: !!select.closest('.composer-box'),
          width: Math.round(select.getBoundingClientRect().width),
          sameRow: (() => {
            const a = select.getBoundingClientRect();
            const b = document.querySelector('[data-role="model-select"]').getBoundingClientRect();
            return { modelRight: Math.round(b.right), selectLeft: Math.round(a.left), dy: Math.round(a.top - b.top) };
          })(),
        };
      })()
    `);
    results.ac5 = { initial: ac5Initial };
    if (ac5Initial.hidden) fail("AC5", "推理下拉不该隐藏（当前模型支持 reasoning）", ac5Initial);
    if (ac5Initial.inComposerBox) fail("AC5", "下拉不许塞进输入框", ac5Initial);
    const expectedLevels = REASON_MODEL.reasoning_levels;
    const optionValues = (ac5Initial.options || []).map((item) => item.value);
    if (JSON.stringify(optionValues) !== JSON.stringify(["", ...expectedLevels])) {
      fail("AC5", `选项必须 = ["", ...${JSON.stringify(expectedLevels)}]，实际 ${JSON.stringify(optionValues)}`);
    }
    if (!ac5Initial.options.some((item) => item.value === "" && item.text === "默认")) {
      fail("AC5", "首项必须是「默认」且 value 为空串", ac5Initial.options);
    }
    if (!ac5Initial.options.some((item) => item.value === "high" && item.text === "推理：高")) {
      fail("AC5", "缺少「推理：高」选项", ac5Initial.options);
    }
    if (ac5Initial.width < 80 || ac5Initial.width > 120) {
      fail("AC5", `下拉宽度应约 96px，实际 ${ac5Initial.width}`, ac5Initial);
    }

    // 切到「高」（真的走 select 的 change 事件 → PUT）。
    await evaluate(`
      (() => {
        const select = document.querySelector('[data-role="conversation-reasoning"]');
        select.value = 'high';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return select.value;
      })()
    `);
    let saved = null;
    const savedStarted = Date.now();
    while (Date.now() - savedStarted < 8000) {
      saved = await configNow();
      if (saved.conversationReasoning === "high") break;
      await sleep(150);
    }
    results.ac5.afterChange = { conversationReasoning: saved.conversationReasoning };
    if (saved.conversationReasoning !== "high") {
      fail("AC5", `GET /api/config 的 conversationReasoning 应为 high，实际 ${saved.conversationReasoning}`);
    }
    results.ac5.selectAfterChange = await evaluate(
      "document.querySelector('[data-role=\"conversation-reasoning\"]').value",
    );
    results.ac5.screenshot = await shot("ac5-conversation-reasoning.png");

    // 刷新后仍然显示「高」（从 GET /api/config 恢复）。
    await reload();
    await evaluate("document.querySelector('[data-role=\"ai-handle\"]').click()");
    await waitFor("!!document.querySelector('[data-role=\"conversation-reasoning\"]')", 15000, "刷新后下拉存在");
    await waitFor(
      "!document.querySelector('[data-role=\"model-select\"]').hasAttribute('data-gateway')",
      15000,
      "刷新后模型清单到位",
    );
    const afterReload = await evaluate(`
      (() => {
        const select = document.querySelector('[data-role="conversation-reasoning"]');
        return { value: select.value, text: select.options[select.selectedIndex]?.textContent || '', hidden: select.hidden };
      })()
    `);
    results.ac5.afterReload = afterReload;
    if (afterReload.value !== "high" || afterReload.text !== "推理：高") {
      fail("AC5", "刷新后必须仍显示「推理：高」", afterReload);
    }
    results.ac5.screenshotReload = await shot("ac5-after-reload.png");

    /* --------------------- 走查：换模型时下拉联动（AC7 的 UI 侧） --------------------- */

    const pickModel = async (modelId, label) => {
      await evaluate("document.querySelector('[data-role=\"model-select\"]').click()");
      await waitFor(
        "document.querySelector('[data-role=\"model-menu\"]') && !document.querySelector('[data-role=\"model-menu\"]').hidden",
        5000,
        `模型菜单打开（${label}）`,
      );
      await evaluate(
        `document.querySelector('[data-role="model-menu"] [data-model-id="${modelId}"]').click()`,
      );
      await sleep(200);
    };

    await pickModel(PLAIN_MODEL.id, "切到不支持推理的模型");
    await waitFor(
      "document.querySelector('[data-role=\"conversation-reasoning\"]').hidden === true",
      8000,
      "不支持推理的模型 → 下拉隐藏",
    );
    const afterPlain = await evaluate(`
      (() => {
        const select = document.querySelector('[data-role="conversation-reasoning"]');
        return { hidden: select.hidden, optionCount: select.options.length };
      })()
    `);
    const cfgAfterPlain = await configNow();
    results.walkthrough = {
      plainModel: { ...afterPlain, conversationReasoning: cfgAfterPlain.conversationReasoning },
    };
    if (!afterPlain.hidden) fail("WALK", "不支持推理的模型必须隐藏下拉", afterPlain);
    if (cfgAfterPlain.conversationReasoning !== "high") {
      fail("WALK", "模型不支持时不许清掉用户设的档位（AC7：请求侧降级，不是删配置）", cfgAfterPlain);
    }

    await pickModel(REASON_MODEL.id, "切回支持推理的模型");
    await waitFor(
      "document.querySelector('[data-role=\"conversation-reasoning\"]').hidden === false",
      8000,
      "切回后下拉回来",
    );
    const backValue = await evaluate(
      "document.querySelector('[data-role=\"conversation-reasoning\"]').value",
    );
    results.walkthrough.backValue = backValue;
    if (backValue !== "high") fail("WALK", "切回支持推理的模型后应仍显示「高」", backValue);

    /* ------------------------------- AC6 ------------------------------- */

    await evaluate("document.querySelector('[data-role=\"rail-settings\"]').click()");
    await waitFor("!!document.querySelector('[data-role=\"settings-modal\"]')", 10000, "设置页打开");
    // 存在 ≠ 已就绪：load() 是异步的，选项要等 /api/config + /api/models 都回来才有。
    await waitFor(
      "(document.querySelector('[data-role=\"review-reasoning\"]')?.options.length || 0) > 0",
      15000,
      "审阅推理下拉就绪",
    );

    const readReviewReasoning = () =>
      evaluate(`
        (() => {
          const select = document.querySelector('[data-role="review-reasoning"]');
          const model = document.querySelector('[data-role="review-model-select"]');
          return {
            exists: !!select,
            disabled: select.disabled,
            value: select.value,
            options: [...select.options].map((o) => ({ value: o.value, text: o.textContent })),
            hint: document.querySelector('[data-role="review-reasoning-hint"]')?.textContent || '',
            reviewModel: model ? model.value : null,
            inReviewBlock: !!select.closest('[data-block="review"]'),
            label: select.closest('.settings-reasoning-row')?.querySelector('label')?.textContent || '',
          };
        })()
      `);

    const ac6Initial = await readReviewReasoning();
    results.ac6 = { initial: ac6Initial };
    if (!ac6Initial.inReviewBlock) fail("AC6", "下拉必须在 data-block=\"review\" 内", ac6Initial);
    if (ac6Initial.label !== "推理强度") fail("AC6", "label 文案必须是「推理强度」", ac6Initial);
    if (ac6Initial.disabled) fail("AC6", "「与对话模型相同」且对话模型支持推理时不该禁用", ac6Initial);
    const initialReviewValues = (ac6Initial.options || []).map((item) => item.value);
    if (JSON.stringify(initialReviewValues) !== JSON.stringify(["", ...expectedLevels])) {
      fail("AC6", `审阅下拉选项应随对话模型 = ${JSON.stringify(expectedLevels)}，实际 ${JSON.stringify(initialReviewValues)}`);
    }

    // 换到不支持的模型 → 禁用 + 文案。
    const plainSwitch = await evaluate(`
      (() => {
        const model = document.querySelector('[data-role="review-model-select"]');
        model.value = ${JSON.stringify(PLAIN_MODEL.id)};
        model.dispatchEvent(new Event('change', { bubbles: true }));
        const select = document.querySelector('[data-role="review-reasoning"]');
        return {
          disabled: select.disabled,
          value: select.value,
          options: [...select.options].map((o) => o.value),
          hint: document.querySelector('[data-role="review-reasoning-hint"]')?.textContent || '',
        };
      })()
    `);
    results.ac6.plainModel = plainSwitch;
    if (!plainSwitch.disabled) fail("AC6", "不支持的模型必须禁用下拉", plainSwitch);
    if (!plainSwitch.hint.includes("这个模型不支持推理强度")) {
      fail("AC6", `禁用文案必须是「这个模型不支持推理强度」，实际「${plainSwitch.hint}」`);
    }

    // 换回支持推理的模型 → 选项回来、可选。
    const reasonSwitch = await evaluate(`
      (() => {
        const model = document.querySelector('[data-role="review-model-select"]');
        model.value = ${JSON.stringify(REASON_MODEL.id)};
        model.dispatchEvent(new Event('change', { bubbles: true }));
        const select = document.querySelector('[data-role="review-reasoning"]');
        select.value = 'low';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          disabled: select.disabled,
          value: select.value,
          options: [...select.options].map((o) => o.value),
        };
      })()
    `);
    results.ac6.reasonModel = reasonSwitch;
    if (reasonSwitch.disabled) fail("AC6", "换回支持推理的模型后必须可用", reasonSwitch);
    if (JSON.stringify(reasonSwitch.options) !== JSON.stringify(["", ...expectedLevels])) {
      fail("AC6", "换模型后选项必须随之重算", reasonSwitch);
    }
    // 截图前把「审阅模型」block 滚进可视区（设置 body 自己的 scrollTop，不动整页）。
    await evaluate(`
      (() => {
        const body = document.querySelector('.settings-body');
        const block = document.querySelector('[data-block="review"]');
        if (body && block) body.scrollTop = Math.max(0, block.offsetTop - body.offsetTop - 8);
        return body ? body.scrollTop : -1;
      })()
    `);
    await sleep(250);
    results.ac6.screenshot = await shot("ac6-review-reasoning.png");

    // 保存（沿用这一节的保存按钮）→ 落盘 → 刷新后回显。
    await evaluate("document.querySelector('[data-role=\"settings-save\"]').click()");
    let savedConfig = null;
    const reviewSavedStarted = Date.now();
    while (Date.now() - reviewSavedStarted < 10000) {
      savedConfig = await configNow();
      if (savedConfig.reviewReasoning === "low") break;
      await sleep(150);
    }
    results.ac6.saved = {
      reviewReasoning: savedConfig.reviewReasoning,
      reviewModel: savedConfig.reviewModel,
    };
    if (savedConfig.reviewReasoning !== "low") {
      fail("AC6", `保存后 reviewReasoning 应为 low，实际 ${savedConfig.reviewReasoning}`);
    }
    if (savedConfig.reviewModel !== REASON_MODEL.id) {
      fail("AC6", `保存后 reviewModel 应为 ${REASON_MODEL.id}，实际 ${savedConfig.reviewModel}`);
    }

    await reload();
    await evaluate("document.querySelector('[data-role=\"rail-settings\"]').click()");
    await waitFor(
      "(document.querySelector('[data-role=\"review-reasoning\"]')?.options.length || 0) > 0",
      15000,
      "刷新后审阅下拉就绪",
    );
    const afterReloadSettings = await readReviewReasoning();
    results.ac6.afterReload = afterReloadSettings;
    if (afterReloadSettings.value !== "low") {
      fail("AC6", `刷新后审阅档位应回显 low，实际 ${afterReloadSettings.value}`, afterReloadSettings);
    }
    if (afterReloadSettings.reviewModel !== REASON_MODEL.id) {
      fail("AC6", "刷新后审阅模型应仍是支持推理的那个", afterReloadSettings);
    }
    results.ac6.screenshotReload = await shot("ac6-after-reload.png");
  } finally {
    if (client) client.close();
    try {
      child.kill();
    } catch {
      // 忽略。
    }
    await handle.close();
    await stub.close();
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 忽略。
    }
  }

  const ok = results.errors.length === 0;
  results.ok = ok;
  writeFileSync(
    path.join(EVIDENCE, "ac56-browser.json"),
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
  console.log(`AC5：${results.ac5 ? "ran" : "missing"}；AC6：${results.ac6 ? "ran" : "missing"}`);
  console.log(ok ? "AC5/AC6 全过（真 Chrome）" : `FAIL：${results.errors.length} 条`);
  for (const error of results.errors) console.error(" -", error.where, error.message);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  results.errors.push({ where: "main", message: err && err.message ? err.message : String(err) });
  results.ok = false;
  try {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(path.join(EVIDENCE, "ac56-browser.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  } catch {
    // 忽略。
  }
  console.error("探针失败：", err);
  process.exitCode = 1;
});
