// 本机可用 shell 的枚举 + 按 id 解析（TASK-V4-F §5.1）。
//
// 只有三个 id：bash（git bash，含 msys）、powershell（Windows PowerShell 5.1）、
// pwsh（PowerShell 7）。不做 WSL / cmd.exe / 自定义路径（卡片 §3 非目标）。
//
// 与 bridge.mjs 的关系：`detectShell()` 保持不动（/api/health 还在用），
// 这里通过 `findMsysBash()` 复用同一套 git bash 探测，通过 `detectShell()`
// 复用同一套「默认 shell」判定，避免两套逻辑漂移。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { detectShell, findMsysBash } from "./bridge.mjs";

/** 对外承认的 shell id（顺序即 UI 顺序）。 */
export const SHELL_IDS = Object.freeze(["bash", "pwsh", "powershell"]);

const VERSION_TIMEOUT_MS = 3000;

/** 展示名。`session.created.shell.name` 直接用它（PowerShell 字样要在里面）。 */
const SHELL_NAMES = Object.freeze({
  bash: "bash",
  pwsh: "PowerShell 7",
  powershell: "PowerShell 5",
});

let shellsCache = null;

function runCommand(path, args) {
  try {
    const out = execFileSync(path, args, {
      timeout: VERSION_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return String(out || "");
  } catch (err) {
    // 超时 / 非零退出都只当作「读不到版本」：stdout 里可能已经有一半结果。
    const stdout = err && err.stdout ? String(err.stdout) : "";
    const stderr = err && err.stderr ? String(err.stderr) : "";
    return stdout || stderr || "";
  }
}

function parseVersion(text) {
  const match = /(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/.exec(String(text || ""));
  return match ? match[1] : "unknown";
}

/** `pwsh` 的三个候选位置（卡片 §5.1 的顺序）+ PATH 兜底。
 *  这里不预先过滤不存在/不可 stat 的路径：可用性靠「试跑能不能拿到版本号」判（见 detectPwsh）。 */
function pwshCandidates() {
  const list = [];
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  if (local) list.push(`${local}\\Microsoft\\WindowsApps\\pwsh.exe`);
  if (pf) list.push(`${pf}\\PowerShell\\7\\pwsh.exe`);
  const pathValue = process.env.PATH || "";
  for (const dir of pathValue.split(";")) {
    if (!dir) continue;
    const candidate = `${dir.replace(/[\\/]+$/, "")}\\pwsh.exe`;
    if (!list.includes(candidate)) list.push(candidate);
  }
  return list;
}

function detectBash() {
  const found = findMsysBash();
  if (!found) {
    return {
      id: "bash",
      name: SHELL_NAMES.bash,
      version: "unknown",
      path: "",
      args: [],
      available: false,
    };
  }
  return {
    id: "bash",
    name: SHELL_NAMES.bash,
    version: found.version,
    path: found.path,
    args: [],
    available: true,
  };
}

function detectPowerShell() {
  const win = process.env.SystemRoot || "C:\\Windows";
  const path = `${win}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (!existsSync(path)) {
    return {
      id: "powershell",
      name: SHELL_NAMES.powershell,
      version: "unknown",
      path,
      args: ["-NoLogo"],
      available: false,
    };
  }
  const out = runCommand(path, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()",
  ]);
  const version = parseVersion(out);
  return {
    id: "powershell",
    name: SHELL_NAMES.powershell,
    version,
    path,
    args: ["-NoLogo"],
    // 探测超时 / 失败时版本是 unknown，但可执行文件在 → 仍算可用（卡片：失败不抛）。
    available: true,
  };
}

function detectPwsh() {
  for (const candidate of pwshCandidates()) {
    // 不能用 existsSync 筛：WindowsApps 里的 pwsh.exe 是「应用执行别名」，
    // existsSync / stat 会报 EACCES，但 execFileSync 能正常跑。
    // 所以直接试跑一次：拿得到版本号才算可用。
    const out = runCommand(candidate, [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ]);
    const version = parseVersion(out);
    if (version === "unknown") continue;
    return {
      id: "pwsh",
      name: SHELL_NAMES.pwsh,
      version,
      path: candidate,
      args: ["-NoLogo"],
      available: true,
    };
  }
  return {
    id: "pwsh",
    name: SHELL_NAMES.pwsh,
    version: "unknown",
    path: "",
    args: ["-NoLogo"],
    available: false,
  };
}

/**
 * 本机三条 shell 的实测结果（进程内缓存一次；每个 shell 只探测一次）。
 *
 * @returns {Array<{id:string, name:string, version:string, path:string, args:string[], available:boolean}>}
 */
export function detectShells() {
  if (shellsCache) return shellsCache;
  const all = [detectBash(), detectPwsh(), detectPowerShell()];
  // 顺序按 SHELL_IDS 归一，不受探测代码顺序影响。
  shellsCache = SHELL_IDS.map((id) => all.find((item) => item.id === id));
  return shellsCache;
}

/** 单条 shell 的原始记录（可能 available:false）。 */
export function shellRecord(id) {
  return detectShells().find((item) => item.id === id) || null;
}

/**
 * 按 id 解析出一个能 spawn 的 shell。不可用 / 不认识的 id → null。
 * @param {string} id
 */
export function resolveShellById(id) {
  if (typeof id !== "string" || id.length === 0) return null;
  const record = shellRecord(id);
  if (!record || !record.available) return null;
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    path: record.path,
    args: record.args,
    // 与 bridge.detectShell() 的返回形状对齐：SessionManager / health 都读这个字段。
    fallback: false,
  };
}

/** 自动探测的默认 shell（与 /api/health 的 shell 同一来源）。 */
export function detectDefaultShell() {
  const detected = detectShell({});
  const plainName = String(detected && detected.name ? detected.name : "");
  let id = null;
  if (/bash/i.test(plainName)) id = "bash";
  else if (/powershell|pwsh/i.test(plainName)) {
    // bridge 的回退分支只产出 PowerShell 5（pwsh 不在它的候选里）。
    id = /7/.test(plainName) ? "pwsh" : "powershell";
  }
  return {
    id,
    name: detected.name,
    version: detected.version,
    path: detected.path,
    args: detected.args || [],
    fallback: Boolean(detected.fallback),
  };
}

/**
 * 解析「这次创建会话该用哪个 shell」。
 *
 * 顺序（卡片 §5.2）：`shellId` → `config.defaultShell` → `MAGPIE_TERMINAL_SHELL`
 * → `detectShell()`。后两者由 `detectDefaultShell()` 一起兜住（bridge 自己认环境变量）。
 *
 * 显式给了 `shellId` 但不可用 → `{ok:false, code:"PTY_UNKNOWN_SHELL"}`（由 ws 层
 * 翻成 session.failed）。配置里的 defaultShell 不可用时**不报错**，退回自动探测：
 * 换机器 / 卸掉 pwsh 不该让用户连终端都开不出来。
 *
 * @param {{shellId?: string|null, defaultShell?: string|null}} [input]
 * @returns {{ok:true, shell:object}|{ok:false, code:string, userText:string}}
 */
export function resolveShellForRequest(input = {}) {
  const shellId = input ? input.shellId : null;
  if (typeof shellId === "string" && shellId.length > 0) {
    const shell = resolveShellById(shellId);
    if (shell) return { ok: true, shell };
    return {
      ok: false,
      code: "PTY_UNKNOWN_SHELL",
      userText: `没有可用的 ${shellId}，或本机没装这个 shell。`,
    };
  }

  const configured = input ? input.defaultShell : null;
  if (typeof configured === "string" && configured.length > 0) {
    const shell = resolveShellById(configured);
    if (shell) return { ok: true, shell };
  }

  return { ok: true, shell: detectDefaultShell() };
}

/** 给测试用：清空探测缓存（环境变量 / 安装状态变化后重新读）。 */
export function resetShellsCache() {
  shellsCache = null;
}
