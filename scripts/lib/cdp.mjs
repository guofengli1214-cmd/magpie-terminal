// 极简 CDP 工具：起一个真 Chrome/Edge（headless），连上它，产出一个能
// `send(method, params)` 的客户端。给 scripts/probe-*.mjs 复用。
//
// 为什么单独抽一份而不是复用 scripts/browser-probe.mjs：
// 那个脚本是「只读一个 CSS 变量的自检」，把它的内部函数导出会改动既有验收脚本的
// 行为（VERIFY 文档引用它）。这里只依赖同一套 CDP 协议，不碰它。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";

export const DEFAULT_CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function httpJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
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
            }, 30000);
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
      if (msg.error) rej(new Error(String(msg.error.message || "CDP error")));
      else res(msg.result || {});
    });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
  });
}

/**
 * 起 Chrome + 新建一个 target，返回 {client, evaluate, screenshot, close, chrome}。
 *
 * @param {{chrome?: string, port?: number, width?: number, height?: number, timeoutMs?: number}} [opts]
 */
export async function openBrowser(opts = {}) {
  const chrome = findChrome(opts.chrome);
  if (!chrome) throw new Error("no Chrome/Edge executable found");
  const devtoolsPort = Number.isFinite(opts.port) ? opts.port : 9400 + Math.floor(Math.random() * 400);
  const width = Number.isFinite(opts.width) ? opts.width : 1400;
  const height = Number.isFinite(opts.height) ? opts.height : 900;
  const profileDir = mkdtempSync(path.join(tmpdir(), "magpie-term-cdp-"));
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
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  if (child.stderr) child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  let client = null;
  try {
    await waitForDevtools(devtoolsPort, opts.timeoutMs || 20000);
    // 新版 Chrome 只接受 PUT /json/new。
    const target = await httpJson(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, "PUT");
    client = await cdpConnect(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    if (typeof opts.width === "number" || typeof opts.height === "number") {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
  } catch (err) {
    if (client) client.close();
    try {
      child.kill();
    } catch {
      // 忽略。
    }
    throw new Error(`${err && err.message ? err.message : err}\n${stderr.slice(-600)}`);
  }

  const api = {
    chrome,
    devtoolsPort,
    raw: client,
    async evaluate(expression, { awaitPromise = false } = {}) {
      const result = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise,
      });
      if (result && result.exceptionDetails) {
        throw new Error(
          `evaluate failed: ${result.exceptionDetails.text || ""} ${
            result.exceptionDetails.exception ? result.exceptionDetails.exception.description : ""
          }`,
        );
      }
      return result && result.result ? result.result.value : undefined;
    },
    async navigate(url) {
      await client.send("Page.navigate", { url });
      const started = Date.now();
      for (;;) {
        if (Date.now() - started > (opts.timeoutMs || 30000)) throw new Error("page load timeout");
        await sleep(150);
        try {
          const state = await api.evaluate("document.readyState");
          if (state === "complete") return;
        } catch {
          // 页面还在切换。
        }
      }
    },
    async screenshot() {
      const shot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      return shot && shot.data ? Buffer.from(shot.data, "base64") : null;
    },
    async close() {
      client.close();
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
    },
  };
  return api;
}

/**
 * 极小 PNG 解码器：只支持 8-bit RGB/RGBA、非隔行（Chrome 截图就是这个形态）。
 * 返回 {width, height, at(x,y) -> [r,g,b,a]}。
 */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG unsupported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels < 0) throw new Error(`unsupported color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const up = y > 0 ? pixels[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;
      let out;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = (value + left) & 0xff;
          break;
        case 2:
          out = (value + up) & 0xff;
          break;
        case 3:
          out = (value + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          out = (value + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      pixels[rowStart + x] = out;
    }
    pos += stride;
  }
  return {
    width,
    height,
    channels,
    at(x, y) {
      const index = y * stride + x * channels;
      return [
        pixels[index],
        pixels[index + 1] ?? pixels[index],
        pixels[index + 2] ?? pixels[index],
        channels === 4 ? pixels[index + 3] : 255,
      ];
    },
  };
}
