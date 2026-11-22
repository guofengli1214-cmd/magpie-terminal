// 孤儿进程检查。
// 用法（CLI）：node scripts/check-orphans.mjs [--wait 5000] [--pid 123 --name bash.exe ...]
// 库用法：import { checkOrphans } from "./check-orphans.mjs"
//
// 判据：进程表中不存在「同 pid 且同名」的条目。只断言 pid 会因 pid 复用误判，所以同时匹配进程名。

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PS_SCRIPT =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name " +
  "| ConvertTo-Json -Compress";

/** 读取完整进程表。 */
export async function readProcessTable() {
  const powershell = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const { stdout } = await execFileAsync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
    { timeout: 30000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
  );
  const text = String(stdout || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  return [parsed];
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{pids: number[], names?: Record<number,string>, waitMs?: number, aliveBeforeWait?: number}} opts
 * @returns {Promise<{orphans: object[], checked: number, waitedMs: number, aliveBeforeWait: number, table: object[]}>}
 */
export async function checkOrphans(opts) {
  const pids = Array.isArray(opts.pids) ? opts.pids.filter((p) => Number.isFinite(p)) : [];
  const names = opts.names || {};
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 5000;

  // 防空转：先确认这些 pid 在等待前真的存在，否则「没查到孤儿」没有意义。
  // 调用方如果在关闭会话之前已经确认过存活数，可以传 aliveBeforeWait 跳过这一步。
  let aliveBeforeWait = Number.isFinite(opts.aliveBeforeWait) ? opts.aliveBeforeWait : null;
  if (aliveBeforeWait === null && pids.length > 0) {
    const beforeTable = await readProcessTable();
    aliveBeforeWait = 0;
    for (const pid of pids) {
      const found = beforeTable.find((row) => Number(row.ProcessId) === Number(pid));
      const expected = names[pid];
      if (!found) continue;
      if (expected && String(found.Name).toLowerCase() !== String(expected).toLowerCase()) continue;
      aliveBeforeWait += 1;
    }
  }
  if (pids.length > 0) await sleep(waitMs);
  if (aliveBeforeWait === null) aliveBeforeWait = 0;

  const table = await readProcessTable();
  const orphans = [];
  for (const pid of pids) {
    const found = table.find((row) => Number(row.ProcessId) === Number(pid));
    if (!found) continue;
    const expected = names[pid];
    if (expected && String(found.Name).toLowerCase() !== String(expected).toLowerCase()) continue;
    orphans.push({ pid, name: found.Name, ppid: found.ParentProcessId });
  }

  return {
    orphans,
    checked: pids.length,
    waitedMs: pids.length > 0 ? waitMs : 0,
    aliveBeforeWait,
    table,
  };
}

/** 找出父进程在给定 pid 集合中的子进程（用于「magpie-bun 的子 shell」排查）。 */
export async function findChildrenOf(parentPids) {
  const parents = new Set(parentPids.map((p) => Number(p)));
  const table = await readProcessTable();
  return table.filter((row) => parents.has(Number(row.ParentProcessId)));
}

function parseArgs(argv) {
  const result = { pids: [], names: {}, waitMs: 5000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--wait") {
      result.waitMs = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--pid") {
      const pid = Number(argv[i + 1]);
      if (Number.isFinite(pid)) result.pids.push(pid);
      i += 1;
    } else if (arg === "--name") {
      const name = argv[i + 1];
      if (result.pids.length > 0) result.names[result.pids[result.pids.length - 1]] = name;
      i += 1;
    }
  }
  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.pids.length === 0) {
    const table = await readProcessTable();
    // 没有指定 pid 时给出所有 shell 进程的 pid/ppid 表，供人工核对。
    const shells = table.filter((row) => /^(bash|powershell|pwsh|node|conhost)\.exe$/i.test(String(row.Name)));
    console.log(JSON.stringify({ mode: "table", shells }, null, 2));
    process.exit(0);
  }
  const result = await checkOrphans(args);
  const summary = {
    orphans: result.orphans.length,
    checked: result.checked,
    aliveBeforeWait: result.aliveBeforeWait,
    waitedMs: result.waitedMs,
    details: result.orphans,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(result.orphans.length === 0 ? 0 : 1);
}
