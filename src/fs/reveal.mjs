// 「打开所在文件夹」的落地（TASK-FIX17-L1 R6）。
//
// 为什么 spawn 必须可注入：这条路径会真的弹出资源管理器窗口。单测如果直接
// `spawn("explorer.exe", …)`，一次 `node --test` 会弹出几十个窗口，还会在 CI
// （无桌面会话）上留下僵尸进程。所以 `revealPath()` 只做「算 argv + 调注入的
// spawn」，参数对不对是纯函数的断言对象。
//
// Windows 的 `explorer.exe /select,<path>` 有三个坑（都在这里处理）：
//   ① 参数是**一个**整体（`/select,` 与路径不能拆成两个 argv）；
//   ② 路径里有逗号时 explorer 会按「下一段」理解 —— 我们只传一条参数，
//      末尾的逗号不会造成分裂（explorer 只按第一个逗号切分）；
//   ③ 目录不能用 `/select,`（会打开父目录），目录本身就够了。

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

/**
 * `target` 是否落在 `dir` 之内（含 dir 本身）。
 *
 * 用 `path.relative` 而不是字符串前缀：`C:\a\downloads2` 以 `C:\a\downloads`
 * 为前缀，但不是子路径 —— 前缀判断会把它放进来。
 *
 * @param {string} dir 已归一的绝对目录
 * @param {string} target 用户给的路径（相对路径视为不合法）
 * @returns {boolean}
 */
export function isPathInside(dir, target) {
  if (typeof dir !== "string" || dir.length === 0) return false;
  if (typeof target !== "string" || target.length === 0) return false;
  if (!path.isAbsolute(target)) return false;
  const base = path.resolve(dir);
  const resolved = path.resolve(target);
  const rel = path.relative(base, resolved);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  return !path.isAbsolute(rel);
}

/**
 * 算「打开所在文件夹」的命令与参数（纯函数，单测的主断言对象）。
 *
 * @param {string} target 已经确认落在下载目录内的绝对路径
 * @param {{platform?:string, isDirectory?:boolean}} [opts]
 * @returns {{command:string, args:string[]}}
 */
export function revealArgv(target, opts = {}) {
  const platform = opts.platform || process.platform;
  const isDirectory = opts.isDirectory === true;
  // 按**目标平台**的路径语义 resolve：在 Windows 上用 path.resolve 会把
  // `/home/x/dl/a.txt` 变成 `C:\\home\\x\\dl\\a.txt`，单测就无法验证 POSIX 分支。
  const paths = platform === "win32" ? path.win32 : path.posix;
  const resolved = paths.resolve(String(target || ""));
  if (platform === "win32") {
    return {
      command: "explorer.exe",
      // 文件 → `/select,<path>`（在资源管理器里选中它）；目录 → 目录本身。
      args: [isDirectory ? resolved : `/select,${resolved}`],
    };
  }
  if (platform === "darwin") {
    return { command: "open", args: isDirectory ? [resolved] : ["-R", resolved] };
  }
  // Linux / 其它：xdg-open 只能开目录，文件就先开它所在目录。
  return { command: "xdg-open", args: [isDirectory ? resolved : paths.dirname(resolved)] };
}

/**
 * 打开 `target` 所在文件夹。
 *
 * `spawnImpl` 可注入（单测断言 argv、不真开窗口）。返回的句柄已经 `unref()`
 * 并 `detached`，所以文件管理器窗口不会把服务进程拖住。
 *
 * @param {string} target
 * @param {{spawnImpl?:Function, platform?:string, isDirectory?:boolean}} [opts]
 * @returns {{ok:true, command:string, args:string[]}}
 */
export function revealPath(target, opts = {}) {
  const spawnImpl = typeof opts.spawnImpl === "function" ? opts.spawnImpl : nodeSpawn;
  const { command, args } = revealArgv(target, opts);
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  if (child && typeof child.unref === "function") child.unref();
  return { ok: true, command, args };
}
