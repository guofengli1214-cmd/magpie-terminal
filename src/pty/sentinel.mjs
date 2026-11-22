// 无 PTY 时的哨兵法降级：常驻一个 bash / powershell，每条命令后追加哨兵。
// 没有 TTY，因此全屏程序不可用；这必须由 UI 明示。

import { spawn } from "node:child_process";

let seqCounter = 0;

function markerFor(seq) {
  return `__DONE_${seq}__`;
}

/**
 * @param {object} opts
 * @param {{path:string,name:string}} opts.shell
 * @param {(data:string)=>void} opts.onData
 * @param {(info:{exitCode:number|null, signal:string|null})=>void} opts.onExit
 * @param {(err:Error)=>void} [opts.onError]
 */
export function createSentinelSession(opts) {
  const isBash = !/powershell/i.test(opts.shell.name);
  const args = isBash ? [] : ["-NoLogo", "-NoProfile", "-Command", "-"];
  const child = spawn(opts.shell.path, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let closed = false;
  let pending = "";
  let stdoutBuffer = "";
  const pendingMarkers = new Map();

  function fail(err) {
    if (closed) return;
    if (opts.onError) opts.onError(err);
  }

  child.on("error", fail);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (closed) return;
    stdoutBuffer += chunk;
    let out = "";
    for (;;) {
      const match = /__DONE_(\d+)__(\d+)__/.exec(stdoutBuffer);
      if (!match) break;
      out += stdoutBuffer.slice(0, match.index);
      stdoutBuffer = stdoutBuffer.slice(match.index + match[0].length);
      const seq = Number(match[1]);
      const code = Number(match[2]);
      const entry = pendingMarkers.get(seq);
      if (entry) {
        entry.exitCode = code;
        pendingMarkers.delete(seq);
      }
    }
    if (out.length > 0 && opts.onData) opts.onData(out);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (closed) return;
    if (opts.onData) opts.onData(chunk);
  });

  child.on("exit", (code, signal) => {
    if (closed) return;
    closed = true;
    if (opts.onExit) opts.onExit({ exitCode: code, signal: signal || null });
  });

  const queuedLines = [];

  function flushLine(line) {
    if (closed || !child.stdin.writable) return;
    if (line.length === 0) {
      child.stdin.write("\n");
      return;
    }
    seqCounter += 1;
    const seq = seqCounter;
    pendingMarkers.set(seq, { exitCode: null });
    if (isBash) {
      child.stdin.write(`${line}\nprintf '${markerFor(seq)}%s__\\n' "$?"\n`);
    } else {
      child.stdin.write(`${line}\nWrite-Output ("${markerFor(seq)}" + $LASTEXITCODE + "__")\n`);
    }
  }

  return {
    write(data) {
      if (closed || typeof data !== "string") return;
      pending += data;
      // 终端回车的字节是 \r；哨兵法走管道，把 \r 与 \n 都当行结束符。
      let index = pending.search(/[\r\n]/);
      while (index !== -1) {
        const line = pending.slice(0, index);
        const isCrLf = pending[index] === "\r" && pending[index + 1] === "\n";
        pending = pending.slice(index + (isCrLf ? 2 : 1));
        queuedLines.push(line);
        index = pending.search(/[\r\n]/);
      }
      while (queuedLines.length > 0) flushLine(queuedLines.shift());
    },
    resize() {
      // 无 TTY，尺寸概念不存在；显式 no-op。
    },
    kill() {
      if (closed) return;
      closed = true;
      try {
        child.kill();
      } catch {
        // 已退出则忽略。
      }
    },
    get pid() {
      return child.pid || null;
    },
    get exited() {
      return closed;
    },
  };
}
