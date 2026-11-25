// 硬禁止清单（PROTOCOL-AGENT.md §8），TASK-FIX17-J R1 起分两层。
//
//   灾难级 catastrophic：任何档位、任何白名单、AI 审阅都不能自动放行。
//   普通黑名单 blacklist ：默认要确认，但「AI 审阅 + 静态护栏」都通过时可以自动跑。
//
// 两层共用**同一张规则表**（RULES），不许复制两份判定逻辑——复制必然漂移。
// 本模块是纯函数、零 IO、永不抛；拿不准一律返回原因（fail-closed）。
//
// 与 src/policy/classify.mjs 的分工：
// classify() 回答「这条命令是否属于内置只读白名单」；
// forbiddenReason() 回答「这条命令是否连『自动执行』这条路都不许走」。
// 两者互不依赖，judge() 先问 catastrophic，再问白名单，最后才用 blacklist 决定放行口径。
//
// 另外导出 tokenize / splitOnSeparators / commandHeads / positionalTargets 给
// src/policy/destructive-targets.mjs 复用（那里要解析删除目标，不许再抄一份切词）。
//
// TASK-V3-D-FIX1 修复 2（m1）：硬禁止只看**每段的命令头**，不再对整条命令的
// 任意 token 做匹配。否则 `npm run format`、`git commit -m "fix reboot bug"`、
// `rg shutdown src/`、`grep -rn "sudo" docs/` 这些日常命令会被误拦，
// 且白名单也绕不过。切段规则：`;` `&&` `||` `|` `&` 都算下一段的开始，
// 每段的第一个 token（跳过 env/xargs/eval 这类包装器）才是命令头。

import path from "node:path";
import os from "node:os";

/** 把任意空白压成一个空格并按此切词；引号剥掉（`rm -rf '/'` 与 `rm -rf /` 等价）。 */
export function tokenize(command) {
  return String(command)
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((token) => {
      let t = token;
      if (t.length >= 2) {
        const first = t[0];
        const last = t[t.length - 1];
        if ((first === "'" || first === '"') && last === first) t = t.slice(1, -1);
      }
      return t;
    })
    .filter((token) => token.length > 0);
}

/** 段分隔符：& 系的词与 | 系的词都算「下一条命令开始」。 */
function isSeparator(token) {
  return token === "&&" || token === "||" || token === "|" || token === ";" || token === "&";
}

/**
 * 把紧贴着的分隔符切开：`ls&&sudo rm` 只有空白切词的话是一个 token，
 * 切段就漏了。这里在 token 内部再切一道，并把分隔符自己作为独立 token 保留。
 * `2>&1` / `foo &> log` 这类重定向不切（`&` 前是 `>` 或后是 `>` 就当字面量）。
 * @param {string} token
 * @returns {string[]}
 */
export function splitOnSeparators(token) {
  const out = [];
  let buffer = "";
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "&") {
      const prev = i > 0 ? token[i - 1] : "";
      const next = i + 1 < token.length ? token[i + 1] : "";
      if (next === "&") {
        if (buffer) {
          out.push(buffer);
          buffer = "";
        }
        out.push("&&");
        i += 1;
        continue;
      }
      if (prev === ">" || next === ">") {
        buffer += ch;
        continue;
      }
      if (buffer) {
        out.push(buffer);
        buffer = "";
      }
      out.push("&");
      continue;
    }
    if (ch === "|") {
      if (buffer) {
        out.push(buffer);
        buffer = "";
      }
      if (token[i + 1] === "|") {
        out.push("||");
        i += 1;
      } else {
        out.push("|");
      }
      continue;
    }
    if (ch === ";") {
      if (buffer) {
        out.push(buffer);
        buffer = "";
      }
      out.push(";");
      continue;
    }
    buffer += ch;
  }
  if (buffer) out.push(buffer);
  return out;
}

