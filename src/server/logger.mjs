// 插件自有日志文件（TASK-FIX17-E R2）：写 %LOCALAPPDATA%\magpie\logs\show-terminal.log。
//
// 为什么不用宿主的 app.log：那是所有插件共用的一个文件（实测已数 MB），
// 出问题时要在一堆别人的行里捞自己那几行；而且我们没有清理它的权限。
// 自有一份文件才能做「导出 / 清空 / 轮转」。
//
// 三条硬约束（违反等于白做）：
//   ① **落地即安全**：写盘前的每一条记录都过 `redact()`，不指望导出时才补救；
//   ② **写盘失败不许影响服务**：日志是旁路，`warn` 一次就静默降级到 stdout；
//   ③ **轮转只留一份**：单文件 2MB，超出后改名 `.1`，旧 `.1` 直接覆盖
//      （不做时间轮转：只需要「别把磁盘写满」）。
//
// 路径用 `LOCALAPPDATA` 现算（不写死用户名），测试/探针可用
// `MAGPIE_TERMINAL_LOG_DIR` 指到临时目录，避免污染用户的真实日志。

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { redact } from "./log-redact.mjs";

export const LOG_FILE_NAME = "show-terminal.log";
export const LOG_ROTATED_NAME = `${LOG_FILE_NAME}.1`;
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** 测试与探针用：不设时不生效（生产永远走 LOCALAPPDATA）。 */
export const LOG_DIR_ENV = "MAGPIE_TERMINAL_LOG_DIR";

/** `%LOCALAPPDATA%\magpie\logs`（非 Windows 回落家目录，仅为可单测）。 */
export function defaultLogDir() {
  const override = process.env[LOG_DIR_ENV];
  if (typeof override === "string" && override.length > 0) return override;
  const base =
    typeof process.env.LOCALAPPDATA === "string" && process.env.LOCALAPPDATA.length > 0
      ? process.env.LOCALAPPDATA
      : os.homedir();
  return path.join(base, "magpie", "logs");
}

function safeStat(file) {
  try {
    const info = statSync(file);
    return { bytes: info.size, mtime: info.mtime.toISOString() };
  } catch {
    return { bytes: 0, mtime: null };
  }
}

/**
 * 建一个日志写入器。
 *
 * @param {{dir?: string, maxBytes?: number, warn?: (message: string) => void}} [options]
 */
export function createLogWriter(options = {}) {
  const dir = options.dir || defaultLogDir();
  const file = path.join(dir, LOG_FILE_NAME);
  const rotated = path.join(dir, LOG_ROTATED_NAME);
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : MAX_LOG_BYTES;
  const warn = typeof options.warn === "function" ? options.warn : (message) => console.warn(message);

  let dirReady = false;
  let warned = false;
  let failed = false;

  function ensureDir() {
    if (dirReady) return true;
    mkdirSync(dir, { recursive: true });
    dirReady = true;
    return true;
  }

  /** 只在写之前判一次：超了就改名（先删旧 `.1`，只留一份备份）。 */
  function rotateIfNeeded() {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return false;
    }
    if (size < maxBytes) return false;
    try {
      rmSync(rotated, { force: true });
      renameSync(file, rotated);
      return true;
    } catch {
      // 轮转失败（文件被占等）不能挡住这一条日志：继续追加，下一轮再试。
      return false;
    }
  }

  function fail(err) {
    failed = true;
    if (warned) return;
    warned = true;
    // 只 warn 一次：日志写不进去是环境问题，刷屏只会让真正的错误更难看到。
    try {
      warn(`[magpie-terminal] log file unavailable, falling back to stdout: ${err && err.message ? err.message : err}`);
    } catch {
      // 连 warn 都失败就彻底放弃（绝不让日志把调用点炸掉）。
    }
  }

  return {
    dir,
    file,
    rotatedFile: rotated,
    maxBytes,
    /** 单行（不含换行）追加；`line` 必须已经脱敏且序列化好。 */
    write(line) {
      try {
        ensureDir();
        rotateIfNeeded();
        appendFileSync(file, `${line}\n`, "utf8");
        failed = false;
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    /** `{ bytes, mtime, rotatedBytes, maxBytes }`；文件不存在时 bytes=0。 */
    status() {
      const main = safeStat(file);
      const backup = safeStat(rotated);
      return {
        file: LOG_FILE_NAME,
        bytes: main.bytes,
        mtime: main.mtime,
        rotatedBytes: backup.bytes,
        rotatedMtime: backup.mtime,
        maxBytes,
        writable: !failed,
      };
    },
    /** 导出用：旧的在前（`.1` → `.log`），原样返回，脱敏由调用方做。 */
    readAll() {
      const parts = [];
      for (const target of [rotated, file]) {
        try {
          if (!existsSync(target)) continue;
          const text = readFileSync(target, "utf8");
          if (text.length > 0) parts.push(text.endsWith("\n") ? text : `${text}\n`);
        } catch {
          // 读不到就跳过：导出能少一段，但不能 500。
        }
      }
      return parts.join("");
    },
    /**
     * 清空（不删文件：Windows 上删除正被追加的文件句柄容易出幺蛾子，
     * 截断成 0 字节效果一样，且下一次写入仍是同一路径）。
     */
    clear() {
      let cleared = 0;
      for (const target of [file, rotated]) {
        try {
          if (!existsSync(target)) continue;
          writeFileSync(target, "", "utf8");
          cleared += 1;
        } catch {
          // 清不掉就跳过（例如被别的进程独占）。
        }
      }
      return cleared;
    },
  };
}

/**
 * 把一条日志记录变成「可以落盘的一行」。
 *
 * - `err` 只保留 `{name, message, stack}`（不把整个错误对象的附加字段带出去）
 * - 整条过 `redact()`（键名 + 字符串内容两条规则）
 * - `JSON.stringify` 失败时退化成最小记录，不抛
 *
 * @param {Record<string, unknown>} entry
 * @param {string} ts
 */
export function formatLogLine(entry, ts) {
  const record = { ts, level: "info", ...entry };
  if (record.msg === undefined) record.msg = "";
  if (record.err && typeof record.err === "object") {
    const err = record.err;
    record.err = { name: err.name, message: err.message, stack: err.stack };
  }
  try {
    return JSON.stringify(redact(record));
  } catch {
    return JSON.stringify({ ts, level: "error", code: "LOG_SERIALIZE_FAILED", msg: "log line dropped" });
  }
}
