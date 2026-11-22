// 假网关：任何请求都返回 500。用于验证 GATEWAY_HTTP_500 且不挂住。

import http from "node:http";
import { fileURLToPath } from "node:url";

export function startFakeGateway500(port = 0) {
  const server = http.createServer((req, res) => {
    req.resume();
    const body = JSON.stringify({ error: { message: "fake gateway always fails" } });
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
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
  const port = Number(process.argv[2] || 3491);
  startFakeGateway500(port).then(({ port: actual }) => {
    console.log(`fake-gateway-500 listening on ${actual}`);
  });
}
