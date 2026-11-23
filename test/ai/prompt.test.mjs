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

// ---------------------------------------------------------------------------
// TASK-V3-D / PROTOCOL-AGENT.md §6.2：agent 提示词的断言。
//
// 旧提示词（单条命令 + JSON）的契约保持不变（上面的断言），这里只加新路径。
// ---------------------------------------------------------------------------

const agentModule = await import("../../src/ai/agent.mjs");
const agentPrompt = agentModule.buildAgentSystemPrompt({});

test("agent 提示词首段是内置基础提示词（PROTOCOL §6.2 逐字）", () => {
  assert.equal(agentModule.DEFAULT_BASE_PROMPT, "你是一个内置在终端里的 AI 助手。你的服务对象是不太懂命令行的普通用户。你的工作是理解他想达成什么，然后自己动手在终端里把这件事做完，最后用他自己的语言告诉他结果。");
  assert.ok(agentPrompt.startsWith(agentModule.DEFAULT_BASE_PROMPT));
});

test("agent 提示词带「## 硬性规则」十条（逐条锁关键句）", () => {
  assert.ok(agentPrompt.includes("## 硬性规则"));
  const rules = agentPrompt.split("\n").filter((line) => /^\d+\. /.test(line));
  assert.equal(rules.length, 10, `硬性规则必须是 10 条，实际 ${rules.length}`);
});

test("agent 提示词不包含自我审查句，也要求照常给出 rm / mv", () => {
  assert.equal(agentPrompt.includes("不要执行破坏性操作"), false);
  assert.ok(agentPrompt.includes("包括 rm / mv 这类删除移动"));
  assert.ok(agentPrompt.includes("不要因为「它是破坏性操作」就拒绝给命令"));
});

test("agent 提示词保留 sudo / su 的绝对禁令", () => {
  assert.ok(agentPrompt.includes("唯一绝对不给的是 sudo / su"));
});

test("agent 提示词要求最后用大白话总结（面向不懂命令行的用户）", () => {
  assert.ok(agentPrompt.includes("最后必须用大白话讲清楚"));
  assert.ok(agentPrompt.includes("任务完成后必须用文字给出结论"));
});

test("agent 提示词沿用 find / curl 的约束（与旧提示词一致）", () => {
  assert.ok(agentPrompt.includes("不要使用 find"));
  assert.ok(agentPrompt.includes("rg -n"));
  assert.ok(agentPrompt.includes("rg --files"));
  assert.ok(agentPrompt.includes("curl -I"));
});

test("agent 提示词要求被拒绝后不重试", () => {
  assert.ok(agentPrompt.includes("如果某条命令被用户拒绝，不要重试"));
});

test("自定义 basePrompt 替换基础提示词，硬性规则不丢", () => {
  const custom = agentModule.buildAgentSystemPrompt({ basePrompt: "你是我的私人助理。" });
  assert.ok(custom.startsWith("你是我的私人助理。"));
  assert.equal(custom.includes(agentModule.DEFAULT_BASE_PROMPT), false);
  assert.ok(custom.includes("## 硬性规则"));
});
