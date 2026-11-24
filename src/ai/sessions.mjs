// AI 会话存储（TASK-V4-H §5.1）。
//
// 一个会话一个文件：`stateDir()/ai-sessions/<id>.json`。
// - 目录 700、文件 600（与 config.json 同一套权限，会话里有用户问过的内容）。
// - 原子写：`.tmp` + rename（写一半断电不会留下半个 JSON）。
// - 同一会话的读-改-写走**写链**（按 id 串行），两个请求不会交错覆盖。
//
// 上限（卡片 §5.1）：
// - 单会话 messages ≤ 200 条、文件 ≤ 512 KB：超了从最旧的轮次裁剪，
//   保留最近 40 条，并在 `trimNote` 里写明（总结里能读到，不是静默丢数据）。
// - 会话总数 ≤ 100：超了删最久未更新且非当前的那一个。
//
// 路径用 `stateDir()` 现算（不是模块级常量）：测试通过
// `MAGPIE_TERMINAL_CONFIG_PATH` 指到临时目录时，ai-sessions/ 也跟着走。
// 会话文件绝不进仓库（`stateDir()` 在 ~/.config/magpie-terminal/）。

import crypto from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { stateDir } from "../config/store.mjs";

/** 会话目录名（在 stateDir 下）。 */
export const SESSIONS_DIR_NAME = "ai-sessions";

/** 单会话消息条数上限。 */
export const MAX_MESSAGES = 200;
/** 单会话文件字节上限。 */
export const MAX_SESSION_BYTES = 512 * 1024;
/** 裁剪时保留的最近消息条数。 */
export const TRIM_KEEP_MESSAGES = 40;
/** 单条消息正文上限（超了截断，否则 40 条也塞不满 512KB 的账）。 */
export const MESSAGE_TEXT_MAX = 4000;
/** 会话总数上限。 */
export const MAX_SESSIONS = 100;
/** 标题长度上限（重命名与自动取标题共用）。 */
export const TITLE_MAX = 80;
/** 自动标题取首条用户消息的前 N 个字。 */
export const TITLE_HEAD_CHARS = 24;

/** 合法的消息角色。 */
const ROLES = new Set(["user", "assistant", "tool"]);

/** 当前生效的会话目录。 */
export function sessionsDir() {
  return path.join(stateDir(), SESSIONS_DIR_NAME);
}

/** 生成 `s-1a2b3c` 形式的会话 id。 */
function newSessionId() {
  return `s-${crypto.randomBytes(4).toString("hex")}`;
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/** 标题：去空白、压成一行、截到 TITLE_MAX。 */
export function normalizeTitle(value) {
  const flat = text(value).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > TITLE_MAX ? flat.slice(0, TITLE_MAX) : flat;
}

/** 自动标题：首条用户消息前 24 字（卡片 §3 非目标：不做语义标题）。 */
export function titleFromQuestion(question) {
  const flat = text(question).replace(/\s+/g, " ").trim();
  if (!flat) return "新会话";
  return flat.length > TITLE_HEAD_CHARS ? `${flat.slice(0, TITLE_HEAD_CHARS)}…` : flat;
}

/** 会话摘要（列表用，不含全文）。 */
export function summarize(session, currentId) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    terminalId: session.terminalId,
    terminalKind: session.terminalKind,
    shell: session.shell,
    hostId: session.hostId,
    hostName: session.hostName,
    hostAddr: session.hostAddr,
    status: session.status,
    messageCount: messages.length,
    current: Boolean(currentId) && session.id === currentId,
  };
}

/** 把磁盘上的对象补成完整形状（旧文件缺字段也不崩）。 */
function normalizeSession(raw, id) {
  const source = raw && typeof raw === "object" ? raw : {};
  const now = Date.now();
  const messages = Array.isArray(source.messages)
    ? source.messages
        .filter((item) => item && typeof item === "object" && ROLES.has(item.role))
        .map((item, index) => ({
          role: item.role,
          text: text(item.text),
          at: Number.isFinite(item.at) ? item.at : now,
          reasoning: typeof item.reasoning === "string" && item.reasoning.length > 0 ? item.reasoning : null,
          round: Number.isFinite(item.round) ? item.round : index + 1,
        }))
    : [];
  const steps = Array.isArray(source.steps)
    ? source.steps
        .filter((item) => item && typeof item === "object" && typeof item.stepId === "string")
        .map((item, index) => ({
          stepId: item.stepId,
          command: text(item.command),
          decision: item.decision === "confirm" ? "confirm" : "auto",
          status: text(item.status, "pending"),
          output: text(item.output),
          startedAt: Number.isFinite(item.startedAt) ? item.startedAt : now,
          endedAt: Number.isFinite(item.endedAt) ? item.endedAt : null,
          round: Number.isFinite(item.round) ? item.round : index + 1,
        }))
    : [];
  return {
    id: typeof source.id === "string" && source.id.length > 0 ? source.id : id,
    title: normalizeTitle(source.title) || "新会话",
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : now,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : now,
    terminalId: text(source.terminalId),
    terminalKind: source.terminalKind === "remote" ? "remote" : "local",
    shell: text(source.shell),
    hostId: typeof source.hostId === "string" && source.hostId.length > 0 ? source.hostId : null,
    hostName: typeof source.hostName === "string" && source.hostName.length > 0 ? source.hostName : null,
    hostAddr: typeof source.hostAddr === "string" && source.hostAddr.length > 0 ? source.hostAddr : null,
    messages,
    steps,
    status: source.status === "stopped" ? "stopped" : "open",
    trimNote: typeof source.trimNote === "string" && source.trimNote.length > 0 ? source.trimNote : null,
  };
}

