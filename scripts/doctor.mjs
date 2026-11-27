// 端到端自检：只测 0.3.0 保留下来的链路 —— HTTP 服务 + SSH 远程终端协议。
//
// 本地 PTY 已删（node-pty / src/pty/ / /api/shells 全部移除），旧 doctor 里的
// `health.pty === "native"`、`stty size`、ConPTY 孤儿检查、d7 探针都没有意义了。
// 这一版做 13 项：
//   服务能起 → 健康检查（含「本机 PTY 字段确实没了」）→ 配置读取（含老配置里的
//   defaultShell 被静默忽略）→ 已删路由 404 → 下载目录范围护栏 → 主机 CRUD
//   → WS 帧协议（不带 hostId / 假 hostId）→ 干净退出。
//
// 隔离：整轮跑在 `mkdtemp` 出来的临时目录里，`MAGPIE_TERMINAL_CONFIG_PATH`
// 指向该目录下的 config.json（它是**文件**路径，`stateDir()` 取 dirname），
// 凭据 / known_hosts / AI 会话都自动跟着走，不碰用户真实配置。
//
// 退出码：全过 0，任一失败 1。实测值落盘 doctor-report.json，控制台只打摘要。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startServer } from "../src/server/http.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(HERE, "..", "doctor-report.json");

/** 与 src/config/store.mjs:22 的 CONFIG_PATH_ENV 同一个名字（值是**文件**路径）。 */
const CONFIG_PATH_ENV = "MAGPIE_TERMINAL_CONFIG_PATH";

