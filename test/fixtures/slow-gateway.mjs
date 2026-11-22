// 慢网关：接到请求后永不响应（直到被 abort）。用于验证 GATEWAY_TIMEOUT。

import http from "node:http";
import { fileURLToPath } from "node:url";

export function startSlowGateway(port = 0) {
  const server = http.createServer((req) => {
    // 刻意什么都不做：不写头、不结束。
    req.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen({ host: "127.0.0.1", port }, () => resolve({ server, port: server.address().port }));
  });
}

// 注意：node --test 会把 test/ 下所有文件当成测试文件执行；在测试运行器里不能自己 listen。
const isMain =
  !process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.argv[2] || 3492);
  startSlowGateway(port).then(({ port: actual }) => {
    console.log(`slow-gateway listening on ${actual}`);
  });
}
