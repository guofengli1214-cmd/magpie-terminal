// 命令切段（唯一一份实现）。
//
// 为什么单独成文件：这张卡要求「用户白名单也必须逐段命中」，也就是
// `src/ai/allowlist.mjs` 与 `src/policy/classify.mjs` 必须用**同一套**切段规则。
// 之前 splitSegments 是 classify.mjs 的模块内私有函数，白名单那边只能靠
// `startsWith` 整串比对 → `mkdir -p /tmp/x && rm -rf /tmp/victim` 因为
// 「以 mkdir 开头」被自动执行（VERIFY-V4-G §4 P0-2）。
// 复制粘贴第二份实现会在两份规则漂移时开新口子，所以抽到这里共用。
//
// 纯函数、零 IO、永不抛：切不开就返回 { ok: false, reason, hit }。

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 「确定无害」的重定向白名单（TASK-FIX17-H R1）。
 *
 * 为什么需要它：用户当天 3 条命令全带 `2>&1`，全被判成 `redirect` → judge 命中
 * UNREVIEWABLE_HITS 跳过第 4 级 AI 审阅 → 卡片一律显示「审阅不可用」。
 * 审阅服务一次都没被调用，用户看到的原因却是「审阅服务坏了」。
 *
 * 只豁免这 4 类（**不是**「见到 `>` 就放过」）：
 *
 * | 形态 | 例子 | 为什么无害 |
 * |---|---|---|
 * | stderr→stdout 合并 | `2>&1`、`1>&2` | 只是把一条流并到另一条，不落盘 |
 * | 关闭 fd | `2>&-`、`1>&-` | 丢弃该流 |
 * | 输出到空设备 | `>/dev/null`、`2>>/dev/null`、`&>/dev/null` | /dev/null 是位桶 |
 * | 输入来自空设备 | `</dev/null`、`0</dev/null` | 读空设备 |
 *
 * 不豁免（仍返回 `redirect`，一条都不许「顺手放过」）：
 *   - `>file` / `>>file` / `2>file` / `&>file`：写文件
 *   - `>&file`：bash 里 `>&word` 就是「stdout+stderr 写文件」
 *   - `2>&12`：fd 12，不是 1/2/-，语义取决于 shell
 *   - `>NUL` / `2>$null`：不同 shell 语义不同（cmd / PowerShell），宁可不剥
 *
 * 正则从 `>` / `<` / `&` **本身**开始锚定（`^`），fd 数字前缀由调用方处理
 *（见 `matchSafeRedirect` 的 `prevIsDigit` 判断），尾部必须落在边界上，
 * 避免 `2>&1x` / `>/dev/nullx` 被误剥。尾部边界：空白 / `;` / `|` / `&` / `)` / `<` / `>` / 串尾。
 */
const SAFE_REDIRECTS = Object.freeze([
  // >&1  >&2  >&-  （fd 合并 / 关闭；`&` 后必须紧跟 1/2/-，所以 `>&out.txt` 天然不匹配）
  /^>&(?:1|2|-)(?=[\s;|&)<>]|$)/,
  // >/dev/null  2>/dev/null  2>>/dev/null
  /^>>?\s*\/dev\/null(?=[\s;|&)<>]|$)/,
  // </dev/null  0</dev/null
  /^<\s*\/dev\/null(?=[\s;|&)<>]|$)/,
  // &>/dev/null  &>>/dev/null（bash 的「stdout+stderr 一起」写法；从 `&` 开始匹配）
  /^&>>?\s*\/dev\/null(?=[\s;|&)<>]|$)/,
]);

/** 边界字符：重定向后面接这些就算干净结束。 */
const BOUNDARY_RE = /[\s;|&)<>]/;

/**
 * 从 `index`（`>` / `<` / `&` 自身的位置）起匹配一条无害重定向。
 *
 * fd 前缀（`2>`、`0<`）在 `>`/`<` **前面**，所以这里要往回看一个字符：
 *   - 前面是独立的 `[012]`（前面是串首或分隔符）→ 它是文件描述符，一起消费
 *   - 前面是别的数字（`3>&1`、`10>/dev/null`）→ 不剥（fd 号大于 2，语义不确认）
 *   - 前面是普通字符（`a2>&1`）→ 不剥（那个数字是词的一部分，剥了会改文字）
 *
 * @param {string} input 整串
 * @param {number} index 当前位置
 * @returns {{length: number, fdPrefix: boolean}|null} 命中就给出要消费的字符数与是否有 fd 前缀
 */
function matchSafeRedirect(input, index) {
  const prev = index > 0 ? input[index - 1] : "";
  const prevIsDigit = /[0-9]/.test(prev);
  let fdPrefix = false;
  if (prevIsDigit) {
    // 只认「独立且 <=2」的 fd 号：cmd 2>&1 剥，3>&1 / a2>&1 不剥。
    const beforeDigit = index >= 2 ? input[index - 2] : "";
    const standalone = beforeDigit === "" || BOUNDARY_RE.test(beforeDigit);
    if (!standalone || !/[012]/.test(prev)) return null;
    fdPrefix = true;
  }
  const slice = input.slice(index);
  for (const pattern of SAFE_REDIRECTS) {
    const hit = pattern.exec(slice);
    if (hit && hit[0].length > 0) return { length: hit[0].length, fdPrefix };
  }
  return null;
}

