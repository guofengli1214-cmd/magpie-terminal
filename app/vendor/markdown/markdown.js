// AI 消息的 markdown 渲染（TASK-FIX17-D R5，问题 12）。
//
// 三段：
//   marked.parse(text)        → 原始 HTML（库在 /vendor/markdown/marked.umd.js，MIT）
//   DOMPurify.sanitize(html)  → 清洗后的 HTML（/vendor/markdown/purify.min.js，Apache-2.0 OR MPL-2.0）
//   危险形态闸门（本文件）     → 清洗后仍出现 <script> / on* / javascript: 就**整条拒绝**
//
// 为什么第三段是「拒绝」而不是「再清洗一次」：
// 字符串级清洗（正则替换 HTML）永远洗不干净 —— 那是自己写解析器的开始，也正是本卡
// 明确禁止的事。反过来，**拒绝**是安全的：调用方拿到 null 就退回纯文本（用户仍然
// 看得见 AI 说了什么，只是没有排版）。所以这里是 fail-closed，兜的是「清洗库被绕过
// 或版本回归」这一种情形，而不是替代清洗库。
//
// 本文件不碰 DOM，也不在模块顶层访问全局：`globalThis.marked` / `globalThis.DOMPurify`
// 由 index.html 的两个普通 <script> 在 app.js 之前装好（见 VERSION.md）。
// 两者任一缺失（离线文件没落地 / node --test 里没有 DOM）→ 返回 null，调用方降级成纯文本。

/** 允许的标签：R5 要求的语法集合 + 表格/引用/分隔线。**不含 img / script / iframe / svg**。 */
export const ALLOWED_TAGS = Object.freeze([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "a",
  "span",
]);

/** 允许的属性：没有 `style`、没有任何 `on*`。 */
export const ALLOWED_ATTR = Object.freeze(["href", "title", "class", "target", "rel"]);

/**
 * DOMPurify 的配置。
 *
 * `FORBID_TAGS` / `FORBID_ATTR` 与 `ALLOWED_*` 重复了一遍是刻意的：
 * DOMPurify 的 `ALLOWED_TAGS` 已经把其它标签全删了，但若将来有人往
 * ALLOWED_TAGS 里加了 img，`FORBID_ATTR: ["onerror", …]` 还能挡住
 * `<img onerror=…>` 这一半。两道闸都在数据里，不靠注释约束。
 */
export const SANITIZE_CONFIG = Object.freeze({
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "svg", "math", "form", "img", "base", "link", "meta"],
  FORBID_ATTR: ["style", "srcset", "formaction", "onerror", "onload", "onclick", "onmouseover", "onfocus"],
  // 链接一律新窗口打开，且不带 opener：AI 回复里的链接不能反向控制本页。
  ADD_ATTR: ["target", "rel"],
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
});

/** 清洗后仍不许出现的标签（fail-closed 闸门）。 */
const DANGEROUS_TAG = /<\s*\/?\s*(script|iframe|object|embed|svg|math|form|style|base|link|meta|img)\b/i;

/** 清洗后仍不许出现的事件属性（`onerror=` / `onload=` …）。 */
// 只看真正被解析成标签的形态：代码块里的 `onclick=` 文本会被 marked 转义成
// `&lt;button …`，不会命中这个正则（否则「AI 讲了一段 HTML」就会整条降级）。
const DANGEROUS_ATTR = /<\s*[a-z][a-z0-9-]*\b[^>]*?\son[a-z]+\s*=/i;

/** 清洗后仍不许出现的脚本 URL。 */
const DANGEROUS_URL = /\b(?:href|src|action|formaction|poster)\s*=\s*["']?\s*(?:javascript|vbscript|data\s*:\s*text\/html)/i;

/** 链接一律 target=_blank + rel=noopener noreferrer（AC9/R5）。 */
const LINK_ATTRS = ' target="_blank" rel="noopener noreferrer"';

/**
 * marked 的 link renderer：给每个 `<a>` 补 target/rel。
 *
 * 为什么在 renderer 里补而不是 sanitize 之后用 DOM 改：sanitize 之后拿到的
 * 是字符串，改它就得再解析一次 HTML（等于自己写解析器）；renderer 拿到的
 * 是结构化参数，注入属性最安全。href 本身**不在这里判**——那是 DOMPurify
 * 的 URI 策略负责的事，判两次容易出现「一处放过、一处拦掉」的分歧。
 *
 * @param {object} markedLib `globalThis.marked`
 * @returns {object|undefined} 传给 `marked.parse` 的 renderer
 */
export function createLinkRenderer(markedLib) {
  if (!markedLib || typeof markedLib.Renderer !== "function") return undefined;
  const renderer = new markedLib.Renderer();
  const baseLink = typeof renderer.link === "function" ? renderer.link.bind(renderer) : null;
  if (!baseLink) return undefined;
  renderer.link = function link(href, title, text) {
    const html = baseLink(href, title, text);
    if (typeof html !== "string" || !html.includes("<a")) return html;
    // `<a href=…` → `<a target=… rel=… href=…`：属性顺序无所谓，只要求插在标签内。
    return html.replace(/<a\s/i, `<a${LINK_ATTRS} `);
  };
  return renderer;
}

/** 清洗后的 HTML 里是否还有必须拒绝的形态。 */
export function isDangerousHtml(html) {
  if (typeof html !== "string") return true;
  return DANGEROUS_TAG.test(html) || DANGEROUS_ATTR.test(html) || DANGEROUS_URL.test(html);
}

/**
 * markdown 文本 → 可安全插入的 HTML。
 *
 * @param {string} text AI 回复的原始文本（markdown）
 * @param {{marked?: object, purify?: object}} [deps] 测试注入用；缺省读 globalThis
 * @returns {string|null} 安全 HTML；不可用时 null（调用方必须降级成纯文本）
 */
export function renderMarkdown(text, deps = {}) {
  const source = typeof text === "string" ? text : "";
  if (source.trim().length === 0) return null;
  const markedLib = deps.marked || globalThis.marked;
  const purifyLib = deps.purify || globalThis.DOMPurify;
  if (!markedLib || typeof markedLib.parse !== "function") return null;
  if (!purifyLib || typeof purifyLib.sanitize !== "function") return null;
  let raw;
  try {
    raw = markedLib.parse(source, {
      gfm: true,
      breaks: true,
      async: false,
      renderer: createLinkRenderer(markedLib),
    });
  } catch (err) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[markdown] marked.parse 失败，降级纯文本", err);
    }
    return null;
  }
  if (typeof raw !== "string" || raw.length === 0) return null;
  let clean;
  try {
    clean = purifyLib.sanitize(raw, SANITIZE_CONFIG);
  } catch (err) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[markdown] DOMPurify.sanitize 失败，降级纯文本", err);
    }
    return null;
  }
  if (typeof clean !== "string" || clean.length === 0) return null;
  if (isDangerousHtml(clean)) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[markdown] 清洗后仍有危险形态，整条降级纯文本");
    }
    return null;
  }
  return clean;
}

export default renderMarkdown;
