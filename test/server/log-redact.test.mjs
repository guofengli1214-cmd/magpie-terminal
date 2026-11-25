// TASK-FIX17-E R3 / AC5：日志脱敏的纯函数表驱动测试。
//
// 为什么这组测试是「安全断言」而不是「行为快照」：脱敏是「敏感内容不落盘」
// 的唯一实现点，一旦某条规则被顺手改宽（例如把密钥键名从黑名单里删掉），
// 日志就开始把凭据写到磁盘上，而所有功能测试仍然全绿。
// 所以每条规则都钉一个正例 + 一个「不该误伤」的反例。
//
// 注意（本文件的写法约定）：**凭据样本一律在运行时用字符码拼出来**，
// 不在源码里写字面量。原因有两条，都不是洁癖：
//   ① 这个仓库本身有一条「{{NAME_ab12cd34}} 形态 = 真凭据」的约定，字面量
//      写进源码就等于把「看起来像真 token 的串」提交进版本库，扫描器会报警；
//   ② 脱敏规则里就包含「模板占位符」这一条（TEMPLATE_TOKEN_RE），测试它就必须
//      真的产生那个形态的字符串 —— 由 `templateToken()` 现拼最不容易出错。
import test from "node:test";
import assert from "node:assert/strict";

import {
  CIRCULAR,
  MAX_DEPTH,
  REDACTED,
  isSecretKey,
  redact,
  redactString,
  redactText,
} from "../../src/server/log-redact.mjs";
import { formatLogLine, LOG_FILE_NAME, MAX_LOG_BYTES } from "../../src/server/logger.mjs";

const LBRACE = String.fromCharCode(0x7b);
const RBRACE = String.fromCharCode(0x7d);
const DOLLAR_OPEN = `${LBRACE}${LBRACE}`;
const DOLLAR_CLOSE = `${RBRACE}${RBRACE}`;

/** 拼出本仓库的凭据占位符形态：`{{NAME_xxxxxxxx}}`。 */
function templateToken(name) {
  return `${DOLLAR_OPEN}${name}${DOLLAR_CLOSE}`;
}

/** 一个普通的模板占位符样本（形状与真实凭据一致，值是假的）。 */
const PLACEHOLDER = templateToken("SECRET_fake1234");
/** 短到不该触发任何规则的「Bearer」正文（用来钉住不误伤）。 */
const BEARER_TOKEN = `abcdef${"123456"}`;

/* ========================================================================
 * 1. 键名命中
 * ====================================================================== */

test("AC5-1：凭据类键名（含大小写 / 下划线 / 横线变体）的值一律换成 [REDACTED]", () => {
  const payload = {
    token: "t-1",
    auth: "Basic xyz",
    Authorization: `Bearer ${BEARER_TOKEN}`,
    cookie: "mt=deadbeef",
    password: "hunter2",
    passwd: "hunter2",
    secret: "s3cr3t",
    apiKey: "k-1",
    api_key: "k-2",
    "API-KEY": "k-3",
    credential: "c-1",
    privateKey: "-----BEGIN-----",
    ssh_key: "AAAA",
    passphrase: "pp",
    sessionToken: "st",
  };
  const out = redact(payload);
  for (const key of Object.keys(payload)) {
    assert.equal(out[key], REDACTED, `键 ${key} 必须整体脱敏`);
  }
  // 反例：名字里带 token 但语义是「数量 / 长度」的字段必须保留，否则日志没法读。
  assert.equal(redact({ tokenBytes: 32 }).tokenBytes, 32);
  assert.equal(redact({ tokenCount: 7 }).tokenCount, 7);
});

