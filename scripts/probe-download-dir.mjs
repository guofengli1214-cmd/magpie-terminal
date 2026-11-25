// TASK-FIX17-L1 真浏览器探针（AC5 / AC6 / AC7 的浏览器一半）。
//
// 用法：node scripts/probe-download-dir.mjs [--chrome <path>] [--port 3901]
//
// 做的事（全部本机、全部隔离）：
//   1. 起一个隔离服务（`MAGPIE_TERMINAL_CONFIG_PATH` / `MAGPIE_TERMINAL_LOG_DIR`
//      指到 `.dispatch/fix17-l1/probe/` 下，绝不碰用户真配置与真日志）；
//   2. 用真 Chrome（headless + CDP）打开应用页，文件面板切到临时工作目录；
//   3. AC6：选 3 个文件 → 批量下载 → 3 个文件都进下载目录（sha256 与源一致），
//      且状态栏汇总文案里带**完整目录**；
//   4. AC5：把 downloadDir 清成 null → 再下载 → 服务器回 NO_DOWNLOAD_DIR，
//      前端回落 `<a download>`（探针断言 anchor 真被点击 + 浏览器下载目录里真有文件）；
//   5. AC7：在设置页填目录并保存 → 点「导出日志」→ 日志落盘、设置页提示里带
//      **完整路径**；再与 `GET /api/logs/export` 对比内容同源。
//
// 退出码：三组全过 0，任一失败 1。结果 JSON 落盘（--out 可改）。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

import { startServer, makeLogger } from "../src/server/http.mjs";
import { CONFIG_PATH_ENV, defaultDownloadDir } from "../src/config/store.mjs";
import { LOG_DIR_ENV } from "../src/server/logger.mjs";

const HERE = path.resolve(".");
const PROBE_ROOT = path.join(HERE, ".dispatch", "fix17-l1", "probe");
const EVIDENCE = path.join(HERE, ".dispatch", "fix17-l1", "evidence");

const DEFAULT_CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

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

/* ------------------------------ CDP 客户端 ------------------------------ */

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
    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
  });
}

function httpJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
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
      const list = await httpJson(`http://127.0.0.1:${port}/json/version`);
      if (list && list.webSocketDebuggerUrl) return list;
    } catch {
      // 还没起来。
    }
    if (Date.now() - started > timeoutMs) throw new Error("devtools endpoint never came up");
    await sleep(150);
  }
}

/* -------------------------------- 主体 -------------------------------- */

const results = { ac5: null, ac6: null, ac7: null, errors: [] };

function fail(where, message, extra) {
  results.errors.push({ where, message, extra: extra || null });
  console.error(`FAIL  ${where}: ${message}`, extra ? JSON.stringify(extra) : "");
}

