// 切段器的行为锁（TASK-FIX17-H R1：剥离无害重定向）。
//
// 背景（真实事故）：用户当天 3 条命令全部带 `2>&1`，`splitSegments` 见到 `>` 就
// 返回 `{ok:false, hit:"redirect"}`，judge 命中 UNREVIEWABLE_HITS 就**跳过 AI 审阅**，
// 卡片于是永远写「审阅不可用，请自己看一眼」—— 审阅服务一次都没被调用。
//
// 这张表分三组，任何一组变红都等于安全边界变化：
//   ① 白名单（剥）：4 类无害重定向，剥完段内容只少掉重定向本身；
//   ② 不豁免（仍 redirect）：写文件 / 未知 fd / 别的 shell 的空设备写法；
//   ③ 结构性约束：引号内不动、剥离后空段 fail-closed、段数与顺序不变。

import test from "node:test";
import assert from "node:assert/strict";
import { splitSegments } from "../../src/policy/segments.mjs";

// ---------------------------------------------------------------- ① 白名单（剥）

const STRIP_CASES = [
  // [命令, 剥离后的段, 为什么无害]
  ["ls 2>&1", ["ls"], "stderr 并到 stdout，不落盘"],
  ["ls 1>&2", ["ls"], "stdout 并到 stderr，不落盘"],
  ["ls 2>&-", ["ls"], "关闭 fd 2，丢弃该流"],
  ["ls 1>&-", ["ls"], "关闭 fd 1，丢弃该流"],
  ["ls >/dev/null", ["ls"], "/dev/null 是位桶"],
  ["ls 1>/dev/null", ["ls"], "显式 fd 1 写空设备"],
  ["ls 2>/dev/null", ["ls"], "显式 fd 2 写空设备"],
  ["ls 2>>/dev/null", ["ls"], "追加到空设备"],
  ["ls &>/dev/null", ["ls"], "bash 的 stdout+stderr 一起丢"],
  ["ls </dev/null", ["ls"], "输入读空设备"],
  ["ls 0</dev/null", ["ls"], "显式 fd 0 读空设备"],
  ["ls > /dev/null", ["ls"], "运算符与目标之间有空格也是空设备"],
  ["docker version 2>&1", ["docker version"], "真实事故里的命令形态"],
  ["ls 2>&1|head", ["ls", "head"], "剥离后还要保住管道两段的边界"],
];

for (const [command, expected, why] of STRIP_CASES) {
  test(`剥离：${JSON.stringify(command)} → ${JSON.stringify(expected)}（${why}）`, () => {
    const result = splitSegments(command);
    assert.equal(result.ok, true, `${command} 应该能切`);
    assert.equal(result.stripped, true, `${command} 必须标成 stripped`);
    assert.deepEqual(result.segments, expected);
  });
}

test("剥离：raw 保留剥离前的原文（日志要看得见用户真正发的是什么）", () => {
  const result = splitSegments("docker version 2>&1 | head -20");
  assert.equal(result.ok, true);
  assert.equal(result.stripped, true);
  assert.deepEqual(result.segments, ["docker version", "head -20"]);
  assert.deepEqual(result.raw, ["docker version 2>&1", "head -20"]);
});

test("剥离：没剥过的命令 stripped=false 且 raw 与 segments 一致", () => {
  const result = splitSegments("ls -la");
  assert.equal(result.ok, true);
  assert.equal(result.stripped, false);
  assert.deepEqual(result.segments, ["ls -la"]);
  assert.deepEqual(result.raw, ["ls -la"]);
});

// ---------------------------------------------------------------- ② 不豁免（仍 redirect）

const NOT_SAFE = [
  ["ls > out.txt", "> 写文件（会截断）"],
  ["echo x >> ~/.bashrc", ">> 追加写文件"],
  ["cat /etc/passwd > /tmp/leak.txt", "读内容再写盘 = 外泄"],
  ["ls >&out.txt", "bash 里 `>&word` 是写文件，不是 fd 复制"],
  ["ls 2>&12", "fd 12 不是 1/2/-，语义要看 shell"],
  ["ls >NUL", "cmd 的空设备写法，不在白名单"],
  ["ls 2>$null", "PowerShell 的空设备写法，不在白名单"],
  ["ls 2>/dev/null > out.txt", "剥掉无害的那半，剩下写文件的仍要 confirm"],
  ["ls 2>&1x", "尾部不是边界，可能是别的语法"],
  ["ls >/dev/nullx", "`/dev/nullx` 是普通文件名"],
  ["ls 3>&1", "fd 3 不在 1/2/- 内"],
  ["ls a2>&1", "那个 2 是词的一部分（a2），剥掉会改命令文字"],
  ["ls &> out.txt", "&>file 是写文件"],
  ["ls &>> out.txt", "&>>file 是追加写文件"],
];

for (const [command, why] of NOT_SAFE) {
  test(`不豁免：${JSON.stringify(command)} 仍 redirect（${why}）`, () => {
    const result = splitSegments(command);
    assert.equal(result.ok, false, `${command} 不该被剥离`);
    assert.equal(result.hit, "redirect");
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  });
}

// ---------------------------------------------------------------- ③ 结构性约束

test("引号内不动（双引号）：echo \"a 2>&1 b\" 原样保留", () => {
  const result = splitSegments('echo "a 2>&1 b"');
  assert.equal(result.ok, true);
  assert.equal(result.stripped, false);
  assert.deepEqual(result.segments, ['echo "a 2>&1 b"']);
});

test("引号内不动（单引号）：echo '> x' 原样保留", () => {
  const result = splitSegments("echo '> x'");
  assert.equal(result.ok, true);
  assert.equal(result.stripped, false);
  assert.deepEqual(result.segments, ["echo '> x'"]);
});

test("剥离后空段 → fail-closed（hit 仍是 redirect，不许当 noop）", () => {
  const result = splitSegments("ls; 2>/dev/null");
  assert.equal(result.ok, false);
  assert.equal(result.hit, "redirect");
  assert.match(result.reason, /空命令段/);
});

test("剥离后整条变空（只有一条重定向）也 fail-closed", () => {
  const result = splitSegments("2>/dev/null");
  assert.equal(result.ok, false);
  assert.equal(result.hit, "redirect");
});

test("段数与顺序不变：ls 2>&1; rm -rf x 仍是两段，第二段原样", () => {
  const result = splitSegments("ls 2>&1; rm -rf x");
  assert.equal(result.ok, true);
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0], "ls");
  assert.equal(result.segments[1], "rm -rf x");
});

test("段数与顺序不变：三段的 && 序列只少重定向，不多不少", () => {
  const result = splitSegments("ls 2>&1 && git status 2>/dev/null && echo done");
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, ["ls", "git status", "echo done"]);
  assert.equal(result.stripped, true);
});

test("向后兼容：老调用方只读 ok/segments，仍拿到剥离后的段", () => {
  const result = splitSegments("git status 2>&1");
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.segments));
  assert.equal(result.segments[0], "git status");
});
