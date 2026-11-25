// 静态护栏：破坏性命令的目标是不是「这条命令有权动的东西」（TASK-FIX17-J R4）。
//
// 为什么要有它：R1 把黑名单分了两层，普通黑名单交给 AI 审阅按对话意图判定。
// 可审阅模型只读文本，它没法知道 `rm -rf D:\photos` 到底在不在工作目录里、
// 对话里到底提没提过。于是再加一道**不依赖 AI** 的闸门：
//   - 目标在工作目录树内 → 放行（用户自己的项目，删了也是他自己的事）
//   - 目标在工作目录外，但对话里点名过（basename 出现在历史文本里）→ 放行
//   - 盘根 / 家目录 / 工作目录本身或它的祖先 / 通配符 → 永远拦
// 两道闸门（审阅 + 护栏）是独立的：审阅说「符合意图」也不能替护栏开口子。
//
// 本模块只读：只 stat / readdir 一层，绝不 touch、绝不创建、绝不打开目标文件。
// 任何 IO 异常只让对应字段变成 null，**不许**因此让护栏失败（那会把正常删除全卡死）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandHeads, positionalTargets, splitOnSeparators, tokenize } from "./forbidden.mjs";

/** 会改动 / 删除目标的命令头。只有它们才需要护栏。 */
export const DESTRUCTIVE_HEADS = new Set(["rm", "rmdir", "del", "erase", "mv", "move", "cp", "copy"]);

