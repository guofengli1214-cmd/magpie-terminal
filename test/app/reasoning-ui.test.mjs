// 前端结构的锁（TASK-FIX17-L4 R4 / R5 + AC5 / AC6 的静态一半）。
//
// 为什么读源码而不是 DOM 单测：这两个模块直接吃浏览器 DOM（select / dialog /
// localStorage），仓里没有 jsdom；行为验证交给 `scripts/probe-reasoning.mjs` 的
// 真 Chrome 探针（AC5 / AC6）。这里钉死的是「不许把档位写死」「不许把 select
// 塞进输入框」「不支持时不许显示假档位」这类会当场回归的契约。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const read = (rel) => readFile(path.join(REPO, rel), "utf8");

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))].map((m) => m[1]).join("\n");
}

/* ------------------------------------------------------------ AI 栏（R4） */

test("R4：AI 栏在 .composer-topbar 内、模型按钮右侧加 conversation-reasoning", async () => {
  const source = await read("app/ui/ai-drawer.js");
  assert.ok(source.includes('"data-role": "conversation-reasoning"'), "缺少 select");
  // 三个子项按顺序 append：模型 → 推理 → 动作按钮。
  const append = source.indexOf("topbar.append(modelSelect, reasoningSelect, actionButton);");
  assert.ok(append > 0, "推理下拉必须和模型按钮同一行、且在模型按钮右侧");
  // 不许塞进输入框容器（D 批已定：输入框里只有文字）。
  const boxStart = source.indexOf('"data-role": "composer-box"');
  const boxEnd = source.indexOf("composerEl.append(");
  const box = source.slice(boxStart, boxEnd);
  assert.equal(box.includes("reasoningSelect"), false, "select 不许塞进 .composer-box");
});

test("R4：选项只来自 /api/models 的 reasoningLevels（不写死档位）", async () => {
  const source = await read("app/ui/ai-drawer.js");
  assert.match(source, /function levelsOf\(model\)[\s\S]*?model\.reasoningLevels/);
  // 选项只能由 `levels`（= 模型清单 ∩ 服务端枚举）生成，不能直接遍历枚举常量。
  assert.match(source, /for \(const level of levels\)/);
  assert.equal(/for \(const level of REASONING_ACCEPTED\)/.test(source), false, "枚举不能当选项源");
  // 首项必须是「默认」空串。
  assert.match(source, /el\("option", \{ value: "" \}, "默认"\)/);
});

test("R4：模型不支持 / 清单为空 → 整个 select 隐藏（不编造档位）", async () => {
  const source = await read("app/ui/ai-drawer.js");
  assert.match(source, /model\.supportsReasoning === true && levels\.length > 0/);
  assert.match(source, /reasoningSelect\.hidden = true;/);
  assert.match(source, /reasoningSelect\.hidden = false;/);
});

