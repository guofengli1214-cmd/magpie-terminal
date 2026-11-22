// WebSocket 帧协议的唯一住所。
// 入站帧全部用 zod 校验；校验失败回 pty.error / BAD_FRAME，但不断开连接。
//
// 会话归属（TASK.md §4.6）：每个会话记下创建它的 socket（owner）。
// socket 关闭 → 该 owner 的会话转入 orphaned，各起一个 ORPHAN_GRACE_MS 定时器；
// 到期无人认领 → 走正常 close(id)。收到 pty.attach{id} → 取消定时器、改由新 socket 持有、
// 回 session.resumed。
//
// 单用户 loopback 服务：任何通过鉴权的连接都可以 attach/close 任意会话，
// 不做 per-socket 隔离（这是有意为之，别自作聪明加）。

import { WebSocketServer } from "ws";
import { z } from "zod";
import { checkWsGate } from "./auth.mjs";
import { classify } from "../policy/classify.mjs";
import { askGateway } from "../ai/gateway.mjs";

export const WS_PATH = "/ws";

/**
 * 孤儿会话的宽限期。
 * 取值等于前端重连退避上限（app/core/constants.js 的 RECONNECT_MAX_MS），
 * 这样短抖动不会杀会话，而刷新后的新页面（store 为空）永远不会 attach 旧 id，
 * 10 秒后自然回收。
 */
export const ORPHAN_GRACE_MS = 10000;

const InputFrame = z.union([
  z.object({ type: z.literal("pty.input"), id: z.string(), data: z.string() }),
  z.object({
    type: z.literal("pty.resize"),
    id: z.string(),
    cols: z.number().int(),
    rows: z.number().int(),
  }),
  z.object({
    type: z.literal("pty.create"),
    cols: z.number().int().optional(),
    rows: z.number().int().optional(),
    cwd: z.string().optional(),
  }),
  z.object({ type: z.literal("pty.close"), id: z.string() }),
  z.object({ type: z.literal("pty.attach"), id: z.string() }),
  z.object({
    type: z.literal("ai.ask"),
    requestId: z.string(),
    question: z.string(),
    context: z
      .object({
        cwd: z.string().optional(),
        shell: z.unknown().optional(),
        recentOutput: z.string().optional(),
      })
      .optional(),
  }),
]);

function send(socket, frame) {
  if (!socket || socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // 连接已断，忽略。
  }
}

/**
 * @param {object} opts
 * @param {import("node:http").Server} opts.server
 * @param {number} opts.port
 * @param {string} opts.token
 * @param {import("../pty/session.mjs").SessionManager} opts.sessions
 * @param {(entry:object)=>void} opts.log
 */