/**
 * 按 && || ; | 切段，同时拒绝无法安全切分的构造。
 *
 * 拒绝的构造与对应 hit（fail-closed 的依据，judge 用它们跳过 AI 审阅）：
 *   - 换行 / 反斜杠结尾 / 引号不闭合 / 空段 → `unparsable`
 *   - 输出/输入重定向 `>` `<`              → `redirect`
 *     （**例外**：SAFE_REDIRECTS 里的 4 类无害重定向会被剥离，剥完再判）
 *   - 命令替换 `` ` `` / `$(`               → `substitution`
 *   - 后台执行 `&`                          → `unparsable`
 *   - 空命令                                → `noop`
 *
 * 成功时返回 `{ ok: true, segments, raw, stripped }`：
 *   - `segments`：**剥离后**的段（判级与用户白名单都按它算）
 *   - `raw`：剥离前的原文段（只给日志 / 排查用）
 *   - `stripped`：这次是否真的剥掉了东西（classify 据此给 note）
 *
 * @param {string} input
 * @returns {{ok: true, segments: string[], raw: string[], stripped: boolean}|{ok: false, reason: string, hit: string}}
 */
export function splitSegments(input) {
  const segments = [];
  // 与 segments 一一对应的「剥离前原文」：落盘/日志要看得见用户真正发的是什么。
  // 用「段的起始下标」而不是第二个累加缓冲：current 永远是 input 的一个子串
  // （转义也原样复制），所以 raw 段就是 input.slice(segStart, 段尾)。
  const rawSegments = [];
  let segStart = 0;
  let current = "";
  let quote = "";
  let any = false;
  let stripped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = "";
      continue;
    }

    if (quote === '"') {
      current += ch;
      if (ch === "\\" && i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') quote = "";
      if (ch === "`") {
        return { ok: false, reason: "命令替换无法静态判定", hit: "substitution" };
      }
      if (ch === "$" && next === "(") {
        return { ok: false, reason: "命令替换无法静态判定", hit: "substitution" };
      }
      continue;
    }

    if (ch === "\\") {
      if (i + 1 >= input.length) {
        return { ok: false, reason: "命令以反斜杠结尾，无法切分", hit: "unparsable" };
      }
      current += ch + input[i + 1];
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "`") {
      return { ok: false, reason: "命令替换无法静态判定", hit: "substitution" };
    }
    if (ch === "$" && next === "(") {
      return { ok: false, reason: "命令替换无法静态判定", hit: "substitution" };
    }
    if (ch === "\n" || ch === "\r") {
      return { ok: false, reason: "命令含换行，无法按单行切分", hit: "unparsable" };
    }
    if (ch === ">" || ch === "<") {
      // 先试无害重定向白名单：命中就消费掉这段字符、补一个空格、继续扫描。
      // 补空格而不是删掉：`ls 2>&1|head` 剥完要变成 `ls |head`，两个词不能粘成一个。
      const safe = matchSafeRedirect(input, i);
      if (safe) {
        // fd 前缀（`2>` 里的 `2`）已经进了 current，要一起削掉。
        if (safe.fdPrefix) current = current.slice(0, -1);
        current += " ";
        i += safe.length - 1;
        stripped = true;
        continue;
      }
      return {
        ok: false,
        reason: ch === ">" ? "命令含输出重定向，可能写文件" : "命令含输入重定向，无法判定来源",
        hit: "redirect",
      };
    }

    if (ch === "&") {
      if (next === "&") {
        segments.push(current);
        rawSegments.push(input.slice(segStart, i));
        current = "";
        any = true;
        i += 1;
        segStart = i + 1;
        continue;
      }
      // `&>/dev/null`（bash 的 stdout+stderr 一起丢）—— 只在确实匹配白名单时剥。
      const safeAmp = matchSafeRedirect(input, i);
      if (safeAmp) {
        current += " ";
        i += safeAmp.length - 1;
        stripped = true;
        continue;
      }
      // `&>file` / `&>>file` 是写文件（bash），归到输出重定向，而不是「后台符号」。
      if (next === ">") {
        return { ok: false, reason: "命令含输出重定向，可能写文件", hit: "redirect" };
      }
      return { ok: false, reason: "命令含后台执行符号", hit: "unparsable" };
    }

    if (ch === "|") {
      segments.push(current);
      rawSegments.push(input.slice(segStart, i));
      current = "";
      any = true;
      if (next === "|") i += 1;
      segStart = i + 1;
      continue;
    }

    if (ch === ";") {
      segments.push(current);
      rawSegments.push(input.slice(segStart, i));
      current = "";
      any = true;
      segStart = i + 1;
      continue;
    }

    current += ch;
  }

  if (quote !== "") {
    return { ok: false, reason: "引号不闭合，命令无法切分", hit: "unparsable" };
  }

  segments.push(current);
  rawSegments.push(input.slice(segStart));

  const cleaned = segments.map((s) => s.trim());
  if (cleaned.some((s) => s.length === 0)) {
    // 剥离后空段（例如 `ls; 2>/dev/null`）的语义与「本来就有空段」不同，
    // 但结论一样是 fail-closed：剥完什么都不剩，就说明这条命令没法静态判定。
    if (stripped) {
      return { ok: false, reason: "剥离无害重定向后存在空命令段", hit: "redirect" };
    }
    return { ok: false, reason: "存在空命令段，命令无法切分", hit: "unparsable" };
  }
  if (!any && cleaned.length === 1 && cleaned[0].length === 0) {
    return { ok: false, reason: "空命令不执行", hit: "noop" };
  }
  return { ok: true, segments: cleaned, raw: rawSegments.map((s) => s.trim()), stripped };
}

/** 环境变量前缀包装 `FOO=1 cmd` 的判定（与 classify 共用，避免两份正则）。 */
export function hasAssignmentPrefix(token) {
  return ASSIGNMENT_RE.test(String(token));
}
