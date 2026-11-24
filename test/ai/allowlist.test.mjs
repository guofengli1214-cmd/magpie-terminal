// 用户白名单匹配的行为锁（PROTOCOL-AGENT.md §2）。
//
// 三个必须做对的点（AC3）：
//   - prefix 命中要校验边界：`mkdir` 命中 `mkdir a b`，不命中 `mkdirx`
//   - exact 只认完全相等（trim 后）
//   - enabled:false 跳过

import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWLIST_MAX_ENTRIES,
  isValidAllowlistEntry,
  matchAllowlist,
} from "../../src/ai/allowlist.mjs";

const prefix = (pattern, enabled = true) => ({ pattern, mode: "prefix", enabled });
const exact = (pattern, enabled = true) => ({ pattern, mode: "exact", enabled });

test("prefix：mkdir 命中 mkdir a b", () => {
  const hit = matchAllowlist("mkdir a b", [prefix("mkdir")]);
  assert.equal(hit && hit.hit, "mkdir");
});

test("prefix：mkdir 不命中 mkdirx（词边界）", () => {
  assert.equal(matchAllowlist("mkdirx", [prefix("mkdir")]), null);
  assert.equal(matchAllowlist("mkdirx a", [prefix("mkdir")]), null);
});

test("prefix：pattern 后面正好结尾也命中", () => {
  assert.equal(matchAllowlist("mkdir", [prefix("mkdir")])?.hit, "mkdir");
});

test("prefix：pattern 后面是 tab 也算空白", () => {
  assert.equal(matchAllowlist("mkdir\ta", [prefix("mkdir")])?.hit, "mkdir");
});

test("prefix：多词 pattern（mkdir -p）同样按边界匹配", () => {
  assert.equal(matchAllowlist("mkdir -p a/b", [prefix("mkdir -p")])?.hit, "mkdir -p");
  assert.equal(matchAllowlist("mkdir -q a", [prefix("mkdir -p")]), null);
});

test("exact：只认完全相等（两侧 trim）", () => {
  assert.equal(matchAllowlist("npm run build", [exact("npm run build")])?.hit, "npm run build");
  assert.equal(matchAllowlist("  npm run build  ", [exact("npm run build")])?.hit, "npm run build");
  assert.equal(matchAllowlist("npm run build --watch", [exact("npm run build")]), null);
});

test("exact：不会退化成前缀匹配", () => {
  assert.equal(matchAllowlist("npm install", [exact("npm")]), null);
});

test("enabled:false 跳过，后面的条目还能命中", () => {
  const list = [prefix("mkdir", false), prefix("mkdir")];
  assert.equal(matchAllowlist("mkdir a", list)?.hit, "mkdir");
});

test("全部 enabled:false → 不命中", () => {
  assert.equal(matchAllowlist("mkdir a", [prefix("mkdir", false)]), null);
});

test("按数组顺序命中第一个 enabled:true 的", () => {
  const list = [prefix("mkdir"), prefix("mkdir a")];
  assert.equal(matchAllowlist("mkdir a", list)?.hit, "mkdir");
  // 反过来数组顺序反过来，命中的就是那条更长的。
  assert.equal(matchAllowlist("mkdir a", [prefix("mkdir a"), prefix("mkdir")])?.hit, "mkdir a");
});

test("大小写敏感", () => {
  assert.equal(matchAllowlist("MKDIR a", [prefix("mkdir")]), null);
  assert.equal(matchAllowlist("mkdir a", [prefix("MKDIR")]), null);
});

test("不做通配符展开", () => {
  assert.equal(matchAllowlist("mkdirX a", [prefix("mkdir*")]), null);
});

test("非法条目一律不命中（不抛错）", () => {
  const bad = [
    null,
    123,
    "mkdir",
    [],
    { pattern: "mkdir", mode: "prefix" }, // 缺 enabled
    { pattern: "", mode: "prefix", enabled: true },
    { pattern: "a\nb", mode: "prefix", enabled: true },
    { pattern: "mkdir", mode: "glob", enabled: true },
    { pattern: "x".repeat(501), mode: "prefix", enabled: true },
  ];
  for (const entry of bad) {
    assert.equal(matchAllowlist("mkdir a", [entry]), null, JSON.stringify(entry));
  }
  assert.equal(matchAllowlist("mkdir a", null), null);
  assert.equal(matchAllowlist("mkdir a", undefined), null);
  assert.equal(matchAllowlist("mkdir a", "mkdir"), null);
});

