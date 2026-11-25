// /api/* 的薄封装：口令走请求头（`x-magpie-term-token`），非 2xx 统一成可展示错误。
//
// 不用 cookie：插件页在沙箱 iframe（opaque origin）里，`document.cookie` 抛
// SecurityError，跨源请求也不会带我们的 cookie。口令来自注入的 <meta>，
// 见 app/core/token.js。

import { readToken } from "./token.js";

const apiError = (code, userText, extra) => ({ ok: false, code, userText, ...extra });
async function getJson(path) {
  let response;
  try {
    response = await fetch(path, {
      method: "GET",
      // credentials 必须是 omit：这里既没有也不该有 cookie 可用。
      credentials: "omit",
      headers: {
        accept: "application/json",
        "x-magpie-term-token": readToken(),
      },
    });
  } catch (err) {
    return apiError("NETWORK", `连不上本地服务：${err && err.message ? err.message : "网络错误"}`);
  }
  if (!response.ok) {
    // 服务端对所有错误都回 `{code, userText}`（中文人话）。这里必须把它透出去：
    // 丢掉的话前端只能显示「HTTP 413」，而 413 的含义是「文件太大」——
    // 用户看不到原因（TASK-V4-G AC6 要求提示「文件太大」/「不是文本」）。
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (body && typeof body.code === "string") {
      return apiError(
        body.code,
        typeof body.userText === "string" ? body.userText : `本地服务返回 HTTP ${response.status}，请重试。`,
      );
    }
    return apiError(`HTTP_${response.status}`, `本地服务返回 HTTP ${response.status}，请重试。`);
  }
  try {
    return { ok: true, data: await response.json() };
  } catch {
    return apiError("BAD_JSON", "本地服务返回了无法解析的内容。");
  }
}

async function sendJson(path, method, payload) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "omit",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-magpie-term-token": readToken(),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return apiError("NETWORK", `连不上本地服务：${err && err.message ? err.message : "网络错误"}`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = body && typeof body.code === "string" ? body.code : `HTTP_${response.status}`;
    const userText =
      body && typeof body.userText === "string"
        ? body.userText
        : `本地服务返回 HTTP ${response.status}，请重试。`;
    // 把服务端附带的诊断字段（指纹之类）一并透出，前端卡片要显示新旧指纹。
    const extra = {};
    if (body && typeof body === "object") {
      for (const key of ["algo", "fingerprint", "knownFingerprint", "knownAlgo"]) {
        if (typeof body[key] === "string") extra[key] = body[key];
      }
    }
    return { ok: false, code, userText, ...extra };
  }
  return { ok: true, data: body };
}

/** DELETE 的响应体不固定：/api/fs 回 200 + JSON，主机/会话删除回 204。 */
async function del(path) {
  let response;
  try {
    response = await fetch(path, {
      method: "DELETE",
      credentials: "omit",
      headers: { accept: "application/json", "x-magpie-term-token": readToken() },
    });
  } catch (err) {
    return apiError("NETWORK", `连不上本地服务：${err && err.message ? err.message : "网络错误"}`);
  }
  // 任何 2xx 都是成功：204 没有响应体（主机/会话删除），200 带 JSON
  // （文件面板的 DELETE /api/fs，返回 {path,type}）。只看 204 会把已经删掉
  // 的文件报成「HTTP 200，请重试」并保留旧条目（TASK-FIX-ACCEPT A）。
  if (response.ok) {
    if (response.status === 204) return { ok: true, data: null };
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: true, data: body };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = body && typeof body.code === "string" ? body.code : `HTTP_${response.status}`;
  const userText =
    body && typeof body.userText === "string"
      ? body.userText
      : `本地服务返回 HTTP ${response.status}，请重试。`;
  return { ok: false, code, userText };
}

