// TASK-FIX17-M R2：`GET /icon.svg` 的「真服务」测试。
//
// 为什么必须起真服务：断言对象是 HTTP 响应头与响应体（流式输出），
// 纯函数层看不到 `content-length` / `cache-control` 是否真的写出去了。
// 隔离手段与 `logs-route.test.mjs` 一致：随机空闲端口 + 静默 logger，
// 不抢真实插件占用的 3480，也不建第二个日志 writer。
//
// 五个断言共用一个服务：`server.close()` 要等 keep-alive 连接自己断掉
// （fetch 默认复用连接），一条一服务会让 5 条用例白白多等十几秒。
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const { startServer } = await import("../../src/server/http.mjs");

/** 静默 logger：`writer: null` 让单测不碰真实日志目录。 */
function quietLog() {
  const log = () => {};
  log.writer = null;
  return log;
}

test("GET /icon.svg：页面图标路由（R2）", async (t) => {
  const port = await freePort();
  const handle = await startServer({ port, log: quietLog() });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-magpie-term-token": handle.token };
  t.after(() => handle.close());

  await t.test("200 image/svg+xml，内容就是页面图标", async () => {
    const response = await fetch(`${base}/icon.svg`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /image\/svg\+xml/);

    const body = await response.text();
    assert.ok(
      body.startsWith("<svg"),
      `图标正文应以 <svg 开头，实际开头：${JSON.stringify(body.slice(0, 40))}`,
    );
    // 与 page/icon.svg 的前景色一致：被改回别的颜色这条会红。
    assert.ok(body.includes("#4ade80"), "图标应使用 #4ade80 前景色");
  });

  await t.test("带 no-store 与 nosniff（与静态资源同一套头）", async () => {
    const response = await fetch(`${base}/icon.svg`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  await t.test("沙箱 iframe 的 Origin: null 也能取到（CORS 头不能缺）", async () => {
    const response = await fetch(`${base}/icon.svg`, { headers: { origin: "null" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "null");
  });

  await t.test("不带 token 也返回 200（图标不是敏感资源）", async () => {
    const response = await fetch(`${base}/icon.svg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /image\/svg\+xml/);
  });

  await t.test("大写 /ICON.SVG 返回 404：大小写严格，别引入大小写不敏感匹配", async () => {
    const response = await fetch(`${base}/ICON.SVG`, { headers });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.code, "NOT_FOUND");
  });

  await t.test("/icon.svg/ 与 /icons.svg 也 404（不做前缀/子路径匹配）", async () => {
    for (const pathname of ["/icon.svg/", "/icons.svg"]) {
      const response = await fetch(`${base}${pathname}`, { headers });
      assert.equal(response.status, 404, `${pathname} 应当 404`);
    }
  });
});