test("AC5-2：isSecretKey 的归一化规则（大小写 / 下划线 / 横线 / 派生后缀 / session 家族）", () => {
  for (const key of ["token", "TOKEN", "apiKey", "api_key", "API-KEY", "parentTokenId", "userPassword"]) {
    assert.equal(isSecretKey(key), true, `${key} 应判为凭据键`);
  }
  for (const key of ["tokenBytes", "tokenCount", "msg", "code", "level", "commandHead"]) {
    assert.equal(isSecretKey(key), false, `${key} 不应判为凭据键`);
  }
  // `session` 家族：PRD R3 的口径是「键名含 session 的，值一律脱敏」。
  assert.equal(isSecretKey("sessionId"), true);
  assert.equal(isSecretKey("session"), true);
  assert.equal(isSecretKey("parentSessionToken"), true);
});

/* ========================================================================
 * 2. 字符串内容模式
 * ====================================================================== */

test("AC5-3：Bearer 令牌 → `Bearer [REDACTED]`（保留写法，不保留值）", () => {
  assert.equal(redactString(`Bearer ${BEARER_TOKEN}`), "Bearer [REDACTED]");
  assert.equal(
    redactString(`curl -H 'Authorization: bearer ${BEARER_TOKEN}' http://x`),
    "curl -H 'Authorization: bearer [REDACTED]' http://x",
  );
  // 反例：短于 8 位的不是令牌，不能被吃掉（例如正文里的 Bearer 一词）。
  assert.equal(redactString("Bearer ok"), "Bearer ok");
});

test("AC5-4：`-p密码` / `--password=…` / `--token …` → 保留参数名，值脱敏", () => {
  assert.equal(redactString("mysql -phunter2 -u root"), "mysql -p[REDACTED] -u root");
  assert.equal(redactString("mysql --password=hunter2"), "mysql --password=[REDACTED]");
  assert.equal(redactString("deploy --token abc123xyz"), "deploy --token=[REDACTED]");
  assert.equal(redactString("deploy --api-key=abcdef123456"), "deploy --api-key=[REDACTED]");
  // 间距形态（空格分隔）与引号形态都要吃掉。
  assert.equal(redactString("mysql -p hunter2"), "mysql -p[REDACTED]");
  assert.equal(redactString("mysql --password 'hunter 2'"), "mysql --password=[REDACTED]");
  // 反例：`-p` 只在「值带数字或符号」时才算密码，纯字母选项（`-print`）不受影响。
  assert.equal(redactString("find . -print"), "find . -print");
  assert.equal(redactString("find . -prune -print"), "find . -prune -print");
});

test("AC5-5：长 hex / base64（≥24 且字母数字都有）→ [REDACTED:len=N]", () => {
  assert.equal(redactString("a1b2c3d4e5f6a7b8c9d0e1f2"), "[REDACTED:len=24]");
  assert.equal(redactString("C10449CC1C7EF7F9123919AB"), "[REDACTED:len=24]");
  // 反例 1：纯数字（毫秒时间戳 / 端口）保留。
  assert.equal(redactString("1795566283681"), "1795566283681");
  // 反例 2：纯字母的长单词保留（否则日志会变成一片占位符）。
  assert.equal(
    redactString("supercalifragilisticexpialidocious"),
    "supercalifragilisticexpialidocious",
  );
});

test("AC5-6：模板占位符 {{NAME_xxx}} 也当密钥脱敏（它同样不该扩散）", () => {
  assert.equal(redactString(PLACEHOLDER), `[REDACTED:len=${PLACEHOLDER.length}]`);
  // 反例：普通模板占位符短于 8 个字符时不脱敏（不够像凭据）。
  assert.equal(redactString(templateToken("x")), templateToken("x"));
});

test("AC5-7：Windows 绝对路径只留盘符 + 最后一级", () => {
  assert.equal(redactString(String.raw`C:\Users\bob\secret.txt`), String.raw`C:\***\secret.txt`);
  assert.equal(
    redactString(String.raw`cat C:\Users\bob\proj\a.txt`),
    String.raw`cat C:\***\a.txt`,
  );
  // 正斜杠写法同样是绝对路径（node 在 Windows 上两种都吃）。
  assert.equal(redactString("cat C:/Users/bob/proj/a.txt"), "cat C:/***/a.txt");
  // 反例：相对路径不动（它不是身份信息，且缩写会毁掉排查价值）。
  assert.equal(redactString("cat page/icon.svg"), "cat page/icon.svg");
});

