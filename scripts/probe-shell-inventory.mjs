// AC1 证据脚本：打印本机实际探测到的 shell 清单 + 各来源的原始探测输出。
//
// 用法（仓库根）：node scripts/probe-shell-inventory.mjs [--json]
// 只读探测，不改配置、不起服务。
//
// 输出分两段：
//   1) sources —— 每个来源的原始输出（wsl -l -q 的 hex / UTF-16LE 解码、WT settings.json 摘录）
//   2) shells  —— detectShells() 的最终清单（即 GET /api/shells 的数据源）

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BUILTIN_SHELL_IDS,
  decodeWslOutput,
  detectShells,
  isValidShellId,
  parseWslDistroList,
  resetShellsCache,
  SHELL_ID_MAX,
} from "../src/pty/shells.mjs";

resetShellsCache();

const out = [];
const say = (line = "") => out.push(line);

/* ---------------------------------------------------------------- 来源原始输出 */
say("===== 1. 来源原始输出 =====");

const comspec = process.env.COMSPEC || "";
const cmdFallback = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\cmd.exe`;
say(`COMSPEC = ${JSON.stringify(comspec)} (exists: ${existsSync(comspec)})`);
say(`cmd 回落 = ${JSON.stringify(cmdFallback)} (exists: ${existsSync(cmdFallback)})`);
try {
  const ver = execFileSync(comspec || cmdFallback, ["/d", "/c", "ver"], {
    encoding: "buffer",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // cmd 的输出是 OEM 码页，只取 ASCII 的版本号部分。
  say(`cmd /d /c ver utf8 = ${JSON.stringify(ver.toString("utf8"))}`);
  say(`cmd /d /c ver hex    = ${ver.toString("hex")}`);
} catch (err) {
  say(`cmd /d /c ver FAILED = ${err && err.message}`);
}

say("");
try {
  const buf = execFileSync("wsl.exe", ["-l", "-q"], {
    encoding: "buffer",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  say(`wsl.exe -l -q  bytes   = ${buf.length}`);
  say(`wsl.exe -l -q  hex     = ${buf.toString("hex")}`);
  say(`wsl.exe -l -q  utf8    = ${JSON.stringify(buf.toString("utf8"))}`);
  say(`wsl.exe -l -q  utf16le = ${JSON.stringify(buf.toString("utf16le"))}`);
  say(`wsl.exe -l -q  decodeWslOutput = ${JSON.stringify(decodeWslOutput(buf))}`);
  say(`wsl.exe -l -q  parseWslDistroList = ${JSON.stringify(parseWslDistroList(buf))}`);
} catch (err) {
  say(`wsl.exe -l -q FAILED = ${err && err.code ? err.code : err && err.message}`);
}

say("");
try {
  const buf = execFileSync("wsl.exe", ["--version"], {
    encoding: "buffer",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  say(`wsl.exe --version decodeWslOutput = ${JSON.stringify(decodeWslOutput(buf))}`);
} catch (err) {
  say(`wsl.exe --version FAILED = ${err && err.code ? err.code : err && err.message}`);
}

say("");
const wtPath = path.join(
  process.env.LOCALAPPDATA || "",
  "Packages",
  "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
  "LocalState",
  "settings.json",
);
say(`WT settings.json = ${JSON.stringify(wtPath)} (exists: ${existsSync(wtPath)})`);
if (existsSync(wtPath)) {
  const text = readFileSync(wtPath, "utf8");
  say(`WT settings.json bytes = ${Buffer.byteLength(text, "utf8")}`);
  say("WT settings.json profiles.list（原始片段）:");
  const match = /"profiles"\s*:\s*\{[\s\S]*?"list"\s*:\s*\[([\s\S]*?)\n\s*\]/.exec(text);
  say(match ? match[1].trim() : "(未能用正则截出 list，下面给全文前 2000 字符)");
  if (!match) say(text.slice(0, 2000));
}

/* ---------------------------------------------------------------- 最终清单 */
say("");
say("===== 2. detectShells() 最终清单（GET /api/shells 的数据源） =====");

const shells = detectShells();
const rows = shells.map((item) => ({
  id: item.id,
  name: item.name,
  group: item.group,
  available: item.available,
  version: item.version,
  path: item.path,
  args: item.args,
  detail: item.detail ?? null,
  idLength: item.id.length,
  idValid: isValidShellId(item.id),
}));

say(`count = ${rows.length}`);
for (const row of rows) {
  say(JSON.stringify(row));
}

/* ---------------------------------------------------------------- 自检 */
say("");
say("===== 3. 自检 =====");
const ids = rows.map((row) => row.id);
const problems = [];
for (const id of BUILTIN_SHELL_IDS) {
  if (!ids.includes(id)) problems.push(`缺少内置 id: ${id}`);
}
if (new Set(ids).size !== ids.length) problems.push("id 有重复");
/** WindowsApps 下的 pwsh.exe 是「应用执行别名」：existsSync 报 EACCES，但能 exec。 */
function existsOrAlias(filePath) {
  if (!filePath) return false;
  if (existsSync(filePath)) return true;
  if (/(\\|^)WindowsApps(\\|$)/i.test(filePath)) {
    try {
      const out = execFileSync(filePath, ["-NoLogo", "-NoProfile", "-Command", "'ok'"], {
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return String(out).includes("ok");
    } catch {
      return false;
    }
  }
  return false;
}

for (const row of rows) {
  if (!row.idValid) problems.push(`id 不合法: ${row.id}`);
  if (row.id.length > SHELL_ID_MAX) problems.push(`id 超长: ${row.id} (${row.id.length})`);
  if (!["local", "wsl", "profile"].includes(row.group)) problems.push(`group 异常: ${row.id} → ${row.group}`);
  if (row.available && !row.path) problems.push(`available:true 但 path 为空: ${row.id}`);
  if (row.available && !existsOrAlias(row.path)) problems.push(`available:true 但 path 不能执行: ${row.id} → ${row.path}`);
}
const availableIds = rows.filter((row) => row.available).map((row) => row.id);
say(`available ids = ${JSON.stringify(availableIds)}`);
say(`groups = ${JSON.stringify(rows.reduce((acc, row) => ({ ...acc, [row.group]: (acc[row.group] || 0) + 1 }), {}))}`);
say(problems.length === 0 ? "SELF-CHECK OK" : `SELF-CHECK PROBLEMS:\n${problems.join("\n")}`);

const wantJson = process.argv.includes("--json");
if (wantJson) console.log(JSON.stringify({ sources: out, shells: rows, problems }, null, 2));
else console.log(out.join("\n"));

process.exit(problems.length === 0 ? 0 : 1);
