// L2 HTTP / WS 安全边界：D2 矩阵。
// 起一个真实 app server（随机空闲端口），用 fetch 与原始 net socket 打请求。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { startServer } from "../../src/server/http.mjs";
// Node 20 没有全局 WebSocket（22 才有），用 ws 包提供的实现，接口兼容。
import { WebSocket } from "ws";

function quiet() {
  return () => {};
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

/** 用原始 socket 发一个 HTTP 请求（可以伪造 Host 头）。 */
function rawHttp(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(requestText);
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("end", () => resolve(buffer));
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve(buffer);
    });
  });
}

/** WS 升级：返回 {statusLine, bodyBytes, closed} */
function rawWsUpgrade(port, extraHeaders) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      const key = crypto.randomBytes(16).toString("base64");
      const lines = [
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        ...extraHeaders,
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    let buffer = "";
    let closed = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("close", () => {
      closed = true;
      resolve({ raw: buffer, closed, bodyBytes: bodyLength(buffer) });
    });
    socket.on("error", () => {
      closed = true;
      resolve({ raw: buffer, closed, bodyBytes: bodyLength(buffer) });
    });
    socket.setTimeout(4000, () => {
      socket.destroy();
    });
  });
}

function bodyLength(responseText) {
  const index = responseText.indexOf("\r\n\r\n");
  if (index === -1) return 0;
  return Buffer.byteLength(responseText.slice(index + 4));
}

let handle;
let port;
let token;

test.before(async () => {
  port = await freePort();
  handle = await startServer({ port, log: quiet() });
  token = handle.token;
});

test.after(async () => {
  if (handle) await handle.close();
});

function base() {
  return `http://127.0.0.1:${port}`;
}

test("#1 无 cookie 无 token 的 /api/health → 403", async () => {
  const response = await fetch(`${base()}/api/health`);
  assert.equal(response.status, 403);
});

test("#2 错 token（64 位 hex 但不匹配）→ 403", async () => {
  const wrong = crypto.randomBytes(32).toString("hex");
  assert.notEqual(wrong, token);
  const response = await fetch(`${base()}/api/health?token=${wrong}`);
  assert.equal(response.status, 403);
});

test("#3 长度不对的 token（32 位）→ 403，且不是 500", async () => {
  const short = token.slice(0, 32);
  assert.equal(short.length, 32);
  const response = await fetch(`${base()}/api/health?token=${short}`);
  assert.equal(response.status, 403);
  assert.notEqual(response.status, 500);
});

test("#4 Origin: http://evil.com + 正确 token → 403", async () => {
  const response = await fetch(`${base()}/api/health?token=${token}`, {
    headers: { origin: "http://evil.com" },
  });
  assert.equal(response.status, 403);
});

test("#5 Host: evil.com:<port>（原始 socket）→ 403", async () => {
  const response = await rawHttp(
    port,
    `GET /api/health?token=${token} HTTP/1.1\r\nHost: evil.com:${port}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(response, /^HTTP\/1\.1 403/);
});

test("#5b Host: 127.0.0.1:3477（端口不匹配）→ 403", async () => {
  const response = await rawHttp(
    port,
    `GET /api/health?token=${token} HTTP/1.1\r\nHost: 127.0.0.1:3477\r\nConnection: close\r\n\r\n`,
  );
  assert.match(response, /^HTTP\/1\.1 403/);
});

test("#6 Origin: null 字面量 + 正确 token → 200", async () => {
  const response = await fetch(`${base()}/api/health?token=${token}`, {
    headers: { origin: "null" },
  });
  assert.equal(response.status, 200);
});

test("#7 正确 token + 自身 Origin → 200", async () => {
  const response = await fetch(`${base()}/api/health?token=${token}`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(response.status, 200);
});

test("#7b 正确 token + 无 Origin（脚本调用方）→ 200；query 也 200", async () => {
  const withHeader = await fetch(`${base()}/api/health`, {
    headers: { "x-magpie-term-token": token },
  });
  assert.equal(withHeader.status, 200);

  // WS 只能用 query，所以 query 通道必须保留。
  const withQuery = await fetch(`${base()}/api/health?token=${token}`);
  assert.equal(withQuery.status, 200);
});

test("#8 WS 无 token → 握手失败（非 101），且没有 HTTP body", async () => {
  const result = await rawWsUpgrade(port, []);
  assert.equal(result.closed, true);
  assert.doesNotMatch(result.raw, /101 Switching Protocols/);
  assert.equal(result.bodyBytes, 0);
});

test("#8b WS 错 token → 同样不是 101，且无 body", async () => {
  const wrong = crypto.randomBytes(32).toString("hex");
  const result = await rawWsUpgrade(port, [`X-Magpie-Term-Token: ${wrong}`]);
  assert.doesNotMatch(result.raw, /101 Switching Protocols/);
  assert.equal(result.bodyBytes, 0);
});

test("#8c WS 正确 token → 101", async () => {
  const result = await rawWsUpgrade(port, [`X-Magpie-Term-Token: ${token}`]);
  assert.match(result.raw, /101 Switching Protocols/);
});

test("#8d WS 伪造 Origin + 正确 token → 不是 101", async () => {
  const result = await rawWsUpgrade(port, [
    `X-Magpie-Term-Token: ${token}`,
    "Origin: http://evil.com",
  ]);
  assert.doesNotMatch(result.raw, /101 Switching Protocols/);
});

test("#9 未知 /api/nope 无 token → 403（鉴权先于路由），不是 404", async () => {
  const response = await fetch(`${base()}/api/nope`);
  assert.equal(response.status, 403);

  const withToken = await fetch(`${base()}/api/nope?token=${token}`);
  assert.equal(withToken.status, 404);
});

test("#4b Origin: http://wails.localhost + 正确 token → 403（不放行宿主 origin）", async () => {
  const response = await fetch(`${base()}/api/health?token=${token}`, {
    headers: { origin: "http://wails.localhost" },
  });
  assert.equal(response.status, 403);
});

test("403 响应体不区分失败原因", async () => {
  const noToken = await fetch(`${base()}/api/health`);
  const badOrigin = await fetch(`${base()}/api/health?token=${token}`, {
    headers: { origin: "http://evil.com" },
  });
  const a = await noToken.text();
  const b = await badOrigin.text();
  assert.equal(a, b);
  assert.match(a, /FORBIDDEN/);
});

test("请求体超过 64KB → 413", async () => {
  const big = "x".repeat(65 * 1024);
  const response = await fetch(`${base()}/api/ai?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: big }),
  });
  assert.equal(response.status, 413);
});

