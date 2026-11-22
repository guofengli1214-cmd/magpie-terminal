// AI 提示词回归锁（TASK.md §4.11 / D10）。
//
// 背景：`buildSystemPrompt()` 里曾经有一句「不要执行破坏性操作」，
// 模型据此自我审查，把用户明确要求的 `rm keepme.txt` 变成
// `{"command":"","reason":"删除文件属于破坏性操作……"}`，
// 前端只能报 AI_BAD_JSON，确认卡永远不会出现 —— 这条路径整段失效。
//
// 本设计的安全关口是「确认卡」，不是模型的自我审查。
// 这组断言就是防止那句话再回来的锁；它已经回来过两次。

import test from "node:test";
import assert from "node:assert/strict";
import { systemPrompt } from "../../src/ai/gateway.mjs";

const prompt = systemPrompt();

test("提示词不得包含自我审查句「不要执行破坏性操作」", () => {
  assert.equal(
    prompt.includes("不要执行破坏性操作"),
    false,
    "`不要执行破坏性操作` 会让模型拒绝给出 rm/mv，确认卡路径永远走不到；不要加回来。",
  );
});

test("提示词必须包含「删掉这个文件 → rm <文件名>」的反例/正例", () => {
  // 反例本身也要在（告诉模型「不要返回空 command」）。
  assert.ok(
    prompt.includes("删掉这个文件"),
    "需要出现「删掉这个文件」这个具体场景，模型才理解边界。",
  );
  // 正例必须逐字包含，这是 TASK.md 明确要求的写法。
  assert.ok(
    prompt.includes('{"command":"rm <文件名>","reason":"删除文件"}'),
    "必须逐字包含正例 {\"command\":\"rm <文件名>\",\"reason\":\"删除文件\"}",
  );
  assert.ok(
    prompt.includes("不要因为它是破坏性操作就返回空 command"),
    "必须明确禁止「因为是破坏性操作就返回空 command」。",
  );
});

test("提示词必须说明：模型自己不执行、由应用/确认卡把关", () => {
  assert.ok(prompt.includes("你自己不执行任何命令"), "要说明助手本身不执行。");
  assert.ok(prompt.includes("确认卡"), "要点明安全关口是确认卡。");
  assert.ok(prompt.includes("只读白名单"), "要说明只有只读白名单会自动执行。");
});

test("提示词仍然禁止 sudo（提权是硬性禁止，不是普通确认）", () => {
  assert.ok(prompt.includes("sudo"), "必须保留 sudo 禁令。");
  assert.ok(
    /sudo.*(禁止|不给|硬性)/.test(prompt) || /唯一绝对不给的是 sudo/.test(prompt),
    "sudo 必须以「硬性禁止」表述，而不是「放进确认卡」。",
  );
});

test("提示词仍然禁止 find，并给出 rg/ls 替代（D8 的配套）", () => {
  assert.ok(prompt.includes("不要使用 find"));
  assert.ok(prompt.includes("rg -n"));
  assert.ok(prompt.includes("rg --files"));
});

test("提示词仍然限定 curl 为 -I（D8 的配套）", () => {
  assert.ok(prompt.includes("curl -I"));
});

test("提示词首行仍是「单条命令 + JSON 输出」的契约", () => {
  assert.ok(prompt.includes('{"command":"…","reason":"…"}'));
  assert.ok(prompt.includes("只输出 JSON"));
});