test("AC5-8：POSIX 绝对路径只留最后一级；接口路由不受影响", () => {
  assert.equal(redactString("ls /home/bob/proj/a.txt"), "ls /***/a.txt");
  assert.equal(redactString("cat /etc/nginx/nginx.conf"), "cat /***/nginx.conf");
  // 反例 1：单段（/tmp）不动。
  assert.equal(redactString("cd /tmp"), "cd /tmp");
  // 反例 2：HTTP 路由不是文件路径，必须原样留下（排查时最有用的字段）。
  // 这条是实测缺陷回归：早期实现把它缩写成了 `GET /***/export`。
  assert.equal(redactString("GET /api/logs/export"), "GET /api/logs/export");
  assert.equal(redactString("DELETE /api/logs"), "DELETE /api/logs");
  assert.equal(redactString("ws /ws"), "ws /ws");
});

test("AC5-9：邮箱 → 首字母 + ***@域名；IPv4 → 前两段 + .*.*", () => {
  assert.equal(redactString("bob@example.com"), "b***@example.com");
  assert.equal(redactString("联系 zhangsan.w@corp.co.uk 谢谢"), "联系 z***@corp.co.uk 谢谢");
  assert.equal(redactString("listen 127.0.0.1:3480"), "listen 127.0.*.*:3480");
  assert.equal(redactString("peer 192.168.10.24"), "peer 192.168.*.*");
  // 反例：版本号不是 IP（三段），不能被改成 .*.*。
  assert.equal(redactString("node v24.16.0"), "node v24.16.0");
});

test("AC5-10：非敏感文本一个字都不改（避免过度脱敏把日志变成噪声）", () => {
  for (const text of [
    "加个目录 mkdir demo",
    "npm test",
    "git status",
    "pty spawn failed",
    "SERVER_STARTED listening on 3480",
  ]) {
    assert.equal(redactString(text), text, `${text} 不该被改写`);
  }
});

/* ========================================================================
 * 3. 递归 / 边界
 * ====================================================================== */

test("AC5-11：null / undefined / 数字 / 布尔 原样返回", () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(42), 42);
  assert.equal(redact(0), 0);
  assert.equal(redact(-1.5), -1.5);
  assert.equal(redact(true), true);
  assert.equal(redact(false), false);
  assert.equal(redact(""), "");
});

test("AC5-12：嵌套对象与数组逐层脱敏（含数组里的对象、对象里的数组）", () => {
  const payload = {
    level: "warn",
    context: {
      token: "t-1",
      args: [
        "mysql -phunter2",
        { nested: { password: "p" }, path: String.raw`C:\Users\bob\x.txt` },
      ],
    },
    list: [{ apiKey: "k" }, `Bearer ${BEARER_TOKEN}`, 7],
  };
  assert.deepEqual(redact(payload), {
    level: "warn",
    context: {
      token: REDACTED,
      args: [
        "mysql -p[REDACTED]",
        { nested: { password: REDACTED }, path: String.raw`C:\***\x.txt` },
      ],
    },
    list: [{ apiKey: REDACTED }, "Bearer [REDACTED]", 7],
  });
});

test("AC5-13：循环引用返回 [Circular]，不抛也不死循环", () => {
  const node = { name: "root" };
  node.self = node;
  node.children = [node];
  const out = redact(node);
  assert.equal(out.name, "root");
  assert.equal(out.self, CIRCULAR);
  assert.deepEqual(out.children, [CIRCULAR]);

  // 两个对象互指同样要能收住。
  const a = {};
  const b = { a };
  a.b = b;
  assert.equal(redact(a).b.a, CIRCULAR);
});