test("pattern 前后空格被 trim 后再比对", () => {
  assert.equal(matchAllowlist("mkdir a", [prefix("  mkdir  ")])?.hit, "mkdir");
});

test("命令为空串 / 非字符串不命中", () => {
  assert.equal(matchAllowlist("", [prefix("mkdir")]), null);
  assert.equal(matchAllowlist(null, [prefix("mkdir")]), null);
  assert.equal(matchAllowlist(123, [prefix("mkdir")]), null);
});

test("isValidAllowlistEntry 的形状契约", () => {
  assert.equal(isValidAllowlistEntry(prefix("mkdir")), true);
  assert.equal(isValidAllowlistEntry(exact("ls")), true);
  assert.equal(isValidAllowlistEntry({ pattern: "x".repeat(500), mode: "prefix", enabled: true }), true);
  assert.equal(isValidAllowlistEntry({ pattern: "x".repeat(501), mode: "prefix", enabled: true }), false);
  assert.equal(isValidAllowlistEntry({ pattern: "a\rb", mode: "prefix", enabled: true }), false);
});

test("上限常量是 200（PROTOCOL §1）", () => {
  assert.equal(ALLOWLIST_MAX_ENTRIES, 200);
});

// ---------------------------------------------------------------- TASK-V4-S §6.2 A1–A8
// P0-2：prefix 白名单只能逐段命中。以前只看整串开头，`mkdir … && rm -rf …`
// 会被整条自动执行（VERIFY-V4-G §4 P0-2 逐字复现）。

test("A1：mkdir … && rm … 不命中（以前命中，就是 P0-2）", () => {
  assert.equal(matchAllowlist("mkdir -p /tmp/x && rm -rf /tmp/victim", [prefix("mkdir")]), null);
});

test("A2：mkdir … ; rm … 不命中", () => {
  assert.equal(matchAllowlist("mkdir -p /tmp/x; rm -rf /tmp/victim", [prefix("mkdir")]), null);
});

test("A3：mkdir … | tee … 不命中（管道后段不是 mkdir）", () => {
  assert.equal(matchAllowlist("mkdir -p /tmp/x | tee /tmp/y", [prefix("mkdir")]), null);
});

test("A4：每一段都命中才放行 —— mkdir a && mkdir b", () => {
  assert.equal(matchAllowlist("mkdir a && mkdir b", [prefix("mkdir")])?.hit, "mkdir");
});

test("A5：mkdir a b 仍命中（不误伤多参数）", () => {
  assert.equal(matchAllowlist("mkdir a b", [prefix("mkdir")])?.hit, "mkdir");
});

test("A6：mkdirx / mkdirx a 仍不命中（词边界不回退）", () => {
  assert.equal(matchAllowlist("mkdirx", [prefix("mkdir")]), null);
  assert.equal(matchAllowlist("mkdirx a", [prefix("mkdir")]), null);
});

test("A7：exact 只认整条单段 —— npm run build && npm run test 不命中", () => {
  assert.equal(matchAllowlist("npm run build && npm run test", [exact("npm run build")]), null);
  assert.equal(matchAllowlist("npm run build", [exact("npm run build")])?.hit, "npm run build");
});

test("A8：ls && ls -la 命中（两段都命中同一条）", () => {
  assert.equal(matchAllowlist("ls && ls -la", [prefix("ls")])?.hit, "ls");
});

test("A9：切不开的命令一律不命中（换行 / 重定向 / 命令替换 / 引号不闭合）", () => {
  const list = [prefix("echo")];
  assert.equal(matchAllowlist("echo hi\nrm -rf /x", list), null);
  assert.equal(matchAllowlist("echo hi > out.txt", list), null);
  assert.equal(matchAllowlist("echo $(rm -rf x)", list), null);
  assert.equal(matchAllowlist('echo "unclosed', list), null);
});