export function attachWebSocket(opts) {
  const { server, port, token, sessions, log } = opts;
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  /**
   * id -> { socket, timer, state }
   * state: "owned"（正常持有）/ "orphaned"（owner 已断，等认领或回收）
   */
  const ownership = new Map();

  // `sessions.create()` 是同步 emit `session.created` 的，早于我们能 setOwner。
  // 用一个同作用域的临时变量把「正在创建的那个 socket」传给 onCreated。
  let creatingFor = null;

  function ownerOf(id) {
    return ownership.get(id) || null;
  }

  function setOwner(id, socket) {
    const existing = ownership.get(id);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.socket = socket;
      existing.timer = null;
      existing.state = socket ? "owned" : "orphaned";
      return existing;
    }
    const record = { socket, timer: null, state: socket ? "owned" : "orphaned" };
    ownership.set(id, record);
    return record;
  }

  function forgetOwner(id) {
    const record = ownership.get(id);
    if (!record) return;
    if (record.timer) clearTimeout(record.timer);
    ownership.delete(id);
  }

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    } catch {
      socket.destroy();
      return;
    }

    const gate = checkWsGate(req, url, port, token);
    if (!gate.ok) {
      log({ level: "warn", code: gate.code, msg: "ws upgrade rejected", route: "ws /ws" });
      // 握手未完成：绝不 writeHead(403)，直接销毁。
      socket.destroy();
      return;
    }
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    // 通过门禁后才把连接交出去。
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, url);
    });
  });

  wss.on("connection", (socket) => {
    clients.add(socket);
    log({ level: "info", code: "WS_CONNECTED", msg: "ws connected", route: "ws /ws" });

    // 服务端不在连接建立时替客户端建会话（TASK.md §4.4）：
    // 分不清「真人在开页面」和「探针连了一下 WS」，替客户端建会话会让每次探测都
    // 凭空多一个 shell，/api/health 的 sessions 也对不上。
    // 自动建首个标签是 UI 行为，归 app.js 的 onStatus(open) 分支。
    socket.on("close", () => {
      clients.delete(socket);
      orphanOwnedBy(socket);
    });
    socket.on("error", () => {
      clients.delete(socket);
      orphanOwnedBy(socket);
    });

    socket.on("message", (raw) => {
      handleMessage(socket, raw);
    });
  });

  /** socket 关闭时，它持有的所有会话转入孤儿态并起宽限定时器。 */
  function orphanOwnedBy(socket) {
    for (const [id, record] of ownership) {
      if (record.socket !== socket) continue;
      record.socket = null;
      record.state = "orphaned";
      if (record.timer) clearTimeout(record.timer);
      record.timer = setTimeout(() => {
        const current = ownership.get(id);
        if (!current) return;
        current.timer = null;
        // 宽限期内没人 attach → 正常关闭（kill + 坑 2 的约 1.07 秒延迟）。
        if (current.state === "orphaned" && !current.socket) {
          log({
            level: "info",
            code: "SESSION_ORPHAN_EXPIRED",
            msg: "orphaned session reclaimed",
            sessionId: id,
          });
          sessions.close(id);
          forgetOwner(id);
        }
      }, ORPHAN_GRACE_MS);
      log({
        level: "info",
        code: "SESSION_ORPHANED",
        msg: "session orphaned, waiting for attach",
        sessionId: id,
      });
    }
  }

  function handleMessage(socket, raw) {
    let json;
    try {
      json = JSON.parse(String(raw));
    } catch {
      send(socket, { type: "pty.error", id: "", code: "BAD_FRAME", userText: "无法解析的 WS 帧。" });
      return;
    }

    const parsed = InputFrame.safeParse(json);
    if (!parsed.success) {
      const rawId = json && typeof json.id === "string" ? json.id : "";
      send(socket, {
        type: "pty.error",
        id: rawId,
        code: "BAD_FRAME",
        userText: "WS 帧格式不正确。",
      });
      return;
    }

    const frame = parsed.data;
    switch (frame.type) {
      case "pty.create": {
        let session = null;
        // sessions.create() 同步 emit session.created，onCreated 需要知道「该发给谁」。
        creatingFor = socket;
        try {
          session = sessions.create({ cols: frame.cols, rows: frame.rows, cwd: frame.cwd });
        } finally {
          creatingFor = null;
        }
        if (session) {
          setOwner(session.id, socket);
          log({
            level: "info",
            code: "SESSION_CREATED",
            msg: "session created",
            sessionId: session.id,
          });
        }
        return;
      }
      case "pty.attach": {
        attachSession(socket, frame.id);
        return;
      }
      case "pty.input": {
        sessions.write(frame.id, frame.data);
        return;
      }
      case "pty.resize": {
        sessions.resize(frame.id, frame.cols, frame.rows);
        return;
      }
      case "pty.close": {
        sessions.close(frame.id);
        forgetOwner(frame.id);
        log({ level: "info", code: "SESSION_CLOSED", msg: "session closed", sessionId: frame.id });
        return;
      }
      case "ai.ask": {
        void handleAsk(socket, frame);
        return;
      }
      default:
        return;
    }
  }

  /** 重连后认领一个仍存活的会话。 */
  function attachSession(socket, id) {
    const session = sessions.get(id);
    if (!session) {
      send(socket, {
        type: "pty.error",
        id,
        code: "SESSION_GONE",
        userText: "这个标签的会话已经结束。",
      });
      forgetOwner(id);
      return;
    }
    setOwner(id, socket);
    send(socket, {
      type: "session.resumed",
      id,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      shell: {
        name: session.shell.name,
        version: session.shell.version,
        path: session.shell.path,
        fallback: session.shell.fallback,
      },
      pty: session.mode === "sentinel" ? "sentinel" : "native",
      recentOutput: session.recentOutput || "",
    });
    log({ level: "info", code: "SESSION_RESUMED", msg: "session resumed", sessionId: id });
  }

  async function handleAsk(socket, frame) {
    const startedAt = Date.now();
    try {
      const result = await askGateway({ question: frame.question, context: frame.context || {} });
      const decision = classify(result.command);
      send(socket, {
        type: "ai.reply",
        requestId: frame.requestId,
        command: result.command,
        reason: result.reason,
        decision: decision.decision,
        policyHit: decision.hit,
      });
      log({
        level: "info",
        code: "AI_REPLY",
        msg: "ai reply",
        route: "ws /ws",
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const code = err && err.code ? err.code : "GATEWAY_UNREACHABLE";
      const userText =
        err && err.userText
          ? err.userText
          : "AI 暂时不可用，命令仍可手动输入。";
      send(socket, {
        type: "ai.error",
        requestId: frame.requestId,
        code,
        userText,
      });
      log({
        level: "warn",
        code,
        msg: "ai request failed",
        route: "ws /ws",
        durationMs: Date.now() - startedAt,
      });
    }
  }

  // 把 PTY 会话事件翻成对外帧。
  const onCreated = (info) => {
    const record = ownerOf(info.id);
    const target = creatingFor || (record && record.socket) || null;
    send(target, { type: "session.created", ...info });
  };
  const onOutput = (info) => {
    const record = ownerOf(info.id);
    // owner 已断（孤儿态）时不发：数据仍在 session.recentOutput 里，attach 时回给新页面。
    if (!record || !record.socket) return;
    send(record.socket, { type: "pty.output", id: info.id, data: info.data });
  };
  const onExited = (info) => {
    const record = ownerOf(info.id);
    const frame = { type: "pty.exit", id: info.id, exitCode: info.exitCode, signal: info.signal };
    if (record && record.socket) send(record.socket, frame);
    forgetOwner(info.id);
  };
  const onFailed = (info) => {
    const record = ownerOf(info.id);
    const frame = { type: "pty.error", id: info.id, code: info.code, userText: info.userText };
    if (record && record.socket) send(record.socket, frame);
    forgetOwner(info.id);
  };

  sessions.on("session.created", onCreated);
  sessions.on("pty.output", onOutput);
  sessions.on("session.exited", onExited);
  sessions.on("session.failed", onFailed);

  function close() {
    sessions.off("session.created", onCreated);
    sessions.off("pty.output", onOutput);
    sessions.off("session.exited", onExited);
    sessions.off("session.failed", onFailed);
    for (const record of ownership.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    ownership.clear();
    for (const client of clients) {
      try {
        client.terminate();
      } catch {
        // 忽略。
      }
    }
    clients.clear();
    wss.close();
  }

  return { close, clients };
}