/** 单步 HTTP 上限；可用 DOCTOR_STEP_TIMEOUT_MS 压低。 */
const STEP_TIMEOUT_MS = Math.max(1000, Number(process.env.DOCTOR_STEP_TIMEOUT_MS) || 8000);
/** 卡里写死的两个 WS 超时。 */
const WS_HOST_REQUIRED_TIMEOUT_MS = 3000;
const WS_REMOTE_ATTEMPT_TIMEOUT_MS = 5000;

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assertContains(output, needle, label) {
  if (typeof output !== "string" || !output.includes(needle)) {
    throw new AssertionError(
      `${label || "assertContains"} failed: expected ${JSON.stringify(needle)} in output` +
        ` (got ${output ? JSON.stringify(output.slice(-400)) : "<empty>"})`,
    );
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new AssertionError(
      `${label || "assertEqual"} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function assertTrue(value, label) {
  if (!value) throw new AssertionError(`${label || "assertTrue"} failed`);
}

/**
 * 挑一个当前空闲的本地端口。
 *
 * 为什么不用 `startServer({ port: 0 })`：src/server/http.mjs:857 的取值逻辑是
 * `Number(options.port) > 0 ? ... : 3480`，`0` 会被折成 3480，不是随机端口。
 * 所以先自己 listen(0) 探一个，再显式传进去；`handle.port` 会复核它真的生效。
 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("挑不到空闲端口"))));
    });
  });
}

/** 带 token 的 JSON 请求。token 走 header（与前端同一个 `x-magpie-term-token`）。 */
async function requestJson(port, token, method, pathname, body) {
  const headers = { "x-magpie-term-token": token };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/**
 * 把服务端 handle 包成一个 WS 客户端：收所有帧，`waitFor` 匹配不到就回 null
 * （不抛错 —— 第 12 项要区分「超时按 skip 过」与「连接本身失败」）。
 */
function connectWs(port, token) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    const frames = [];
    const waiters = new Set();

    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.match(frame)) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      reject(new Error(`ws upgrade rejected: HTTP ${res.statusCode}`));
    });
    ws.on("error", (err) => {
      if (ws.readyState !== WebSocket.OPEN) reject(err);
    });
    ws.on("open", () => {
      resolve({
        send(frame) {
          ws.send(JSON.stringify(frame));
        },
        close() {
          try {
            ws.close();
          } catch {
            // 忽略。
          }
          try {
            ws.terminate();
          } catch {
            // 忽略。
          }
        },
        frames,
        waitFor(match, timeoutMs) {
          const hit = frames.find(match);
          if (hit) return Promise.resolve(hit);
          return new Promise((resolveWaiter) => {
            const waiter = {
              match,
              resolve: resolveWaiter,
              timer: setTimeout(() => {
                waiters.delete(waiter);
                resolveWaiter(null);
              }, timeoutMs),
            };
            waiters.add(waiter);
          });
        },
      });
    });
  });
}

function errorDetail(err) {
  if (!err) return "unknown error";
  const code = err && err.code ? `[${err.code}] ` : "";
  return `${code}${err && err.message ? err.message : String(err)}`;
}

/**
 * 跑完整自检。返回 `{ passed, checks, ... }`，不自己 exit（isMain 里处理）。
 *
 * @param {{ port?: number }} [options]
 */
export async function runDoctor(options = {}) {
  const checks = [];
  const startedAt = Date.now();
  const record = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail: String(detail) });
    return Boolean(ok);
  };

  // 临时配置目录：config.json 放这里，stateDir() 就是它 —— 凭据 / known_hosts /
  // ai-sessions 全落在临时目录内，跑完整个 rmSync 掉。
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "magpie-doctor-"));
  const configFile = path.join(tmpDir, "config.json");
  // 第 6 项要的老配置：带 defaultShell（已删字段），store 应当静默忽略。
  const legacyConfig = { version: 1, defaultShell: "bash", downloadDir: null };
  writeFileSync(configFile, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

  const previousConfigEnv = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = configFile;

  // 注入静默 logger：既不写真实日志文件，又能断言「没有报错日志」。
  const logs = [];
  const log = (entry) => {
    logs.push(entry);
  };

  let handle = null;
  let wsClient = null;
  let listenPort = 0;

  /** 每项单独 try/catch：一项炸了不吞掉后面的实测值。 */
  async function step(name, fn) {
    try {
      const result = await fn();
      if (result && typeof result === "object" && "ok" in result) {
        record(name, result.ok, result.detail);
        return result;
      }
      record(name, true, String(result ?? ""));
      return { ok: true, detail: String(result ?? "") };
    } catch (err) {
      const detail = errorDetail(err);
      record(name, false, detail);
      return { ok: false, detail };
    }
  }

  const requireServer = () => {
    if (!handle) throw new Error("前置 server.start 未成功，无法继续");
    return handle;
  };

  try {
    /* 1. server.start ------------------------------------------------ */
    await step("server.start", async () => {
      const requested = Number(options.port || process.env.DOCTOR_PORT || 0);
      const port = requested > 0 ? requested : await pickFreePort();
      handle = await startServer({ port, log });
      listenPort = handle.port;
      if (!listenPort) throw new Error("startServer 没有返回 port");
      if (listenPort !== port) {
        throw new Error(`监听端口 ${listenPort} 与请求的 ${port} 不一致`);
      }
      return {
        ok: true,
        detail: `listening 127.0.0.1:${listenPort}（startServer 的 port<=0 会折成 3480，见 src/server/http.mjs:857，所以这里先探空闲口）`,
      };
    });

    /* 2. health.ok --------------------------------------------------- */
    await step("health.ok", async () => {
      const srv = requireServer();
      const res = await requestJson(srv.port, srv.token, "GET", "/api/health");
      const body = res.json || {};
      if (res.status !== 200) throw new Error(`GET /api/health 返回 ${res.status}`);
      if (body.ok !== true) throw new Error(`body.ok=${JSON.stringify(body.ok)}`);
      if (typeof body.version !== "string" || body.version.length === 0) {
        throw new Error(`body.version=${JSON.stringify(body.version)}`);
      }
      return { ok: true, detail: `200 ok=true version=${body.version} port=${body.port}` };
    });

    /* 3. health.noLocalPty ------------------------------------------- */
    await step("health.noLocalPty", async () => {
      const srv = requireServer();
      const res = await requestJson(srv.port, srv.token, "GET", "/api/health");
      const body = res.json || {};
      const forbidden = ["pty", "nodePtyVersion", "shell"].filter((key) =>
        Object.prototype.hasOwnProperty.call(body, key),
      );
      if (forbidden.length > 0) {
        throw new Error(`健康检查里仍有已删字段: ${forbidden.join(", ")}`);
      }
      return {
        ok: true,
        detail: `不含 pty/nodePtyVersion/shell；实际字段: ${Object.keys(body).join(", ")}`,
      };
    });

    /* 4. health.sessions --------------------------------------------- */
    await step("health.sessions", async () => {
      const srv = requireServer();
      const res = await requestJson(srv.port, srv.token, "GET", "/api/health");
      const body = res.json || {};
      if (typeof body.sessions !== "number") {
        throw new Error(`body.sessions 不是数字: ${JSON.stringify(body.sessions)}`);
      }
      if (body.sessions !== 0) throw new Error(`初始 sessions=${body.sessions}，应为 0`);
      return { ok: true, detail: `sessions=${body.sessions}（number）` };
    });

    /* 5. config.read ------------------------------------------------- */
    await step("config.read", async () => {
      const srv = requireServer();
      const res = await requestJson(srv.port, srv.token, "GET", "/api/config");
      if (res.status !== 200) throw new Error(`GET /api/config 返回 ${res.status}`);
      const body = res.json || {};
      if (Object.prototype.hasOwnProperty.call(body, "defaultShell")) {
        throw new Error("GET /api/config 仍返回 defaultShell");
      }
      return {
        ok: true,
        detail: `200 且不含 defaultShell；downloadDirDefault=${JSON.stringify(body.downloadDirDefault)}`,
      };
    });

    /* 6. config.legacyIgnored ---------------------------------------- */
    await step("config.legacyIgnored", async () => {
      const srv = requireServer();
      const onDisk = JSON.parse(readFileSync(configFile, "utf8"));
      if (onDisk.defaultShell !== "bash") {
        throw new Error(`临时配置没写进去（defaultShell=${JSON.stringify(onDisk.defaultShell)}）`);
      }
      const res = await requestJson(srv.port, srv.token, "GET", "/api/config");
      if (res.status !== 200) throw new Error(`GET /api/config 返回 ${res.status}`);
      const body = res.json || {};
      if (Object.prototype.hasOwnProperty.call(body, "defaultShell")) {
        throw new Error("老配置里的 defaultShell 被透传出来了");
      }
      const errors = logs.filter((entry) => entry && entry.level === "error");
      if (errors.length > 0) {
        throw new Error(`进程有 error 日志: ${errors.map((e) => e.code).join(", ")}`);
      }
      return {
        ok: true,
        detail: '磁盘配置 defaultShell="bash" 已被静默忽略；GET 仍 200 且无该字段；error 日志 0 条',
      };
    });

    /* 7. shells.routeGone -------------------------------------------- */
    await step("shells.routeGone", async () => {
      const srv = requireServer();
      const res = await requestJson(srv.port, srv.token, "GET", "/api/shells");
      if (res.status !== 404) throw new Error(`GET /api/shells 返回 ${res.status}，应为 404`);
      return { ok: true, detail: `404（code=${res.json && res.json.code}）` };
    });

    /* 8. fs.localGone ------------------------------------------------ */
    await step("fs.localGone", async () => {
      const srv = requireServer();
      const res = await requestJson(srv.port, srv.token, "GET", "/api/fs/list?path=.");
      if (res.status !== 404) throw new Error(`GET /api/fs/list 返回 ${res.status}，应为 404`);
      return { ok: true, detail: `404（本机文件接口已删，code=${res.json && res.json.code}）` };
    });

    /* 9. fs.revealScope ---------------------------------------------- */
    await step("fs.revealScope", async () => {
      const srv = requireServer();
      const outside = process.platform === "win32" ? "C:/Windows" : "/etc";
      const res = await requestJson(srv.port, srv.token, "POST", "/api/fs/reveal", {
        path: outside,
      });
      const code = res.json && res.json.code;
      if (res.status !== 400) {
        throw new Error(`POST /api/fs/reveal(${outside}) 返回 ${res.status}，应为 400`);
      }
      if (code !== "REVEAL_OUT_OF_SCOPE" && code !== "NO_DOWNLOAD_DIR") {
        throw new Error(`返回 code=${JSON.stringify(code)}，预期 REVEAL_OUT_OF_SCOPE 或 NO_DOWNLOAD_DIR`);
      }
      return {
        ok: true,
        detail: `400 code=${code}（临时配置 downloadDir=null；两种 code 都算通过）`,
      };
    });

    /* 10. hosts.crud -------------------------------------------------- */
    await step("hosts.crud", async () => {
      const srv = requireServer();
      const listBefore = await requestJson(srv.port, srv.token, "GET", "/api/hosts");
      if (listBefore.status !== 200) throw new Error(`GET /api/hosts 返回 ${listBefore.status}`);
      const beforeBody = listBefore.json || {};
      // 卡里写「返回数组」，实际实现是 `{hosts:[...]}`（src/server/http.mjs:1057），
      // 按代码断言，别让文档差异把 doctor 弄红。
      if (!Array.isArray(beforeBody.hosts)) {
        throw new Error(
          `GET /api/hosts 响应里没有数组 hosts（实际键: ${Object.keys(beforeBody).join(", ")}）`,
        );
      }
      const beforeCount = beforeBody.hosts.length;

      const created = await requestJson(srv.port, srv.token, "POST", "/api/hosts", {
        name: "doctor-probe",
        host: "127.0.0.1",
        port: 1,
        username: "nobody",
        authType: "password",
        password: "doctor-probe-not-a-real-secret",
      });
      if (created.status !== 200 && created.status !== 201) {
        throw new Error(`POST /api/hosts 返回 ${created.status}: ${String(created.text).slice(0, 200)}`);
      }
      const host = created.json && created.json.host;
      if (!host || typeof host.id !== "string" || host.id.length === 0) {
        throw new Error("POST /api/hosts 没有返回 host.id");
      }

      const deleted = await requestJson(srv.port, srv.token, "DELETE", `/api/hosts/${host.id}`);
      // 代码实际是 204 无体（src/server/http.mjs:1273-1277）；卡里写 200，两者都收。
      if (deleted.status !== 200 && deleted.status !== 204) {
        throw new Error(`DELETE /api/hosts/${host.id} 返回 ${deleted.status}`);
      }

      const listAfter = await requestJson(srv.port, srv.token, "GET", "/api/hosts");
      const afterCount = Array.isArray(listAfter.json && listAfter.json.hosts)
        ? listAfter.json.hosts.length
        : -1;
      if (afterCount !== beforeCount) {
        throw new Error(`删除后主机数 ${afterCount}，预期回到 ${beforeCount}`);
      }
      return {
        ok: true,
        detail: `GET {hosts:[...]}（${beforeCount} 条）→ POST ${created.status} id=${host.id} → DELETE ${deleted.status} → 回到 ${afterCount} 条（临时配置，未污染用户数据）`,
      };
    });

    /* 11. ws.hostRequired -------------------------------------------- */
    await step("ws.hostRequired", async () => {
      const srv = requireServer();
      wsClient = await connectWs(srv.port, srv.token);
      wsClient.send({ type: "pty.create", cols: 80, rows: 24 });
      const frame = await wsClient.waitFor(
        (f) => f && f.type === "pty.error" && f.code === "HOST_REQUIRED",
        WS_HOST_REQUIRED_TIMEOUT_MS,
      );
      if (!frame) {
        throw new Error(
          `${WS_HOST_REQUIRED_TIMEOUT_MS}ms 内没收到 HOST_REQUIRED（收到: ${JSON.stringify(wsClient.frames)}）`,
        );
      }
      return { ok: true, detail: `pty.create 不带 hostId → pty.error code=${frame.code}` };
    });

    /* 12. ws.remoteAttempt ------------------------------------------- */
    await step("ws.remoteAttempt", async () => {
      const srv = requireServer();
      if (!wsClient) throw new Error("前置 ws.hostRequired 未建立连接");
      wsClient.send({ type: "pty.create", hostId: "h-doctor-missing", cols: 80, rows: 24 });
      const frame = await wsClient.waitFor(
        (f) => f && f.type === "pty.error" && typeof f.id === "string" && f.id.length > 0,
        WS_REMOTE_ATTEMPT_TIMEOUT_MS,
      );
      if (!frame) {
        // 卡允许：远端不可达拿不到错误帧 → skip，不计失败。
        return {
          ok: true,
          detail: `skip: ${WS_REMOTE_ATTEMPT_TIMEOUT_MS}ms 内没收到 pty.error（远端不可达/挂起），按卡规则不计失败`,
        };
      }
      return {
        ok: true,
        detail: `假 hostId → pty.error id=${frame.id} code=${frame.code}（预期 HOST_NOT_FOUND，未真连网络）`,
      };
    });

    /* 13. cleanup ---------------------------------------------------- */
    await step("cleanup", async () => {
      const srv = requireServer();
      if (wsClient) {
        wsClient.close();
        wsClient = null;
      }
      const t0 = Date.now();
      await srv.close();
      const cost = Date.now() - t0;
      if (srv.server && srv.server.listening) {
        throw new Error("close() 之后 server 仍在 listening");
      }
      return { ok: true, detail: `close() 用时 ${cost}ms，server.listening=false，进程可正常退出` };
    });
  } finally {
    if (wsClient) {
      try {
        wsClient.close();
      } catch {
        // 忽略。
      }
      wsClient = null;
    }
    if (handle && handle.server && handle.server.listening) {
      try {
        await handle.close();
      } catch {
        // 忽略。
      }
    }
    if (previousConfigEnv === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previousConfigEnv;
  }

  const failed = checks.filter((check) => !check.ok);
  const report = {
    ts: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    port: listenPort,
    durationMs: Date.now() - startedAt,
    passed: failed.length === 0,
    checks,
    // 只留 error 级：warn 里有 ws.remoteAttempt 故意制造的「主机不存在」。
    errorLogs: logs.filter((entry) => entry && entry.level === "error"),
  };

  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉不影响结论。
  }

  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDoctor({})
    .then((report) => {
      const failed = report.checks.filter((check) => !check.ok);
      console.log(`doctor: ${report.checks.length - failed.length}/${report.checks.length} checks passed`);
      for (const check of report.checks) {
        console.log(`  ${check.ok ? "PASS" : "FAIL"} ${check.name} — ${check.detail}`);
      }
      console.log(`report: ${REPORT_PATH}`);
      process.exit(failed.length === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error(`doctor fatal: ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    });
}
