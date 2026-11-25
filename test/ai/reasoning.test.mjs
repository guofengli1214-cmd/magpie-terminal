// TASK-FIX17-L4 的 AI 侧行为锁（R2 / R3 + AC1 / AC3 / AC4 / AC7）。
//
// 关键约定（工作单 §4）：**不打真网关**。AC3/AC4 要求的「请求体里有没有
// reasoning_effort」必须由本地 stub 网关记录原始请求体来断言 —— 真网关只能说
// 「它接受了/拒绝了」，证明不了我们发了什么。真实 SDK 仍然全程参与
// （streamText / generateText 都走 @ai-sdk/openai-compatible 的真实序列化），
// 所以这里断言的是最终 HTTP body，不是我们自己的中间变量。
//
// stub 同时提供：
//   GET  /v1/models            → 模型清单（含 reasoning / reasoning_levels）
//   POST /v1/chat/completions  → stream=true 时回 SSE；否则回一条工具调用结论

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import {
  probeGateway,
  resetReasoningSupportCache,
  resolveReasoningEffort,
  reasoningSupportFor,
} from "../../src/ai/gateway.mjs";
import { createAgentRunner } from "../../src/ai/agent.mjs";
import { reviewCommand } from "../../src/ai/review.mjs";
import { judge } from "../../src/ai/judge.mjs";
import { startServer } from "../../src/server/http.mjs";
import { CONFIG_PATH_ENV } from "../../src/config/store.mjs";

const ENV_URL = "MAGPIE_TERMINAL_GATEWAY_URL";

const REASON_MODEL = {
  id: "m/reason",
  magpie_label: "Reason Model",
  context_length: 1000000,
  reasoning: true,
  reasoning_levels: ["low", "high", "max"],
  supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
};

const PLAIN_MODEL = {
  id: "m/plain",
  magpie_label: "Plain Model",
  context_length: 1000000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, timeoutMs = 8000, stepMs = 20) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await sleep(stepMs);
  }
  return false;
}

function toolCallCompletion(model) {
  return {
    id: "c-review",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "review_command",
                arguments: JSON.stringify({
                  risk: "safe",
                  aligned: true,
                  justification: "只读命令",
                  effect: "不会改变任何东西，只是查看目录。",
                  confirmWhy: "",
                  reversible: true,
                }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  };
}

/** 起本地 stub 网关（记录原始请求体）。只监听 127.0.0.1 的随机端口。 */
function startStubGateway({ models = [REASON_MODEL, PLAIN_MODEL], completion } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      requests.push({ method: req.method, url: req.url, body, raw });
      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        const payload = JSON.stringify({ data: models });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
        if (body && body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const chunk = (delta, finish = null) =>
            `data: ${JSON.stringify({
              id: "c-stream",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`;
          res.write(chunk({ role: "assistant", content: "好的，都做完了。" }));
          res.write(chunk({}, "stop"));
          res.write(
            `data: ${JSON.stringify({
              id: "c-stream",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        const payload = JSON.stringify(completion || toolCallCompletion(body && body.model));
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        chatRequests: () => requests.filter((item) => item.url.startsWith("/v1/chat/completions")),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function withGateway(url, fn) {
  const previous = process.env[ENV_URL];
  process.env[ENV_URL] = url;
  resetReasoningSupportCache();
  try {
    return await fn();
  } finally {
    resetReasoningSupportCache();
    if (previous === undefined) delete process.env[ENV_URL];
    else process.env[ENV_URL] = previous;
  }
}

function makeSend() {
  const frames = [];
  const send = (frame) => frames.push(frame);
  send.frames = frames;
  send.ofType = (type) => frames.filter((frame) => frame.type === type);
  return send;
}

function fakeRunner() {
  return {
    async run() {
      return { ok: true, exitCode: 0, output: "", truncated: false };
    },
    async probe() {
      return true;
    },
    dispose() {},
  };
}

async function runAgentOnce({ config, model = REASON_MODEL.id, logs = [] }) {
  const send = makeSend();
  const agent = createAgentRunner({ log: (entry) => logs.push(entry), runner: fakeRunner() });
  agent.start({ requestId: "r1", question: "看看当前目录", model, socket: {}, send, config });
  const done = await waitUntil(() => send.ofType("agent.done").length > 0 || send.ofType("agent.error").length > 0);
  assert.ok(done, "agent 必须有收尾帧（done 或 error）");
  return { send, logs };
}

/* ------------------------------------------------------- AC1 / R2：透传 */

test("R2/AC1：probeGateway 透传 reasoningLevels 与 supportsReasoning", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      const probe = await probeGateway();
      const reason = probe.models.find((model) => model.id === REASON_MODEL.id);
      const plain = probe.models.find((model) => model.id === PLAIN_MODEL.id);
      assert.deepEqual(reason.reasoningLevels, ["low", "high", "max"]);
      assert.equal(reason.supportsReasoning, true);
      assert.deepEqual(plain.reasoningLevels, [], "没有 reasoning_levels → 空数组（不是 null）");
      assert.equal(plain.supportsReasoning, false);
      // AC1 的「每项都含数组」：类型必须是数组，前端才敢直接遍历。
      for (const model of probe.models) assert.ok(Array.isArray(model.reasoningLevels));
    });
  } finally {
    await stub.close();
  }
});

test("R2/AC1：GET /api/models 每项带 reasoningLevels 数组（deepseek 有 low/high/max）", async () => {
  const stub = await startStubGateway();
  const root = await mkdtemp(path.join(os.tmpdir(), "mt-l4-models-"));
  const previousConfig = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(root, "config.json");
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const handle = await startServer({ port, log: () => {} });
  try {
    await withGateway(stub.url, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/models`, {
        headers: { "x-magpie-term-token": handle.token },
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.ok(Array.isArray(payload.models));
      for (const model of payload.models) {
        assert.ok(Array.isArray(model.reasoningLevels), `${model.id} 必须带 reasoningLevels 数组`);
        assert.equal(typeof model.supportsReasoning, "boolean");
      }
      const deepseek = payload.models.find((model) => model.id === REASON_MODEL.id);
      for (const level of ["low", "high", "max"]) {
        assert.ok(deepseek.reasoningLevels.includes(level), `缺档位 ${level}`);
      }
    });
  } finally {
    await handle.close();
    await stub.close();
    if (previousConfig === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previousConfig;
  }
});

/* ------------------------------------------------------- R3：解档位的规则 */

test("R3：resolveReasoningEffort —— 空值不探网关、直接 null", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      assert.equal(await resolveReasoningEffort({ level: null, modelId: REASON_MODEL.id }), null);
      assert.equal(await resolveReasoningEffort({ level: "", modelId: REASON_MODEL.id }), null);
      assert.equal(await resolveReasoningEffort({ level: "   ", modelId: REASON_MODEL.id }), null);
      assert.equal(stub.requests.length, 0, "空值不许触发 /v1/models 探测（每句提问都探一次会白等）");
    });
  } finally {
    await stub.close();
  }
});