/** 文件字节数（用于 512 KB 判定）。 */
function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * 裁剪到上限：先砍最旧的消息（保留最近 40 条），再砍步骤输出与最旧的步骤。
 * 返回是否真的裁过。
 */
export function trimSession(session) {
  let trimmed = false;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (messages.length > MAX_MESSAGES) {
    session.messages = messages.slice(messages.length - TRIM_KEEP_MESSAGES);
    trimmed = true;
  }
  if (trimmed || byteLength(session) > MAX_SESSION_BYTES) {
    if (session.messages.length > TRIM_KEEP_MESSAGES) {
      session.messages = session.messages.slice(session.messages.length - TRIM_KEEP_MESSAGES);
      trimmed = true;
    }
    // 单条超长消息（贴进来一整个日志）先截断：不截的话 40 条也塞不进 512KB。
    for (const message of session.messages) {
      if (typeof message.text === "string" && message.text.length > MESSAGE_TEXT_MAX) {
        message.text = `${message.text.slice(0, MESSAGE_TEXT_MAX)}…（已截断）`;
        trimmed = true;
      }
      if (typeof message.reasoning === "string" && message.reasoning.length > MESSAGE_TEXT_MAX) {
        message.reasoning = `${message.reasoning.slice(0, MESSAGE_TEXT_MAX)}…（已截断）`;
        trimmed = true;
      }
    }
    // 步骤输出逐条收到 800 字符，仍超就只留最近 100 步。
    for (const step of session.steps) {
      if (typeof step.output === "string" && step.output.length > 800) {
        step.output = `${step.output.slice(0, 800)}…`;
        trimmed = true;
      }
    }
    if (session.steps.length > 100) {
      session.steps = session.steps.slice(session.steps.length - 100);
      trimmed = true;
    }
    // 还超就从最旧的开始丢（至少留 1 条，不然会话看起来是空的）。
    while (byteLength(session) > MAX_SESSION_BYTES && session.messages.length > 1) {
      session.messages.shift();
      trimmed = true;
    }
  }
  if (trimmed) {
    session.trimNote = `更早的对话已裁剪，只保留最近 ${TRIM_KEEP_MESSAGES} 条消息（文件上限 ${Math.round(
      MAX_SESSION_BYTES / 1024,
    )} KB）。`;
  }
  return trimmed;
}

/**
 * 创建会话存储。
 *
 * @param {object} [opts]
 * @param {string} [opts.dir] 覆盖目录（默认 sessionsDir()，测试用）
 * @param {(entry:object)=>void} [opts.log]
 * @param {()=>number} [opts.now] 仅供测试
 */
