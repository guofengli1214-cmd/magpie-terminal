// 端到端冒烟：真网关 + 真 PTY + 真 WS，走一遍用户视角的 agent 任务。
//
// 不是正式测试（不进 node --test）：它会打真网关、会花钱、会跑真命令。
// 只用来说明「一个不懂命令行的人说一句话，能不能走通」。
//
// 用法：D:/nodejs/install/node.exe scripts/agent-smoke.mjs "把这边的测试跑一遍，告诉我有没有失败"

import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { startServer } from "../src/server/http.mjs";

const question = process.argv[2] || "看看当前目录下有哪些文件，用一句话告诉我";
const dir = await mkdtemp(path.join(os.tmpdir(), "mt-smoke-"));
process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
const port = 3499;

const handle = await startServer({ port, log: () => {} });
const url = `ws://127.0.0.1:${port}/ws?token=${handle.token}`;
const ws = new WebSocket(url);

const frames = [];
const startedAll = Date.now();

function waitFor(type, timeoutMs = 180000) {
  const existing = frames.find((frame) => frame.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${type}`)), timeoutMs);
    const tick = setInterval(() => {
      const hit = frames.find((frame) => frame.type === type);
      if (hit) {
        clearInterval(tick);
        clearTimeout(timer);
        resolve(hit);
      }
    }, 50);
  });
}

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});

ws.addEventListener("message", (event) => {
  let frame;
  try {
    frame = JSON.parse(String(event.data));
  } catch {
    return;
  }
  frames.push(frame);
  if (frame.type === "agent.step" || frame.type === "agent.done" || frame.type === "agent.approval" || frame.type === "agent.error") {
    const brief = {
      type: frame.type,
      stepId: frame.stepId,
      index: frame.index,
      status: frame.status,
      command: frame.command,
      exitCode: frame.exitCode,
    };
    console.log(`[${((Date.now() - startedAll) / 1000).toFixed(1)}s] ${JSON.stringify(brief)}`);
  }
  // 用户视角：弹出确认卡就当用户点「确认执行」。
  if (frame.type === "agent.approval") {
    console.log(`  → 自动批准（模拟用户点确认）: ${frame.command}`);
    console.log(`    risk=${frame.risk} reversible=${frame.reversible} reviewModel=${frame.reviewModel}`);
    console.log(`    effect=${JSON.stringify(frame.effect)}`);
    console.log(`    confirmWhy=${JSON.stringify(frame.confirmWhy)}`);
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "agent.approve", requestId: frame.requestId, approvalId: frame.approvalId, approved: true }));
    }, 300);
  }
});

// 建一个本地会话，拿到 sessionId。
ws.send(JSON.stringify({ type: "pty.create", cols: 120, rows: 30, cwd: process.cwd() }));
const created = await waitFor("session.created");
const sessionId = created.id;
console.log(`sessionId=${sessionId} cwd=${created.cwd}`);

ws.send(
  JSON.stringify({
    type: "agent.run",
    requestId: "smoke-1",
    question,
    context: { cwd: process.cwd(), sessionId },
  }),
);

const done = await waitFor("agent.done").catch(async (err) => {
  const errorFrame = frames.find((frame) => frame.type === "agent.error");
  if (errorFrame) {
    console.log("agent.error:", JSON.stringify(errorFrame));
  }
  throw err;
});

console.log("--- agent.done ---");
console.log(JSON.stringify(done, null, 2));

const steps = frames.filter((frame) => frame.type === "agent.step" && frame.status !== "running" && frame.status !== "awaiting");
console.log(`--- steps (${steps.length}) ---`);
for (const step of steps) {
  console.log(JSON.stringify({ index: step.index, status: step.status, command: step.command, exitCode: step.exitCode, output: (step.output || "").slice(0, 300) }));
}

ws.close();
await handle.close();
// WS/PTY 的收尾是异步的；给事件循环一点时间再退出，避免 libuv 断言噪音。
setTimeout(() => process.exit(0), 200);
