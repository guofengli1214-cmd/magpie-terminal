// node-pty 封装与默认 shell 探测。
// 这里只做「拿一个能 spawn 的 PTY / 拿一个可用的 shell」，不做会话注册（见 session.mjs）。

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

export const LOCKED_NODE_PTY_VERSION = "1.2.0-beta.15";

const VERSION_TIMEOUT_MS = 3000;

let shellCache = null;
let ptyCache = null;

function runVersion(path, args) {
  try {
    const out = execFileSync(path, args, {
      timeout: VERSION_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return String(out || "");
  } catch (err) {
    const stdout = err && err.stdout ? String(err.stdout) : "";
    const stderr = err && err.stderr ? String(err.stderr) : "";
    const combined = stdout || stderr;
    return combined ? combined : null;
  }
}

function parseBashVersion(output) {
  const match = /GNU bash, version (\d+\.\d+(?:\.\d+)?)/i.exec(output || "");
  return match ? match[1] : "unknown";
}

function parsePowerShellVersion(output) {
  const match = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(output || "");
  return match ? match[1] : "unknown";
}

function isValidMsysBash(path) {
  if (!path || !existsSync(path)) return false;
  const out = runVersion(path, ["--version"]);
  if (!out) return false;
  if (!/msys/i.test(out)) return false;
  return true;
}

function pathCandidatesForBash() {
  const out = [];
  const pathValue = process.env.PATH || "";
  for (const dir of pathValue.split(";")) {
    if (!dir) continue;
    for (const name of ["bash.exe", "bash"]) {
      const candidate = `${dir.replace(/[\\/]+$/, "")}\\${name}`;
      if (/\\WindowsApps\\/i.test(candidate)) continue;
      if (existsSync(candidate)) out.push(candidate);
    }
  }
  return out;
}

function envBashCandidates() {
  const pf = process.env.ProgramFiles;
  const pf86 = process.env["ProgramFiles(x86)"];
  const local = process.env.LOCALAPPDATA;
  const list = [];
  if (pf) list.push(`${pf}\\Git\\bin\\bash.exe`);
  if (pf86) list.push(`${pf86}\\Git\\bin\\bash.exe`);
  if (local) list.push(`${local}\\Programs\\Git\\bin\\bash.exe`);
  return list;
}

function powerShellInfo() {
  const win = process.env.SystemRoot || "C:\\Windows";
  const path = `${win}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const out = runVersion(path, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()",
  ]);
  return {
    name: "PowerShell（回退）",
    version: out ? parsePowerShellVersion(out) : "unknown",
    path,
    fallback: true,
    args: ["-NoLogo", "-NoProfile"],
  };
}

/**
 * 默认 shell 探测，结果进程内缓存一次。
 * @param {{shell?: string}} [options]
 */
export function detectShell(options = {}) {
  if (shellCache) return shellCache;

  const override = (options && options.shell) || process.env.MAGPIE_TERMINAL_SHELL;
  if (override && String(override).trim()) {
    const path = String(override).trim();
    const out = runVersion(path, ["--version"]);
    shellCache = {
      name: /bash/i.test(path) ? "bash" : path.split(/[\\/]/).pop() || path,
      version: out ? (/(\d+\.\d+\.\d+\S*)/.exec(out)?.[1] || "unknown") : "unknown",
      path,
      fallback: false,
      args: [],
    };
    return shellCache;
  }

  for (const candidate of envBashCandidates()) {
    if (isValidMsysBash(candidate)) {
      const out = runVersion(candidate, ["--version"]) || "";
      shellCache = {
        name: "bash",
        version: parseBashVersion(out),
        path: candidate,
        fallback: false,
        args: [],
      };
      return shellCache;
    }
  }

  for (const candidate of pathCandidatesForBash()) {
    if (isValidMsysBash(candidate)) {
      const out = runVersion(candidate, ["--version"]) || "";
      shellCache = {
        name: "bash",
        version: parseBashVersion(out),
        path: candidate,
        fallback: false,
        args: [],
      };
      return shellCache;
    }
  }

  shellCache = powerShellInfo();
  return shellCache;
}

/**
 * 加载 node-pty 并读取实际版本。
 * 版本不符只作为事实上报，不阻止加载（健康行里如实暴露）。
 */
export function loadNodePty() {
  // 强制降级必须每次都被尊重，不能被缓存掩盖（测试与现场排障都靠它）。
  if (process.env.MAGPIE_TERMINAL_FORCE_SENTINEL === "1") {
    return {
      ok: false,
      module: null,
      version: null,
      reason: "MAGPIE_TERMINAL_FORCE_SENTINEL=1",
    };
  }

  if (ptyCache) return ptyCache;

  try {
    const require = createRequire(import.meta.url);
    const mod = require("node-pty");
    let version = null;
    try {
      version = require("node-pty/package.json").version || null;
    } catch {
      version = null;
    }
    ptyCache = { ok: true, module: mod, version, reason: null };
    return ptyCache;
  } catch (err) {
    ptyCache = {
      ok: false,
      module: null,
      version: null,
      reason: err && err.message ? err.message : String(err),
    };
    return ptyCache;
  }
}

/**
 * spawn 一个真 PTY。失败由调用方映射为 PTY_SPAWN_FAILED。
 */
export function spawnPty(ptyModule, shell, { cols, rows, cwd }) {
  const env = { ...process.env, TERM: "xterm-256color" };
  return ptyModule.spawn(shell.path, shell.args || [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    useConpty: undefined,
  });
}

export function resetShellCache() {
  shellCache = null;
}

export function resetPtyCache() {
  ptyCache = null;
}
