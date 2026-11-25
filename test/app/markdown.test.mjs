// TASK-FIX17-D R5：markdown 渲染管线的单测（node --test，不起浏览器）。
//
// 覆盖范围与分工（重要，别把两层混成一层）：
//
//   本文件（node --test，无 DOM）：
//     * marked 真的解析出了 markdown 结构（标题/粗体/行内代码/围栏块/列表/表格/链接）
//     * **清洗契约**：SANITIZE_CONFIG 的白名单里没有 img/script/iframe/svg，
//       属性白名单里没有任何 on*；
//     * **本项目的 fail-closed 闸门**：即使 DOMPurify 被绕过 / 版本回归 / 配置写错，
//       只要清洗后的 HTML 里还有 script 标签、on* 属性或 javascript: URL，
//       renderMarkdown 就返回 null（调用方降级成纯文本，绝不插入危险 HTML）。
//     * 库缺失、marked 抛错、sanitize 抛错 → 返回 null（降级），不抛异常。
//
//   scripts/probe-drawer.mjs（真浏览器 + 真 DOMPurify）：
//     * AC9 的三个 XSS 载荷真的进了 DOM 之后 `<img>` 不存在、`on*` 属性不存在、
//       href 不含 `javascript:`、`<script>` 被剥离、alert 没被调用。
//       —— 只有真 DOM 能证明「真的剥掉了」，Node 里没有 DOM 可以做这件事。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

// 真实的 marked UMD（纯 JS，不依赖 DOM）。它执行时挂到 globalThis.marked。
// 注：Windows 下 ESM 的 `import()` 不接盘绝对路径（会当成 `c:` 协议），必须转 file:// URL。
await import(pathToFileURL(path.join(REPO, "app", "vendor", "markdown", "marked.umd.js")).href);

const {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  SANITIZE_CONFIG,
  createLinkRenderer,
  isDangerousHtml,
  renderMarkdown,
} = await import("../../app/vendor/markdown/markdown.js");

/**
 * 直通式「清洗器」替身：原样返回 marked 的输出。
 *
 * 为什么需要它：Node 里没有 DOM，真 DOMPurify 的 isSupported 是 false。
 * 这个替身让本文件能测「本项目自己那一道闸门」——如果 marked 产出危险 HTML，
 * 闸门必须拒绝（返回 null）。危险形态能不能被 DOMPurify 洗掉，由浏览器探针证。
 */
const passthroughPurify = { sanitize: (html) => html };

/** 真 marked + 直通清洗器：用来观察 marked 到底解析出了什么结构。 */
function renderRaw(markdown) {
  return renderMarkdown(markdown, { marked: globalThis.marked, purify: passthroughPurify });
}

/* ---------------------------------------------------------------- marked 结构 */

const SAMPLE = [
  "### 小结",
  "",
  "**粗体** 与 `inline()` 与 *斜体*。",
  "",
  "```bash",
  "git status --short",
  "```",
  "",
  "- 一",
  "- 二",
  "",
  "> 引用",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "详见 [文档](https://example.com/doc)。",
  "",
  "---",
].join("\n");

test("R5：marked 解析出标题/粗体/行内代码/围栏代码块/列表/引用/表格/链接/分隔线", () => {
  const html = renderRaw(SAMPLE);
  assert.equal(typeof html, "string", "渲染结果必须是字符串");
  for (const [tag, re] of [
    ["h3", /<h3>/],
    ["strong", /<strong>/],
    ["em", /<em>/],
    ["行内 code", /<code>inline\(\)<\/code>/],
    ["pre", /<pre>/],
    ["带语言标签的代码块", /<code class="language-bash">/],
    ["ul/li", /<ul>[\s\S]*<li>一<\/li>/],
    ["blockquote", /<blockquote>/],
    ["table", /<table>/],
    ["th", /<th>a<\/th>/],
    ["td", /<td>1<\/td>/],
    ["a", /<a [^>]*href="https:\/\/example\.com\/doc"/],
    ["hr", /<hr>/],
  ]) {
    assert.match(html, re, `缺少 ${tag}：${html.slice(0, 200)}`);
  }
});

test("R5：代码块里的内容被转义（< > & 不会变成真标签）", () => {
  const html = renderRaw("```html\n<b>x</b> && y\n```");
  assert.ok(html.includes("&lt;b&gt;"), "代码里的 < 必须被转义");
  assert.ok(!html.includes("<b>x</b>"), "代码里的标签不能被当 HTML 解析");
});

