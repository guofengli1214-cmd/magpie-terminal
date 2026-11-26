// 只读白名单 / 危险黑名单 / 参数级允许集。
// 这里是分级器唯一的数据来源：判定逻辑不硬编码任何命令名，也不硬编码参数名。
// 文件本身不做 IO，不放函数，只导出冻结的常量。
//
// 为什么参数层用「允许集」而不是「危险参数黑名单」：
// 见 docs/security.md 3.3 / 3.4。
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
 *
 * TASK-FIX17-H R2 新增 `free` / `df` / `uptime` / `uname` / `whoami` / `hostname` /
 * `nproc` / `date`：都是「只吐本机概况」的只读命令，没有任何参数能写盘。
 *
 * **`ps` 故意不加**（本条是刻意的，不是漏了）：`ps aux` / `ps -ef` 会原样列出
 * 其它进程的**完整命令行**，而真实命令行里常见 `mysql -pMyPlainPassword`、
 * `app --password=...`、`docker login -p <token>`、`curl -H 'Authorization: Bearer ...'`。
 * 那是可直接拿去用的凭据，属于信息泄露路径（与 `cat .env` 同一类），
 * 不是「只读就安全」。真要看「谁在占哪个端口」用 `netstat` / `ss` 已够，
 * 两者只给地址与端口，不给完整命令行。
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
  "free",
  "df",
  "uptime",
  "uname",
  "whoami",
  "hostname",
  "nproc",
  "date",
]);

/**
 * 只有特定子命令只读的命令。
 *
 * 子命令可以是**多个词**（`docker volume ls`、`git stash list`）：
 * `src/policy/classify.mjs` 拿 args 的前 1..3 个 token 与这里逐项**最长匹配**，
 * 命中就返回 `allow:<head> <sub>`。所以 `docker volume ls`（放行）与
 * `docker volume rm`（不在表里 → confirm）能区分开。
 */
