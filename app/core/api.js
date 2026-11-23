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

/** DELETE 没有响应体，单独走一条。 */
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
  if (response.status === 204) return { ok: true, data: null };
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
};
