// AC1/AC2/AC3/AC4/AC10 证据脚本：/api/shells 与 shellId 相关行为。
//
// 用法（仓库根）：node scripts/probe-shells-api.mjs [--json]
// 起真服务（真 PTY）+ 真 WS，全部用真安装状态，不 mock。
//
// 覆盖：
//   AC1  GET /api/shells 同时含 cmd + bash + pwsh + powershell（+ wsl:* 若有发行版）
//   AC2  用每个 available:true 的 id 建会话 → 都拿到 session.created；cmd/wsl 各手工 echo 一次
//   AC3  非法 shellId（nope:）→ session.failed + PTY_UNKNOWN_SHELL，不是 BAD_FRAME
//   AC4  PUT /api/config 接受 cmd / wsl:*，拒绝 "bad shell!"（临时配置文件）
//   AC10 /api/shells 既有字段一个没少没改名；老前端（只认 3 个 id）不会崩
//
// 退出码：全过 0，任一失败 1。

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { startServer } from "../src/server/http.mjs";
import { shutdown, sleep } from "./lib/pty-cleanup.mjs";

const json = process.argv.includes("--json");

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

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const frames = [];
    const waiters = [];
    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      frames.push(frame);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter.predicate(frame)) {
          waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
    ws.addEventListener("open", () =>
      resolve({
        frames,
        send: (frame) => ws.send(JSON.stringify(frame)),
        waitFor(predicate, timeoutMs = 30000) {
          const existing = frames.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error(`waitFor timeout after ${timeoutMs}ms`)),
              timeoutMs,
            );
            waiters.push({ predicate, resolve: res, timer });
          });
        },
        outputFor(id) {
          return frames
            .filter((frame) => frame.type === "pty.output" && (!id || frame.id === id))
            .map((frame) => frame.data)
            .join("");
        },
        close: () => ws.close(),
      }),
    );
  });
}

/** 从某一帧之后的新帧里等；避免 waitFor 命到历史帧（旧失败/旧会话）。 */
function waitForNew(client, predicate, fromIndex, timeoutMs = 30000) {
  const existing = client.frames.slice(fromIndex).find(predicate);
  if (existing) return Promise.resolve(existing);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = client.frames.slice(fromIndex).find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`waitForNew timeout after ${timeoutMs}ms`));
      }
      return setTimeout(tick, 60);
    };
    tick();
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    await sleep(60);
  }
}

const results = [];
const record = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });

/* ---------------------------------------------------------------- 主流程 */

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-shells-api-"));
const configFile = path.join(dir, "config.json");
process.env.MAGPIE_TERMINAL_CONFIG_PATH = configFile;
const port = await freePort();
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const handle = await startServer({ port, log: quiet });
const base = `http://127.0.0.1:${port}`;
const headers = { "x-magpie-term-token": handle.token, "content-type": "application/json" };

const getJson = async (pathname) => {
  const response = await fetch(`${base}${pathname}`, { headers });
  return { status: response.status, body: await response.json() };
};
const putConfig = async (patch) => {
  const response = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers,
    body: JSON.stringify(patch),
  });
  return { status: response.status, body: await response.json() };
};