test("R3/AC7：resolveReasoningEffort —— 模型不支持时降级为 null 并记 REASONING_SKIPPED", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      const support = await reasoningSupportFor(PLAIN_MODEL.id);
      assert.equal(support.known, true);
      assert.equal(support.supportsReasoning, false);
      const logs = [];
      const effort = await resolveReasoningEffort({
        level: "high",
        modelId: PLAIN_MODEL.id,
        log: (entry) => logs.push(entry),
        where: "agent",
      });
      assert.equal(effort, null);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].code, "REASONING_SKIPPED");
      assert.equal(logs[0].level, "warn");
      assert.equal(logs[0].requested, "high");
    });
  } finally {
    await stub.close();
  }
});

/* ------------------------------------------------------- AC3：对话请求体 */

test("AC3：conversationReasoning=\"high\" → 对话请求体含 reasoning_effort:\"high\"", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      const { send } = await runAgentOnce({
        config: { autonomy: "balanced", allowlist: [], conversationReasoning: "high" },
      });
      assert.equal(send.ofType("agent.done").length, 1);
      const posts = stub.chatRequests();
      assert.ok(posts.length >= 1, "必须真的发出一次 chat/completions");
      assert.equal(posts[posts.length - 1].body.reasoning_effort, "high");
    });
  } finally {
    await stub.close();
  }
});

test("AC3：conversationReasoning=null → 请求体不含 reasoning_effort（也不能是 null）", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      const { send } = await runAgentOnce({
        config: { autonomy: "balanced", allowlist: [], conversationReasoning: null },
      });
      assert.equal(send.ofType("agent.done").length, 1);
      const body = stub.chatRequests().pop().body;
      assert.equal(Object.prototype.hasOwnProperty.call(body, "reasoning_effort"), false);
      assert.equal(body.reasoning_effort, undefined);
    });
  } finally {
    await stub.close();
  }
});

test("AC3：conversationReasoning=\"\" → 同样不传该键（空串等于默认）", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      await runAgentOnce({ config: { autonomy: "balanced", allowlist: [], conversationReasoning: "" } });
      const body = stub.chatRequests().pop().body;
      assert.equal(Object.prototype.hasOwnProperty.call(body, "reasoning_effort"), false);
    });
  } finally {
    await stub.close();
  }
});