async function main() {
  const chrome = findChrome(argValue("--chrome", null));
  if (!chrome) throw new Error("找不到 Chrome / Edge，无法跑真浏览器探针");
  const port = Number(argValue("--port", "3901"));
  const devtoolsPort = Number(argValue("--devtools-port", "9345"));

  // 干净的探针目录（`.dispatch/` 是点开头目录，插件宿主不会轮询它）。
  rmSync(PROBE_ROOT, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  const configDir = path.join(PROBE_ROOT, "config");
  const workDir = path.join(PROBE_ROOT, "work");
  const downloadDir = path.join(PROBE_ROOT, "downloads");
  const logDir = path.join(PROBE_ROOT, "logs");
  const browserDownloads = path.join(PROBE_ROOT, "browser-downloads");
  for (const dir of [configDir, workDir, logDir, browserDownloads]) mkdirSync(dir, { recursive: true });

  process.env[CONFIG_PATH_ENV] = path.join(configDir, "config.json");
  process.env[LOG_DIR_ENV] = logDir;

  // 三个待下载文件（内容各不相同，便于 sha256 对比）。
  const sources = {
    "a.txt": "AAA 第一批\n".repeat(10),
    "b.txt": "BBB 第二批\n".repeat(12),
    "c.txt": "CCC 第三批\n".repeat(14),
  };
  for (const [name, body] of Object.entries(sources)) {
    writeFileSync(path.join(workDir, name), body, "utf8");
  }

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

  const profileDir = mkdtempSync(path.join(tmpdir(), "magpie-term-dl-"));
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
    // 让 `<a download>` 的落盘位置可断言（浏览器侧默认下载目录）。
    try {
      await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: browserDownloads });
    } catch {
      await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: browserDownloads });
    }

    const evaluate = async (expression, { awaitPromise = false } = {}) => {
      const result = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise,
      });
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

    await client.send("Page.navigate", { url: base });
    await waitFor("document.readyState === 'complete'", 20000, "页面加载");
    await sleep(1200);

    /* ---------------------- 打开文件面板并切目录 ---------------------- */
    await evaluate("document.querySelector('[data-role=\"rail-files\"]').click()");
    await waitFor(
      "!!document.querySelector('[data-role=\"file-panel\"]') && !document.querySelector('[data-role=\"file-panel\"]').hidden",
      10000,
      "文件面板打开",
    );
    // 面板打开会先按终端 cwd 自己 load 一次（异步）。等它结束再改路径，
    // 否则后到的那次 load 会把我们刚填的路径覆盖掉（探针自己的执行顺序问题）。
    await waitFor(
      "(document.querySelector('[data-role=\"file-panel-path\"]')?.value || '').length > 0",
      15000,
      "文件面板首次加载完成",
    );
    await sleep(600);

    // 切到工作目录（有一次重试：首次 load 可能刚好在改路径之后回来）。
    let entriesOk = false;
    for (let attempt = 0; attempt < 3 && !entriesOk; attempt += 1) {
      await evaluate(`
        (() => {
          const input = document.querySelector('[data-role="file-panel-path"]');
          input.value = ${JSON.stringify(workDir)};
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true;
        })()
      `);
      const started = Date.now();
      while (Date.now() - started < 6000) {
        const count = await evaluate("document.querySelectorAll('[data-role=\"file-entry\"]').length");
        if (count === 3) {
          entriesOk = true;
          break;
        }
        await sleep(200);
      }
    }
    if (!entriesOk) {
      const snapshot = await evaluate(
        "JSON.stringify({ path: document.querySelector('[data-role=\"file-panel-path\"]')?.value, entries: [...document.querySelectorAll('[data-role=\"file-entry\"]')].map((n) => n.getAttribute('data-name')) })",
      );
      throw new Error(`文件面板没有列出 3 个条目：${snapshot}`);
    }

    /* ================================ AC6 ================================ */
    // 设置下载目录（先经 HTTP：更接近「用户上次已经保存过」的状态）。
    const putDir = await api("/api/config", { method: "PUT", body: JSON.stringify({ downloadDir }) });
    if (putDir.status !== 200) throw new Error(`PUT downloadDir 失败：${JSON.stringify(putDir.body)}`);

    const selectAll = await evaluate(`
      (() => {
        const nodes = [...document.querySelectorAll('[data-role="file-entry"]')];
        nodes[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        nodes[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        nodes[2].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        return document.querySelector('[data-role="files-batch-count"]')?.textContent || '';
      })()
    `);
    if (!selectAll.includes("3")) throw new Error(`多选失败：文件面板显示「${selectAll}」`);

    await evaluate("document.querySelector('[data-role=\"files-batch-download\"]').click()");

    // 3 个文件落盘。
    const ac6Started = Date.now();
    let ac6Files = [];
    while (Date.now() - ac6Started < 20000) {
      ac6Files = existsSync(downloadDir) ? readdirSync(downloadDir).filter((n) => !n.startsWith(".")) : [];
      if (ac6Files.length >= 3) break;
      await sleep(200);
    }
    const ac6Notice = await evaluate(
      "document.querySelector('[data-role=\"status-item\"][data-status=\"notice\"]')?.textContent || ''",
    );
    const ac6Hashes = {};
    for (const name of ac6Files.sort()) {
      const file = path.join(downloadDir, name);
      ac6Hashes[name] = sha256(readFileSync(file));
    }
    const expectedHashes = Object.fromEntries(
      Object.entries(sources).map(([name, body]) => [name, sha256(Buffer.from(body, "utf8"))]),
    );
    const hashesMatch =
      Object.keys(expectedHashes).every((name) => ac6Hashes[name] === expectedHashes[name]);
    const noticeHasDir = typeof ac6Notice === "string" && ac6Notice.includes(downloadDir);
    results.ac6 = {
      ok: ac6Files.length === 3 && hashesMatch && noticeHasDir,
      files: ac6Files,
      hashes: ac6Hashes,
      expectedHashes,
      hashesMatch,
      notice: ac6Notice,
      noticeHasDir,
      downloadDir,
      screenshot: await shot("ac6-batch-download.png"),
    };
    if (!results.ac6.ok) fail("AC6", "3 个文件或汇总文案不符合预期", results.ac6);

    /* ================================ AC5 ================================ */
    // 清空目录设置 → 服务端回 NO_DOWNLOAD_DIR → 前端回落 `<a download>`。
    const clearDir = await api("/api/config", { method: "PUT", body: JSON.stringify({ downloadDir: null }) });
    if (clearDir.status !== 200) throw new Error("清空 downloadDir 失败");
    const beforeCount = readdirSync(downloadDir).length;

    await evaluate(`
      (() => {
        window.__anchorClicks = [];
        const original = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function patched() {
          window.__anchorClicks.push({
            download: this.getAttribute('download'),
            href: String(this.href || ''),
          });
          return original.apply(this, arguments);
        };
        return true;
      })()
    `);
    // 只选 a.txt 再触发下载（批量按钮对单文件同样走 downloadFile）。
    await evaluate(`
      (() => {
        const nodes = [...document.querySelectorAll('[data-role="file-entry"]')];
        const a = nodes.find((n) => n.getAttribute('data-name') === 'a.txt');
        a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.querySelector('[data-role="files-batch-download"]').click();
        return true;
      })()
    `);
    const clicks = await (async () => {
      const started = Date.now();
      for (;;) {
        const value = await evaluate("window.__anchorClicks.length");
        if (value > 0) return evaluate("window.__anchorClicks");
        if (Date.now() - started > 15000) return [];
        await sleep(150);
      }
    })();
    // 浏览器真的把文件落进了它的默认下载目录。
    const ac5BrowserFile = await (async () => {
      const started = Date.now();
      for (;;) {
        const files = existsSync(browserDownloads) ? readdirSync(browserDownloads).filter((n) => !n.endsWith(".crdownload")) : [];
        if (files.length > 0) return files;
        if (Date.now() - started > 15000) return [];
        await sleep(200);
      }
    })();
    const afterCount = readdirSync(downloadDir).length;
    results.ac5 = {
      ok: clicks.length > 0 && clicks[0].download === "a.txt" && ac5BrowserFile.length > 0 && afterCount === beforeCount,
      anchorClicks: clicks,
      browserDownloads: ac5BrowserFile,
      downloadDirUntouched: afterCount === beforeCount,
      downloadDirCount: { before: beforeCount, after: afterCount },
      notice: await evaluate(
        "document.querySelector('[data-role=\"status-item\"][data-status=\"notice\"]')?.textContent || ''",
      ),
    };
    if (!results.ac5.ok) fail("AC5", "未设置目录时没有回落成 <a download>", results.ac5);

    /* ================================ AC7 ================================ */
    // 全程走设置页 UI：打开设置 → 用默认目录按钮 → 改成我们的目录 → 保存。
    await evaluate("document.querySelector('[data-role=\"rail-settings\"]').click()");
    await waitFor("!!document.querySelector('[data-role=\"settings-modal\"]')", 10000, "设置页打开");
    const expectedDefault = defaultDownloadDir();
    // placeholder 与「用默认目录」按钮都是 `GET /api/config` 回来之后才填的
    // （`downloadDirDefault` 由服务端算），所以要等它们到位再断言。
    const defaultPlaceholder = await waitFor(
      `(() => { const v = document.querySelector('[data-role="download-dir"]')?.placeholder || ''; return v === ${JSON.stringify(defaultDownloadDir())} ? v : ''; })()`,
      15000,
      "下载目录 placeholder = downloadDirDefault",
    );
    if (defaultPlaceholder !== expectedDefault) {
      fail("AC7", `placeholder 不是 downloadDirDefault：${defaultPlaceholder} != ${expectedDefault}`);
    }
    const filled = await evaluate(`
      (() => {
        document.querySelector('[data-role="download-dir-default"]').click();
        return document.querySelector('[data-role="download-dir"]').value;
      })()
    `);
    // 把「下载与导出」block 滚到视口里再截图（设置页很长，默认停在顶部）。
    await evaluate(`
      (() => {
        const block = document.querySelector('[data-block="downloads"]');
        if (block && typeof block.scrollIntoView === "function") {
          block.scrollIntoView({ block: "center" });
        }
        return true;
      })()
    `);
    await sleep(400);
    const settingsShot = await shot("ac7-settings-downloads.png");
    await evaluate(`
      (() => {
        const input = document.querySelector('[data-role="download-dir"]');
        input.value = ${JSON.stringify(downloadDir)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-role="settings-save"]').click();
        return true;
      })()
    `);
    await waitFor(
      "(document.querySelector('[data-role=\"settings-status\"]')?.textContent || '').includes('已保存')",
      15000,
      "设置保存成功",
    );
    const savedConfig = await api("/api/config");
    await waitFor("!document.querySelector('[data-role=\"settings-modal\"]') || document.querySelector('[data-role=\"settings-modal\"]').closest('[data-role=\"settings-backdrop\"]').hidden", 8000, "设置页关闭");

    // 重新打开设置点「导出日志」。
    // 要等 `load()` 跑完再点：它结尾会 `setStatus("", null)`，抢在导出之后
    // 回来就会把我们刚写的「已导出到 …」擦掉（探针自己撞上过一次）。
    await evaluate("document.querySelector('[data-role=\"rail-settings\"]').click()");
    await waitFor("!!document.querySelector('[data-role=\"logs-export\"]')", 10000, "设置页重开");
    await waitFor(
      `(() => {
        const modal = document.querySelector('[data-role="settings-modal"]');
        if (!modal) return '';
        const status = modal.querySelector('[data-role="settings-status"]')?.textContent || '';
        const input = modal.querySelector('[data-role="download-dir"]');
        const loaded = input && input.placeholder === ${JSON.stringify(defaultDownloadDir())};
        return loaded && !status.includes('读取') ? 'ready' : '';
      })()`,
      20000,
      "设置页加载完成",
    );
    await evaluate("document.querySelector('[data-role=\"logs-export\"]').click()");
    const ac7Status = await waitFor(
      "(() => { const t = document.querySelector('[data-role=\"settings-status\"]')?.textContent || ''; return t.includes('已导出到') ? t : ''; })()",
      20000,
      "导出到目录的提示",
    );
    const ac7Logs = existsSync(downloadDir)
      ? readdirSync(downloadDir).filter((name) => /^show-terminal-logs-\d{8}-\d{6}.*\.log$/.test(name))
      : [];
    const ac7File = ac7Logs.length > 0 ? path.join(downloadDir, ac7Logs[0]) : null;
    const ac7Text = ac7File ? readFileSync(ac7File, "utf8") : "";
    const exported = await fetch(`${base}/api/logs/export`, { headers: { "x-magpie-term-token": handle.token } }).then((r) => r.text());
    const exportedLines = new Set(exported.split("\n").filter((line) => line.length > 0));
    const sameSource =
      ac7Text.length > 0 &&
      ac7Text
        .split("\n")
        .filter((line) => line.length > 0)
        .every((line) => exportedLines.has(line));
    const revealVisible = await evaluate(
      "!document.querySelector('[data-role=\"logs-reveal\"]')?.hidden",
    );
    results.ac7 = {
      ok:
        ac7Status.includes(downloadDir) &&
        Boolean(ac7File) &&
        statSize(ac7File) > 0 &&
        sameSource &&
        revealVisible &&
        filled === expectedDefault &&
        savedConfig.body.downloadDir === downloadDir,
      status: ac7Status,
      file: ac7File,
      bytes: ac7File ? statSize(ac7File) : 0,
      sameSourceAsExport: sameSource,
      revealButtonVisible: revealVisible,
      defaultButtonFilled: filled,
      downloadDirDefault: expectedDefault,
      savedConfig: savedConfig.body,
      screenshot: settingsShot,
    };
    if (!results.ac7.ok) fail("AC7", "导出到目录 / 提示文本 / 内容同源 不符合预期", results.ac7);
  } catch (err) {
    results.errors.push({ where: "probe", message: err && err.message ? err.message : String(err), stack: err && err.stack });
    console.error("探针异常：", err);
  } finally {
    if (client) client.close();
    try {
      child.kill();
    } catch {
      // 忽略。
    }
    await sleep(300);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 忽略。
    }
    try {
      await handle.close();
    } catch {
      // 忽略。
    }
  }

  results.ok = Boolean(results.ac5?.ok && results.ac6?.ok && results.ac7?.ok && results.errors.length === 0);
  const out = path.join(EVIDENCE, "probe-download-dir-results.json");
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: results.ok, ac5: results.ac5?.ok, ac6: results.ac6?.ok, ac7: results.ac7?.ok, out }, null, 2));

  // 成功时也把临时下载目录里的产物清掉（证据在 JSON 与截图里）。
  if (results.ok) rmSync(path.join(PROBE_ROOT, "downloads"), { recursive: true, force: true });
  process.exit(results.ok ? 0 : 1);
}

function statSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
