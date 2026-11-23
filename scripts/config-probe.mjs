// AC4 手工证据脚本：起一个真服务，用 curl 语义打 GET/PUT /api/config。
//
// 用法（仓库根）：D:/nodejs/install/node.exe scripts/config-probe.mjs
// 落到临时配置文件，不碰用户的 ~/.config/magpie-terminal/config.json。

import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { startServer } from "../src/server/http.mjs";

const dir = await mkdtemp(path.join(os.tmpdir(), "mt-config-probe-"));
const file = path.join(dir, "config.json");
process.env.MAGPIE_TERMINAL_CONFIG_PATH = file;

const port = 3483;
const handle = await startServer({ port, log: () => {} });
const base = `http://127.0.0.1:${port}`;
const headers = { "x-magpie-term-token": handle.token };

const out = [];
const show = (label, status, body) => {
  out.push(`--- ${label}`);
  out.push(`HTTP ${status}`);
  out.push(JSON.stringify(body));
};

async function call(method, body) {
  const response = await fetch(`${base}/api/config`, {
    method,
    headers: method === "GET" ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

out.push(`configPath = ${file}`);
out.push("");

let r = await call("GET");
show("GET /api/config（文件不存在 → 四个默认值）", r.status, r.body);

r = await call("PUT", {
  autonomy: "loose",
  allowlist: [{ pattern: "mkdir", mode: "prefix", enabled: true }],
  reviewModel: "commandcode/deepseek/deepseek-v4.1-flash",
  basePrompt: "你是我的私人助理。",
});
show("PUT /api/config（四个合法值）", r.status, r.body);

r = await call("GET");
show("GET /api/config（回读，应与 PUT 一致）", r.status, r.body);

for (const [label, body] of [
  ["PUT INVALID_AUTONOMY", { autonomy: "yolo" }],
  ["PUT INVALID_ALLOWLIST（不是数组）", { allowlist: "mkdir" }],
  ["PUT INVALID_ALLOWLIST（pattern 超 500）", { allowlist: [{ pattern: "x".repeat(501), mode: "prefix", enabled: true }] }],
  ["PUT INVALID_REVIEW_MODEL", { reviewModel: 42 }],
  ["PUT INVALID_BASE_PROMPT", { basePrompt: "x".repeat(8001) }],
]) {
  r = await call("PUT", body);
  show(label, r.status, r.body);
}

out.push("");
out.push("--- 落盘文件内容");
out.push(await readFile(file, "utf8"));

console.log(out.join("\n"));

await handle.close();
