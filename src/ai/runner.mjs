// PTY 命令执行通道（PROTOCOL-AGENT.md §4）。
//
// 在用户真实 PTY 里执行，这样命令跟随用户 shell 的当前目录，用户也能在终端里看见。
//
// 三个必须做对的点（PROTOCOL §6.7）：
//   1. lastIndexOf(startMark) —— 终端的回显里也会出现 startMark。
//   2. 静默判定必须在「该命令自己的」输出 buffer 上算，不能被别的命令的输出刷新。
//   3. 输出截断到 4000 字符（头部 1000 + 尾部 3000），中间插省略标记。
//
// 铁律（PROTOCOL §4.5）：
//   - 日志里绝不出现完整命令（只打 commandLength + 前 40 字符）
//   - 绝不把 PTY 原始字节塞给模型（先 stripAnsi 再截断）
//   - 执行期间不改终端尺寸、不发 pty.resize

import crypto from "node:crypto";

import { redact } from "../server/log-redact.mjs";

/** 输出上限：头部 1000 + 尾部 3000 = 4000 字符（PROTOCOL §3.2）。 */
export const OUTPUT_HEAD_CHARS = 1000;
export const OUTPUT_TAIL_CHARS = 3000;
export const OUTPUT_MAX_CHARS = OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS;

/** 结束判定默认值（PROTOCOL §4.3）。 */
export const DEFAULT_QUIET_MS = 1000;
export const DEFAULT_MIN_WAIT_MS = 300;
export const DEFAULT_TIMEOUT_MS = 90000;

/**
 * 静默阈值的放缩倍数（TASK-V3-D-FIX1 修复 1）。
 *
 * 第一次静默判定的阈值 = quietMs * DEFAULT_QUIET_FACTOR（默认 1000 × 3 = 3000ms）。
 * 为什么要把原来的 1000ms 放大到 3000ms：
 *   - 命令启动后要第一条输出很慢（`node --test`、`npm install`、编译、`sleep 2; echo`），
 *     1 秒静默会把它们误判成「进入了交互模式」，直接切断输出、exitCode=null。
 *   - 输出中途停顿 1 秒也很常见（测试框架/包管理器的进度打印都有 1–2 秒空窗）。
 * 总超时（DEFAULT_TIMEOUT_MS = 90 秒）不放宽，它是兜底。
 */
export const DEFAULT_QUIET_FACTOR = 3;

/**
 * 静默阈值的天花板倍数（TASK-V3-D-FIX1 修复 1）。
 *
 * 3000ms 只是**第一次**静默判定点。到点但还没看到结束标记时，不立刻判死，
 * 而是把阈值升一档（×2）再等一轮，直到 `DEFAULT_QUIET_MS * DEFAULT_QUIET_MAX_FACTOR
 * = 16000ms` 才真的判 EXEC_QUIET。
 *
 * 为什么必须再加这一层（两个都来自真 PTY 实测，不是拍脑袋）：
 *   - 「还没收到任何输出」也会超 3000ms：`sleep 5; echo late` 的第一条输出在 5 秒。
 *   - 「已有输出但空窗」也会超 3000ms：本仓库跑 `node --test` 时，真 PTY 实测
 *     最长一次输出间隔 9031ms（某个用例整整跑了 9 秒才打下一行）。
 * 两种情形都按 3000ms 判死，就是核验报告里的 M1；只靠一个平坦的 3000ms 修不好。
 *
 * 卡住 / 等输入的命令仍然会很快给结论（默认配置下：3s → 6s → 12s → 16s 封顶），
 * 且总超时 90 秒是硬兜底——上限比总超时小一个量级，不会被静默放宽掩盖。
 */
export const DEFAULT_QUIET_MAX_FACTOR = 16;

/**
 * 「看到结束标记后再等一小段」的宽限（TASK-V3-D-FIX1 修复 3）。
 *
 * 修复 3 要求 endMark 取**最后一个**——但输出是一条条流进来的：若命令自己输出的
 * `__MT_E_<nonce>__99` 先进一个 chunk、真实的 `__MT_E_<nonce>__0` 晚一个 chunk 到，
 * 「最后一个匹配」当场还是 99。所以看到结束标记后不立刻 resolve，先等这一小段；
 * 期间有新输出（包含真实结束标记）就重取最后一个匹配。
 *
 * 代价：每条命令多等 120ms（真 PTY 实测 `echo hi` 仍在 1.5s 内）。
 */