/**
 * 把 tokens 按 `;` `&&` `||` `|` `&` 切成若干段，每段是一条命令。
 *
 * 注意 `2>&1` 这类重定向不以分隔符开头，所以不会被切错。
 * @param {string[]} tokens
 * @returns {string[][]}
 */
function splitSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (isSeparator(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** `/bin/rm` → `rm`（保留原有「带路径的命令也算同一个命令」的行为）。 */
function basenameOf(token) {
  return String(token).split(/[/\\]/).pop();
}

/**
 * 透传型包装器：`env chmod …`、`xargs rm …`、`eval rm …` 里的第二段才是真正的命令。
 * 只用于「跳过前缀」，不改变 §8 的覆盖范围。
 */
const WRAPPERS = new Set(["env", "nohup", "time", "nice", "command", "exec", "eval", "xargs", "busybox"]);

/**
 * 该段的命令头在段内的下标（跳过包装器及其选项 / VAR=val / 纯数字参数）。
 * @param {string[]} segment
 * @returns {number} -1 表示该段没有可识别的命令头
 */
function headIndex(segment) {
  let i = 0;
  while (i < segment.length) {
    if (!WRAPPERS.has(basenameOf(segment[i]))) return i;
    i += 1;
    while (i < segment.length) {
      const token = segment[i];
      if (token.startsWith("-") || /^\d+$/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        i += 1;
        continue;
      }
      break;
    }
  }
  return -1;
}

/** 该段命令头的名字（已去路径）；没有命令头返回空串。 */
function headOf(segment) {
  const i = headIndex(segment);
  return i < 0 ? "" : basenameOf(segment[i]);
}

/** 该段的命令头参数（从命令头之后开始）。 */
function headArgs(segment) {
  const i = headIndex(segment);
  return i < 0 ? [] : segment.slice(i + 1);
}

/** 每段的 { head, args } 视图。 */
export function commandHeads(tokens) {
  return splitSegments(tokens).map((segment) => ({
    segment,
    head: headOf(segment),
    args: headArgs(segment),
  }));
}

/** 某条命令（head）后面是否出现过匹配 flagRe 的参数。 */
function hasFlagFor(heads, head, flagRe) {
  for (const item of heads) {
    if (item.head !== head) continue;
    for (const arg of item.args) {
      if (flagRe.test(arg)) return true;
    }
  }
  return false;
}

/** `head sub …` 形式的子命令后面是否出现过匹配 flagRe 的参数。 */
function subcommandHasFlag(heads, head, sub, flagRe) {
  for (const item of heads) {
    if (item.head !== head) continue;
    if (item.args.length === 0 || item.args[0] !== sub) continue;
    for (const arg of item.args.slice(1)) {
      if (flagRe.test(arg)) return true;
    }
  }
  return false;
}

/** `head sub` 是否出现（例如 `reg delete`）。 */
function hasSubcommand(heads, head, sub) {
  for (const item of heads) {
    if (item.head !== head) continue;
    if (item.args.length > 0 && item.args[0] === sub) return true;
  }
  return false;
}

/** 任意一段的命令头是否是给定名字之一（允许 `mkfs.ext4` 这种带后缀的形式）。 */
function hasHead(heads, names, { allowDotted = false } = {}) {
  for (const item of heads) {
    if (item.head.length === 0) continue;
    for (const name of names) {
      if (item.head === name) return true;
      if (allowDotted && item.head.startsWith(`${name}.`)) return true;
    }
  }
  return false;
}

/** `init 0` / `init 6` 这种两词组合。 */
function hasInitRunlevel(heads) {
  for (const item of heads) {
    if (item.head !== "init") continue;
    if (item.args.length > 0 && (item.args[0] === "0" || item.args[0] === "6")) return true;
  }
  return false;
}

/** 管道右侧直接执行解释器：`… | sh` / `… | bash` / `… | python` / `… | node`。 */
function pipesIntoInterpreter(command) {
  const normalized = String(command).replace(/\s+/g, " ");
  const parts = normalized.split(/(?<!\|)\|(?!\|)/);
  for (let i = 1; i < parts.length; i += 1) {
    const head = parts[i].trim().split(" ")[0] || "";
    const bare = head.replace(/^["'](.*)["']$/, "$1");
    const base = bare.split(/[/\\]/).pop();
    if (["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3", "node", "perl", "ruby"].includes(base)) {
      return true;
    }
  }
  return false;
}

/** `rm` 的递归删除目标是否落在「危险目标」集合里（§8 表格第三类）。 */
// 全部按归一形态书写：`normalizeDangerTarget()` 会把 `~/`、`$HOME/`、`~/.`、`//`、
// `/./`、`/tmp/../..` 这些写法全部折成下面这几个形态（P1-1）。
const DANGEROUS_RM_TARGETS = new Set(["/", "/*", "~", "~/*", "*", "c:", "c:/*"]);

/**
 * 把删除目标归一成「比较用的形态」（TASK-V4-S §6.4，P1-1）。
 *
 * 为什么要归一：以前集合只认 11 个字面量（`/` `/ *` `~` `$HOME` `C:\` …），
 * 带尾斜杠、`$HOME/`、`~/.`、`//`、`/./`、`/tmp/../..` 全部漏判
 * （VERIFY-V4-G §4 P1-1 实测 11/11 漏判）。
 *
 * 规则（顺序不能变）：
 *   1. 去首尾空白与成对引号
 *   2. `\` → `/`
 *   3. 小写
 *   4. `$home` / `${home}` / `%userprofile%` → `~`
 *   5. 折叠连续 `/`（`//` → `/`），并把尾部的 `/**` 折成 `/*`
 *   6. 反复去掉尾部 `/` 与末尾 `/.`
 *   7. 用 path.posix.normalize 处理 `..`（`/tmp/../..` → `/`、`$HOME//x/..` → `~`）
 *   8. `//` 已经是 `/`；`..` 开头的形态不在本函数内判，由 `isDangerousRmTarget()` 当危险处理
 *
 * `/**` 与 `/*` 归一后同一个形态（第 5 步的尾部折叠）。
 *
 * @param {unknown} target
 * @returns {string}
 */
export function normalizeDangerTarget(target) {
  let text = String(target === undefined || target === null ? "" : target).trim();
  // 1) 成对引号（`rm -rf '/'` 与 `rm -rf /` 等价）。
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" || first === '"') && last === first) text = text.slice(1, -1).trim();
  }
  // 2) 反斜杠统一成正斜杠。
  text = text.replace(/\\/g, "/");
  // 3) 小写。
  text = text.toLowerCase();
  // 4) 家目录变量的各种写法。
  text = text.replace(/\$\{home\}/g, "~").replace(/\$home/g, "~").replace(/%userprofile%/g, "~");
  // 5) 折叠连续斜杠（`//` → `/`），但保留开头的 `//`（UNC 风格）供第 8 步判定。
  const leadingDouble = text.startsWith("//");
  text = text.replace(/\/{2,}/g, "/");
  // 5b) 通配符尾斜杠：`/**` / `~/**` 与 `/*` / `~/*` 是同一回事，
  //     先在尾部折叠一次（否则下面的尾斜杠规则碰不到它，`/**` 会原样漏网）。
  text = text.replace(/\/\*\*$/, "/*");
  // 6) 反复去尾部 `/` 与 `/.`。`~/` → `~`，`~/.` → `~`，`/./` → `/`。
  let previous = null;
  while (previous !== text) {
    previous = text;
    // `/.` 就是根、`~/.` 就是家目录：先折它们，否则 `/./` 会被尾部斜杠规则削成空串。
    if (text === "/.") {
      text = "/";
      continue;
    }
    if (text === "~/.") {
      text = "~";
      continue;
    }
    if (text.length > 2 && text.endsWith("/.")) {
      text = text.slice(0, -2);
      continue;
    }
    if (text.length > 1 && text.endsWith("/")) {
      text = text.slice(0, -1);
      continue;
    }
  }
  // 7) `..` 归一。只对纯 POSIX 形式走 posix.normalize（`~` 开头的交给第 6 步的规则）。
  if (text.startsWith("/")) {
    // path.posix 只做字符串处理，不碰文件系统，跨平台行为一致（`/tmp/../..` → `/`）。
    text = path.posix.normalize(text);
  } else if (text.startsWith("~/")) {
    // `~` 开头的也要处理 `..`：`$HOME//x/..` 折成 `~`（家目录本身，属危险目标）。
    const rest = path.posix.normalize(text.slice(1));
    text = rest === "/" || rest.length === 0 ? "~" : `~${rest}`;
  }
  // 再跑一次尾部清理：posix.normalize('/tmp/../..') 在部分平台上会留下尾斜杠形态。
  if (text.length > 1 && text.endsWith("/")) text = text.slice(0, -1);
  if (text === "/.") text = "/";
  // 8) `//`（UNC/盘根变体）统一成 `/`；`..` 开头交给 isDangerousRmTarget 判危险。
  if (leadingDouble && text === "/") return "/";
  return text;
}

/**
 * 归一后落在集合里 / 明显是向上越界的（`..` 开头 / UNC 盘根）都算危险目标。
 * @param {unknown} target
 * @returns {boolean}
 */
export function isDangerousRmTarget(target) {
  const t = normalizeDangerTarget(target);
  if (DANGEROUS_RM_TARGETS.has(t)) return true;
  // 归一后仍是 `..` 开头（`rm -rf ../../..` 这种向上跑到根）：按危险处理。
  if (t === ".." || t.startsWith("../")) return true;
  // 只有盘符（`c:` / `d:`）：那是盘根。
  if (/^[a-z]:$/.test(t)) return true;
  return false;
}

/**
 * cmd / PowerShell 删除用的加严判据：除了根与家目录，**家目录的父级**也算危险。
 *
 * 为什么单独开一条：Windows 上 `%USERPROFILE%` 是 `C:\Users\<名字>`，
 * `del /s C:\Users` 会把所有用户的桌面 / 文档一起删（P1-1 的 F11 就是这条）。
 * 它不等于家目录，但删掉它比删家目录更坏，所以归到同一级。
 *
 * 只在删除命令上用它，不影响 `chmod`/`chown`（那两条不需要这条加严）。
 *
 * @param {unknown} target
 * @returns {boolean}
 */
export function isDangerousDeleteTarget(target) {
  if (isDangerousRmTarget(target)) return true;
  const t = normalizeDangerTarget(target);
  const home = normalizeDangerTarget(os.homedir());
  if (t === home) return true;
  const parentOfHome = normalizeDangerTarget(path.dirname(os.homedir()));
  // 盘根（`c:/` 归一后是 `c:`）与家目录父级：删它们等于删掉整台机器的用户数据。
  if (parentOfHome.length > 1 && t === parentOfHome) return true;
  return false;
}

function isRecursiveRmFlag(token) {
  if (token === "--recursive") return true;
  if (!token.startsWith("-")) return false;
  if (token.startsWith("--")) return false;
  return /r/i.test(token.slice(1));
}

/**
 * 递归删除 + 危险目标：只看每段命令头是不是 rm（参数里出现 rm 不算）。
 *
 * 目标先过 `normalizeDangerTarget()`（P1-1）：`~/` `$HOME/` `~/.` `//` `/**` `/./`
 * `/tmp/../..` 全部折成集合里的形态。
 *
 * 另外补上「`rm -rf /` 不带 -r 但也写全了根」这类变体？不需要 —— rm 不带递归就删不掉目录，
 * 保留递归前置条件能避开 `rm -f /tmp/../x` 这类正常用法。
 */
function destroysDangerousTarget(heads) {
  for (const item of heads) {
    if (item.head !== "rm" && item.head !== "rm.exe") continue;
    let recursive = false;
    const targets = [];
    for (const arg of item.args) {
      if (isRecursiveRmFlag(arg)) {
        recursive = true;
        continue;
      }
      if (arg.startsWith("-")) continue;
      targets.push(arg);
    }
    if (recursive && targets.some(isDangerousRmTarget)) return true;
  }
  return false;
}

/** 参数里是否有任一命中 flagRe 的项（不分命令头，用于 cmd/PowerShell 风格）。 */
function argsHave(args, flagRe) {
  for (const arg of args) {
    if (flagRe.test(String(arg))) return true;
  }
  return false;
}

/** 参数里的位置目标（非 `-` / `/` 开头的选项；cmd 风格 `/s` `/q` 跳过）。 */
export function positionalTargets(args) {
  const out = [];
  for (const arg of args) {
    const text = String(arg);
    if (text.startsWith("-")) continue;
    // cmd 的选项是 `/s` `/q` `/f`；但盘根 `/` 与路径 `/tmp` 也是斜杠开头。
    // 判据：单字母斜杠项当选项，其余当路径（`/` 本体与 `/` 开头带字母的路径都保留）。
    if (/^\/[A-Za-z]{1,2}$/.test(text)) continue;
    out.push(text);
  }
  return out;
}

/**
 * cmd 的 `rd` / `rmdir`（带 `/s`）与 `del` / `erase`（带 `/s`）。
 *
 * 为什么单开一条：这些命令的命令头不是 rm，以前完全不在硬禁止覆盖面内
 * （P1-1 实测 `rd /s /q C:\`、`del /f /s /q C:\Users` 都返回 null）。
 * 均为「粗筛 + 复用 normalizeDangerTarget」：宁可多确认不可漏。
 */
function destroysWindowsTarget(heads) {
  for (const item of heads) {
    const head = item.head.toLowerCase();
    if (head !== "rd" && head !== "rmdir" && head !== "del" && head !== "erase") continue;
    // `/s` 大小写不敏感（cmd 习惯 /S）。
    const recursive = argsHave(item.args, /^\/[sS]$/);
    if (!recursive) continue;
    if (positionalTargets(item.args).some(isDangerousDeleteTarget)) return true;
  }
  return false;
}

/**
 * PowerShell 的 `Remove-Item` / `ri` / `del`：带 `-Recurse`（或 `-r`）且目标是
 * 盘根 / 家目录 / `*` → 危险。
 *
 * PowerShell 的选项大小写与缩写都很多（`-Recurse` `-Recurse:$true` `-r`），
 * 所以用「前两个字母是 r- 开头的已知形式」做粗筛，不枚举全部。
 */
function destroysPowerShellTarget(heads) {
  for (const item of heads) {
    // PowerShell cmdlet 名大小写不敏感（`Remove-Item` / `remove-item` 同一回事）。
    const head = item.head.toLowerCase();
    if (head !== "remove-item" && head !== "ri" && head !== "del" && head !== "rmdir") continue;
    const recursive = argsHave(item.args, /^-(recurse|r)(:.+)?$/i);
    if (!recursive) continue;
    if (positionalTargets(item.args).some(isDangerousDeleteTarget)) return true;
  }
  return false;
}

/**
 * `chmod` / `chown` 的目标是根（`/` 或 `/*`）时判危险，**无论有没有 `-R`**。
 *
 * 以前只挡 `chmod -R`：`chmod 777 /` 不带 -R 时返回 null（P1-1 已复现）。
 * `chmod 777 /` 确实不会递归，但它会把根目录本身改成全开 —— 用户迟早会被挡在外面，
 * 属「不可撤销且影响全盘」，不值得放行。
 */
function changesRootPermission(heads) {
  for (const item of heads) {
    if (item.head !== "chmod" && item.head !== "chown") continue;
    for (const target of positionalTargets(item.args)) {
      const t = normalizeDangerTarget(target);
      // `777` 这种模式串归一后不变，进不了集合，不会误伤。
      if (t === "/" || t === "/*") return true;
    }
  }
  return false;
}

/**
 * 规则表：**唯一**的判定来源。
 *
 * 每条规则：
 *   tier   "catastrophic" = 灾难级（永远人工） / "blacklist" = 可审阅黑名单
 *   reason 命中的中文原因（给用户看）
 *   test   判定函数，入参 c = { heads, raw }
 *
 * 顺序即优先级（同层内先命中先返回）。层与层之间由下面三个导出函数各自过滤，
 * 所以灾难级永远先于普通黑名单被问到（judge 也是这个顺序）。
 *
 * 以前这里是一串顺序 `if`；改成表以后加规则只要加一行，且不可能出现
 * 「灾难级漏了一条、黑名单多了一条」这种两份逻辑不一致。
 */
const RULES = Object.freeze([
  // ---------------------------------------------------------------- 灾难级
  { tier: "catastrophic", reason: "提权命令（sudo）", test: (c) => hasHead(c.heads, ["sudo"]) },
  { tier: "catastrophic", reason: "提权命令（su）", test: (c) => hasHead(c.heads, ["su"]) },
  { tier: "catastrophic", reason: "提权命令（runas）", test: (c) => hasHead(c.heads, ["runas"]) },
  { tier: "catastrophic", reason: "提权命令（doas）", test: (c) => hasHead(c.heads, ["doas"]) },
  { tier: "catastrophic", reason: "提权命令（pkexec）", test: (c) => hasHead(c.heads, ["pkexec"]) },

  {
    tier: "catastrophic",
    reason: "磁盘格式化命令（mkfs）",
    test: (c) => hasHead(c.heads, ["mkfs"], { allowDotted: true }),
  },
  { tier: "catastrophic", reason: "磁盘写入命令（dd）", test: (c) => hasHead(c.heads, ["dd"]) },
  { tier: "catastrophic", reason: "磁盘分区命令（diskpart）", test: (c) => hasHead(c.heads, ["diskpart"]) },
  { tier: "catastrophic", reason: "磁盘格式化命令（format）", test: (c) => hasHead(c.heads, ["format"]) },
  { tier: "catastrophic", reason: "磁盘分区命令（fdisk）", test: (c) => hasHead(c.heads, ["fdisk"]) },
  { tier: "catastrophic", reason: "磁盘分区命令（parted）", test: (c) => hasHead(c.heads, ["parted"]) },

  {
    tier: "catastrophic",
    reason: "递归删除根目录或家目录（rm -rf / ~）",
    test: (c) => destroysDangerousTarget(c.heads),
  },
  {
    tier: "catastrophic",
    reason: "递归删除盘根或家目录（rd /s、del /s）",
    test: (c) => destroysWindowsTarget(c.heads),
  },
  {
    tier: "catastrophic",
    reason: "递归删除盘根或家目录（Remove-Item -Recurse）",
    test: (c) => destroysPowerShellTarget(c.heads),
  },

  {
    tier: "catastrophic",
    reason: "修改根目录权限（chmod / chown /）",
    test: (c) => changesRootPermission(c.heads),
  },
  { tier: "catastrophic", reason: "接管文件所有权（takeown）", test: (c) => hasHead(c.heads, ["takeown"]) },
  { tier: "catastrophic", reason: "修改文件权限（icacls）", test: (c) => hasHead(c.heads, ["icacls"]) },

  { tier: "catastrophic", reason: "关机命令（shutdown）", test: (c) => hasHead(c.heads, ["shutdown"]) },
  { tier: "catastrophic", reason: "重启命令（reboot）", test: (c) => hasHead(c.heads, ["reboot"]) },
  { tier: "catastrophic", reason: "关机命令（halt）", test: (c) => hasHead(c.heads, ["halt"]) },
  { tier: "catastrophic", reason: "关机命令（poweroff）", test: (c) => hasHead(c.heads, ["poweroff"]) },
  { tier: "catastrophic", reason: "切换运行级别（init 0/6）", test: (c) => hasInitRunlevel(c.heads) },

  {
    tier: "catastrophic",
    reason: "把下载内容直接管道给解释器执行",
    test: (c) => pipesIntoInterpreter(c.raw),
  },

  {
    tier: "catastrophic",
    reason: "删除 Windows 注册表项（reg delete）",
    test: (c) => hasSubcommand(c.heads, "reg", "delete"),
  },

  // ---------------------------------------------------------------- 普通黑名单
  // 这些**可以**被 AI 审阅按对话意图放行（前提：静态护栏也通过）。
  {
    tier: "blacklist",
    reason: "递归修改权限（chmod -R）",
    test: (c) => hasFlagFor(c.heads, "chmod", /^-[a-zA-Z]*R[a-zA-Z]*$/),
  },
  {
    tier: "blacklist",
    reason: "递归修改所有者（chown -R）",
    test: (c) => hasFlagFor(c.heads, "chown", /^-[a-zA-Z]*R[a-zA-Z]*$/),
  },
  {
    tier: "blacklist",
    reason: "git 强制推送（--force）",
    test: (c) => subcommandHasFlag(c.heads, "git", "push", /^--force(-with-lease)?$/),
  },
  {
    tier: "blacklist",
    reason: "git 强制推送（-f）",
    test: (c) => subcommandHasFlag(c.heads, "git", "push", /^-[a-zA-Z]*f[a-zA-Z]*$/),
  },
  {
    tier: "blacklist",
    reason: "git 丢弃本地改动（reset --hard）",
    test: (c) => subcommandHasFlag(c.heads, "git", "reset", /^--hard$/),
  },
  {
    tier: "blacklist",
    reason: "git 删除未跟踪文件（clean -fd）",
    test: (c) => subcommandHasFlag(c.heads, "git", "clean", /^-[a-zA-Z]*f[a-zA-Z]*$/),
  },
]);

/** 判定过程异常时的原因（fail-closed）：两层都当命中，绝不放行。 */
export const UNDECIDABLE_REASON = "命令无法安全判定";

/**
 * 在指定层上跑规则表。异常一律 fail-closed。
 *
 * @param {unknown} command
 * @param {ReadonlyArray<string>} tiers 允许跑的层
 * @returns {string|null}
 */
function lookup(command, tiers) {
  try {
    if (typeof command !== "string") return null;
    const raw = command.replace(/\s+/g, " ").trim();
    if (raw.length === 0) return null;
    const tokens = tokenize(raw).flatMap(splitOnSeparators);
    // 只看每段的命令头：参数、引号内的文字不再参与匹配（修复 2）。
    const ctx = { heads: commandHeads(tokens), raw };
    for (const rule of RULES) {
      if (!tiers.includes(rule.tier)) continue;
      if (rule.test(ctx)) return rule.reason;
    }
    return null;
  } catch {
    // 判定过程异常：按禁止处理（fail-closed），而不是放行。
    return UNDECIDABLE_REASON;
  }
}

/**
 * 灾难级禁止：任何档位、任何白名单、AI 审阅都**不能**自动放行。
 *
 * @param {unknown} command
 * @returns {string|null} 命中返回中文原因（给用户看），未命中返回 null
 */
export function catastrophicReason(command) {
  return lookup(command, ["catastrophic"]);
}

/**
 * 普通黑名单：默认要确认，但 AI 审阅说「符合对话意图」且静态护栏通过时可以自动执行。
 *
 * @param {unknown} command
 * @returns {string|null}
 */
export function blacklistReason(command) {
  return lookup(command, ["blacklist"]);
}

/**
 * 硬禁止判定（向后兼容：两层之或）。
 *
 * 语义与拆分前完全一致：`forbiddenReason(cmd) !== null` 仍是「这条命令不许自动走」。
 * judge 用的是更细的 catastrophicReason / blacklistReason，这里保留给旧调用方与旧测试。
 *
 * @param {unknown} command
 * @returns {string|null} 命中返回中文原因（给用户看），未命中返回 null
 */
export function forbiddenReason(command) {
  return catastrophicReason(command) || blacklistReason(command);
}
