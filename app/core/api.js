// /api/* 的薄封装：同源 cookie 自动携带，非 2xx 统一成可展示错误。

const apiError = (code, userText, extra) => ({ ok: false, code, userText, ...extra });

async function getJson(path) {
  let response;
  try {
    response = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
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