/** 原始 body（非 JSON）写盘：文件面板的 PUT /api/fs/write 用它。 */
async function putRaw(url, text) {
  let response;
  try {
    response = await fetch(url, {
      method: "PUT",
      credentials: "omit",
      headers: { "x-magpie-term-token": readToken(), "content-type": "text/plain; charset=utf-8" },
      body: text,
    });
  } catch (err) {
    return apiError("NETWORK", `连不上本地服务：${err && err.message ? err.message : "网络错误"}`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return apiError(
      body && typeof body.code === "string" ? body.code : `HTTP_${response.status}`,
      body && typeof body.userText === "string"
        ? body.userText
        : `本地服务返回 HTTP ${response.status}，请重试。`,
    );
  }
  return { ok: true, data: body };
}

/**
 * 文件接口的路径前缀：`target` 为 null 走本地 `/api/fs`，
 * 否则是远程主机的 `/api/hosts/:id/fs`（同名同形）。
 */
function fsEndpoint(target, action, params = {}) {
  const base =
    target && typeof target.hostId === "string"
      ? `/api/hosts/${encodeURIComponent(target.hostId)}/fs`
      : "/api/fs";
  const path = action ? `${base}/${action}` : base;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

export default {
  health() {
    return getJson("/api/health");
  },
  policy() {
    return getJson("/api/policy");
  },
  /** GET /api/models：网关可达性 + 模型清单 + 默认模型。 */
  models() {
    return getJson("/api/models");
  },
  /** GET /api/config：当前偏好（本卡只有 model）。 */
  config() {
    return getJson("/api/config");
  },
  /** PUT /api/config：只提交已知字段；失败返回可展示错误。 */
  saveConfig(patch) {
    return sendJson("/api/config", "PUT", patch);
  },
  /** GET /api/shells：本机可用 shell 清单 + 生效的默认 shell（TASK-V4-F）。 */
  shells() {
    return getJson("/api/shells");
  },

  /**
   * GET /api/version（TASK-FIX17-G R1）：
   * `{version, name, repository, installKind, updateSupported}`。
   * `repository` 是归一后的 https 地址，没配置时为 null。
   */
  version() {
    return getJson("/api/version");
  },
  /**
   * GET /api/update/check（TASK-FIX17-G R1/R3）：
   * `{current, latest, hasUpdate, url, note?}`，失败时是
   * `{hasUpdate:false, error:"<人话>"}`（HTTP 仍是 200，不是异常）。
   */
  updateCheck() {
    return getJson("/api/update/check");
  },
  /**
   * GET /api/theme：当前主题（TASK-FIX17-B R1）。
   *
   * 返回 `{ scheme, theme, source, textSize, lang, tokens, settingsOk, settingsReason }`，
   * `tokens` 的键全部是 `--magpie-*` 形态。
   *
   * `prefer` 是浏览器自己看到的系统深浅色（`matchMedia`）：magpie 的
   * `theme: "system"` 语义就是「跟随操作系统」，而服务端是普通进程看不到
   * 操作系统的当前配色，只能由页面告诉它。
   *
   * @param {"dark"|"light"|null} [prefer]
   */
  theme(prefer) {
    const query = prefer === "dark" || prefer === "light" ? `?prefer=${prefer}` : "";
    return getJson(`/api/theme${query}`);
  },
  /**
   * POST /api/theme/bridge：把 bridge 令牌交给服务端缓存。
   *
   * 带路页发不了这个请求（CSP `default-src 'none'`），所以正常链路里不会走到；
   * 保留它是因为 `app` 页在普通浏览器里打开时可以用它手工注入一套主题（验收 / 排查）。
   */
  pushTheme(tokens, dark) {
    return sendJson("/api/theme/bridge", "POST", { tokens, dark });
  },

  /**
   * 日志（TASK-FIX17-E R4）。
   *
   * `logsExport()` 返回原始 `Response` 而不是 JSON：导出的是纯文本附件，
   * `content-disposition` 里的文件名只有调用方（`<a download>`）用得上。
   * 交由 UI 判 `ok` / 取 blob，不在这一层猜。
   */
  logsStatus() {
    return getJson("/api/logs/status");
  },
  /** DELETE /api/logs -> {ok, cleared} */
  logsClear() {
    return del("/api/logs");
  },
  /**
   * GET /api/logs/export：返回 `{ok, response, filename}` / `{ok:false, code, userText}`。
   *
   * 为什么不直接在这里 `createObjectURL`：触发下载要用到 DOM，而 api.js
   * 在单测里是裸 Node（只有 `document.querySelector` 桩），把 DOM 操作留在 UI 层
   * 才能让这一层保持可单测。
   */
  async logsExport() {
    let response;
    try {
      response = await fetch("/api/logs/export", {
        method: "GET",
        credentials: "omit",
        headers: { accept: "text/plain", "x-magpie-term-token": readToken() },
      });
    } catch (err) {
      return apiError("NETWORK", `连不上本地服务：${err && err.message ? err.message : "网络错误"}`);
    }
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return apiError(
        body && typeof body.code === "string" ? body.code : `HTTP_${response.status}`,
        body && typeof body.userText === "string"
          ? body.userText
          : `本地服务返回 HTTP ${response.status}，请重试。`,
      );
    }
    const disposition = response.headers.get("content-disposition") || "";
    const match = /filename="?([^";]+)"?/.exec(disposition);
    return {
      ok: true,
      response,
      filename: match ? match[1] : "show-terminal-logs.log",
    };
  },

  /* ---- AI 会话（TASK-V4-H §5.4） ---- */

  /** GET /api/ai/sessions?current=<id> -> { sessions } */
  aiSessions(currentId) {
    const query = currentId ? `?current=${encodeURIComponent(currentId)}` : "";
    return getJson(`/api/ai/sessions${query}`);
  },
  /** GET /api/ai/sessions/:id -> 全文（含 messages / steps） */
  aiSession(id) {
    return getJson(`/api/ai/sessions/${encodeURIComponent(id)}`);
  },
  /** PATCH /api/ai/sessions/:id {title} */
  renameAiSession(id, title) {
    return sendJson(`/api/ai/sessions/${encodeURIComponent(id)}`, "PATCH", { title });
  },
  /** DELETE /api/ai/sessions/:id（忙会话 409 SESSION_BUSY） */
  deleteAiSession(id) {
    return del(`/api/ai/sessions/${encodeURIComponent(id)}`);
  },

  /* ---- 主机（TASK-V2-B §2.5） ---- */

  /** GET /api/hosts -> { hosts } */
  hosts() {
    return getJson("/api/hosts");
  },
  /** POST /api/hosts -> 201 { host } */
  createHost(payload) {
    return sendJson("/api/hosts", "POST", payload);
  },
  /** PUT /api/hosts/:id */
  updateHost(id, payload) {
    return sendJson(`/api/hosts/${encodeURIComponent(id)}`, "PUT", payload);
  },
  /** DELETE /api/hosts/:id -> 204 */
  deleteHost(id) {
    return del(`/api/hosts/${encodeURIComponent(id)}`);
  },
  /** POST /api/hosts/:id/test（失败也是 200 {ok:false, code, userText}） */
  testHost(id) {
    return sendJson(`/api/hosts/${encodeURIComponent(id)}/test`, "POST", {});
  },
  /** GET /api/hosts/:id/fingerprint -> { algo, fingerprint, known } */
  hostFingerprint(id) {
    return getJson(`/api/hosts/${encodeURIComponent(id)}/fingerprint`);
  },
  /** POST /api/hosts/:id/trust -> { algo, fingerprint, known:true } */
  trustHost(id, fingerprint) {
    return sendJson(`/api/hosts/${encodeURIComponent(id)}/trust`, "POST", { fingerprint });
  },
  /** GET /api/hosts/:id/files?path=… -> { path, entries } */
  hostFiles(id, remotePath) {
    const query = new URLSearchParams({ path: remotePath || "." });
    return getJson(`/api/hosts/${encodeURIComponent(id)}/files?${query.toString()}`);
  },

  /* ---- 文件面板（TASK-V4-G §5.3 / §5.4）：本地用 /api/fs，远程用 /api/hosts/:id/fs ---- */

  /** 列表：{ path, parent, entries } */
  fsList(target, path) {
    return getJson(fsEndpoint(target, "list", { path }));
  },
  /** 读文本：{ path, content, size, mtime }（413 FILE_TOO_LARGE / 415 NOT_TEXT） */
  fsRead(target, path) {
    return getJson(fsEndpoint(target, "read", { path }));
  },
  fsStat(target, path) {
    return getJson(fsEndpoint(target, "stat", { path }));
  },
  fsMkdir(target, path) {
    return sendJson(fsEndpoint(target, "mkdir"), "POST", { path });
  },
  fsNewFile(target, path) {
    return sendJson(fsEndpoint(target, "newfile"), "POST", { path });
  },
  fsRename(target, from, to) {
    return sendJson(fsEndpoint(target, "rename"), "POST", { from, to });
  },
  /**
   * 批量移动（TASK-FIX17-C R3）：`POST /api/fs/move`。
   *
   * 服务端**逐项独立**执行，状态码固定 200，失败明细在 `data.failed` 里
   * （`{from,to,code,userText}`）。调用方必须自己检查 `failed`，不能只看 `ok`。
   *
   * `overwrite` 默认 false（不覆盖任何已存在的目标）—— 本批 UI 永远不传 true。
   *
   * @param {Array<{from:string,to:string}>} items
   * @param {{hostId?:string}|null} [target]
   * @param {{overwrite?:boolean}} [opts]
   */
  fsMove(target, items, opts = {}) {
    const payload = { items };
    if (opts.overwrite === true) payload.overwrite = true;
    return sendJson(fsEndpoint(target, "move"), "POST", payload);
  },
  /** 写文本（原始 body，不是 JSON）。 */
  fsWrite(target, path, text) {
    return putRaw(fsEndpoint(target, "write", { path }), text);
  },
  /** 删除；递归只在本地用得上（远程只允许空目录）。 */
  fsDelete(target, path, recursive) {
    const endpoint = fsEndpoint(target, "", { path, recursive: recursive ? "1" : "0" });
    return del(endpoint);
  },
  /** 下载地址（调用方自己 fetch + blob，口令走请求头，不能裸链）。 */
  fsDownloadUrl(target, path) {
    return fsEndpoint(target, "download", { path });
  },
  /** 上传用的地址与口令（XHR 自己发，才能拿 progress 事件）。 */
  fsUploadEndpoint(target, dir) {
    return { url: fsEndpoint(target, "upload", { path: dir }), token: readToken() };
  },
  /** 鉴权头（下载 / 上传都自己发请求）。 */
  fsAuthHeader() {
    return { "x-magpie-term-token": readToken() };
  },
};