export function createSessionStore(opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const dirOverride = typeof opts.dir === "string" && opts.dir.length > 0 ? opts.dir : null;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  /** id -> Promise（写链，同一会话的读-改-写串行）。 */
  const chains = new Map();
  /** id -> true（正在跑的会话，删除时拒绝）。 */
  const busy = new Set();

  function dir() {
    return dirOverride || sessionsDir();
  }

  function fileOf(id) {
    return path.join(dir(), `${id}.json`);
  }

  async function ensureDir() {
    await mkdir(dir(), { recursive: true, mode: 0o700 });
  }

  /** 原子写：目录 700 → 临时文件 600 → rename。 */
  async function writeAtomic(target, value) {
    await ensureDir();
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    // Windows 上两个 rename 撞同一目标会拿到 EPERM（目标被另一个句柄占着），
    // 这是暂时状态（实测几十毫秒即消退），不能当成写失败丢掉用户数据。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, target);
        return;
      } catch (err) {
        const retriable =
          process.platform === "win32" && attempt < 12 && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
        if (!retriable) {
          await rm(tmp, { force: true });
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 15 + attempt * 10));
      }
    }
  }

  /** 同一会话串行（不同会话互不阻塞）。 */
  function withLock(id, fn) {
    const previous = chains.get(id) || Promise.resolve();
    const next = previous.then(fn, fn);
    // 链尾吞掉异常，避免一次失败把后续写全钉死。
    chains.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** 从磁盘读一个会话（不加锁，调用方决定）。 */
  async function readSession(id) {
    if (typeof id !== "string" || id.length === 0) return null;
    // 目录穿越防护：id 必须是 [A-Za-z0-9_-]。
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    let raw;
    try {
      raw = await readFile(fileOf(id), "utf8");
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log({ level: "warn", code: "SESSION_CORRUPT", msg: "ai session file is not json", sessionId: id });
      return null;
    }
    return normalizeSession(parsed, id);
  }

  /** 读-改-写：fn(session) 返回新 session 或假值表示不写。 */
  async function mutate(id, fn) {
    return withLock(id, async () => {
      const session = await readSession(id);
      if (!session) return null;
      const next = await fn(session);
      if (!next) return session;
      trimSession(next);
      next.updatedAt = now();
      await writeAtomic(fileOf(id), next);
      return next;
    });
  }

  /**
   * 建会话（不预建空记录是 UI 的事；这里被调用就一定落盘）。
   * @param {object} meta
   */
  async function createSession(meta = {}) {
    const createdAt = now();
    const session = normalizeSession(
      {
        id: newSessionId(),
        title: normalizeTitle(meta.title) || "新会话",
        createdAt,
        updatedAt: createdAt,
        terminalId: text(meta.terminalId),
        terminalKind: meta.terminalKind === "remote" ? "remote" : "local",
        shell: text(meta.shell),
        hostId: typeof meta.hostId === "string" && meta.hostId.length > 0 ? meta.hostId : null,
        hostName: typeof meta.hostName === "string" && meta.hostName.length > 0 ? meta.hostName : null,
        hostAddr: typeof meta.hostAddr === "string" && meta.hostAddr.length > 0 ? meta.hostAddr : null,
        messages: [],
        steps: [],
        status: "open",
      },
      "s-unknown",
    );
    await writeAtomic(fileOf(session.id), session);
    await prune({ keep: [session.id, text(meta.keepId)] });
    log({
      level: "info",
      code: "AI_SESSION_CREATED",
      msg: "ai session created",
      sessionId: session.id,
      terminalId: session.terminalId,
    });
    return session;
  }

  /** 会话总数 ≤ MAX_SESSIONS：删最久未更新的（keep 里的不动）。 */
  async function prune({ keep = [] } = {}) {
    const guard = new Set(keep.filter((id) => typeof id === "string" && id.length > 0));
    let entries;
    try {
      entries = await readdir(dir(), { withFileTypes: true });
    } catch {
      return 0;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
    if (files.length <= MAX_SESSIONS) return 0;
    const metas = [];
    for (const name of files) {
      const id = name.slice(0, -".json".length);
      if (guard.has(id)) continue;
      let info;
      try {
        info = await stat(path.join(dir(), name));
      } catch {
        continue;
      }
      metas.push({ id, updatedAt: info.mtimeMs });
    }
    metas.sort((a, b) => a.updatedAt - b.updatedAt);
    let removed = 0;
    let excess = files.length - MAX_SESSIONS;
    for (const meta of metas) {
      if (excess <= 0) break;
      try {
        await rm(fileOf(meta.id), { force: true });
        removed += 1;
        excess -= 1;
      } catch {
        // 忽略：下一个。
      }
    }
    if (removed > 0) {
      log({ level: "info", code: "AI_SESSION_PRUNED", msg: "oldest ai sessions removed", removed });
    }
    return removed;
  }

  /** 摘要列表（不返回全文）。按 updatedAt 倒序。 */
  async function listSessions({ currentId = null } = {}) {
    let entries;
    try {
      entries = await readdir(dir(), { withFileTypes: true });
    } catch {
      return [];
    }
    const ids = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length));
    const sessions = [];
    for (const id of ids) {
      const session = await readSession(id);
      if (session) sessions.push(session);
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions.map((session) => summarize(session, currentId));
  }

  /** 全文（含 steps）。 */
  async function getSession(id) {
    return readSession(id);
  }

  /** 该终端最近的会话（没有返回 null）。 */
  async function findByTerminal(terminalId) {
    if (typeof terminalId !== "string" || terminalId.length === 0) return null;
    const list = await listSessions({});
    const hits = list.filter((item) => item.terminalId === terminalId);
    if (hits.length === 0) return null;
    return readSession(hits[0].id);
  }

  /**
   * 追加一条消息。首条用户消息会把标题从「新会话」换成问题摘要。
   * @param {string} id
   * @param {{role:"user"|"assistant"|"tool", text:string, reasoning?:string|null, round?:number, at?:number}} message
   */
  async function appendMessage(id, message) {
    const input = message && typeof message === "object" ? message : {};
    const role = ROLES.has(input.role) ? input.role : "tool";
    return mutate(id, (session) => {
      const at = Number.isFinite(input.at) ? input.at : now();
      const round = Number.isFinite(input.round)
        ? input.round
        : session.messages.filter((item) => item.role === "user").length + (role === "user" ? 1 : 0);
      session.messages.push({
        role,
        text: text(input.text),
        at,
        reasoning:
          typeof input.reasoning === "string" && input.reasoning.length > 0 ? input.reasoning : null,
        round: round > 0 ? round : 1,
      });
      if (role === "user" && (session.title === "新会话" || session.title === "")) {
        session.title = titleFromQuestion(input.text);
      }
      return session;
    });
  }

  /**
   * 按 stepId upsert 一步（agent.step 的多次推送只留一条）。
   * @param {string} id
   * @param {{stepId:string, command?:string, decision?:"auto"|"confirm", status?:string,
   *          output?:string, startedAt?:number, endedAt?:number|null, round?:number}} step
   */
  async function upsertStep(id, step) {
    const input = step && typeof step === "object" ? step : {};
    if (typeof input.stepId !== "string" || input.stepId.length === 0) return null;
    return mutate(id, (session) => {
      const existing = session.steps.find((item) => item.stepId === input.stepId);
      if (existing) {
        if (typeof input.command === "string") existing.command = input.command;
        if (input.decision === "auto" || input.decision === "confirm") existing.decision = input.decision;
        if (typeof input.status === "string") existing.status = input.status;
        if (typeof input.output === "string") existing.output = input.output;
        if (Number.isFinite(input.endedAt)) existing.endedAt = input.endedAt;
        if (Number.isFinite(input.round)) existing.round = input.round;
        return session;
      }
      session.steps.push({
        stepId: input.stepId,
        command: text(input.command),
        decision: input.decision === "confirm" ? "confirm" : "auto",
        status: text(input.status, "pending"),
        output: text(input.output),
        startedAt: Number.isFinite(input.startedAt) ? input.startedAt : now(),
        endedAt: Number.isFinite(input.endedAt) ? input.endedAt : null,
        round: Number.isFinite(input.round) ? input.round : 1,
      });
      return session;
    });
  }

  /** 重命名（≤ TITLE_MAX）。 */
  async function renameSession(id, title) {
    const next = normalizeTitle(title);
    if (!next) return null;
    return mutate(id, (session) => {
      session.title = next;
      return session;
    });
  }

  /** 会话状态：open / stopped（AC12 的「已停止」）。 */
  async function setStatus(id, status) {
    const next = status === "stopped" ? "stopped" : "open";
    return mutate(id, (session) => {
      session.status = next;
      return session;
    });
  }

  /**
   * 删除。正在跑的会话拒绝（409 SESSION_BUSY，卡片 §5.4）。
   * @returns {Promise<{ok:boolean, code?:string, userText?:string}>}
   */
  async function deleteSession(id) {
    if (busy.has(id)) {
      return { ok: false, code: "SESSION_BUSY", userText: "这个会话还在跑，先停掉再删。" };
    }
    return withLock(id, async () => {
      if (busy.has(id)) {
        return { ok: false, code: "SESSION_BUSY", userText: "这个会话还在跑，先停掉再删。" };
      }
      const session = await readSession(id);
      if (!session) return { ok: false, code: "SESSION_NOT_FOUND", userText: "没有这个会话。" };
      await rm(fileOf(id), { force: true });
      log({ level: "info", code: "AI_SESSION_DELETED", msg: "ai session deleted", sessionId: id });
      return { ok: true };
    });
  }

  /** 标记 / 解除「正在跑」（删除时拒绝）。 */
  function markBusy(id, value) {
    if (typeof id !== "string" || id.length === 0) return;
    if (value) busy.add(id);
    else busy.delete(id);
  }

  function isBusy(id) {
    return busy.has(id);
  }

  /** 仅供测试：等所有写链落盘。 */
  async function flush() {
    await Promise.all([...chains.values()]);
  }

  return {
    dir,
    createSession,
    listSessions,
    getSession,
    findByTerminal,
    appendMessage,
    upsertStep,
    renameSession,
    setStatus,
    deleteSession,
    markBusy,
    isBusy,
    prune,
    flush,
  };
}
