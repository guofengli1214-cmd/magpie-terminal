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
 * 按 && || ; | 切段，同时拒绝无法安全切分的构造。
 *
 * 拒绝的构造与对应 hit（fail-closed 的依据，judge 用它们跳过 AI 审阅）：
 *   - 换行 / 反斜杠结尾 / 引号不闭合 / 空段 → `unparsable`
 *   - 输出/输入重定向 `>` `<`              → `redirect`
 *   - 命令替换 `` ` `` / `$(`               → `substitution`
 *   - 后台执行 `&`                          → `unparsable`
 *   - 空命令                                → `noop`
 *
 * @param {string} input
 * @returns {{ok: true, segments: string[]}|{ok: false, reason: string, hit: string}}
 */
export function splitSegments(input) {
  const segments = [];
  let current = "";
  let quote = "";
  let any = false;

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
    if (ch === ">") {
      return { ok: false, reason: "命令含输出重定向，可能写文件", hit: "redirect" };
    }
    if (ch === "<") {
      return { ok: false, reason: "命令含输入重定向，无法判定来源", hit: "redirect" };
    }

    if (ch === "&") {
      if (next === "&") {
        segments.push(current);
        current = "";
        any = true;
        i += 1;
        continue;
      }
      return { ok: false, reason: "命令含后台执行符号", hit: "unparsable" };
    }

    if (ch === "|") {
      segments.push(current);
      current = "";
      any = true;
      if (next === "|") i += 1;
      continue;
    }

    if (ch === ";") {
      segments.push(current);
      current = "";
      any = true;
      continue;
    }

    current += ch;
  }

  if (quote !== "") {
    return { ok: false, reason: "引号不闭合，命令无法切分", hit: "unparsable" };
  }

  segments.push(current);

  const cleaned = segments.map((s) => s.trim());
  if (cleaned.some((s) => s.length === 0)) {
    return { ok: false, reason: "存在空命令段，命令无法切分", hit: "unparsable" };
  }
  if (!any && cleaned.length === 1 && cleaned[0].length === 0) {
    return { ok: false, reason: "空命令不执行", hit: "noop" };
  }
  return { ok: true, segments: cleaned };
}

/** 环境变量前缀包装 `FOO=1 cmd` 的判定（与 classify 共用，避免两份正则）。 */
export function hasAssignmentPrefix(token) {
  return ASSIGNMENT_RE.test(String(token));
}