export const DEFAULT_TAIL_GRACE_MS = 120;

/** 静默超时 / 总超时的中文说明（逐字来自 PROTOCOL §4.3）。 */
export const USER_TEXT_QUIET =
  "命令没有按预期结束，可能进入了交互模式（比如等待输入）。";
export const USER_TEXT_TIMEOUT = "命令超过 90 秒还没结束，已放弃等待。";
export const USER_TEXT_UNSUPPORTED =
  "这个终端不支持自动执行（可能是 Windows 的 cmd.exe），我把命令列给你，你复制到终端里运行。";

/** PROTOCOL §4.2 指定的 stripAnsi 正则。 */
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * 去 ANSI 控制序列。
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  if (typeof text !== "string") return "";
  return text.replace(ANSI_RE, "");
}

/**
 * 截断到 4000 字符：头部 1000 + 尾部 3000，中间插省略标记。
 * @param {string} text
 * @returns {{output: string, truncated: boolean}}
 */
export function truncateOutput(text) {
  const value = typeof text === "string" ? text : "";
  if (value.length <= OUTPUT_MAX_CHARS) return { output: value, truncated: false };
  const head = value.slice(0, OUTPUT_HEAD_CHARS);
  const tail = value.slice(value.length - OUTPUT_TAIL_CHARS);
  const omitted = value.length - OUTPUT_MAX_CHARS;
  return {
    output: `${head}\n…（中间省略 ${omitted} 字符）…\n${tail}`,
    truncated: true,
  };
}

/** 生成一次执行用的标记对。 */
export function makeMarks(nonce) {
  const value = nonce || crypto.randomBytes(6).toString("hex");
  return {
    nonce: value,
    startMark: `__MT_S_${value}__`,
    endMark: `__MT_E_${value}__`,
  };
}

/**
 * bash 分支的包装串（PROTOCOL §4.1-bash）。
 *
 * TASK-FIX17-A（问题 2 的另一半）：起首的 `printf '\\n%s\\n'` 改成 `printf '%s\\n'`。
 * 原来那个前导 `\n` 会让 AI 每执行一条命令就在用户终端上先多打一个空行
 * （命令回显上一行凭空空一行），而它对解析毫无用处：`splitBuffer()` 取的是
 * startMark 与 endMark 之间的内容，两个标记各占一行就够。
 * 其余字节（`( cmd\n ) 2>&1`、结尾的 `$?` 与提交用换行）保持不变。
 *
 * 冻结口径：`docs/PROTOCOL-AGENT.md` §4.1-bash 是本函数的唯一规格，
 * 改这里必须同步改文档（本卡不改文档，已在 REPORT 的「已知风险」里登记）。
 */
export function buildPayload(command, startMark, endMark) {
  return `printf '%s\\n' '${startMark}'; ( ${command}\n ) 2>&1; printf '${endMark}%s\\n' "$?"\n`;
}

/**
 * 这个会话该用哪种包装串（TASK-FIX-PS-SHELL §6.1）。
 *
 * 只认两个家族：
 *   - `PowerShell 7` / `PowerShell 5` / `pwsh` 这类展示名 → `"powershell"`
 *   - 其它一切（`bash`、`ssh user@host`、`null`、`undefined`）→ `"bash"`
 *
 * 为什么 SSH 远端必须落回 bash：远程会话的 `session.shell.name` 是
 * `ssh <user>@<host>`（src/ssh/registry.mjs），远端跑的是 Linux bash，
 * 绝不是 PowerShell。别往这里加第三个分支。
 *
 * @param {string|null|undefined} shellName
 * @returns {"bash"|"powershell"}
 */
export function shellFamilyOf(shellName) {
  if (typeof shellName === "string" && /powershell|pwsh/i.test(shellName)) return "powershell";
  return "bash";
}

/**
 * PowerShell 分支的包装串（PROTOCOL §4.1，TASK-FIX-PS-SHELL §6.2）。
 *
 * 三处与 bash 根本不同，全是真 PTY 实测出来的：
 *   1. 片段之间用 **CR**（`\r`）提交。用 `\n` 会被 PSReadLine 当成续行，
 *      永远停在 `>> ` 提示符上不执行。
 *   2. 命令本体的换行先归一成 `\n` 再全换成 `\r`（逐行提交；块语句靠在
 *      `>> ` 续行里自己闭合）。
 *   3. 退出码不能靠 `$?`——它是**布尔**。这里用 `$?` + `$Error.Count` 增量
 *      + `$LASTEXITCODE` 变化三条一起判定，判完立刻输出 `<endMark>0/1`，
 *      格式与 bash 分支一致，`splitBuffer()` 不用改。
 *
 * `$__mtBad` 那一行必须紧跟在命令本体之后：`$?` 只反映紧邻的上一条语句。
 *
 * @param {string} command
 * @param {string} startMark
 * @param {string} endMark
 * @returns {string}
 */
