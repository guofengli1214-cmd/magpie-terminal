// 插件入口：只负责懒起服务。顶层零副作用。
// 宿主从不调用任何关闭回调，因此这里不提供关闭方法，也不注册进程信号。
// 唯一清理点是 SessionManager 里的 process.on("exit") 同步 kill。

let started = null;

// 上一次的 magpie 宿主退出时会带走自己的插件服务，但它松手有几秒延迟：
// 新宿主若在这一刻启动，绑定会撞上 EADDRINUSE。直接失败会让页面永久打不开
// （宿主只调一次 server()），所以这里像 page-chat 一样每秒重试。
const RETRY_DELAY_MS = 1000;
const MAX_ATTEMPTS = 120;

async function start(options) {
  const { startServer } = await import("./src/server/http.mjs");
  const port = options && Number.isFinite(Number(options.port)) ? Number(options.port) : 3480;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const handle = await startServer({ port, shell: options && options.shell });
      console.log(`[magpie-terminal] listening on http://127.0.0.1:${handle.port}`);
      return handle;
    } catch (err) {
      if (err && err.code === "PORT_IN_USE" && attempt < MAX_ATTEMPTS) {
        console.log(`[magpie-terminal] ${port} 还被上一次的宿主占着，${RETRY_DELAY_MS}ms 后重试（第 ${attempt} 次）`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
}

export default {
  id: "magpie-terminal",
  server: async (input, options) => {
    // 内部单飞：并发 / 重复调用共用同一个 Promise。
    if (!started) {
      started = start(options || {}).catch((err) => {
        // 宿主会把抛出的错误当成插件崩掉，所以吞掉，只记一条。
        const code = err && err.code === "PORT_IN_USE" ? "PORT_IN_USE" : "SERVER_START_FAILED";
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            code,
            msg: "failed to start magpie-terminal server",
            err: err && err.message ? err.message : String(err),
          }),
        );
        started = null;
        return null;
      });
    }
    await started;
    return {};
  },
};
