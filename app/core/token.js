// 从服务端注入的 <meta> 读口令。
//
// 为什么不是 cookie：magpie 把插件页放进 `<iframe sandbox="allow-scripts">`，
// 文档是 opaque origin，该环境下 `document.cookie = …` 会抛 SecurityError，
// 而且跨源请求不会带我们的 cookie。同理 localStorage / sessionStorage 也会抛
// SecurityError —— 这个模块（以及整个 app/）都不得依赖它们。
//
// 口令由服务端在返回 app/index.html 时替换成
// `<meta name="magpie-term-token" content="<64 位 hex>">`。

const META_SELECTOR = 'meta[name="magpie-term-token"]';

let cached;

/**
 * 读取口令。取不到时返回空字符串（调用方会用 403 暴露问题，而不是这里抛错）。
 * @returns {string}
 */
export function readToken() {
  if (typeof cached === "string") return cached;
  try {
    const el = document.querySelector(META_SELECTOR);
    const value = el && typeof el.getAttribute("content") === "string" ? el.getAttribute("content").trim() : "";
    cached = value;
    return cached;
  } catch {
    // 极端情况下（文档还没解析完）也不抛：让请求自己 403。
    return "";
  }
}

export default readToken;
