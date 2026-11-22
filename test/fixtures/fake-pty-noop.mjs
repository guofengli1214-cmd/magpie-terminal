// fabricated-positive fixture：一个假 PTY，永远返回空输出。
// 断言 assertContains(它的输出, "M-2") 必须抛错 —— 证明 doctor 的断言不是恒真。

export function createFakePtyNoop() {
  const listeners = new Set();
  const exitListeners = new Set();
  return {
    pid: 424242,
    onData(fn) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    onExit(fn) {
      exitListeners.add(fn);
      return { dispose: () => exitListeners.delete(fn) };
    },
    // 故意什么都不发：空输出。
    emit() {
      // no-op
    },
    write() {},
    resize() {},
    kill() {},
  };
}

/** 只会「收到什么就返回什么」的假 PTY：用来证明断言能区分空输出。 */
export function collectFakePtyOutput(fake, ms = 20) {
  return new Promise((resolve) => {
    const chunks = [];
    fake.onData((chunk) => chunks.push(chunk));
    setTimeout(() => resolve(chunks.join("")), ms);
  });
}

export default createFakePtyNoop;