test("R5：链接强制 target=_blank + rel=noopener noreferrer", () => {
  const renderer = createLinkRenderer(globalThis.marked);
  assert.ok(renderer, "必须能造出 link renderer");
  const html = renderMarkdown("[x](https://a.example)", {
    marked: globalThis.marked,
    purify: passthroughPurify,
  });
  assert.match(html, /<a [^>]*target="_blank"/);
  assert.match(html, /<a [^>]*rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/a\.example"/);
});

/* ---------------------------------------------------------------- 清洗契约 */

test("R5：白名单里没有 img / script / iframe / svg 这类可执行或外链取图的标签", () => {
  for (const forbidden of ["img", "script", "iframe", "object", "embed", "svg", "math", "form", "style"]) {
    assert.equal(ALLOWED_TAGS.includes(forbidden), false, `ALLOWED_TAGS 不该包含 ${forbidden}`);
    assert.ok(SANITIZE_CONFIG.FORBID_TAGS.includes(forbidden), `FORBID_TAGS 必须显式挡 ${forbidden}`);
  }
});

test("R5：属性白名单里没有任何 on* / style", () => {
  for (const attr of ALLOWED_ATTR) {
    assert.equal(/^on/i.test(attr), false, `属性白名单里不许有事件属性：${attr}`);
    assert.notEqual(attr, "style", "style 会打开 CSS 注入面");
  }
  assert.ok(ALLOWED_ATTR.includes("href"));
  assert.ok(ALLOWED_ATTR.includes("target"));
  assert.ok(ALLOWED_ATTR.includes("rel"));
});

/* ---------------------------------------------------------------- fail-closed 闸门 */

test("R5：清洗后仍有 <script> → 整条拒绝（返回 null）", () => {
  assert.equal(isDangerousHtml('<p>ok</p><script>alert(1)</script>'), true);
  assert.equal(renderRaw("<script>alert(1)</script> 后面的正文"), null);
});

test("R5：清洗后仍有 on* 属性 → 整条拒绝（返回 null）", () => {
  assert.equal(isDangerousHtml('<p><img src=x onerror="alert(1)"></p>'), true);
  assert.equal(isDangerousHtml('<a href="#" onclick="x()">y</a>'), true);
  assert.equal(renderRaw('看图：<img src=x onerror="alert(1)">'), null);
});

test("R5：清洗后仍有 javascript: / vbscript: / data:text/html → 整条拒绝（返回 null）", () => {
  assert.equal(isDangerousHtml('<a href="javascript:alert(1)">x</a>'), true);
  assert.equal(isDangerousHtml('<a href="vbscript:msgbox(1)">x</a>'), true);
  assert.equal(isDangerousHtml('<iframe src="data:text/html,<script>x</script>"></iframe>'), true);
  assert.equal(renderRaw("[点我](javascript:alert(1))"), null);
});

test("R5：代码块里的 on* / <script> 文本（已被 marked 转义）不会被误判成危险", () => {
  // 这段是「AI 讲了一段 HTML」的典型内容：尖括号被转义成实体，
  // 属性名只是正文文字，不是真正的标签属性 —— 不能因此把整条消息降级成纯文本。
  const html = renderRaw('```html\n<button onclick="go()">x</button>\n```');
  assert.equal(typeof html, "string", "代码块里的 onclick= 不该触发闸门");
  assert.equal(isDangerousHtml(html), false);
  assert.ok(html.includes("onclick=&quot;go()&quot;") || html.includes("onclick=&#39;") || html.includes("onclick="));
  assert.ok(!html.includes("<button"), "代码里的 <button 必须转义成实体");
});

test("R5：正常的 markdown（含表格与链接）不会被闸门挡住", () => {
  const html = renderRaw(SAMPLE);
  assert.equal(typeof html, "string");
  assert.equal(isDangerousHtml(html), false);
});

/* ---------------------------------------------------------------- 降级路径 */

test("R5：marked 缺失 → 返回 null（调用方降级成纯文本），不抛异常", () => {
  // 直接摘掉全局再看：这才是「离线文件没落地」的真实形态（deps 参数是测试专用口）。
  const saved = globalThis.marked;
  try {
    delete globalThis.marked;
    assert.equal(renderMarkdown("**x**", { purify: passthroughPurify }), null);
  } finally {
    globalThis.marked = saved;
  }
});

test("R5：DOMPurify 缺失 → 返回 null（宁可纯文本也不插未清洗的 HTML）", () => {
  const saved = globalThis.DOMPurify;
  try {
    delete globalThis.DOMPurify;
    assert.equal(renderMarkdown("**x**", { marked: globalThis.marked }), null);
  } finally {
    if (saved !== undefined) globalThis.DOMPurify = saved;
  }
});

test("R5：marked.parse 抛错 → 返回 null 并 console.warn，不抛异常", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const result = renderMarkdown("**x**", {
      marked: {
        parse: () => {
          throw new Error("boom");
        },
        Renderer: globalThis.marked.Renderer,
      },
      purify: passthroughPurify,
    });
    assert.equal(result, null);
    assert.ok(warnings.some((args) => String(args[0]).includes("marked.parse")), "必须 warn 一句");
  } finally {
    console.warn = originalWarn;
  }
});