test("POST /api/ai 已鉴权 → 501（存在且鉴权）", async () => {
  const response = await fetch(`${base()}/api/ai?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "hi" }),
  });
  assert.equal(response.status, 501);
});

test("GET /api/policy 已鉴权 → 200 且含白名单 / 黑名单", async () => {
  const response = await fetch(`${base()}/api/policy?token=${token}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.allowlist.heads));
  assert.ok(Array.isArray(body.denylist.heads));
});

test("根路径 / 注入 meta 口令、不再下发 set-cookie、CSP 无 frame-ancestors", async () => {
  const response = await fetch(`${base()}/`, { redirect: "manual" });
  assert.equal(response.status, 200);

  // 第 6 轮：cookie 方案在沙箱 opaque origin 下不可用，改为 HTML <meta> 注入。
  assert.equal(response.headers.get("set-cookie"), null);
  const html = await response.text();
  assert.match(html, /<meta name="magpie-term-token" content="[0-9a-f]{64}">/);
  assert.ok(html.includes("data-role=\"terminal-host\""));

  // CSP 保留收紧项，但绝不能有 frame-ancestors（否则沙箱 iframe 被拦成错误页）。
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.equal(/frame-ancestors/.test(csp), false);
});

test("buildCsp() 不含 frame-ancestors（防止有人顺手加回去）", async () => {
  const { buildCsp } = await import("../../src/server/http.mjs");
  const csp = buildCsp(3480);
  assert.equal(
    csp.includes("frame-ancestors"),
    false,
    "magpie 把插件页放在 sandbox=\"allow-scripts\" iframe 里（opaque origin），" +
      "frame-ancestors 会直接把它拦成 Chromium 错误页。必须留空。",
  );
  // 其余收紧项仍在
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
});

