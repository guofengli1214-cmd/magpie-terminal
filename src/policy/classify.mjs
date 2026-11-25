// 命令分级器：纯函数、零 IO、永不抛。
// 唯一的输出是 auto / confirm；任何判不准的分支都落到 confirm（fail-closed）。

import {
  DEFAULT_ALLOWLIST,
  DEFAULT_DENYLIST,
  DANGEROUS_ARGUMENTS,
  PARAM_ARGUMENTS,
} from "./allowlist.mjs";
// 切段只有一份实现（TASK-V4-S §6.2）：用户白名单也用它，两份实现会漂移开新口子。
import { splitSegments } from "./segments.mjs";
import { isSensitivePath } from "./sensitive.mjs";

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 「会吐出文件内容」的只读命令头。
 *
 * `ls` / `dir` / `pwd` / `echo` / `netstat` / `ss` / `ping` / `where`(无参) 都**不在**里面：
 * 它们不吐文件内容，把它们列进来只会造成误伤（`ls ~/.ssh` 看文件名并不泄露密钥）。
 *
 * 注意 `where` 在默认层级软件靠 PARAM_ARGUMENTS 判定，实际吐路径不开内容；
 * 为了与卡 §6.3 的表一致，这里仍包含 `where` / `which` —— 它们只是列路径，
 * 但列出敏感目录下有什么文件本身就是信息泄露，宁可多确认。
 */
const READ_HEADS = new Set(["cat", "type", "head", "tail", "stat", "grep", "where", "which"]);

/**
 * 剥离过无害重定向时给日志/排查用的说明（TASK-FIX17-H R1）。
 *
 * **只用于展示，不参与 decision**：分级只看剥离后的 `segments`。
 */
export const SAFE_REDIRECT_NOTE = "已忽略无害重定向（2>&1 / /dev/null 一类）";

/** 允许的「多词子命令」最大长度（token 数）。`docker system df` 是 2 词，留到 3 保险。 */
const MAX_SUB_TOKENS = 3;

function verdict(decision, reason, hit) {
  return { decision, reason, hit };
}

/**
 * @param {unknown} command
 * @param {{allowlist?: object, denylist?: object}} [opts]
 * @returns {{decision: "auto"|"confirm", reason: string, hit: string, note: string|null}}
 */
export function classify(command, opts = {}) {
  try {
    if (typeof command !== "string") {
      return { ...verdict("confirm", "输入不是字符串，按危险处理", "invalid-input"), note: null };
    }
    const raw = command.trim();
    if (raw.length === 0) {
      return { ...verdict("confirm", "空命令不执行", "noop"), note: null };
    }

    const allowlist = opts && opts.allowlist ? opts.allowlist : DEFAULT_ALLOWLIST;
    const denylist = opts && opts.denylist ? opts.denylist : DEFAULT_DENYLIST;

    const split = splitSegments(raw);
    if (!split.ok) {
      return { ...verdict("confirm", split.reason, split.hit), note: null };
    }

    // 剥离过无害重定向 → 带一条 note（仅供展示/排查，不参与 decision）。
    const note = split.stripped === true ? SAFE_REDIRECT_NOTE : null;

    let firstAutoHit = null;
    for (const segment of split.segments) {
      const checked = inspectSegment(segment, allowlist, denylist);
      if (!checked.ok) {
        return { ...verdict("confirm", checked.reason, checked.hit), note };
      }
      if (firstAutoHit === null) firstAutoHit = checked.hit;
    }

    return { ...verdict("auto", "只读白名单命中，无需确认", firstAutoHit || "allow"), note };
  } catch {
    return { ...verdict("confirm", "判定过程异常，按危险处理", "exception"), note: null };
  }
}