test("R5：DOMPurify.sanitize 抛错 → 返回 null 并 console.warn，不抛异常", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const result = renderMarkdown("**x**", {
      marked: globalThis.marked,
      purify: {
        sanitize: () => {
          throw new Error("purify boom");
        },
      },
    });
    assert.equal(result, null);
    assert.ok(warnings.some((args) => String(args[0]).includes("DOMPurify")), "必须 warn 一句");
  } finally {
    console.warn = originalWarn;
  }
});

test("R5：空文本 / 非字符串 → 返回 null（没什么可渲染的）", () => {
  assert.equal(renderMarkdown(""), null);
  assert.equal(renderMarkdown("   \n  "), null);
  assert.equal(renderMarkdown(null), null);
  assert.equal(renderMarkdown(undefined), null);
});

/* ---------------------------------------------------------------- 接线 */

test("R5：app/index.html 用普通 script 引入两个 vendor 文件，且排在 app.js 之前", async () => {
  const html = await readFile(path.join(REPO, "app", "index.html"), "utf8");
  const markedAt = html.indexOf('<script src="/vendor/markdown/marked.umd.js"></script>');
  const purifyAt = html.indexOf('<script src="/vendor/markdown/purify.min.js"></script>');
  const appAt = html.indexOf('<script type="module" src="/app.js"></script>');
  assert.ok(markedAt > 0, "必须引入 marked.umd.js");
  assert.ok(purifyAt > 0, "必须引入 purify.min.js");
  assert.ok(appAt > 0, "app.js 入口不能丢");
  assert.ok(markedAt < appAt && purifyAt < appAt, "vendor 库必须排在 app.js 之前（同步脚本先执行）");
  assert.ok(
    markedAt < purifyAt,
    "顺序：marked → DOMPurify（与 VERSION.md 的说明一致）",
  );
});

test("R5：ai-drawer.js 只在总结落地后渲染 markdown（流式分支保持 textContent）", async () => {
  const source = await readFile(path.join(REPO, "app", "ui", "ai-drawer.js"), "utf8");
  const codeLines = source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  // 每一处 innerHTML 赋值的右值必须是「已经过清洗的 html」或「本文件里的静态图标」：
  //   wrap.innerHTML = html        （buildSummaryText，html 来自 renderMarkdown）
  //   actionButton.innerHTML = ACTION_ICON_SEND（模块常量字符串）
  //   actionButton.innerHTML = icon（= buildSummaryText 里那个 busy ? STOP : SEND）
  // 这条断言把「以后有人顺手写 el.innerHTML = 模型给的文本」这种回归当场拦住。
  const writes = codeLines
    .filter((line) => /\.innerHTML\s*=/.test(line))
    .map((line) => /\.innerHTML\s*=\s*([^;]+);/.exec(line)[1].trim())
    .sort();
  assert.deepEqual(writes, ["ACTION_ICON_SEND", "html", "icon"], {
    message: `innerHTML 只许写这些安全值，实际：${JSON.stringify(writes)}`,
  });
  // icon 只能来自这两个模块常量（不是从模型/用户数据来的）
  assert.match(source, /const icon = busy \? ACTION_ICON_STOP : ACTION_ICON_SEND;/);
  assert.match(source, /function buildSummaryText/, "必须有 buildSummaryText");
  assert.match(source, /renderMarkdown\(text\)/, "必须调用 renderMarkdown");
  // 流式区域用 el(...) 的 textContent 路径（第三个参数是文本，不是 html）
  assert.match(
    source,
    /agent-stream[\s\S]{0,160}turn\.streamText/,
    "流式区域必须直接把 turn.streamText 当文本赋给元素",
  );
});