/* ------------------------------------------------------- AC4：审阅请求体 */

test("AC4：reviewReasoning=\"low\" → 审阅请求体含 reasoning_effort:\"low\"", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      const verdict = await reviewCommand({ command: "ls -la", model: REASON_MODEL.id, reasoning: "low" });
      assert.equal(verdict.risk, "safe", "stub 的工具调用必须被真实解析");
      const body = stub.chatRequests().pop().body;
      assert.equal(body.reasoning_effort, "low");
      // 强制工具调用不受影响（审阅的稳定拿到结论靠它）。
      assert.deepEqual(body.tool_choice, { type: "function", function: { name: "review_command" } });
    });
  } finally {
    await stub.close();
  }
});

test("AC4：审阅不设 reasoning → 请求体不含 reasoning_effort", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      const verdict = await reviewCommand({ command: "ls -la", model: REASON_MODEL.id });
      assert.equal(verdict.risk, "safe");
      const body = stub.chatRequests().pop().body;
      assert.equal(Object.prototype.hasOwnProperty.call(body, "reasoning_effort"), false);
    });
  } finally {
    await stub.close();
  }
});

test("R3：judge 把 config.reviewReasoning 传给审阅（并把 log 一起传下去）", async () => {
  const calls = [];
  const review = async (input) => {
    calls.push(input);
    return {
      risk: "safe",
      aligned: true,
      justification: "测试",
      effect: "无",
      confirmWhy: "",
      reversible: true,
      cachedTokens: null,
      model: input.model || "m/reason",
    };
  };
  const log = () => {};
  // `ls` 会在内置只读白名单就 auto（第 4 级），根本走不到审阅；
  // 用一个需要审阅的写操作（mkdir → 黑名单层），保证第 7 级真的被调到。
  await judge({ command: "mkdir brand-new-dir", config: { autonomy: "balanced", reviewReasoning: "max" }, review, log });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoning, "max");
  assert.equal(typeof calls[0].log, "function");
});

/* ------------------------------------------------------- AC7：降级不阻断 */

test("AC7：模型不支持 + 设了值 → 对话请求不带 reasoning_effort，日志有 REASONING_SKIPPED，功能不报错", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      const logs = [];
      const { send } = await runAgentOnce({
        model: PLAIN_MODEL.id,
        config: { autonomy: "balanced", allowlist: [], conversationReasoning: "high" },
        logs,
      });
      assert.equal(send.ofType("agent.error").length, 0, "降级不是错误：不许出 agent.error");
      assert.equal(send.ofType("agent.done").length, 1, "该跑完的必须跑完");
      const body = stub.chatRequests().pop().body;
      assert.equal(Object.prototype.hasOwnProperty.call(body, "reasoning_effort"), false);
      const skipped = logs.filter((entry) => entry.code === "REASONING_SKIPPED");
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0].model, PLAIN_MODEL.id);
      assert.equal(skipped[0].requested, "high");
      assert.equal(typeof skipped[0].taskId, "string", "降级日志要能对到具体任务");
    });
  } finally {
    await stub.close();
  }
});

test("AC7：模型不支持 + 设了值 → 审阅也不带 reasoning_effort，且仍拿到结论", async () => {
  const stub = await startStubGateway();
  try {
    await withGateway(stub.url, async () => {
      const logs = [];
      const verdict = await reviewCommand({
        command: "ls",
        model: PLAIN_MODEL.id,
        reasoning: "low",
        log: (entry) => logs.push(entry),
      });
      assert.equal(verdict.risk, "safe", "降级不能把审阅变成失败");
      const body = stub.chatRequests().pop().body;
      assert.equal(Object.prototype.hasOwnProperty.call(body, "reasoning_effort"), false);
      assert.equal(logs.filter((entry) => entry.code === "REASONING_SKIPPED").length, 1);
    });
  } finally {
    await stub.close();
  }
});

/* ------------------------------------------------------- 落盘（AC3 的配置源） */

test("R1：updateConfig 把 conversationReasoning 落盘（agent 读的是这一份）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mt-l4-store-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(root, "config.json");
  try {
    const { updateConfig } = await import("../../src/config/store.mjs");
    await updateConfig({ conversationReasoning: "high", reviewReasoning: "low" });
    const raw = JSON.parse(await readFile(process.env[CONFIG_PATH_ENV], "utf8"));
    assert.equal(raw.conversationReasoning, "high");
    assert.equal(raw.reviewReasoning, "low");
  } finally {
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
  }
});
