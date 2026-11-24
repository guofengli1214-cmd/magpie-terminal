// TASK-FIX17-C：前端 API 封装 + 静态结构的锁（不启浏览器）。
//
// 三组：
//   1. `api.fsMove()` 的请求形状（POST /api/fs/move，`{items}`，默认不带 overwrite）；
//   2. hosts-panel 里不再有「文件面板」按钮，rail-files 入口还在（问题 16）；
//   3. 文件面板段 CSS 的两个硬约束：批量条/路径框同高、没有写死色值。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const TOKEN_META = { getAttribute: () => "test-token" };

async function loadApi() {
  globalThis.document = { querySelector: () => TOKEN_META };
  const mod = await import("../../app/core/api.js");
  return mod.default;
}

/* ------------------------------ fsMove ------------------------------ */

test("fsMove：POST /api/fs/move + {items}，默认不带 overwrite（AC7 的「永远不覆盖」）", async (t) => {
  const api = await loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
  });

  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({
        moved: [{ from: "C:\\a\\1.txt", to: "C:\\b\\1.txt", via: "rename" }],
        failed: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const items = [{ from: "C:\\a\\1.txt", to: "C:\\b\\1.txt" }];
  const result = await api.fsMove(null, items);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.url, "/api/fs/move");
  assert.equal(seen.init.headers["x-magpie-term-token"], "test-token");
  assert.deepEqual(JSON.parse(seen.init.body), { items }, "默认请求体只有 items");
  assert.equal(result.ok, true);
  assert.equal(result.data.moved.length, 1);
});

test("fsMove：overwrite 只在显式 true 时才进请求体", async (t) => {
  const api = await loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
  });
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ moved: [], failed: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await api.fsMove(null, [], { overwrite: true });
  await api.fsMove(null, [], { overwrite: false });
  await api.fsMove(null, []);
  assert.deepEqual(bodies[0], { items: [], overwrite: true });
  assert.deepEqual(bodies[1], { items: [] });
  assert.deepEqual(bodies[2], { items: [] });
});

test("fsMove：远程主机走 /api/hosts/:id/fs/move（同名同形）", async (t) => {
  const api = await loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
  });
  let seenUrl = null;
  globalThis.fetch = async (url) => {
    seenUrl = url;
    return new Response(JSON.stringify({ moved: [], failed: [{ code: "NOT_SUPPORTED" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await api.fsMove({ hostId: "h-1" }, [{ from: "/a", to: "/b" }]);
  assert.equal(seenUrl, "/api/hosts/h-1/fs/move");
  assert.equal(result.ok, true);
  assert.equal(result.data.failed[0].code, "NOT_SUPPORTED", "远程不支持必须如实透出，不能假装成功");
});

test("fsMove：非 2xx 仍透出 {code,userText}", async (t) => {
  const api = await loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: "TOO_MANY_ITEMS", userText: "一次最多移动 500 项（本次 900 项）。" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  const result = await api.fsMove(null, [{ from: "a", to: "b" }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "TOO_MANY_ITEMS");
  assert.match(result.userText, /最多移动/);
});

/* ------------------------------ 问题 16：去掉主机栏的文件按钮 ------------------------------ */

test("R4：hosts-panel.js 里不再有 hosts-open-files / hosts-tabs", async () => {
  const source = await readFile(path.join(REPO, "app", "ui", "hosts-panel.js"), "utf8");
  // 只在「代码行」里找，注释里提到旧名字是允许的（说明为什么删）。
  const codeLines = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const offenders = codeLines.filter(
    (line) => /hosts-open-files|hosts-tabs|onOpenFiles/.test(line) && !/TASK-FIX17-C/.test(line),
  );
  assert.deepEqual(offenders, [], "主机面板不该再有人和「文件面板」按钮相关的代码");
});

test("R4：app.js 不再给主机面板传 onOpenFiles", async () => {
  const source = await readFile(path.join(REPO, "app", "app.js"), "utf8");
  const codeLines = source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const offenders = codeLines.filter((line) => /onOpenFiles\s*:/.test(line));
  assert.deepEqual(offenders, [], "onOpenFiles 传参已删（文件面板唯一入口是 rail-files）");
});

test("R4：rail-files 入口仍在 index.html（AC10 的「rail 还能开面板」）", async () => {
  const html = await readFile(path.join(REPO, "app", "index.html"), "utf8");
  assert.match(html, /data-role="rail-files"/, "rail 上的文件图标不能删");
});

test("R4：components.css 里没有 hosts-tabs / hosts-open-files 的样式规则了", async () => {
  const css = await readFile(path.join(REPO, "app", "styles", "components.css"), "utf8");
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/\.hosts-tabs/.test(stripped), false, ".hosts-tabs 的规则应一并删除（容器本身已删）");
  assert.equal(/hosts-open-files/.test(stripped), false);
});

/* ------------------------------ 文件面板段 CSS ------------------------------ */

const FILE_PANEL_CSS = await readFile(path.join(REPO, "app", "styles", "components.css"), "utf8");

/** 取 `.selector { ... }` 的声明块（只用于断言，不追求完整 CSS 解析）。 */
function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g");
  const blocks = [...css.matchAll(match)].map((m) => m[1]);
  return blocks.join("\n");
}

test("AC4：.file-panel-slot 与 .file-panel-batch 同高（切换不跳版）", () => {
  const slot = blockOf(FILE_PANEL_CSS, ".file-panel-slot");
  const batch = blockOf(FILE_PANEL_CSS, ".file-panel-batch");
  assert.match(slot, /height:\s*28px/, "槽位高度必须写死，否则「有内容才有高度」会跳版");
  assert.match(batch, /height:\s*24px/);
  assert.match(slot, /display:\s*flex/);
});

test("R1：定位按钮的三态各有真实样式（不是空规则）", () => {
  for (const state of ["current", "away", "no-terminal"]) {
    const block = blockOf(FILE_PANEL_CSS, `.file-panel-locate[data-state="${state}"]`);
    assert.ok(block.trim().length > 0, `data-state="${state}" 必须有样式`);
    assert.match(block, /(color|opacity|cursor)\s*:/, `data-state="${state}" 的样式不能是空的`);
  }
});

test("R1/R2：新增的文件面板样式没有写死色值（只用变量）", () => {
  // 只扫本卡新增的几段：从文件面板注释头到状态栏，以及批量条。
  const start = FILE_PANEL_CSS.indexOf("TASK-V4-G：文件面板（终端下方的常驻区域）");
  const end = FILE_PANEL_CSS.indexOf("V4-H：会话选择（抽屉头部）");
  assert.ok(start > 0 && end > start, "找不到文件面板段（CSS 结构变了？）");
  const section = FILE_PANEL_CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const literals = [...section.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], "文件面板段不许出现写死的 #hex / rgb()（一律用 --term-* 或 color-mix）");
});

test("R2：多选选中态只用底色（没有新增边框 / 发光）", () => {
  const block = blockOf(FILE_PANEL_CSS, '.file-panel-entry[data-selected="true"]');
  assert.match(block, /background:\s*var\(--term-accent-soft\)/);
  assert.equal(/box-shadow/.test(block), false, "选中态不许加发光（一屏十项会变成十个光框）");
});
