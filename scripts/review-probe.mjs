// AC7 手工验证脚本：对三条命令真调网关做第二 AI 审阅，逐字打印 JSON。
//
// 用法（仓库根）：D:/nodejs/install/node.exe scripts/review-probe.mjs
// 网关地址走 MAGPIE_TERMINAL_GATEWAY_URL，默认 http://127.0.0.1:3425。

import { reviewCommand } from "../src/ai/review.mjs";
import { gatewayBaseUrl } from "../src/ai/gateway.mjs";

const COMMANDS = ["ls -la", "rm -rf build", "sudo rm -rf /"];

const out = [];
out.push(`gateway = ${gatewayBaseUrl()}`);
const startedAll = Date.now();

for (const command of COMMANDS) {
  const startedAt = Date.now();
  const verdict = await reviewCommand({ command, cwd: process.cwd() });
  const durationMs = Date.now() - startedAt;
  out.push(`--- command: ${JSON.stringify(command)}  durationMs=${durationMs}  under8s=${durationMs <= 8000}`);
  out.push(JSON.stringify(verdict));
}

out.push(`totalDurationMs=${Date.now() - startedAll}`);
console.log(out.join("\n"));