export function buildPowerShellPayload(command, startMark, endMark) {
  const body = String(command).replace(/\r\n/g, "\n").replace(/\n/g, "\r");
  return [
    `Write-Output '${startMark}'`,
    `$__mtErr0 = $Error.Count; $__mtLx0 = $LASTEXITCODE`,
    `${body} 2>&1`,
    `$__mtBad = (-not $?) -or ($Error.Count -gt $__mtErr0) -or ($LASTEXITCODE -ne $__mtLx0 -and $LASTEXITCODE -ne 0)`,
    `Write-Output ('${endMark}' + $(if ($__mtBad) { 1 } else { 0 }))`,
  ].join("\r") + "\r";
}

/** 退出码判定行的特征（`-not $?` 只在 `$__mtBad = …` 那一行出现）。 */
const EXIT_ECHO_RE = /\$__mtBad = \(-not \$\?\)/;

/**
 * PowerShell 分支的输出清洗（PROTOCOL §4.1-PS，TASK-FIX-PS-SHELL §6.4）。
 *
 * 逐行 CR 提交时 PowerShell 会把提示符、命令回显和续行提示符 `>> ` 一起吐回来。
 * 这些是 shell 噪音，不是命令输出；不清掉会把 4000 字符预算全花在回显上。
 *
 * 关键在于**只切掉回显那一段，不丢掉整行**：真 PTY 实测里见过
 * `1027511XPS C:\Users\…> $__mtBad = …` 这种「真输出 + 提示符重绘」粘在一行，
 * 整行丢弃就把真输出（`1027511`）丢了。所以规则是：
 *
 *   1. CR / CRLF 统一成 LF；
 *   2. 把**嵌在行中的**提示符（`PS C:\…> `）换成换行：它之前是真输出，之后是回显；
 *   3. 丢掉换行后以 `>> `（续行提示符）开头的行：那整行都是我们写进去的续行回显；
 *   4. 在每行的第一个标记（`__MT_S_` / `__MT_E_`）或 `$__mt` 处截断：前缀是真输出，
 *      后缀是回显或竞态残留；
 *   5. **遇到退出码判定行的回显（含 `-not $?` 的那一行）就整体截断**：命令已经跑完，
 *      它后面的全部是包装串回显。这一条是折行残片的根治手段——终端宽度窄时
 *      PSReadLine 会把那一行折成好几段（真 PTY 实测：120 列 + 长提示符下会折出
 *      单独一行 `0` 和 ` -and $LASTEXITCODE -ne 0)`），靠逐行识别永远有漏网的；
 *   6. 丢掉「payload 回显的折行残片」：第 5 条没盖住的（命令回显那一行的折行），
 *      用「整行是某个 `echoLines` 元素的前缀/后缀/全等且长度 ≥ 8」做兑底。
 *
 * 为什么不用「子串」判据：`in-block` 是 `Write-Output 'in-block'` 的子串，但它是
 * 真输出（真 PTY 实测过的误杀）。
 *
 * 第 5 条为什么必须有：真 PTY 实测（`.dispatch/fix-ps/repro8.mjs`）在 **120 列**
 * + 长提示符下把 `$__mtBad = …` 那一行折成 `…$__mtLx0` / `0` / ` -and … -ne 0)`
 * 三段，孤立的 `0` 会混进最终输出（live.txt 里真见过）。靠逐行识别永远有漏网的，
 * 直接截断到这一行最干净。代价：命令的**异步**后置输出（后台作业往终端打东西）
 * 会丢——但 runner 本来就以 endMark 为结束依据，那部分输出原本也领不到。
 *
 * 代价：若命令自己的输出恰好是 payload 某个片段的**前缀或后缀**或全等（长度 ≥ 8），
 * 会被当作回显丢掉。已写入 PROTOCOL §4.6。
 *
 * **只对 PowerShell 分支调用**，bash 分支的输出一个字节都不许变。
 *
 * @param {string} text
 * @param {{echoLines?: string[]}} [opts] echoLines：本次写进 PTY 的 payload 按 CR 拆开
 * @returns {string}
 */
