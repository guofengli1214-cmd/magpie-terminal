// 硬禁止清单（PROTOCOL-AGENT.md §8）。
//
// 命中即「永远要用户确认」——任何自动执行档位、任何白名单都不能绕过。
// 本模块是纯函数、零 IO、永不抛；拿不准一律返回原因（fail-closed）。
//
// 与 src/policy/classify.mjs 的分工：
// classify() 回答「这条命令是否属于内置只读白名单」；
// forbiddenReason() 回答「这条命令是否连『自动执行』这条路都不许走」。
// 两者互不依赖，judge() 先问 forbidden，再问白名单。
//
// TASK-V3-D-FIX1 修复 2（m1）：硬禁止只看**每段的命令头**，不再对整条命令的
// 任意 token 做匹配。否则 `npm run format`、`git commit -m "fix reboot bug"`、
// `rg shutdown src/`、`grep -rn "sudo" docs/` 这些日常命令会被误拦，
// 且白名单也绕不过。切段规则：`;` `&&` `||` `|` `&` 都算下一段的开始，
// 每段的第一个 token（跳过 env/xargs/eval 这类包装器）才是命令头。

/** 把任意空白压成一个空格并按此切词；引号剥掉（`rm -rf '/'` 与 `rm -rf /` 等价）。 */
function tokenize(command) {
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
function splitOnSeparators(token) {
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
function commandHeads(tokens) {
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
// 全部小写：isDangerousRmTarget 会先 toLowerCase 再比对。
const DANGEROUS_RM_TARGETS = new Set([
  "/",
  "/*",
  "~",
  "~/*",
  "$home",
  "${home}",
  "$home/*",
  "${home}/*",
  "c:\\",
  "c:/",
  "*",
]);

function isDangerousRmTarget(target) {
  const t = String(target || "").toLowerCase();
  return DANGEROUS_RM_TARGETS.has(t);
}

function isRecursiveRmFlag(token) {
  if (token === "--recursive") return true;
  if (!token.startsWith("-")) return false;
  if (token.startsWith("--")) return false;
  return /r/i.test(token.slice(1));
}

/** 递归删除 + 危险目标：只看每段命令头是不是 rm（参数里出现 rm 不算）。 */
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

/**
 * 硬禁止判定。
 *
 * @param {unknown} command
 * @returns {string|null} 命中返回中文原因（给用户看），未命中返回 null
 */
export function forbiddenReason(command) {
  try {
    if (typeof command !== "string") return null;
    const raw = command.replace(/\s+/g, " ").trim();
    if (raw.length === 0) return null;
    const tokens = tokenize(raw).flatMap(splitOnSeparators);
    // 只看每段的命令头：参数、引号内的文字不再参与匹配（修复 2）。
    const heads = commandHeads(tokens);

    if (hasHead(heads, ["sudo"])) return "提权命令（sudo）";
    if (hasHead(heads, ["su"])) return "提权命令（su）";
    if (hasHead(heads, ["runas"])) return "提权命令（runas）";
    if (hasHead(heads, ["doas"])) return "提权命令（doas）";
    if (hasHead(heads, ["pkexec"])) return "提权命令（pkexec）";

    if (hasHead(heads, ["mkfs"], { allowDotted: true })) return "磁盘格式化命令（mkfs）";
    if (hasHead(heads, ["dd"])) return "磁盘写入命令（dd）";
    if (hasHead(heads, ["diskpart"])) return "磁盘分区命令（diskpart）";
    if (hasHead(heads, ["format"])) return "磁盘格式化命令（format）";
    if (hasHead(heads, ["fdisk"])) return "磁盘分区命令（fdisk）";
    if (hasHead(heads, ["parted"])) return "磁盘分区命令（parted）";

    if (destroysDangerousTarget(heads)) return "递归删除根目录或家目录（rm -rf / ~）";

    if (hasFlagFor(heads, "chmod", /^-[a-zA-Z]*R[a-zA-Z]*$/)) return "递归修改权限（chmod -R）";
    if (hasFlagFor(heads, "chown", /^-[a-zA-Z]*R[a-zA-Z]*$/)) return "递归修改所有者（chown -R）";
    if (hasHead(heads, ["takeown"])) return "接管文件所有权（takeown）";
    if (hasHead(heads, ["icacls"])) return "修改文件权限（icacls）";

    if (hasHead(heads, ["shutdown"])) return "关机命令（shutdown）";
    if (hasHead(heads, ["reboot"])) return "重启命令（reboot）";
    if (hasHead(heads, ["halt"])) return "关机命令（halt）";
    if (hasHead(heads, ["poweroff"])) return "关机命令（poweroff）";
    if (hasInitRunlevel(heads)) return "切换运行级别（init 0/6）";

    if (pipesIntoInterpreter(raw)) return "把下载内容直接管道给解释器执行";

    if (subcommandHasFlag(heads, "git", "push", /^--force(-with-lease)?$/)) return "git 强制推送（--force）";
    if (subcommandHasFlag(heads, "git", "push", /^-[a-zA-Z]*f[a-zA-Z]*$/)) return "git 强制推送（-f）";

    if (subcommandHasFlag(heads, "git", "reset", /^--hard$/)) return "git 丢弃本地改动（reset --hard）";
    if (subcommandHasFlag(heads, "git", "clean", /^-[a-zA-Z]*f[a-zA-Z]*$/)) return "git 删除未跟踪文件（clean -fd）";

    if (hasSubcommand(heads, "reg", "delete")) return "删除 Windows 注册表项（reg delete）";

    return null;
  } catch {
    // 判定过程异常：按禁止处理（fail-closed），而不是放行。
    return "命令无法安全判定";
  }
}
