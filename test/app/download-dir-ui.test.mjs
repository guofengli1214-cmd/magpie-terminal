// 前端结构的锁（TASK-FIX17-L1 R4）：设置页新 block、保存时带 downloadDir、
// 日志导出优先走目录、文件面板「先存目录再回落 `<a download>`」。
//
// 为什么是源码级断言而不是 DOM 单测：这两个模块都直接吃浏览器 DOM
// （xterm / ResizeObserver / localStorage / confirm），仓里既没有 jsdom 也没有
// 事件模拟层。既有测试（file-panel-batch / ai-drawer-structure）用的也是
// 「读源码断言关键片段」，行为验证交给 `scripts/probe-download-dir.mjs` 的真
// Chrome 探针（AC5/AC6/AC7）。这里锁定的是「不许把回落路径删掉」这类回归。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

async function readSource(rel) {
  return readFile(path.join(REPO, rel), "utf8");
}

/* ---------------------------- 设置页 ---------------------------- */

test("R4：设置页有 data-block=\"downloads\" 且排在 gateway 之前", async () => {
  const source = await readSource("app/ui/settings-panel.js");
  const downloads = source.indexOf('"data-block": "downloads"');
  const gateway = source.indexOf('"data-block": "gateway"');
  assert.ok(downloads > 0, "必须新增 downloads block");
  assert.ok(gateway > 0, "gateway block 还在");
  assert.ok(downloads < gateway, "下载与导出目录要排在「AI 网关」之前（用户日常会改的设置靠前）");
});

test("R4：设置页下载 block 的 data-role 与文案（验收探针逐字用）", async () => {
  const source = await readSource("app/ui/settings-panel.js");
  for (const role of ["download-dir", "download-dir-default", "download-dir-hint", "logs-reveal"]) {
    assert.ok(source.includes(`"data-role": "${role}"`), `缺少 data-role="${role}"`);
  }
  assert.ok(source.includes("下载与导出"), "block 标题");
  assert.ok(
    source.includes("下载的文件、导出的日志都会存到这个目录。留空则用浏览器默认下载目录。"),
    "说明文案必须逐字保留（用户要知道留空会发生什么）",
  );
  assert.ok(source.includes("用默认目录"), "「用默认目录」按钮");
});

test("R4：保存时把 downloadDir 一起 PUT（空 → null，不送空串）", async () => {
  const source = await readSource("app/ui/settings-panel.js");
  assert.match(source, /downloadDir:\s*downloadDirInput && downloadDirInput\.value\.trim\(\)\.length > 0/);
  assert.match(source, /: null,/);
  // 默认目录来自服务端（前端拿不到家目录，不许自己拼）。
  assert.match(source, /downloadDirDefault/);
});

test("R4：日志导出先走 export-to-dir，NO_DOWNLOAD_DIR 才回落 blob + `<a download>`", async () => {
  const source = await readSource("app/ui/settings-panel.js");
  const bodyStart = source.indexOf("async function exportLogs() {");
  const bodyEnd = source.indexOf("async function exportLogsToDir() {");
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, "两个函数都要在");
  const body = source.slice(bodyStart, bodyEnd);
  const toDir = body.indexOf("await exportLogsToDir()");
  const legacy = body.indexOf("api.logsExport()");
  assert.ok(toDir > 0, "exportLogs 必须先调 exportLogsToDir()");
  assert.ok(legacy > toDir, "旧 blob 下载必须作为回落保留（且在优先路径之后）");
  assert.ok(source.includes("api.logsExportToDir()"), "必须调用 api.logsExportToDir()");
  assert.match(source, /result\.code === "NO_DOWNLOAD_DIR"/);
  assert.match(source, /download: result\.filename/, "回落路径必须原样保留 <a download>");
  // 提示文案里给完整路径。
  assert.match(source, /已导出到 \$\{data\.savedPath\}/);
});

test("R4：设置页导出/下载提示里的路径是完整路径，不是文件名", async () => {
  const source = await readSource("app/ui/settings-panel.js");
  assert.ok(!/已导出到 \$\{data\.name\}/.test(source), "只能用 savedPath，不能用 name");
  assert.match(source, /revealPath\(lastExportedPath\)|api\.revealPath\(/);
});

/* ---------------------------- 文件面板 ---------------------------- */

test("R4：downloadFile 先调 api.fsSave，成功时提示完整 savedPath", async () => {
  const source = await readSource("app/ui/file-panel.js");
  const save = source.indexOf("api.fsSave(target(), entry.path)");
  assert.ok(save > 0, "downloadFile 必须调用 api.fsSave");
  assert.match(source, /已保存到 \$\{data\.savedPath\}/);
  assert.match(source, /showSavedHint\(data\.savedPath\)/);
});

test("AC5：NO_DOWNLOAD_DIR 时回落原来的 `<a download>`（一字不改）", async () => {
  const source = await readSource("app/ui/file-panel.js");
  assert.match(source, /if \(data\.code === "NO_DOWNLOAD_DIR"\) return null;/);
  assert.match(source, /if \(saved\) return saved;\s*\n\s*return legacyDownload\(entry, opts\);/);
  // 旧实现的关键三行必须还在（anchor + download 属性 + click）。
  assert.match(source, /anchor\.download = entry\.name;/);
  assert.match(source, /anchor\.click\(\);/);
  assert.match(source, /setTimeout\(\(\) => URL\.revokeObjectURL\(objectUrl\), 30000\)/);
});

test("R4：文件面板有「打开所在文件夹」入口（files-reveal）且调 /api/fs/reveal", async () => {
  const source = await readSource("app/ui/file-panel.js");
  assert.match(source, /"data-role": "files-reveal"/);
  assert.match(source, /api\.revealPath\(targetPath\)/);
  assert.match(source, /"data-role": "files-saved-hint"/);
});

test("AC6：批量下载汇总文案带目录（已保存 N 个文件到 <目录>）", async () => {
  const source = await readSource("app/ui/file-panel.js");
  assert.match(source, /已保存 \$\{savedPaths\.length\} 个文件到 \$\{dirOfEditorial\(savedPaths\[0\]\)\}/);
  // 没设目录时仍要说「已开始下载 N 个文件」（旧文案）。
  assert.match(source, /已开始下载 \$\{browserCount\} 个文件/);
  assert.match(source, /\$\{failed\.length\} 个失败/);
});

test("R4：CSS 只新增下载相关段落（不改既有行）", async () => {
  const css = await readSource("app/styles/components.css");
  assert.ok(css.includes(".file-panel-saved-hint"), "回显行的样式");
  assert.ok(css.includes('[data-role="download-dir"]'), "输入框样式");
  assert.ok(css.includes('[data-role="download-dir-default"]'));
  // 新增段里的颜色必须走变量，不许字面量（F 批规矩）。
  const tail = css.slice(css.indexOf("/* =====================================================================\n * 下载与导出目录"));
  assert.ok(tail.length > 0, "downloads 段必须存在");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(tail), "新增样式里不许写死颜色");
});

test("R4：慢 load() 不许抹掉用户刚触发的状态（statusVersion 竞态）", async () => {
  const source = await readSource("app/ui/settings-panel.js");
  // 自查发现：设置页一打开就点「导出日志」时，load() 结尾的 setStatus("", null)
  // 会把「已导出到 C:\…」擦掉，用户以为没成功。
  assert.match(source, /let statusVersion = 0;/);
  assert.match(source, /function setStatus\(text, tone\) \{\s*\n\s*statusVersion \+= 1;/);
  assert.match(source, /if \(statusVersion === versionAtStart \+ 1\) setStatus\("", null\);/);
});