export function cleanPowerShellOutput(text, opts = {}) {
  if (typeof text !== "string" || text.length === 0) return "";
  const echoLines = Array.isArray(opts && opts.echoLines)
    ? opts.echoLines.map((line) => String(line).trim()).filter((line) => line.length >= 8)
    : [];

  // 2. 行中夹的提示符 = 换行（它后面的都是回显）。
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/PS [A-Za-z]:[^>\n]*> ?/g, "\n");

  const kept = [];
  for (const rawLine of normalized.split("\n")) {
    // 5. 退出码判定行的回显 = 命令已经跑完，后面全是包装串回显 → 整体截断。
    if (EXIT_ECHO_RE.test(rawLine)) break;
    // 3. 整行都是续行回显。
    if (/^>> /.test(rawLine)) continue;
    // 4. 在第一个标记 / 包装串变量处截断，保留前缀（真输出可能在前面）。
    let line = rawLine;
    const cutAt = line.search(/__MT_[SE]_|\$__mt/);
    if (cutAt >= 0) line = line.slice(0, cutAt);
    line = line.replace(/^>> /, "").replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // 6. 回显的折行残片 / 整行回显 / 截断后剩下的回显前缀。
    //    一般的折行残片至少 8 字符；但 ` 2>&1` 这种尾巴可能折出 `&1` 这类 2 字符
    //    短残片，它们一定含重定向/管道字符，这类也当回显丢。
    const isFragmentOf = (echo) => echo === trimmed || echo.startsWith(trimmed) || echo.endsWith(trimmed);
    const fragment =
      (trimmed.length >= 8 && echoLines.some(isFragmentOf)) ||
      (trimmed.length >= 2 && /[&|>]/.test(trimmed) && echoLines.some(isFragmentOf));
    if (fragment) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * 剥掉 OSC 序列（`ESC ] … BEL` / `ESC ] … ESC \\`）与 stripAnsi 漏掉的其余 CSI。
 *
 * 为什么必须单独剥：
 *   1. 本仓库给每个会话注入了 OSC 7（当前目录），它夹在命令输出里。`stripAnsi()`
 *      的正则（PROTOCOL §4.2 逐字规定，不能改）吃 OSC 时只吃掉前半截，会留下
 *      `ile://NING/C:/…` 这种残渣（真 PTY 实测）。
 *   2. 同一个正则不认 `ESC [57X` 这类以 `X` / `@` 结尾的 CSI，PSReadLine 重绘
 *      经常发，不剥会在输出里留随机字母。
 * **只对 PowerShell 分支用**：bash 分支的输出必须逐字节不变（那是既有测试锁定的
 * 行为，与本卡无关）。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTerminalNoise(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * PROTOCOL §4.4 的能力探测串。
 *
 * 协议原文只给了这一行命令、没写行尾；写进 PTY 时必须补一个 `\n` 才会被 shell
 * 提交执行（不补的话那行一直停在提示行上，探测永远等不到回显）。与 §4.1 的
 * buildPayload 末尾带换行是同一个理由。
 */
export function buildProbePayload(nonce) {
  return `printf '__MT_PROBE_${nonce}__%s\\n' "ok"\n`;
}

/**
 * PowerShell 分支的探测串（PROTOCOL §4.4，TASK-FIX-PS-SHELL §6.3）。
 *
 * 与 bash 分支的唯一差别是行尾：必须用 **CR** 提交，用 `\n` 会停在 `>> ` 上
 * 不执行（探测永远等不到标记）。`_ok` 直接拼在标记后面，回显与真输出同形。
 *
 * @param {string} nonce
 * @returns {string}
 */
export function buildPowerShellProbePayload(nonce) {
  return `Write-Output '__MT_PROBE_${nonce}__ok'\r`;
}

/**
 * 探测标记是否真的被「执行」过（PROTOCOL §4.4）。
 *
 * bash 分支的探测串是 `printf '__MT_PROBE_<nonce>__%s\n' "ok"`，回显里只出现
 * `__MT_PROBE_<nonce>__%s`，所以 `includes(marker)` 不会被回显骗过。
 *
 * PowerShell 分支不同：探测串是 `Write-Output '__MT_PROBE_<nonce>__ok'`，**回显本身**
 * 就含完整标记（真 PTY 实测）。所以不能只 `includes`，要排掉 `Write-Output` 的回显行，
 * 否则「终端能回显」就会被当成「终端能执行」。
 *
 * @param {string} text 已 stripAnsi 的累积输出
 * @param {string} marker `__MT_PROBE_<nonce>__ok`
 * @param {"bash"|"powershell"} family
 * @returns {boolean}
 */
export function probeMarkerSeen(text, marker, family) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (typeof marker !== "string" || marker.length === 0) return false;
  if (family !== "powershell") return text.includes(marker);
  return text
    .split(/\r\n|\r|\n/)
    .some((line) => line.includes(marker) && !line.includes("Write-Output"));
}

/**
 * 从（已 stripAnsi 的）buffer 里切出最后一次命令的输出。
 *
 * @param {string} buffer
 * @param {string} startMark
 * @param {string} endMark
 * @returns {{found:boolean, finished:boolean, exitCode:number|null, output:string}}
 */
export function splitBuffer(buffer, startMark, endMark) {
  const text = typeof buffer === "string" ? buffer : "";
  // 回显里也会出现 startMark（它就写在 printf 的参数里）→ 必须取最后一次。
  const startAt = text.lastIndexOf(startMark);
  if (startAt < 0) return { found: false, finished: false, exitCode: null, output: "" };
  const afterStart = text.slice(startAt + startMark.length);

  // endMark 也必须取**最后一次**（与 startMark 的 lastIndexOf 同思路）。
  // 命令输出里可能本身就含本命令的 endMark + 数字（`set -x`、`bash -x`、`history`、
  // `cat` 了自己的脚本），取第一个会把输出截空、还会拿到伪造的 exitCode。
  const endRe = new RegExp(`${escapeRegExp(endMark)}(\\d+)`, "g");
  let match = null;
  for (let found = endRe.exec(afterStart); found !== null; found = endRe.exec(afterStart)) {
    match = found;
  }
  if (!match) {
    return { found: true, finished: false, exitCode: null, output: afterStart.trim() };
  }
  const output = afterStart.slice(0, match.index).trim();
  const exitCode = Number.parseInt(match[1], 10);
  return {
    found: true,
    finished: true,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    output,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 创建命令执行器。
 *
 * @param {object} opts
 * @param {object} opts.sessions 本地 SessionManager（提供 on/off/write/get）
 * @param {object} [opts.remote] 远程 RemoteRegistry（同接口）
 * @param {(entry:object)=>void} [opts.log]
 * @param {number} [opts.quietMs] 基础静默阈值（实际阈值 = quietMs * quietFactor）
 * @param {number} [opts.minWaitMs]
 * @param {number} [opts.timeoutMs] 总超时（兜底，不随静默阈值放宽）
 * @param {number} [opts.quietFactor] 静默阈值倍数，默认 DEFAULT_QUIET_FACTOR
 *        （环境变量 MAGPIE_TERMINAL_QUIET_FACTOR 可覆盖，仅用于本机实测/排障）
 * @param {number} [opts.maxQuietMs] 静默阈值的上限（宽限后的天花板），
 *        默认 quietMs × DEFAULT_QUIET_MAX_FACTOR（即 1000 × 16 = 16000ms）
 * @param {number} [opts.tailGraceMs] 看到结束标记后再等多久才 resolve（默认 120ms），
 *        用于「输出里的伪造 endMark 先到、真实结束标记后到」的情形
 */
export function createCommandRunner(opts = {}) {
  const sessions = opts.sessions;
  const remote = opts.remote;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const envFactor = Number.parseFloat(process.env.MAGPIE_TERMINAL_QUIET_FACTOR || "");
  const factorInput = Number.isFinite(opts.quietFactor) ? opts.quietFactor : envFactor;
  const quietFactor = Number.isFinite(factorInput) && factorInput > 0 ? factorInput : DEFAULT_QUIET_FACTOR;
  const defaultQuietMs = Number.isFinite(opts.quietMs) ? opts.quietMs : DEFAULT_QUIET_MS;
  const defaultTimeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const defaultMinWaitMs = Number.isFinite(opts.minWaitMs) ? opts.minWaitMs : DEFAULT_MIN_WAIT_MS;
  const defaultMaxQuietMs = Number.isFinite(opts.maxQuietMs) ? opts.maxQuietMs : null;
  const defaultTailGraceMs = Number.isFinite(opts.tailGraceMs) ? opts.tailGraceMs : DEFAULT_TAIL_GRACE_MS;

  /** sessionId -> "local" | "remote" | null（由 ws.mjs 注入） */
  let sessionResolver = () => null;

  /**
   * sessionId -> shell 展示名（如 `PowerShell 7` / `bash` / `ssh u@h`），由 ws.mjs 注入。
   * 独立于 sessionResolver：现有测试依赖后者的返回值形状（"local" | "remote" | null）。
   */
  let shellNameResolver = () => null;

  /** sessionId -> "ok" | "unsupported"（能力探测缓存，PROTOCOL §4.4） */
  const capabilities = new Map();

  /** sessionId -> 正在执行的那条命令的上下文（同一会话不并发跑两条） */
  const active = new Map();

  function setSessionResolver(fn) {
    sessionResolver = typeof fn === "function" ? fn : () => null;
  }

  /** 注入「这个会话用的是哪个 shell」（TASK-FIX-PS-SHELL §6.5）。 */
  function setShellNameResolver(fn) {
    shellNameResolver = typeof fn === "function" ? fn : () => null;
  }

  /** 这个会话该走哪个 payload 分支（`"bash" | "powershell"`）。 */
  function familyOf(sessionId) {
    let name = null;
    try {
      name = shellNameResolver(sessionId);
    } catch {
      // 解析器自己抛错也不能把命令执行带崩：退化为 bash 分支。
      name = null;
    }
    return shellFamilyOf(name);
  }

  function registryFor(sessionId) {
    const kind = sessionResolver(sessionId);
    if (kind === "remote" && remote) return remote;
    if (kind === "local" && sessions) return sessions;
    // resolver 没给答案时退化为「谁有这个会话就用谁」。
    if (remote && typeof remote.get === "function" && remote.get(sessionId)) return remote;
    if (sessions && typeof sessions.get === "function" && sessions.get(sessionId)) return sessions;
    return null;
  }

  function attach(sessionId, onOutput) {
    const registry = registryFor(sessionId);
    if (!registry || typeof registry.on !== "function") return null;
    registry.on("pty.output", onOutput);
    return () => {
      if (typeof registry.off === "function") registry.off("pty.output", onOutput);
    };
  }

  /** 把命令写进 PTY：本地 sessions.write，远程 remote.write（PROTOCOL §4.1）。 */
  function writeTo(sessionId, payload) {
    const registry = registryFor(sessionId);
    if (!registry || typeof registry.write !== "function") return false;
    registry.write(sessionId, payload);
    return true;
  }

  /**
   * 能力探测：每个会话一次，结果按 sessionId 缓存。
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async function probe(sessionId) {
    const cached = capabilities.get(sessionId);
    if (cached === "ok") return true;
    if (cached === "unsupported") return false;

    const nonce = crypto.randomBytes(6).toString("hex");
    const marker = `__MT_PROBE_${nonce}__ok`;
    const family = familyOf(sessionId);
    const payload = family === "powershell" ? buildPowerShellProbePayload(nonce) : buildProbePayload(nonce);

    const supported = await new Promise((resolve) => {
      let buffer = "";
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (detach) detach();
        resolve(value);
      };
      const onOutput = (info) => {
        if (!info || info.id !== sessionId) return;
        buffer += typeof info.data === "string" ? info.data : "";
        if (probeMarkerSeen(stripAnsi(buffer), marker, family)) finish(true);
      };
      const detach = attach(sessionId, onOutput);
      const timer = setTimeout(() => finish(false), defaultTimeoutMs > 5000 ? 5000 : defaultTimeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      if (!writeTo(sessionId, payload)) finish(false);
    });

    capabilities.set(sessionId, supported ? "ok" : "unsupported");
    if (!supported) {
      log({
        level: "warn",
        code: "EXEC_UNSUPPORTED",
        msg: "pty sentinel probe failed",
        sessionId,
      });
    }
    return supported;
  }

  /**
   * 执行一条命令。
   *
   * @param {{sessionId: string, command: string, quietMs?: number, timeoutMs?: number,
   *          minWaitMs?: number}} input
   * @returns {Promise<{ok: boolean, exitCode: number|null, output: string,
   *          truncated: boolean, userText?: string, code?: string}>}
   */
  async function run({ sessionId, command, quietMs, timeoutMs, minWaitMs } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { ok: false, code: "SESSION_GONE", exitCode: null, output: "", truncated: false, userText: "会话已经结束。" };
    }
    if (typeof command !== "string" || command.trim().length === 0) {
      return { ok: false, code: "EMPTY_COMMAND", exitCode: null, output: "", truncated: false, userText: "没有要执行的命令。" };
    }
    if (active.has(sessionId)) {
      return {
        ok: false,
        code: "BUSY_SESSION",
        exitCode: null,
        output: "",
        truncated: false,
        userText: "这个终端里还有一条命令没跑完，等它结束。",
      };
    }

    const registry = registryFor(sessionId);
    if (!registry || (typeof registry.get === "function" && !registry.get(sessionId))) {
      return {
        ok: false,
        code: "SESSION_GONE",
        exitCode: null,
        output: "",
        truncated: false,
        userText: "这个终端的会话已经结束。",
      };
    }

    const supported = await probe(sessionId);
    if (!supported) {
      return {
        ok: false,
        code: "EXEC_UNSUPPORTED",
        exitCode: null,
        output: "",
        truncated: false,
        userText: USER_TEXT_UNSUPPORTED,
      };
    }

    // 静默阈值：基础值 × 倍数（默认 1000 × 3 = 3000ms）作为**第一次**判定点；
    // 到点但没结束标记就逐次 ×2 宽限，直到 quietCap（默认 1000 × 16 = 16000ms）。
    // 总超时（默认 90 秒）不随静默阈值放宽，始终是最后的硬兜底。
    const baseQuiet = (Number.isFinite(quietMs) ? quietMs : defaultQuietMs) * quietFactor;
    const quiet = baseQuiet;
    const quietCap =
      defaultMaxQuietMs !== null
        ? Math.max(baseQuiet, defaultMaxQuietMs)
        : Math.max(baseQuiet, (Number.isFinite(quietMs) ? quietMs : defaultQuietMs) * DEFAULT_QUIET_MAX_FACTOR);
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeoutMs;
    const minWait = Number.isFinite(minWaitMs) ? minWaitMs : defaultMinWaitMs;

    const family = familyOf(sessionId);
    const { startMark, endMark } = makeMarks();
    const payload =
      family === "powershell"
        ? buildPowerShellPayload(command, startMark, endMark)
        : buildPayload(command, startMark, endMark);
    // 日志里绝不出现完整命令（PROTOCOL §4.5）。
    // TASK-FIX17-E R3：前 40 字符也要过 `redact()`。
    //   为什么：这 40 字符是**用户原话切片**，里面可能带 `-p密码`、`--token=…`
    //   或 `C:\Users\<name>\…` 这类绝对路径。logger 那边虽然也会再过一次，
    //   但这里有两条独立理由不能省略：
    //   ① `createCommandRunner({ log })` 的调用方可以传自己的 sink（单测、探针、
    //      将来的日志转发），那份 sink 不一定过 `formatLogLine`；
    //   ② 上游少一次泄漏面总比下游多一次补救划算（security-model §4「单点过滤
    //      漏一次就够出事」）。
    log({
      level: "info",
      code: "COMMAND_RUN_START",
      msg: "running command in pty",
      sessionId,
      family,
      commandLength: command.length,
      commandHead: redact(command.slice(0, 40)),
    });

    const startedAt = Date.now();
    let buffer = "";
    let lastDataAt = startedAt;
    let finished = false;

    return await new Promise((resolve) => {
      let quietTimer = null;
      let totalTimer = null;

      const cleanup = () => {
        finished = true;
        active.delete(sessionId);
        if (quietTimer) clearTimeout(quietTimer);
        if (totalTimer) clearTimeout(totalTimer);
        if (tailTimer) clearTimeout(tailTimer);
        quietTimer = null;
        totalTimer = null;
        tailTimer = null;
        if (detach) detach();
      };

      const settle = (rawOutput, exitCode, extra) => {
        if (finished) return;
        cleanup();
        const stripped = stripAnsi(family === "powershell" ? stripTerminalNoise(rawOutput) : rawOutput);
        // PowerShell 分支多一步清洗（§6.4）：bash 分支的输出一个字节都不许变。
        const cleaned =
          family === "powershell"
            ? cleanPowerShellOutput(stripped, { echoLines: payload.split("\r") })
            : stripped;
        const { output, truncated } = truncateOutput(cleaned);
        const durationMs = Date.now() - startedAt;
        log({
          level: "info",
          code: "COMMAND_RUN_END",
          msg: "command finished",
          sessionId,
          exitCode,
          durationMs,
          outputLength: output.length,
          truncated,
        });
        resolve({
          ok: true,
          exitCode,
          output,
          truncated,
          durationMs,
          ...(extra || {}),
        });
      };

      // 当前生效的静默阈值：从 quiet（默认 3000ms）开始，每次「到点但仍无结束标记」
      // 就升一档（×2）直到 quietCap（默认 16000ms），到天花板才真的判 EXEC_QUIET。
      // 这样既不切断慢启动命令（`sleep 5; echo late` 第一条输出在 5s），也不切断
      // 长空窗命令（真 PTY 实测 `node --test` 的输出间隔最长 9031ms），
      // 而真正卡住 / 等输入的命令按默认配置 16 秒内给结论，总超时 90 秒仍是硬兜底。
      let quietThreshold = quiet;
      // 看到结束标记后的小宽限（修复 3）：让真实结束标记有机会追上伪造的那一条。
      let tailTimer = null;

      const settleFromLastMark = () => {
        const split = splitBuffer(buffer, startMark, endMark);
        if (!split.finished) return;
        settle(split.output, split.exitCode, {});
      };

      const checkQuiet = () => {
        if (finished) return;
        const elapsed = Date.now() - startedAt;
        const idle = Date.now() - lastDataAt;
        // 静默判定只在本命令自己的 buffer/时间戳上算（PROTOCOL §6.7 第 2 点）。
        // elapsed 是「从写完命令到现在」，idle 是「距上次输出」。两者都过阈值才判静默，
        // 且必须有 startMark（否则连通都没通，交给总超时兜底）。
        const split = splitBuffer(buffer, startMark, endMark);
        if (elapsed >= minWait && idle >= quietThreshold && split.found) {
          if (quietThreshold < quietCap) {
            // 到点但没看到结束标记：升一档再等，不立刻判死（修复 1）。
            quietThreshold = Math.min(quietCap, quietThreshold * 2);
            quietTimer = setTimeout(checkQuiet, Math.max(20, quietThreshold - idle));
            if (quietTimer && typeof quietTimer.unref === "function") quietTimer.unref();
            return;
          }
          settle(split.output, null, { userText: USER_TEXT_QUIET, code: "EXEC_QUIET" });
          return;
        }
        if (!finished) {
          quietTimer = setTimeout(checkQuiet, Math.max(20, quietThreshold - idle));
          if (quietTimer && typeof quietTimer.unref === 'function') quietTimer.unref();
        }
      };

      const onOutput = (info) => {
        if (!info || info.id !== sessionId) return;
        const chunk = typeof info.data === "string" ? info.data : "";
        if (chunk.length === 0) return;
        buffer += chunk;
        lastDataAt = Date.now();
        const split = splitBuffer(buffer, startMark, endMark);
        if (split.finished && !tailTimer) {
          // 先不 resolve：等 tailGraceMs 后再取一次最后一个 endMark（修复 3）。
          tailTimer = setTimeout(settleFromLastMark, defaultTailGraceMs);
          if (tailTimer && typeof tailTimer.unref === "function") tailTimer.unref();
        }
      };

      active.set(sessionId, { command, startedAt });
      const detach = attach(sessionId, onOutput);

      totalTimer = setTimeout(() => {
        if (finished) return;
        const split = splitBuffer(buffer, startMark, endMark);
        settle(split.output, null, { userText: USER_TEXT_TIMEOUT, code: "EXEC_TIMEOUT" });
      }, limit);
      if (totalTimer && typeof totalTimer.unref === "function") totalTimer.unref();

      quietTimer = setTimeout(checkQuiet, Math.max(minWait, quietThreshold));
      if (quietTimer && typeof quietTimer.unref === "function") quietTimer.unref();

      if (!writeTo(sessionId, payload)) {
        settle("", null, { userText: "这个终端的会话已经结束。", code: "SESSION_GONE" });
      }
    });
  }

  /** 会话关闭时清缓存（PROTOCOL §6.7）。 */
  function dispose(sessionId) {
    capabilities.delete(sessionId);
    active.delete(sessionId);
  }

  /** 仅供测试：清空全部缓存。 */
  function reset() {
    capabilities.clear();
    active.clear();
  }

  return { setSessionResolver, setShellNameResolver, run, probe, dispose, reset };
}