/** 目标里出现这些字符时静态解析不出来（变量 / 通配符 / 家目录缩写）→ 按「读不出来」处理。 */
const UNRESOLVABLE_TARGET_RE = /[*?$`%~]/;

/** 把路径折成比较用的形态：Windows 大小写不敏感，统一小写。 */
function fold(p) {
  return String(p).toLowerCase();
}

function resolveAgainst(cwd, target) {
  const base = typeof cwd === "string" && cwd.trim().length > 0 ? path.resolve(cwd) : process.cwd();
  return path.resolve(base, String(target));
}

/** target 是否就是 base 或 base 的后代（大小写不敏感）。 */
export function isInsideCwd(resolved, cwd) {
  const base = typeof cwd === "string" && cwd.trim().length > 0 ? path.resolve(cwd) : process.cwd();
  const rel = path.relative(fold(base), fold(resolved));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** target 是否就是 base 本身。 */
export function isSamePath(resolved, other) {
  return fold(path.resolve(String(resolved))) === fold(path.resolve(String(other)));
}

/** target 是否是 cwd 的严格祖先（或 cwd 本身）。 */
export function isCwdOrAncestor(resolved, cwd) {
  const base = typeof cwd === "string" && cwd.trim().length > 0 ? path.resolve(cwd) : process.cwd();
  const rel = path.relative(fold(resolved), fold(base)); // cwd 相对 target
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 盘根（`/`、`C:\`、`D:/`）。 */
export function isDriveRoot(resolved) {
  const text = path.resolve(String(resolved));
  return fold(path.parse(text).root) === fold(text);
}

/**
 * 从一条命令里抽出破坏性命令的**目标**（原始参数，未解析成绝对路径）。
 *
 * @param {unknown} command
 * @returns {{heads: boolean, targets: string[], targetsUnresolved: boolean}}
 *   heads            命令里是否有 rm/mv/del/... 这类命令头
 *   targets          位置参数（已跳过 `-x` 与 cmd 的 `/s` `/q` `/f` 一类开关）
 *   targetsUnresolved 目标里含通配符 / 变量，或该段根本读不出目标
 */
export function extractDestructiveTargets(command) {
  const empty = { heads: false, targets: [], targetsUnresolved: false };
  try {
    if (typeof command !== "string") return empty;
    const raw = command.replace(/\s+/g, " ").trim();
    if (raw.length === 0) return empty;
    const heads = commandHeads(tokenize(raw).flatMap(splitOnSeparators));

    let sawDestructive = false;
    let unresolved = false;
    const targets = [];
    for (const item of heads) {
      const head = fold(item.head);
      if (!DESTRUCTIVE_HEADS.has(head)) continue;
      sawDestructive = true;
      const positional = positionalTargets(item.args);
      if (positional.length === 0) {
        // `rm -rf` 后面什么都没有、或目标全被当成开关剥掉了：读不出来。
        unresolved = true;
        continue;
      }
      for (const target of positional) {
        if (UNRESOLVABLE_TARGET_RE.test(target)) unresolved = true;
        targets.push(target);
      }
    }
    return { heads: sawDestructive, targets, targetsUnresolved: unresolved };
  } catch {
    // 解析抛错：当「读不出来」处理（更保守），但heads=false 时不影响判级。
    return empty;
  }
}

/** 一句话说清楚这类目标为什么必须人工确认。 */
function blockedReasonFor(kind, resolved) {
  switch (kind) {
    case "root":
      return `这条命令会动到盘根 ${resolved}，删掉它等于毁掉整块盘，只能你自己确认`;
    case "home":
      return `这条命令会动到家目录 ${resolved}，只能你自己确认`;
    case "cwd":
      return `这条命令会动到整个工作目录 ${resolved}（不是它里面的某个文件），需要你确认`;
    case "outside":
      return `这条命令会动到工作目录以外的 ${resolved}，你在对话里也没提过它，需要你确认`;
    case "unknown":
      return `这条命令的目标 ${resolved} 含通配符或变量，读不出具体是哪些文件，需要你确认`;
    default:
      return `这条命令的目标 ${resolved} 无法确认，需要你确认`;
  }
}

/**
 * 静态护栏：破坏性命令的每个目标都必须「在工作目录内」或「对话里点名过」，
 * 且不能是盘根 / 家目录 / 工作目录本身或它的祖先 / 通配符。
 *
 * @param {{targets?: string[], cwd?: string, historyText?: string, targetsUnresolved?: boolean}} input
 *   historyText 是对**全量**对话历史序列化后的文本（serializeHistoryForReview 的结果）；
 *   targetsUnresolved 来自 extractDestructiveTargets（通配符 / 变量读不出目标）。
 * @returns {{ok: boolean, reason: string|null, blocked: string[]}}
 */
export function guardTargets({ targets, cwd, historyText, targetsUnresolved } = {}) {
  const list = Array.isArray(targets) ? targets.filter((item) => typeof item === "string" && item.length > 0) : [];
  const base = typeof cwd === "string" && cwd.trim().length > 0 ? path.resolve(cwd) : process.cwd();
  const history = typeof historyText === "string" ? fold(historyText) : "";
  const home = path.resolve(os.homedir());

  if (list.length === 0) {
    if (targetsUnresolved === true) {
      return {
        ok: false,
        reason: "这条命令里删除/移动的目标是通配符或变量，读不出具体是哪些文件，需要你确认",
        blocked: [],
      };
    }
    // 没有破坏性目标：不该拦（`cp` 之类完全没参数时会走到这里）。
    return { ok: true, reason: null, blocked: [] };
  }

  const blocked = [];
  let reason = null;
  const block = (target, kind, resolved) => {
    blocked.push(target);
    if (reason === null) reason = blockedReasonFor(kind, resolved);
  };

  for (const target of list) {
    let resolved;
    try {
      resolved = resolveAgainst(base, target);
    } catch {
      block(target, "unknown", target);
      continue;
    }

    // 通配符 / 变量：静态判不出范围，一律人工。
    if (UNRESOLVABLE_TARGET_RE.test(target)) {
      // 用原始目标回报（`~` / `$TARGET` 解析成绝对路径后反而看不懂）。
      block(target, "unknown", target);
      continue;
    }

    if (isDriveRoot(resolved)) {
      block(target, "root", resolved);
      continue;
    }
    if (isSamePath(resolved, home)) {
      block(target, "home", resolved);
      continue;
    }
    if (isCwdOrAncestor(resolved, base)) {
      // cwd 本身与它的祖先：删掉就等于删掉用户正在干活的整个目录。
      block(target, "cwd", resolved);
      continue;
    }

    const inside = isInsideCwd(resolved, base);
    const name = fold(path.basename(resolved));
    const mentioned = name.length >= 3 && history.includes(name);
    if (inside || mentioned) continue;

    block(target, "outside", resolved);
  }

  if (targetsUnresolved === true) {
    // 命令里只要有一段的目标读不出来，整条命令的范围就是未知的 → 保守拦下。
    return {
      ok: false,
      reason:
        reason ||
        "这条命令里删除/移动的目标是通配符或变量，读不出具体是哪些文件，需要你确认",
      blocked,
    };
  }
  return { ok: blocked.length === 0, reason, blocked };
}

/**
 * 目标事实（**纯读**，给审阅模型看「这个目录是空的还是有一堆东西」）。
 *
 * 任何一步失败只把对应字段置 null，绝不让护栏失败：
 * 空文件夹是用户最想自动放行的场景，不能因为 readdir 权限问题反而卡住。
 *
 * @param {string[]} targets 原始目标参数
 * @param {string} cwd
 * @returns {{targets: Array<{path: string, exists: boolean, type: "file"|"dir"|"missing",
 *            entries: number|null, bytes: number|null, insideCwd: boolean}>, emptyDirs: number}}
 */
export function targetFacts(targets, cwd) {
  const list = Array.isArray(targets) ? targets.filter((item) => typeof item === "string" && item.length > 0) : [];
  const base = typeof cwd === "string" && cwd.trim().length > 0 ? path.resolve(cwd) : process.cwd();
  const facts = [];
  for (const target of list) {
    let resolved;
    let insideCwd = false;
    try {
      resolved = resolveAgainst(base, target);
      insideCwd = isInsideCwd(resolved, base);
    } catch {
      continue;
    }
    const fact = { path: resolved, exists: false, type: "missing", entries: null, bytes: null, insideCwd };

    let stat = null;
    try {
      stat = fs.statSync(resolved, { throwIfNoEntry: false });
    } catch {
      stat = null;
    }

    if (stat) {
      fact.exists = true;
      if (stat.isDirectory()) {
        fact.type = "dir";
        try {
          fact.entries = fs.readdirSync(resolved).length;
        } catch {
          fact.entries = null;
        }
      } else {
        fact.type = "file";
        fact.bytes = Number.isFinite(stat.size) ? stat.size : null;
      }
    }
    facts.push(fact);
  }
  const emptyDirs = facts.filter((fact) => fact.type === "dir" && fact.entries === 0).length;
  return { targets: facts, emptyDirs };
}
