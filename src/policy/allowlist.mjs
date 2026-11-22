// 只读白名单 / 危险黑名单 / 参数级允许集。
// 这里是分级器唯一的数据来源：判定逻辑不硬编码任何命令名，也不硬编码参数名。
// 文件本身不做 IO，不放函数，只导出冻结的常量。
//
// 为什么参数层用「允许集」而不是「危险参数黑名单」：
// 见 docs/security.md 3.3 / 3.4 与 .trellis/spec/backend/security-model.md 5.4.1。
// 危险参数黑名单漏一个就整条链失守（实测 find -fprint / curl -T / git branch <name>
// 都被放行并真的写盘/建分支）。

/**
 * 命令头直接命中即视为只读（参数不参与判定）。
 *
 * `find` 故意不在这里：`-fprint` / `-fprintf` / `-fls` / `-fprint0` / `-delete` / `-exec`
 * 都会写盘或执行命令，参数空间不值得枚举 —— 一律 confirm。
 * 文件检索用 `ls`、`rg -n`、`rg --files`。
 *
 * `rg` / `wc` / `curl` 也不在这里：它们的参数能改语义，走 PARAM_ALLOWLIST。
 */
const ALLOW_HEADS = Object.freeze([
  "ls",
  "dir",
  "pwd",
  "cat",
  "type",
  "head",
  "tail",
  "stat",
  "grep",
  "where",
  "which",
  "echo",
  "netstat",
  "ss",
  "ping",
]);

/** 只有特定子命令只读的命令。 */
const ALLOW_SUBCOMMANDS = Object.freeze({
  // `git show` 按 docs/security.md 第 3.3 节是只读的；它唯一会写盘的参数
  // --output=<file> 已由 DANGEROUS_ARGUMENTS.git 的 "output" 稠筛拦住。
  git: Object.freeze(["status", "log", "diff", "show", "branch"]),
  node: Object.freeze(["-v"]),
  npm: Object.freeze(["-v"]),
  python: Object.freeze(["--version"]),
  docker: Object.freeze(["ps"]),
});

/** 命中即要求确认的命令头。 */
const DENY_HEADS = Object.freeze(["rm", "mv", "del", "cp", "sudo"]);

/** 命中即要求确认的子命令。 */
const DENY_SUBCOMMANDS = Object.freeze({
  npm: Object.freeze(["i", "install"]),
  pip: Object.freeze(["install"]),
  git: Object.freeze(["push", "reset"]),
});

/**
 * 参数级「允许集」。名字不带前导连字符（判定时两边都规范化），
 * 因此 `-delete` 与 `--delete`、`-fprint` 与 `--fprint` 判定必然一致。
 *
 * 键：命令头，或「命令头 子命令」（后者只对该子命令生效）。
 *
 * flags        允许的选项（规范化后，不带连字符）
 * require      必须至少出现其中一个（用于 curl 必须带 -I/--head）
 * positional   "ok"（位置参数是只读操作数）| "deny"（任何位置参数都 confirm）
 */
const PARAM_ALLOWLIST = Object.freeze({
  curl: Object.freeze({
    // curl 不加 -I/--head 会下载正文到 stdout；按规范只放 HEAD 请求。
    require: Object.freeze(["I", "head"]),
    positional: "ok",
    flags: Object.freeze([
      "I",
      "head",
      "s",
      "silent",
      "S",
      "show-error",
      "k",
      "insecure",
      "L",
      "location",
      "i",
      "include",
      "compressed",
    ]),
  }),
  rg: Object.freeze({
    positional: "ok",
    flags: Object.freeze([
      "i",
      "n",
      "l",
      "c",
      "w",
      "e",
      "g",
      "t",
      "u",
      "hidden",
      "no-ignore",
      "A",
      "B",
      "C",
      "m",
      "max-count",
      "files",
      "type",
      "glob",
    ]),
  }),
  wc: Object.freeze({
    positional: "ok",
    flags: Object.freeze(["l", "w", "c", "m", "L", "files0-from"]),
  }),
  "git branch": Object.freeze({
    // 任何位置参数都会被当成「新建分支」的名字 → 一律 confirm。
    positional: "deny",
    flags: Object.freeze([
      "a",
      "r",
      "v",
      "vv",
      "l",
      "list",
      "show-current",
      "contains",
      "merged",
      "no-merged",
      "points-at",
    ]),
  }),
});

/**
 * 第一道粗筛：命令头只读、但带这些参数时会写盘 / 执行任意命令。
 * 只作为 coarse hint；最终判定以 PARAM_ALLOWLIST / 移除为准（见 4.10.1 第 9 条）。
 *
 * 名字同样不带前导连字符，保证短/长写法对称。
 */
const DANGEROUS_ARGS = Object.freeze({
  // find 已整条移出白名单，但保留粗筛让 `-fprint` 系列拿到 `deny` 而非 `default`。
  find: Object.freeze([
    "fprint",
    "fprintf",
    "fprint0",
    "fls",
    "delete",
    "exec",
    "execdir",
    "ok",
    "okdir",
  ]),
  git: Object.freeze(["output"]),
});

export const DEFAULT_ALLOWLIST = Object.freeze({
  heads: ALLOW_HEADS,
  subcommands: ALLOW_SUBCOMMANDS,
});

export const DEFAULT_DENYLIST = Object.freeze({
  heads: DENY_HEADS,
  subcommands: DENY_SUBCOMMANDS,
});

export const DANGEROUS_ARGUMENTS = DANGEROUS_ARGS;
export const PARAM_ARGUMENTS = PARAM_ALLOWLIST;