const ALLOW_SUBCOMMANDS = Object.freeze({
  // `git show` 按 docs/security.md 第 3.3 节是只读的；它唯一会写盘的参数
  // --output=<file> 已由 DANGEROUS_ARGUMENTS.git 的 "output" 稠筛拦住。
  //
  // `git remote` / `git tag` 是 TASK-FIX17-H R2 新增的：两者都是「不带位置参数才只读」，
  // 位置参数就是写操作（`git remote add origin x` / `git tag v1.0`），所以它们
  // **必须同时在 PARAM_ALLOWLIST 里带 positional:"deny"**。
  // `git stash list` 同理：stash 本体（push/pop/drop）都是写操作。
  git: Object.freeze([
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "remote",
    "tag",
    "rev-parse",
    "describe",
    "blame",
    "stash list",
  ]),
  node: Object.freeze(["-v"]),
  // `npm ls` / `npm list` / `npm outdated` 是只读查询。
  // **`npm run` 绝不加**：`npm run <script>` 会执行 package.json 里的任意脚本。
  npm: Object.freeze(["-v", "ls", "list", "outdated"]),
  python: Object.freeze(["--version"]),
  docker: Object.freeze([
    "ps",
    "images",
    "image ls",
    "container ls",
    "version",
    "info",
    "stats",
    "logs",
    "inspect",
    "port",
    "top",
    "history",
    "diff",
    "search",
    "system df",
    "volume ls",
    "network ls",
    "compose ps",
    "compose logs",
  ]),
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
 * flags              允许的选项（规范化后，不带连字符）
 * require            必须至少出现其中一个（用于 curl 必须带 -I/--head）
 * positional         "ok"（位置参数是只读操作数）| "deny"（任何位置参数都 confirm）
 * positionalPrefixes positional:"deny" 时，以这些前缀开头的位置参数仍视为只读
 *                     （`date +%s` 的 `+%s` 是格式串，不带 `+` 的 `010100002020` 才是改时间）
 * valueFlags         这些选项的下一个 token 是**值**，不是位置参数
 *                     （`date -d "2020-01-01"` / `git tag --contains HEAD`）
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
    // `--contains <commit>` / `--merged <commit>` 的值是下一个 token，不吞掉会被当新建分支名。
    valueFlags: Object.freeze(["contains", "merged", "no-merged", "points-at"]),
  }),
  "git remote": Object.freeze({
    // `git remote add <name> <url>` / `git remote remove <name>` / `git remote prune`
    // 都是写操作：只要带位置参数就 confirm。只放行 `git remote` / `git remote -v`。
    positional: "deny",
    flags: Object.freeze(["v", "verbose"]),
  }),
  date: Object.freeze({
    // 位置参数有两种含义：`date +%s`（以 `+` 开头）= 只读格式串；
    // 不带 `+` 的 `date 010100002020` = **设系统时间**（写）。
    // 所以只放行以 `+` 开头的位置参数，并禁掉 `-s/--set`（它也能设时间）。
    positional: "deny",
    positionalPrefixes: Object.freeze(["+"]),
    flags: Object.freeze([
      "u",
      "utc",
      "R",
      "rfc-email",
      "rfc-2822",
      "rfc-3339",
      "I",
      "iso-8601",
      "d",
      "date",
      "r",
      "reference",
      "debug",
      "help",
      "version",
    ]),
    // `date -d "2020-01-01"` / `-r <file>`：值在下一个 token。
    valueFlags: Object.freeze(["d", "date", "r", "reference"]),
  }),
  hostname: Object.freeze({
    // 不带位置参数 = 打印主机名；带位置参数 = **改主机名**（写）。
    // `-F/--file` 也是改主机名（从文件读新名字），一并禁掉。
    positional: "deny",
    flags: Object.freeze([
      "f",
      "fqdn",
      "s",
      "short",
      "d",
      "domain",
      "i",
      "ip-address",
      "I",
      "all-ip-addresses",
      "a",
      "alias",
      "A",
      "all-fqdns",
      "y",
      "yp",
      "nis",
      "t",
      "help",
      "version",
    ]),
  }),
  "git tag": Object.freeze({
    // `git tag v1.0` 是创建标签（写仓库），`git tag -d v1` 是删除。
    // 只放行「列标签」：`git tag`、`git tag -l`、`git tag --contains x` 一类。
    positional: "deny",
    flags: Object.freeze(["l", "list", "n", "contains", "points-at", "no-merged", "merged"]),
    // `git tag -l 'v*'` / `--contains HEAD`：值是下一个 token，吞掉才不会被当标签名（= 写操作）。
    valueFlags: Object.freeze(["l", "list", "n", "contains", "points-at", "no-merged", "merged"]),
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

/**
 * 内置只读白名单的**扁平字符串形态**（TASK-FIX17-I R1）：唯一数据源。
 *
 * 元素形式两种：
 *   - `"free"`：整个命令头放行（= 旧 `ALLOW_HEADS` 的一项）；
 *   - `"docker volume ls"`：命令头 + 1~2 个只读子命令词（= 旧 `ALLOW_SUBCOMMANDS` 的一项）。
 *
 * 为什么要有扁平形态：设置页（`config.builtinAllowlist`）里用户看到/编辑的是这个数组，
 * 内核判级用 `builtinRulesFrom()` 把它还原成 `{heads, subcommands}`。
 * **本数组是唯一数据源**：`ALLOW_HEADS` / `ALLOW_SUBCOMMANDS` 由它摊平生成
 * （下方），单测锁死 `DEFAULT_ALLOWLIST` 与 `builtinRulesFrom(DEFAULT_BUILTIN_ALLOWLIST)`
 * 逐项相等 —— 不许再出现第二份手写清单。
 */
export const DEFAULT_BUILTIN_ALLOWLIST = Object.freeze([
  ...ALLOW_HEADS,
  ...Object.entries(ALLOW_SUBCOMMANDS).flatMap(([head, subs]) =>
    subs.map((sub) => `${head} ${sub}`),
  ),
]);

/**
 * 把扁平清单还原成判级用的 `{ heads, subcommands }`（TASK-FIX17-I R2）。
 *
 * **纯函数、永不抛**，只做形状转换，**不做安全过滤**：
 * 用户把 `rm` 加进清单时这里照样返回它 —— 「deny 先于 allow」由 `classify()` 保证，
 * 而不是靠这里偷偷删掉（悄悄删会让用户以为「加了生效了」，且掩盖了真正的安全边界）。
 *
 * - `undefined` / `null` / 非数组 → 返回 `DEFAULT_ALLOWLIST`（老配置自然升级）；
 * - 空数组 → `{ heads: [], subcommands: {} }` = 所有命令都要确认；
 * - 元素非字符串 / 空白 → 跳过（落盘前已由 store 校验拒绝，这里只保证不抛）。
 *
 * @param {unknown} list
 * @returns {{heads: readonly string[], subcommands: Readonly<Record<string, readonly string[]>>}}
 */
export function builtinRulesFrom(list) {
  if (list === undefined || list === null) return DEFAULT_ALLOWLIST;
  if (!Array.isArray(list)) return DEFAULT_ALLOWLIST;
  if (list.length === 0) return Object.freeze({ heads: Object.freeze([]), subcommands: Object.freeze({}) });

  const heads = [];
  const subcommands = new Map();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const text = raw.trim().replace(/\s+/g, " ");
    if (!text) continue;
    const parts = text.split(" ");
    if (parts.length === 1) {
      if (!heads.includes(parts[0])) heads.push(parts[0]);
      continue;
    }
    const head = parts[0];
    const sub = parts.slice(1).join(" ");
    const arr = subcommands.get(head) || [];
    if (!arr.includes(sub)) arr.push(sub);
    subcommands.set(head, arr);
  }

  const frozenSubs = {};
  for (const [key, value] of subcommands) frozenSubs[key] = Object.freeze([...value]);
  return Object.freeze({ heads: Object.freeze(heads), subcommands: Object.freeze(frozenSubs) });
}

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