/** 最小词法器：只认单 / 双引号与反斜杠。 */
function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = "";
  let started = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = "";
      else current += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = "";
      } else if (ch === "\\" && i + 1 < segment.length) {
        current += segment[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      current += segment[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== "") return null;
  if (started) tokens.push(current);
  return tokens;
}

function commandHead(token) {
  const normalized = String(token).replace(/^['"]|['"]$/g, "");
  const parts = normalized.split(/[\\/]/);
  let head = parts[parts.length - 1] || normalized;
  if (head.toLowerCase().endsWith(".exe")) head = head.slice(0, -4);
  return head;
}

/**
 * 把参数规范化成「比较用的名字」：去掉前导连字符，`=` 右侧丢弃。
 * `-delete` / `--delete` -> "delete"；`--files0-from=list` -> "files0-from"。
 * 这样短选项与长选项、带值/不带值写法在判定上必然对称。
 */
function stripDashes(arg) {
  return String(arg).split("=")[0].replace(/^-+/, "");
}

/**
 * 把一个参数解析成「待检查的名字列表」。
 *
 * - `--files0-from=list` -> ["files0-from"]
 * - `-n`                 -> ["n"]
 * - `-ln`（组合短选项）  -> 只有当整名不在允许集时才拆成 ["l","n"]
 *
 * 「整名优先」让 `--pre` 报成 `-pre` 而不是 `-p r e`，错误信息才指得准。
 *
 * @param {string} arg
 * @param {Set<string>} allowed
 * @returns {string[]}
 */
function flagNames(arg, allowed) {
  const name = stripDashes(arg);
  if (!name) return [""];
  // 长选项（--xxx）永不拆分：`--pre` 就是 "pre"，不是 -p -r -e。
  if (String(arg).startsWith("--")) return [name];
  if (allowed.has(name)) return [name];
  // 单连字符且多字符：可能是组合短选项（-ln / -sS）或带值的长名（-max-count）。
  if (name.includes("-")) return [name];
  const chars = name.split("");
  // 每个字符都是允许的单字符选项 → 组合短选项。
  if (chars.length > 1 && chars.every((c) => allowed.has(c))) return chars;
  return [name];
}

/** 参数名是否命中危险表（粗筛）。不做组合拆分。 */
function firstUnsafeArg(args, patterns) {
  if (!patterns) return null;
  for (const arg of args) {
    if (!String(arg).startsWith("-")) continue;
    const name = stripDashes(arg);
    if (name && patterns.includes(name)) return `-${name}`;
  }
  return null;
}

/**
 * 危险参数粗筛（只返回 hit 字符串）。fin 走这里拿 `deny:*`，
 * 其余命令即使通过粗筛还要再过参数级允许集。
 */
function hasDangerousArg(head, args) {
  const direct = firstUnsafeArg(args, DANGEROUS_ARGUMENTS[head]);
  if (direct) return `${head} ${direct}`;
  return null;
}

/**
 * 参数级允许集校验。返回 null 表示通过；否则返回 { hit, reason }。
 *
 * @param {string} scope  键：`head` 或 `head sub`
 * @param {string[]} args 该段的参数（不含命令头；git 场景下已含子命令）
 * @param {object} table  PARAM_ARGUMENTS
 */
function checkParamAllowlist(scope, args, table) {
  const rule = table[scope];
  if (!rule) return null;

  const allowed = new Set(rule.flags);
  // `valueFlags`：这些选项的**下一个 token 是值**，不是位置参数。
  // 例：`date -d "2020-01-01"`、`git tag --contains HEAD`、`git branch --merged main`。
  // 不认这一点的话，值会被当成位置参数，positional:"deny" 就把只读命令误判成 confirm。
  const valueFlags = new Set(Array.isArray(rule.valueFlags) ? rule.valueFlags : []);
  const present = new Set();
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!String(arg).startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const names = flagNames(arg, allowed);
    for (const name of names) {
      present.add(name);
      if (!allowed.has(name)) {
        return {
          hit: `deny:${scope} -${name}`,
          reason: `${scope} 的参数 -${name} 不在只读允许集内`,
        };
      }
    }
    // 带值选项且值是分开写的（不是 `--date=x`）→ 吞掉下一个 token。
    if (
      valueFlags.size > 0 &&
      !String(arg).includes("=") &&
      names.length === 1 &&
      valueFlags.has(names[0]) &&
      i + 1 < args.length
    ) {
      i += 1;
    }
  }

  if (rule.require && rule.require.length > 0) {
    const satisfied = rule.require.some((name) => present.has(name));
    if (!satisfied) {
      return {
        hit: `deny:${scope} missing ${rule.require.join("|")}`,
        reason: `${scope} 必须显式带上 ${rule.require.join(" / ")}`,
      };
    }
  }

  if (rule.positional === "deny" && positionals.length > 0) {
    // `positionalPrefixes` 是给「位置参数有两种含义」的命令留的：例如 `date +%s`
    // 位置参数以 `+` 开头是**只读格式串**，不带 `+` 就是「设系统时间」（写）。
    const prefixes = Array.isArray(rule.positionalPrefixes) ? rule.positionalPrefixes : [];
    const bad = positionals.find((item) => !prefixes.some((prefix) => String(item).startsWith(prefix)));
    if (bad !== undefined) {
      return {
        hit: `deny:${scope} positional:${bad}`,
        reason: `${scope} 带位置参数会被当成写操作`,
      };
    }
    return null;
  }

  return null;
}

/**
 * 把参数表里所有「两词键」（`git branch` / `git remote` / `git tag`）的**第二词**
 * 从参数里摘掉：子命令本身就是这些 token，留着会被当成位置参数。
 *
 * 例：`git remote -v` → args=["remote","-v"]，`git remote` 规则只该拿 ["-v"] 去判，
 * 否则 "remote" 会命中 positional:"deny"，`git remote -v` 就白名单不了了。
 *
 * @param {string[]} args 整段参数（含子命令）
 * @param {string[]} skip  要去掉的子命令 token（从左到右逐词剔除）
 * @returns {string[]}
 */
function withoutSubPrefix(args, skip) {
  let index = 0;
  while (index < skip.length && index < args.length && args[index] === skip[index]) index += 1;
  return args.slice(index);
}

/**
 * 最长匹配只读子命令（TASK-FIX17-H R2）：拿 args 的 1..MAX_SUB_TOKENS 个 token
 * 与 allowSubs 逐项比对，**从长到短**第一个命中就返回（`docker volume ls` 不能
 * 被 `docker` 前缀的 `ps` 之类截断）。
 *
 * @param {string[]} args
 * @param {string[]} allowSubs
 * @returns {string|null} 命中的子命令文本（可能是多个词）
 */
function matchSubcommand(args, allowSubs) {
  const limit = Math.min(args.length, MAX_SUB_TOKENS);
  for (let n = limit; n >= 1; n -= 1) {
    const candidate = args.slice(0, n).join(" ");
    if (allowSubs.includes(candidate)) return candidate;
  }
  return null;
}

function inspectSegment(segment, allowlist, denylist) {
  const tokens = tokenize(segment);
  if (!tokens || tokens.length === 0) {
    return { ok: false, reason: "命令段无法解析", hit: "unparsable" };
  }

  // 环境变量前缀包装：FOO=1 cmd —— 真实命令头被藏起来了，一律确认。
  if (ASSIGNMENT_RE.test(tokens[0])) {
    return { ok: false, reason: "环境变量前缀包装，无法确认真实命令", hit: "env-prefix" };
  }

  let index = 0;
  // env FOO=1 包装：按规范剥掉包装后再看真实命令头。
  if (commandHead(tokens[0]) === "env") {
    index = 1;
    while (index < tokens.length && ASSIGNMENT_RE.test(tokens[index])) {
      index += 1;
    }
    if (index >= tokens.length) {
      return { ok: false, reason: "env 后没有真实命令", hit: "unparsable" };
    }
  }

  const head = commandHead(tokens[index]);
  const args = tokens.slice(index + 1);

  if (!head) {
    return { ok: false, reason: "命令头为空", hit: "unparsable" };
  }

  if (denylist.heads.includes(head)) {
    return { ok: false, reason: `命中黑名单命令：${head}`, hit: `deny:${head}` };
  }

  const denySubs = denylist.subcommands[head];
  if (denySubs && args.length > 0 && denySubs.includes(args[0])) {
    return { ok: false, reason: `命中黑名单子命令：${head} ${args[0]}`, hit: `deny:${head} ${args[0]}` };
  }

  // 1) 危险参数粗筛：`find -fprint` 系列、`git --output` 等拿到明确的 deny。
  const dangerous = hasDangerousArg(head, args);
  if (dangerous) {
    return { ok: false, reason: `危险参数：${dangerous}`, hit: `deny:${dangerous}` };
  }

  // 2) 参数级允许集（curl / rg / wc / "git branch"）。位置在命令头白名单之前：
  //    这些命令的参数能改语义，必须先过参数关才谈「命令头只读」。
  const subScope = args.length > 0 ? `${head} ${args[0]}` : null;
  if (subScope && PARAM_ARGUMENTS[subScope]) {
    // 子命令级规则：把子命令本身从参数里去掉再判，
    // 否则 `git branch -a` 里的 "branch" 会被当成位置参数。
    const subRule = checkParamAllowlist(subScope, args.slice(1), PARAM_ARGUMENTS);
    if (subRule) return { ok: false, reason: subRule.reason, hit: subRule.hit };
  }
  const headRule = checkParamAllowlist(head, args, PARAM_ARGUMENTS);
  if (headRule) {
    return { ok: false, reason: headRule.reason, hit: headRule.hit };
  }

  if (allowlist.heads.includes(head)) {
    // 敏感路径：命令头只读也要确认。放在「允许」之后统一拦，避免每个分支各写一遍。
    // 为什么放在这里：allowlist.heads 分支是 cat / head / tail 这类「会吐文件内容」的
    // 命令的唯一出口（它们不走子命令分支），所以这道拦在这里覆盖面最全。
    if (READ_HEADS.has(head)) {
      const hitPath = args.find((arg) => !arg.startsWith("-") && isSensitivePath(arg));
      if (hitPath) {
        return { ok: false, reason: "这条命令会读出密钥或凭据文件，需要你确认", hit: "deny:sensitive-path" };
      }
    }
    return { ok: true, hit: `allow:${head}` };
  }

  const allowSubs = allowlist.subcommands[head];
  if (allowSubs) {
    if (args.length === 0) {
      return {
        ok: false,
        reason: `命令头 ${head} 只放行只读子命令`,
        hit: `default:${head}`,
      };
    }
    // 最长匹配：`docker volume ls` / `git stash list` 这类多词子命令也要能被认出。
    const sub = matchSubcommand(args, allowSubs);
    if (!sub) {
      return {
        ok: false,
        reason: `命令头 ${head} 只放行只读子命令`,
        hit: `default:${head}`,
      };
    }
    // 子命令级允许集（如 "git branch" / "git remote" / "git tag"）已经在上面按
    // 两词键查过，但那里统一用的是 `${head} ${args[0]}`，多词子命令会漏。
    // 这里按**命中的子命令**再查一次：`git stash list` 对应 "git stash list"，
    // 没配规则就是不拦（与现状一致：未列在参数表里的命令不做参数级校验）。
    const subScope = `${head} ${sub}`;
    if (PARAM_ARGUMENTS[subScope]) {
      const subRule = checkParamAllowlist(subScope, withoutSubPrefix(args, sub.split(" ")), PARAM_ARGUMENTS);
      if (subRule) return { ok: false, reason: subRule.reason, hit: subRule.hit };
    }
    return { ok: true, hit: `allow:${head} ${sub}` };
  }

  // 有参数级允许集但没有命令头白名单（例如 curl / rg / wc）：
  // 参数已通过 → 视为允许。
  if (PARAM_ARGUMENTS[head]) {
    return { ok: true, hit: `allow:${head}` };
  }

  return { ok: false, reason: `命令头 ${head} 不在只读白名单`, hit: `default:${head}` };
}
