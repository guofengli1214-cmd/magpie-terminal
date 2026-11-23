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
import { createAgentRunner } from "../ai/agent.mjs";
import { createCommandRunner } from "../ai/runner.mjs";
import { readConfig } from "../config/store.mjs";
import { resolveShellForRequest } from "../pty/shells.mjs";

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
    // TASK-V2-B：带 hostId 就是远程会话；不带就是本地（行为与以前逐字一致）。
    hostId: z.string().max(64).optional(),
    // TASK-V4-F：本机会话可以指定 shell（bash / pwsh / powershell）。
    // 刻意不用 z.enum：非法值要回 session.failed + PTY_UNKNOWN_SHELL，
    // 而不是被 zod 打成 BAD_FRAME（卡片 §5.2 / AC4）。合法性在 resolveShellForRequest 里判。
    shellId: z.string().max(32).optional(),
  }),
  z.object({ type: z.literal("pty.close"), id: z.string() }),
  z.object({ type: z.literal("pty.attach"), id: z.string() }),
  z.object({
    type: z.literal("ai.ask"),
    requestId: z.string(),
    question: z.string(),
    // 可选：前端模型下拉选中的 id。不校验是否在清单里（网关会自己报错）。
    model: z.string().max(200).optional(),
    context: z
      .object({
        cwd: z.string().optional(),
        shell: z.unknown().optional(),
        recentOutput: z.string().optional(),
      })
      .optional(),
  }),
  // ---- agent 帧（TASK-V3-D / PROTOCOL-AGENT.md §3.1，字段名逐字） ----
  z.object({
    type: z.literal("agent.run"),
    requestId: z.string(),
    question: z.string(),
    model: z.string().max(200).optional(),
    context: z
      .object({
        cwd: z.string().optional(),
        shell: z.unknown().optional(),
        recentOutput: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("agent.approve"),
    requestId: z.string(),
    approvalId: z.string(),
    approved: z.boolean(),
    scope: z.enum(["once", "rest"]).optional(),
  }),
  z.object({
    type: z.literal("agent.stop"),
    requestId: z.string(),
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
 * @param {import("../pty/session.mjs").SessionManager} opts.sessions 本地 PTY
 * @param {import("../ssh/registry.mjs").RemoteRegistry} [opts.remote] 远程 SSH 会话
 * @param {(entry:object)=>void} opts.log
 */
export function attachWebSocket(opts) {
  const { server, port, token, sessions, remote, log } = opts;
  // TASK-V4-F：config.defaultShell 现取（PUT /api/config 后不重启也生效）。
  const getDefaultShell = typeof opts.getDefaultShell === "function" ? opts.getDefaultShell : () => null;
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  /**
   * id -> { socket, timer, state }
   * state: "owned"（正常持有）/ "orphaned"（owner 已断，等认领或回收）
   */
  const ownership = new Map();

  // agent 内核（TASK-V3-D）：runner 在用户真实 PTY 里执行命令，agent 跑多步循环。
  const runner = createCommandRunner({ sessions, remote, log });
  // resolver：agent 拿到的 sessionId 属于本地还是远程。
  runner.setSessionResolver((id) => {
    const hit = lookup(id);
    return hit ? hit.kind : null;
  });
  const agent = createAgentRunner({ log, runner });

  // `sessions.create()` 是同步 emit `session.created` 的，早于我们能 setOwner。
  // 用一个同作用域的临时变量把「正在创建的那个 socket」传给 onCreated。
  // 远程 create() 是异步 emit 的（建连要时间），所以远程的 session.created 必须靠
  // ownership 里的记录找到 socket —— 远程会话在 create() 返回后立刻 setOwner。
  let creatingFor = null;

  // 每个 socket 一个串行队列（TASK-V4-F）：handleMessage 要 await 配置读取。
  const queues = new Map();

  /**
   * 帧路由的唯一分叉点：远程注册表优先，其次本地。
   * 两边都没有才由调用方回 SESSION_GONE。
   */
  function lookup(id) {
    if (remote) {
      const found = remote.get(id);
      if (found) return { kind: "remote", session: found, registry: remote };
    }
    const local = sessions.get(id);
    if (local) return { kind: "local", session: local, registry: sessions };
    return null;
  }

  function registryOf(id) {
    const hit = lookup(id);
    return hit ? hit.registry : null;
  }

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
      const task = agent.taskForSocket(socket);
      if (task) task.stop({ reason: "disconnect" });
      orphanOwnedBy(socket);
    });
    socket.on("error", () => {
      clients.delete(socket);
      const task = agent.taskForSocket(socket);
      if (task) task.stop({ reason: "disconnect" });
      orphanOwnedBy(socket);
    });

    socket.on("message", (raw) => {
      // TASK-V4-F：pty.create 现在要读 config.defaultShell（异步），所以 handleMessage
      // 变成 async；为了不把原来的「帧按到达顺序处理」语义弄丢，按 socket 串行排队。
      const previous = queues.get(socket) || Promise.resolve();
      const next = previous
        .then(() => handleMessage(socket, raw))
        .catch(() => {
          // 单帧处理失败不能把整个 socket 的队列钉死。
        });
      queues.set(socket, next);
    });
  });

  /** socket 关闭时，它持有的所有会话转入孤儿态并起宽限定时器。 */
  function orphanOwnedBy(socket) {
    queues.delete(socket);
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
          const registry = registryOf(id);
          if (registry) registry.close(id);
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

  async function handleMessage(socket, raw) {
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
        // 远程分支：不带 hostId 时一个字节都不走这里。
        if (typeof frame.hostId === "string" && frame.hostId.length > 0) {
          if (!remote) {
            send(socket, {
              type: "pty.error",
              id: "",
              code: "REMOTE_UNAVAILABLE",
              userText: "远程会话不可用。",
            });
            return;
          }
          const stub = remote.create({ hostId: frame.hostId, cols: frame.cols, rows: frame.rows });
          if (!stub) {
            send(socket, {
              type: "pty.error",
              id: "",
              code: "HOST_NOT_FOUND",
              userText: "没有这条主机，先在主机面板里添加。",
            });
            return;
          }
          // 远程 session.created 是异步来的：必须先登记 owner/target，
          // 否则 onCreated 找不到该发给谁（帧会丢，前端永远转圈）。
          setOwner(stub.id, socket);
          if (remote) pendingCreateSockets.set(stub.id, socket);
          log({
            level: "info",
            code: "REMOTE_SESSION_STARTING",
            msg: "remote session starting",
            sessionId: stub.id,
            hostId: frame.hostId,
          });
          return;
        }
        let session = null;
        // 解析本次会话要用的 shell（shellId → config.defaultShell → 自动探测）。
        const resolution = resolveShellForRequest({
          shellId: frame.shellId,
          defaultShell: await getDefaultShell(),
        });
        if (!resolution.ok) {
          // 非法 / 不可用的 shellId：回 session.failed，不抛未捕获异常，不影响其它会话。
          send(socket, {
            type: "session.failed",
            id: "",
            code: resolution.code,
            userText: resolution.userText,
          });
          log({
            level: "warn",
            code: resolution.code,
            msg: "pty.create rejected: unknown shell",
            shellId: frame.shellId,
          });
          return;
        }
        // sessions.create() 同步 emit session.created，onCreated 需要知道「该发给谁」。
        creatingFor = socket;
        try {
          session = sessions.create({
            cols: frame.cols,
            rows: frame.rows,
            cwd: frame.cwd,
            shell: resolution.shell,
          });
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
        const registry = registryOf(frame.id);
        if (registry) registry.write(frame.id, frame.data);
        return;
      }
      case "pty.resize": {
        const registry = registryOf(frame.id);
        if (registry) registry.resize(frame.id, frame.cols, frame.rows);
        return;
      }
      case "pty.close": {
        // 先远程再本地；两边都没有就安静忽略（与 A 卡行为逐字一致，不发多余帧）。
        const registry = registryOf(frame.id);
        if (registry) registry.close(frame.id);
        forgetOwner(frame.id);
        runner.dispose(frame.id);
        log({ level: "info", code: "SESSION_CLOSED", msg: "session closed", sessionId: frame.id });
        return;
      }
      case "ai.ask": {
        void handleAsk(socket, frame);
        return;
      }
      case "agent.run": {
        void handleAgentRun(socket, frame);
        return;
      }
      case "agent.approve": {
        agent.resolveApproval({
          approvalId: frame.approvalId,
          approved: frame.approved,
          scope: frame.scope,
        });
        return;
      }
      case "agent.stop": {
        const task = agent.taskForSocket(socket);
        if (task) task.stop({ reason: "user" });
        return;
      }
      default:
        return;
    }
  }

  /** 重连后认领一个仍存活的会话。 */
  function attachSession(socket, id) {
    const hit = lookup(id);
    const session = hit ? hit.session : null;
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
      kind: hit.kind,
      ...(hit.kind === "remote"
        ? { hostId: session.hostId, hostName: session.hostName, host: session.host }
        : {}),
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      shell: {
        name: session.shell.name,
        version: session.shell.version,
        path: session.shell.path,
        fallback: session.shell.fallback,
      },
      pty: hit.kind === "remote" ? "remote" : session.mode === "sentinel" ? "sentinel" : "native",
      recentOutput: session.recentOutput || "",
    });
    log({ level: "info", code: "SESSION_RESUMED", msg: "session resumed", sessionId: id });
  }

  async function handleAgentRun(socket, frame) {
    const context = frame.context && typeof frame.context === "object" ? frame.context : {};
    // 目标会话：context.sessionId 优先，其次这个 socket 当前持有的最新会话。
    let sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
    if (!sessionId) {
      for (const [id, record] of ownership) {
        if (record.socket === socket) sessionId = id;
      }
    }
    if (!sessionId || !lookup(sessionId)) {
      send(socket, {
        type: "agent.error",
        requestId: frame.requestId,
        taskId: "",
        code: "NO_SESSION",
        userText: "先开一个终端标签，再让 AI 动手。",
      });
      return;
    }

    let config = {};
    try {
      const read = await readConfig();
      config = read.config || {};
    } catch {
      config = {};
    }

    agent.start({
      requestId: frame.requestId,
      question: frame.question,
      model: frame.model,
      context: { ...context, sessionId },
      sessionId,
      socket,
      send: (outbound) => send(socket, outbound),
      config,
    });
  }

  async function handleAsk(socket, frame) {
    const startedAt = Date.now();
    try {
      // model 必须透传：以前这里丢掉了，前端选了模型也不生效（本卡要修的 bug）。
      const result = await askGateway({
        question: frame.question,
        context: frame.context || {},
        model: frame.model,
      });
      const decision = classify(result.command);
      send(socket, {
        type: "ai.reply",
        requestId: frame.requestId,
        command: result.command,
        reason: result.reason,
        decision: decision.decision,
        policyHit: decision.hit,
        // 回答头要显示「用了哪个模型」，所以回显（不是回显请求值，而是网关实际用的）。
        model: result.model,
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

  // 远程 create() 是异步的：id 在 create() 返回时就知道，但 socket 要在 send 时再查一次
  // （期间可能重连换过 socket）。这张表只用于 created 帧补 kind 之前的定位。
  const pendingCreateSockets = new Map();

  // 把 PTY 会话事件翻成对外帧。
  const onCreated = (info) => {
    const record = ownerOf(info.id);
    const target = creatingFor || (record && record.socket) || null;
    // 本地帧：`{ type, ...info }` 一个字段都不多（A 卡与 T1/T2 的测试锁着这个形状）。
    send(target, { type: "session.created", kind: "local", ...info });
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
    runner.dispose(info.id);
  };
  const onFailed = (info) => {
    const record = ownerOf(info.id);
    const target = (record && record.socket) || creatingFor || null;
    const frame = { type: "pty.error", id: info.id, code: info.code, userText: info.userText };
    send(target, frame);
    forgetOwner(info.id);
    runner.dispose(info.id);
  };

  // TASK-V4-G §5.1：OSC 7 解析出来的当前目录 → `{type:"session.cwd", id, cwd}`。
  // 与 pty.output 同样遵守孤儿会话不发帧的规则（attach 时 session.resumed.cwd 兜底）。
  const onCwd = (info) => {
    const record = ownerOf(info.id);
    if (!record || !record.socket) return;
    send(record.socket, { type: "session.cwd", id: info.id, cwd: info.cwd });
  };

  const onRemoteCreated = (info) => {
    const record = ownerOf(info.id);
    const target = (record && record.socket) || pendingCreateSockets.get(info.id) || null;
    pendingCreateSockets.delete(info.id);
    send(target, { type: "session.created", kind: "remote", ...info });
  };
  const onRemoteExited = (info) => {
    const record = ownerOf(info.id);
    if (record && record.socket) {
      send(record.socket, {
        type: "pty.exit",
        id: info.id,
        exitCode: info.exitCode,
        signal: info.signal,
      });
    }
    forgetOwner(info.id);
    pendingCreateSockets.delete(info.id);
    runner.dispose(info.id);
  };
  const onRemoteFailed = (info) => {
    const record = ownerOf(info.id);
    const target = (record && record.socket) || pendingCreateSockets.get(info.id) || null;
    send(target, { type: "pty.error", id: info.id, code: info.code, userText: info.userText });
    forgetOwner(info.id);
    pendingCreateSockets.delete(info.id);
    runner.dispose(info.id);
  };
  const onRemoteOutput = (info) => {
    const record = ownerOf(info.id);
    if (!record || !record.socket) return;
    send(record.socket, { type: "pty.output", id: info.id, data: info.data });
  };

  sessions.on("session.created", onCreated);
  sessions.on("pty.output", onOutput);
  sessions.on("session.exited", onExited);
  sessions.on("session.failed", onFailed);
  sessions.on("session.cwd", onCwd);
  if (remote) {
    remote.on("session.created", onRemoteCreated);
    remote.on("pty.output", onRemoteOutput);
    remote.on("session.exited", onRemoteExited);
    remote.on("session.failed", onRemoteFailed);
    // 远程 shell 也发 OSC 7（远端一般是 bash，够用）。
    remote.on("session.cwd", onCwd);
  }

  function close() {
    // 服务关闭：停掉所有 agent 任务（不杀已在跑的 PTY 命令）。
    try {
      agent.stopAll();
    } catch {
      // 忽略。
    }
    sessions.off("session.created", onCreated);
    sessions.off("pty.output", onOutput);
    sessions.off("session.exited", onExited);
    sessions.off("session.failed", onFailed);
    sessions.off("session.cwd", onCwd);
    if (remote) {
      remote.off("session.created", onRemoteCreated);
      remote.off("pty.output", onRemoteOutput);
      remote.off("session.exited", onRemoteExited);
      remote.off("session.failed", onRemoteFailed);
      remote.off("session.cwd", onCwd);
    }
    pendingCreateSockets.clear();
    for (const id of ownership.keys()) runner.dispose(id);
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