test("R4：切换 → PUT conversationReasoning（空串 → null），失败回滚 + toast", async () => {
  const source = await read("app/ui/ai-drawer.js");
  assert.match(source, /api\.saveConfig\(\{ conversationReasoning: next \}\)/);
  assert.match(source, /const next = typeof value === "string" && value\.length > 0 \? value : null;/);
  // 回滚：失败写回上一次的值 + 提示。
  const body = source.slice(source.indexOf("function persistReasoning("), source.indexOf("/* ---------------- 时间线渲染"));
  assert.match(body, /conversationReasoning = previous;/);
  assert.match(body, /onNotice\(/);
});

test("R4/AC5：刷新后从 GET /api/config 恢复对话档位", async () => {
  const source = await read("app/ui/ai-drawer.js");
  assert.match(source, /configResult\.data\.conversationReasoning/);
  assert.match(source, /conversationReasoning = typeof saved === "string"/);
});

/* ------------------------------------------------------------ 设置页（R5） */

test("R5：设置页「审阅模型」block 内多一行「推理强度」+ review-reasoning", async () => {
  const source = await read("app/ui/settings-panel.js");
  const blockStart = source.indexOf('"data-block": "review"');
  const blockEnd = source.indexOf('"data-block": "effect"');
  assert.ok(blockStart > 0 && blockEnd > blockStart, "review block 必须存在且在 effect 之前");
  const block = source.slice(blockStart, blockEnd);
  assert.ok(block.includes('"data-role": "review-reasoning"'), "select 必须在 review block 内");
  assert.ok(block.includes('"推理强度"'), "label 文案");
  assert.ok(block.includes('"data-role": "review-reasoning-hint"'), "说明行");
  // 位置：在审阅模型下拉之后。
  assert.ok(block.indexOf("review-model-select") < block.indexOf("review-reasoning"));
});

test("R5：选项按所选审阅模型的 reasoningLevels 重算（换模型时保留合法值，否则默认）", async () => {
  const source = await read("app/ui/settings-panel.js");
  assert.match(source, /reviewSelect\.addEventListener\("change", \(\) => renderReviewReasoning\(\)\);/);
  assert.match(source, /levels\.includes\(reviewReasoning\)/);
  assert.match(source, /reviewReasoning = null;/);
  assert.match(source, /reviewReasoningSelect\.value = reviewReasoning \|\| "";/);
});

test("R5：模型无 reasoning → select 禁用并写「这个模型不支持推理强度」", async () => {
  const source = await read("app/ui/settings-panel.js");
  assert.match(source, /reviewReasoningSelect\.disabled = true;/);
  assert.ok(source.includes('"这个模型不支持推理强度。"'), "逐字文案");
  assert.match(source, /reviewReasoningSelect\.disabled = false;/);
});

test("R5：保存时随其它字段一起 PUT（空 → null）", async () => {
  const source = await read("app/ui/settings-panel.js");
  assert.match(source, /reviewReasoning: reviewReasoning \|\| null,/);
});

test("R5/AC6：打开设置页从 GET /api/config 恢复审阅档位与对话模型 id", async () => {
  const source = await read("app/ui/settings-panel.js");
  assert.match(source, /const configuredModel = typeof config\.model === "string"/);
  assert.match(source, /conversationModelId = known\(configuredModel\)/);
  assert.match(source, /typeof config\.reviewReasoning === "string"/);
  assert.match(source, /renderReviewReasoning\(\);/);
});

test("R4/R5：前端只提供服务端接受的档位（镜像 REASONING_LEVELS，绝不摆出会 400 的值）", async () => {
  const { REASONING_LEVELS } = await import("../../src/config/store.mjs");
  const expected = [...REASONING_LEVELS];
  for (const rel of ["app/ui/ai-drawer.js", "app/ui/settings-panel.js"]) {
    const source = await read(rel);
    const match = /const REASONING_ACCEPTED = Object\.freeze\((\[[^\]]*\])\)/.exec(source);
    assert.ok(match, `${rel} 必须有 REASONING_ACCEPTED 镜像`);
    const list = JSON.parse(match[1].replace(/'/g, '"'));
    assert.deepEqual(list, expected, `${rel} 的镜像必须和 store.mjs 的枚举逐字一致`);
    assert.match(source, /REASONING_ACCEPTED\.includes\(level\)/, `${rel} 必须真的用它过滤`);
  }
});

/* ------------------------------------------------------------ 样式（F 批规矩） */

test("R4/R5：CSS 只新增 composer 段与设置段两处，颜色只用既有变量", async () => {
  const css = await read("app/styles/components.css");
  const clean = strip(css);
  const settingsStart = clean.indexOf(".settings-modal {");
  assert.ok(settingsStart > 0, "设置模态段必须存在（用它当两段的边界）");
  const composerBlock = blockOf(clean, '[data-role="ai-drawer"] .composer-topbar [data-role="conversation-reasoning"]');
  assert.ok(composerBlock.length > 0, "composer 段的推理下拉样式必须存在");
  assert.match(composerBlock, /width:\s*96px/);
  assert.match(composerBlock, /border:\s*1px solid var\(--term-line-3\)/);
  assert.match(composerBlock, /background:\s*var\(--term-bg\)/);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(composerBlock), false, "不许出现颜色字面量");
  // composer 段的规则必须在「设置模态」之前（= 属于抽屉段，只新增不搬家）。
  assert.ok(clean.indexOf('[data-role="ai-drawer"] .composer-topbar [data-role="conversation-reasoning"]') < settingsStart);

  const settingsBlock = blockOf(clean, '.settings-block [data-role="review-reasoning"]');
  assert.ok(settingsBlock.length > 0, "设置段的推理下拉样式必须存在");
  assert.match(settingsBlock, /border:\s*1px solid var\(--term-line-3\)/);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(settingsBlock), false, "不许出现颜色字面量");
  assert.ok(clean.indexOf('.settings-block [data-role="review-reasoning"]') > settingsStart);

  // 聚焦态两处都要用 --term-focus（F 批：不能拿 accent 当前景/边框）。
  assert.match(blockOf(clean, '[data-role="ai-drawer"] .composer-topbar [data-role="conversation-reasoning"]:focus-visible'), /border-color:\s*var\(--term-focus\)/);
  assert.match(blockOf(clean, '.settings-block [data-role="review-reasoning"]:focus-visible'), /border-color:\s*var\(--term-focus\)/);
});
