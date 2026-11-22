// 插件入口：只负责懒起服务。顶层零副作用。
// 宿主从不调用任何关闭回调，因此这里不提供关闭方法，也不注册进程信号。
// 唯一清理点是 SessionManager 里的 process.on("exit") 同步 kill。

let started = null;

async function start(options) {
  const { startServer } = await import("./src/server/http.mjs");
  const port = options && Number.isFinite(Number(options.port)) ? Number(options.port) : 3480;
  const handle = await startServer({ port, shell: options && options.shell });
  console.log(`[magpie-terminal] listening on http://127.0.0.1:${handle.port}`);
  return handle;
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