test("AC5-14：深度上限是 8，超过返回 [Truncated] 而不是爆栈", () => {
  assert.equal(MAX_DEPTH, 8);
  let deep = { leaf: "x" };
  for (let i = 0; i < MAX_DEPTH + 4; i = i + 1) deep = { child: deep };
  const serialized = JSON.stringify(redact(deep));
  assert.match(serialized, /\[Truncated\]/);
  // 顶层本身不被截断（否则整条日志都没了）。
  assert.equal(Object.keys(redact({ a: 1 })).length, 1);
});

test("AC5-15：Error 只保留 name / message / stack，且栈里的绝对路径被缩写", () => {
  const err = new Error(String.raw`open failed: C:\Users\bob\proj\secret.txt`);
  err.code = "ENOENT";
  err.path = String.raw`C:\Users\bob\proj\secret.txt`;
  const out = redact({ err });
  assert.equal(out.err.name, "Error");
  assert.equal(out.err.message, String.raw`open failed: C:\***\secret.txt`);
  // 附加字段（code / path）不跟着出去：error-handling §2 只允许三个字段。
  assert.equal(out.err.code, undefined);
  assert.equal(out.err.path, undefined);
});

test("AC5-16：redactText 逐行脱敏（导出前整文过一遍），输出仍是合法 JSON", () => {
  const input = [
    JSON.stringify({ code: "A", detail: `Bearer ${BEARER_TOKEN}` }),
    JSON.stringify({ code: "B", path: String.raw`C:\Users\bob\secret.txt` }),
    JSON.stringify({ code: "C", head: "mysql --password=hunter2" }),
    "",
  ].join("\n");
  const out = redactText(input);
  assert.equal(out.includes(BEARER_TOKEN), false);
  assert.equal(out.includes("bob"), false);
  assert.equal(out.includes("hunter2"), false);
  assert.equal(out.split("\n").length, input.split("\n").length);
  // 关键：脱敏不能把 JSON 弄坏（早期实现对原文跑路径正则，把 `\\` 变成 `\`，
  // 导出的日志 `JSON.parse` 直接 Bad escaped character）。
  for (const line of out.split("\n").filter((item) => item.length > 0)) {
    assert.doesNotThrow(() => JSON.parse(line), `导出的每一行都必须是合法 JSON: ${line}`);
  }
  // 非法 JSON / 截断的半行也必须脱敏（导出不能指望文件是完好 JSON）。
  assert.equal(redactText(`{"a":"Bearer ${BEARER_TOKEN}`).includes(BEARER_TOKEN), false);
  assert.equal(redactText(""), "");
});

/* ========================================================================
 * 4. 与 logger 的接缝：写入前就脱敏
 * ====================================================================== */

test("AC5-17：formatLogLine 出来的单行不含原串（落地即安全）", () => {
  const line = formatLogLine(
    {
      level: "warn",
      code: "COMMAND_RUN_START",
      msg: "running command",
      sessionId: "11111111-2222-3333-4444-555555555555",
      commandHead: "mysql -phunter2",
      detail: String.raw`C:\Users\bob\secret.txt`,
      token: "should-not-appear",
      err: new Error(String.raw`boom at C:\Users\bob\secret.txt`),
    },
    "2026-11-25T00:41:02.512Z",
  );
  assert.equal(line.includes("\n"), false, "必须是单行（宿主按行 grep）");
  assert.equal(line.includes("hunter2"), false);
  assert.equal(line.includes("bob"), false);
  assert.equal(line.includes("should-not-appear"), false);
  assert.equal(line.includes("11111111-2222-3333-4444-555555555555"), false);
  // 结构还在：事后要能靠这一行定位，字段少了就没意义。
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.code, "COMMAND_RUN_START");
  assert.equal(parsed.ts, "2026-11-25T00:41:02.512Z");
  assert.equal(parsed.err.name, "Error");
  assert.ok(parsed.err.stack.includes("runner"), "栈里的函数名要保留（只缩路径）");
});

test("AC5-18：轮转阈值与文件名常量与卡片一致", () => {
  assert.equal(MAX_LOG_BYTES, 2 * 1024 * 1024);
  assert.equal(LOG_FILE_NAME, "show-terminal.log");
});