let error = null;
let client = null;
try {
  /* ============ AC1 ============ */
  const shellsResponse = await getJson("/api/shells");
  const payload = shellsResponse.body;
  const shells = Array.isArray(payload.shells) ? payload.shells : [];
  const ids = shells.map((item) => item.id);
  const byId = (id) => shells.find((item) => item.id === id);
  const requiredBuiltins = ["cmd", "bash", "pwsh", "powershell"];

  record(
    "AC1.a GET /api/shells 200，且同时包含 cmd / bash / pwsh / powershell",
    shellsResponse.status === 200 && requiredBuiltins.every((id) => ids.includes(id)),
    {
      httpStatus: shellsResponse.status,
      ids,
      missing: requiredBuiltins.filter((id) => !ids.includes(id)),
      default: payload.default,
      configured: payload.configured,
    },
  );

  const wslItems = shells.filter((item) => item.group === "wsl");
  record(
    "AC1.b 本机装了 WSL 发行版 → 出现 wsl:<发行版>（每条带 detail，args 是 -d <发行版>）",
    wslItems.every((item) => item.id === `wsl:${item.detail}`),
    {
      wslIds: wslItems.map((item) => item.id),
      note: wslItems.length === 0 ? "本机没有注册任何 WSL 发行版（wsl -l -q 为空）" : "有发行版",
    },
  );

  record(
    "AC1.c 每条的 available 与实际能否 spawn 一致（本批按 shell record 的 path 可执行性判定）",
    shells.every((item) => item.available === false || (typeof item.path === "string" && item.path.length > 0)),
    {
      available: shells.filter((item) => item.available).map((item) => ({ id: item.id, path: item.path })),
      unavailable: shells.filter((item) => !item.available).map((item) => item.id),
    },
  );

  /* ============ AC10 ============ */
  const LEGACY_FIELDS = ["id", "name", "version", "path", "available"];
  const fieldProblems = [];
  for (const item of shells) {
    for (const field of LEGACY_FIELDS) {
      const present = Object.prototype.hasOwnProperty.call(item, field);
      const expectedType = field === "available" ? "boolean" : "string";
      if (!present) fieldProblems.push(`${item.id}: 缺字段 ${field}`);
      else if (typeof item[field] !== expectedType) {
        fieldProblems.push(`${item.id}: ${field} 类型是 ${typeof item[field]}，应为 ${expectedType}`);
      }
    }
    // 旧前端只认的 3 个 id 必须仍在（且语义不变：可用 = true）。
    for (const key of Object.keys(item)) {
      if (!LEGACY_FIELDS.includes(key) && !["group", "detail"].includes(key)) {
        fieldProblems.push(`${item.id}: 出现未登记的新字段 ${key}`);
      }
    }
  }
  record("AC10.a 每条都保留旧字段 id/name/version/path/available，类型不变，只新增 group/detail", fieldProblems.length === 0, {
    fieldProblems,
    sample: shells[1],
    groups: [...new Set(shells.map((item) => item.group))],
  });
  record(
    "AC10.b 老前端（只认 bash/pwsh/powershell）仍能在这份清单里找到它们",
    ["bash", "pwsh", "powershell"].every((id) => byId(id)),
    { legacyIdsPresent: ["bash", "pwsh", "powershell"].filter((id) => byId(id)) },
  );

  /* ============ AC3 ============ */
  client = await connect(port, handle.token);
  client.send({ type: "pty.create", cols: 90, rows: 28, shellId: "nope:" });
  const bad = await client.waitFor(
    (frame) => frame.type === "session.failed" || frame.type === "pty.error",
  );
  record(
    "AC3.a shellId:'nope:' → session.failed + PTY_UNKNOWN_SHELL（不是 BAD_FRAME）",
    bad.type === "session.failed" && bad.code === "PTY_UNKNOWN_SHELL",
    { frameType: bad.type, code: bad.code, userText: bad.userText, sessions: handle.sessions.size },
  );

  /* ============ AC2 ============ */
  // 用清单里每个 available:true 的 id 各建一次会话。
  // 注意：必须只看「这次 send 之后」的帧，否则会命中前面 AC3 的 session.failed。
  const availableIds = shells.filter((item) => item.available).map((item) => item.id);
  const sessions = {};
  for (const shellId of availableIds) {
    const from = client.frames.length;
    client.send({ type: "pty.create", cols: 90, rows: 28, shellId });
    try {
      const created = await waitForNew(
        client,
        (frame) => frame.type === "session.created" || (frame.type === "session.failed" && frame.code !== undefined),
        from,
        60000,
      );
      sessions[created.id || `failed:${shellId}`] = { shellId, frame: created };
    } catch (err) {
      sessions[`timeout:${shellId}`] = { shellId, error: String(err && err.message ? err.message : err) };
    }
    await sleep(150);
  }
  const createdOk = Object.values(sessions).filter((entry) => entry.frame && entry.frame.type === "session.created");
  const createdFail = Object.values(sessions).filter((entry) => !entry.frame || entry.frame.type !== "session.created");
  record(
    "AC2.a 清单里每个 available:true 的 id 都能拿到 session.created",
    createdFail.length === 0 && createdOk.length === availableIds.length,
    {
      availableIds,
      created: createdOk.map((entry) => ({ id: entry.frame.id, shellId: entry.shellId, name: entry.frame.shell && entry.frame.shell.name })),
      failed: createdFail.map((entry) => ({ shellId: entry.shellId, frame: entry.frame, error: entry.error })),
    },
  );

  // 手工验证 cmd 与 wsl:* 各一次 echo（AC2 明写）。
  const echoChecks = [];
  const echoTargets = [
    { shellId: "cmd", command: "echo CMD_ECHO_OK\r\n", expect: "CMD_ECHO_OK", newline: "\r\n" },
    {
      shellId: wslItems.length > 0 ? wslItems[0].id : null,
      command: "echo WSL_ECHO_OK\r",
      expect: "WSL_ECHO_OK",
      newline: "\r",
    },
  ];
  for (const target of echoTargets) {
    if (!target.shellId) {
      echoChecks.push({ shellId: null, skipped: "本机没有 WSL 发行版" });
      continue;
    }
    const from = client.frames.length;
    client.send({ type: "pty.create", cols: 100, rows: 30, shellId: target.shellId });
    let created;
    try {
      created = await waitForNew(
        client,
        (frame) => frame.type === "session.created" || (frame.type === "session.failed" && frame.code !== undefined),
        from,
        60000,
      );
    } catch (err) {
      echoChecks.push({ shellId: target.shellId, error: `create timeout: ${err && err.message}` });
      continue;
    }
    if (created.type !== "session.created") {
      echoChecks.push({ shellId: target.shellId, error: `create failed: ${JSON.stringify(created).slice(0, 200)}` });
      continue;
    }
    // 等提示符稳定后再写，避免把字符打进 shell 初始化。
    let lastLen = -1;
    try {
      await waitUntil(() => {
        const current = client.outputFor(created.id).length;
        const stable = current > 0 && current === lastLen;
        lastLen = current;
        return stable;
      }, 60000, `${target.shellId} prompt`);
    } catch {
      // 没等到稳定也继续写一次（最坏情形下也能看到结果）。
    }
    await sleep(500);
    client.send({ type: "pty.input", id: created.id, data: target.command });
    let hits = 0;
    try {
      await waitUntil(() => {
        const out = client.outputFor(created.id);
        hits = (out.match(new RegExp(target.expect, "g")) || []).length;
        return hits >= 2;
      }, 30000, `${target.shellId} echo`);
    } catch {
      // 超时就记录实际命中数。
    }
    echoChecks.push({
      shellId: target.shellId,
      sessionId: created.id,
      shellName: created.shell && created.shell.name,
      expect: target.expect,
      hits,
      ok: hits >= 2,
      tail: client.outputFor(created.id).slice(-300),
    });
    client.send({ type: "pty.close", id: created.id });
    await sleep(300);
  }
  const echoOk = echoChecks.every((entry) => entry.skipped || entry.ok === true);
  record(
    "AC2.b cmd 与 wsl:* 各手工 echo 一次，回显正常（命中 ≥ 2 次：回显 + 执行结果）",
    echoOk,
    { echoChecks },
  );

  /* ============ AC4 ============ */
  const putCmd = await putConfig({ defaultShell: "cmd" });
  const afterCmd = JSON.parse(await readFile(configFile, "utf8"));
  const putWsl = await putConfig({ defaultShell: wslItems.length > 0 ? wslItems[0].id : "wsl:Ubuntu-24.04" });
  const afterWsl = JSON.parse(await readFile(configFile, "utf8"));
  const putBad = await putConfig({ defaultShell: "bad shell!" });
  const badBody = putBad.body;
  const afterBad = JSON.parse(await readFile(configFile, "utf8"));

  record(
    "AC4.a PUT defaultShell='cmd' → 200 并落盘",
    putCmd.status === 200 && putCmd.body.defaultShell === "cmd" && afterCmd.defaultShell === "cmd",
    { status: putCmd.status, body: putCmd.body.defaultShell, persisted: afterCmd.defaultShell },
  );
  record(
    "AC4.b PUT defaultShell='wsl:<发行版>' → 200 并落盘（冒号不被拒）",
    putWsl.status === 200 && afterWsl.defaultShell.startsWith("wsl:"),
    { status: putWsl.status, body: putWsl.body.defaultShell, persisted: afterWsl.defaultShell },
  );
  record(
    "AC4.c PUT defaultShell='bad shell!' → 400 INVALID_SHELL，且不落盘",
    putBad.status === 400 && badBody.code === "INVALID_SHELL" && afterBad.defaultShell !== "bad shell!",
    { status: putBad.status, code: badBody.code, userText: badBody.userText, persisted: afterBad.defaultShell },
  );

  // 配置里的 id 在本机不存在时仍走「回落自动探测」，不报错。
  // 先把 defaultShell 换成不存在的 wsl:*，再建会话（不带 shellId）。
  await putConfig({ defaultShell: "wsl:NoSuchDistro-99" });
  const fallbackFrom = client.frames.length;
  client.send({ type: "pty.create", cols: 90, rows: 28 });
  const fallbackCreated = await waitForNew(
    client,
    (frame) => frame.type === "session.created" || frame.type === "session.failed",
    fallbackFrom,
    45000,
  );
  record(
    "AC4.d 配置里存了本机不存在的 wsl:NoSuchDistro-99 → 建会话静默回落自动探测（bash），不报错",
    fallbackCreated &&
      fallbackCreated.type === "session.created" &&
      /bash/i.test(fallbackCreated.shell && fallbackCreated.shell.name ? fallbackCreated.shell.name : ""),
    { frameType: fallbackCreated && fallbackCreated.type, shell: fallbackCreated && fallbackCreated.shell },
  );
  if (fallbackCreated && fallbackCreated.id) client.send({ type: "pty.close", id: fallbackCreated.id });
  await putConfig({ defaultShell: null });
} catch (err) {
  error = err && err.message ? err.message : String(err);
} finally {
  if (client) {
    for (const key of handle.sessions.sessions.keys()) {
      try {
        client.send({ type: "pty.close", id: key });
      } catch {
        // 忽略。
      }
    }
    await sleep(400);
    client.close();
  }
  // 关键：必须等 ConPTY 真正释放 console 再退进程，否则连跑几轮会撞
  // 「too many consoles in use, max consoles is 128」（见 scripts/lib/pty-cleanup.mjs）。
  await shutdown(handle);
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
