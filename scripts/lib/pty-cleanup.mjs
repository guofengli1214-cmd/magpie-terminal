// 探针脚本共用的「干净收尾」。
//
// 为什么需要它：Windows ConPTY 的 kill 是**异步**的 —— `kill()` 返回时 pseudoconsole
// 还没关完，进程要 ~1.07s 才真正消失（pty-lifecycle.md §4，FLUSH_DATA_INTERVAL=1000）。
// 探针如果在 kill 后立刻 `process.exit()`，console 句柄会在下一代进程里继续占着，
// 连跑几轮就会撞上 ConPTY 的上限：
//   `fatal error - console device allocation failure - too many consoles in use, max consoles is 128`
// 一旦撞上，后面所有 PTY 都建不出 shell，表现为「测试莫名其妙全挂」。
// 所以每个探针收尾必须：关会话 → 等 onExit → 等足 >1.1s 让原生 teardown 落定。

/** ConPTY 关掉后到真正释放 console 的等待时间（>1.1s，见 pty-lifecycle.md §4）。 */
export const CONSOLE_RELEASE_MS = 1400;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 关掉服务上所有本机会话，并等到它们真的退出。
 *
 * @param {{sessions?: Map<string, object>, whenExited?: Function, close?: Function, killAllSync?: Function}} sessions
 *   SessionManager（handle.sessions）
 */
export async function drainSessions(sessions) {
  if (!sessions || typeof sessions !== "object") return;
  const ids = sessions.sessions instanceof Map ? [...sessions.sessions.keys()] : [];
  const pending = [];
  for (const id of ids) {
    try {
      const session = sessions.get(id);
      if (session && typeof sessions.whenExited === "function") {
        pending.push(sessions.whenExited(session, 5000).catch(() => false));
      }
      sessions.close(id);
    } catch {
      // 已经关掉 / 已退出都忽略。
    }
  }
  await Promise.all(pending);
  // 即便 onExit 已经到达，原生 teardown 还要 ~1.07s。
  await sleep(CONSOLE_RELEASE_MS);
}

/** 关服务 + 释放 console（探针 finally 里调用）。 */
export async function shutdown(handle) {
  if (!handle) return;
  try {
    await drainSessions(handle.sessions);
  } catch {
    // 忽略。
  }
  try {
    await handle.close();
  } catch {
    // 忽略。
  }
  await sleep(CONSOLE_RELEASE_MS);
}
