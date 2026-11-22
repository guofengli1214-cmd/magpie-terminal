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

export default {
  health() {
    return getJson("/api/health");
  },
  policy() {
    return getJson("/api/policy");
  },
};