test("Origin: null 取静态 JS 时带 ACAO: null 与 vary: Origin", async () => {
  const response = await fetch(`${base()}/app.js`, { headers: { origin: "null" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.match(response.headers.get("vary") || "", /Origin/i);
  assert.match(response.headers.get("access-control-allow-headers") || "", /x-magpie-term-token/);
  await response.text();
});

test("Origin: null 取 CSS / vendor 也带 ACAO: null", async () => {
  for (const pathname of ["/styles/tokens.css", "/vendor/xterm/xterm.js"]) {
    const response = await fetch(`${base()}${pathname}`, { headers: { origin: "null" } });
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("access-control-allow-origin"), "null", pathname);
    await response.text();
  }
});

test("OPTIONS /api/health 带 Origin: null → 204 + CORS，且不需要 token", async () => {
  const response = await fetch(`${base()}/api/health`, {
    method: "OPTIONS",
    headers: {
      origin: "null",
      "access-control-request-method": "GET",
      "access-control-request-headers": "x-magpie-term-token",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.match(response.headers.get("access-control-allow-headers") || "", /x-magpie-term-token/);
  assert.match(response.headers.get("access-control-allow-methods") || "", /GET/);
  assert.match(response.headers.get("vary") || "", /Origin/i);
  await response.text();
});

test("cookie 通道已关闭：只带 cookie: mt=<正确 token> → 403", async () => {
  const response = await fetch(`${base()}/api/health`, {
    headers: { cookie: `mt=${token}` },
  });
  assert.equal(response.status, 403);
});

test("403 的 /api/* 也带 CORS 头（否则沙箱里分不清没权限还是网络错）", async () => {
  const response = await fetch(`${base()}/api/health`, { headers: { origin: "null" } });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  await response.text();
});

test("Origin 不合法时不回 ACAO（不向恶意页面确认「你能读」）", async () => {
  const response = await fetch(`${base()}/api/health?token=${token}`, {
    headers: { origin: "http://evil.com" },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  await response.text();
});

// ---------------------------------------------------------------------------
// 返工第 2 轮回归：服务端不许在连接建立时替客户端建会话（TASK.md §4.4 / D7-1）。
// 这条测试防的是「任何探针连一下 WS 就多一个 bash.exe」的退化。
// ---------------------------------------------------------------------------

function openWs(extraUrl = "") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}${extraUrl}`);
    const frames = [];
    ws.addEventListener("message", (event) => {
      try {
        frames.push(JSON.parse(String(event.data)));
      } catch {
        // 忽略。
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
    ws.addEventListener("open", () => {
      resolve({
        ws,
        frames,
        send(frame) {
          ws.send(JSON.stringify(frame));
        },
        close() {
          try {
            ws.close();
          } catch {
            // 忽略。
          }
        },
      });
    });
  });
}

async function sessionCount() {
  const response = await fetch(`${base()}/api/health`, { headers: { "x-magpie-term-token": token } });
  const body = await response.json();
  return body.sessions;
}

test("WS 连上但什么都不发 → 500ms 后 sessions 不变（服务端不自动建会话）", async () => {
  const before = await sessionCount();
  const client = await openWs();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await sessionCount();
  assert.equal(after, before);
  assert.equal(client.frames.filter((f) => f.type === "session.created").length, 0);
  client.close();
});

test("WS：不带 hostId 的 pty.create 被拒（HOST_REQUIRED），不建会话", async () => {
  const before = await sessionCount();
  const creator = await openWs();
  try {
    creator.send({ type: "pty.create", cols: 80, rows: 24 });

    const rejected = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pty.error HOST_REQUIRED timeout")), 8000);
      const iv = setInterval(() => {
        const hit = creator.frames.find((f) => f.type === "pty.error" && f.code === "HOST_REQUIRED");
        if (hit) {
          clearInterval(iv);
          clearTimeout(timer);
          resolve(hit);
        }
      }, 25);
    });

    assert.equal(rejected.type, "pty.error");
    assert.equal(rejected.code, "HOST_REQUIRED");
    // 被拒就不能建会话：
    assert.equal(await sessionCount(), before);
    assert.equal(creator.frames.filter((f) => f.type === "session.created").length, 0);
  } finally {
    // 断言失败也必须关 socket，否则这个文件的进程不退出（全量运行会卡死）。
    creator.close();
  }
});

test("pty.attach 不存在的 id → pty.error / SESSION_GONE", async () => {
  const client = await openWs();
  const bogus = "00000000-0000-4000-8000-000000000000";
  client.send({ type: "pty.attach", id: bogus });
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SESSION_GONE timeout")), 8000);
    const iv = setInterval(() => {
      const hit = client.frames.find((f) => f.type === "pty.error" && f.id === bogus);
      if (hit) {
        clearInterval(iv);
        clearTimeout(timer);
        resolve(hit);
      }
    }, 25);
  });
  assert.equal(frame.code, "SESSION_GONE");
  assert.equal(typeof frame.userText, "string");
  client.close();
});

test("CSP 的 style-src 带 'unsafe-inline'，script-src 仍严格 'self'", async () => {
  const response = await fetch(`${base()}/`);
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false);
  assert.match(csp, /script-src 'self'/);
});

test("注入的 tokens 用 html:root 选择器（否则被 tokens.css 兜底值盖掉）", async () => {
  const tokens = Buffer.from(JSON.stringify({ "--magpie-bg": "#1e1e2e" })).toString("base64");
  const response = await fetch(`${base()}/?theme=dark&tokens=${encodeURIComponent(tokens)}`);
  const html = await response.text();
  assert.match(html, /html:root\s*\{/);
  assert.ok(html.includes("--magpie-bg: #1e1e2e;"));
});

// ===========================================================================
// TASK-V4-S §6.1 N1–N6：根 HTML 只服务导航请求（P0-1）
//
// 修之前：`Origin: null` 请求 `GET /` → 200 + `access-control-allow-origin: null`，
// body 里带真 64 位 token（VERIFY-V4-G §4 P0-1）。任意网页一个沙箱 iframe
// 就能偷到口令，再用它开 WS 执行任意命令。
// ===========================================================================

/** 用原始 socket 发一个可伪造任意头的 GET，返回 {status, headers, body}。 */
function rawGet(pathAndQuery, extraHeaderLines) {
  const requestText = [
    `GET ${pathAndQuery} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: close",
    ...(extraHeaderLines || []),
    "",
    "",
  ].join("\r\n");
  return rawHttp(port, requestText).then(parseRawResponse);
}

function parseRawResponse(text) {
  const split = text.indexOf("\r\n\r\n");
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split + 4);
  const lines = head.split("\r\n");
  const status = Number((lines[0] || "").split(" ")[1]);
  const headers = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status, headers, body, raw: text };
}

test("N1：Origin: null + sec-fetch-mode: cors 请求 GET / → 403，无 ACAO，body 不含口令", async () => {
  const response = await rawGet("/", ["Origin: null", "Sec-Fetch-Mode: cors", "Sec-Fetch-Dest: empty"]);
  assert.equal(response.status, 403);
  assert.equal(response.headers["access-control-allow-origin"], undefined, "恶意页必须连 body 都读不到");
  assert.doesNotMatch(response.body, /magpie-term-token/);
  assert.equal(response.body.includes(token), false, "响应体里绝不能出现真 token");
  assert.match(response.body, /FORBIDDEN/);
});

test("N2：导航请求（无 Origin + sec-fetch-mode: navigate）→ 200 且含口令 meta", async () => {
  const response = await rawGet("/", [
    "Sec-Fetch-Mode: navigate",
    "Sec-Fetch-Dest: iframe",
    "Sec-Fetch-Site: cross-site",
  ]);
  assert.equal(response.status, 200);
  assert.match(response.body, /<meta name="magpie-term-token" content="[0-9a-f]{64}">/);
  assert.equal(response.body.includes(token), true);
});

test("N3：无任何 Sec-Fetch / Origin（curl 形态）→ 200 含口令", async () => {
  const response = await rawGet("/");
  assert.equal(response.status, 200);
  assert.match(response.body, /<meta name="magpie-term-token" content="[0-9a-f]{64}">/);
  assert.equal(response.body.includes(token), true);
});

test("N3b：无 Origin 但带 sec-fetch-mode: cors（Node fetch / doctor 形态）→ 200", async () => {
  // Node 24 的全局 fetch 自带 sec-fetch-mode: cors，doctor 与现有测试都依赖这条。
  const response = await fetch(`${base()}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<meta name="magpie-term-token" content="[0-9a-f]{64}">/);
});

test("N4：GET /index.html + Origin: null + sec-fetch-mode: cors → 403", async () => {
  const response = await rawGet("/index.html", ["Origin: null", "Sec-Fetch-Mode: cors"]);
  assert.equal(response.status, 403);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.body.includes(token), false);
});

test("N5：GET / + Origin: http://evil.example.com → 403（沿用 checkHttpGate）", async () => {
  const response = await rawGet("/", ["Origin: http://evil.example.com"]);
  assert.equal(response.status, 403);
  assert.equal(response.body.includes(token), false);
});

test("N5b：GET / + Origin: null 但没有 sec-fetch-mode → 403（没 Sec-Fetch 也不放行）", async () => {
  const response = await rawGet("/", ["Origin: null"]);
  assert.equal(response.status, 403);
  assert.equal(response.body.includes(token), false);
});

test("N5c：GET / + sec-fetch-mode: no-cors + Origin: null → 403", async () => {
  const response = await rawGet("/", ["Origin: null", "Sec-Fetch-Mode: no-cors"]);
  assert.equal(response.status, 403);
});

test("N6：GET /app.js + Origin: null → 200 + access-control-allow-origin: null（不回归）", async () => {
  const response = await rawGet("/app.js", ["Origin: null", "Sec-Fetch-Mode: cors", "Sec-Fetch-Dest: empty"]);
  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], "null");
});

test("N6b：/api 的 Origin: null 行为不变（沙箱 iframe 依赖它）", async () => {
  const response = await fetch(`${base()}/api/health?token=${token}`, { headers: { origin: "null" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
});

test("N7：拿偷来的 token 也无法在没有导航判定的情况下读 _根 HTML_", async () => {
  // 就算攻击者已经有 token（例如从前一次泄漏），根 HTML 这道门仍然拦住他 —— 这道门
  // 不依赖 token，只看「是不是导航」。
  const response = await rawGet("/", ["Origin: null", "Sec-Fetch-Mode: cors", `X-Magpie-Term-Token: ${token}`]);
  assert.equal(response.status, 403);
  assert.equal(response.body.includes(token), false);
});
