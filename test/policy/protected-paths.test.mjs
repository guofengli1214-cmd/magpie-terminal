// TASK-FIX17-K R1：系统目录保护表的锁。
//
// 表本身是纯函数、零 IO：归一化（去引号 / 反斜杠 / 尾随 * 与 / / 折叠 ..）
// 与「子树保护 / 只保护本身 / 系统变量写法」三件事都在这里钉死。
// 误伤面（用户自己的目录、/var/log、/usr/local）单独一组，防止以后往表里乱加。

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  PROTECTED_EXACT,
  PROTECTED_SUBTREES,
  isProtectedTarget,
  normalizeTargetPath,
} from "../../src/policy/protected-paths.mjs";

const CWD = path.resolve(process.cwd());

function forward(text) {
  return String(text).replace(/\\/g, "/");
}

/* ---------------------------------------------------------------- 归一化 */

test("K R1 normalizeTargetPath：去引号 / 反斜杠转正斜杠 / 去尾随 * 与 /", () => {
  assert.equal(normalizeTargetPath("'C:\\Windows\\\\'", CWD).toLowerCase(), "c:/windows");
  assert.equal(normalizeTargetPath('"C:\\Windows\\*"', CWD).toLowerCase(), "c:/windows");
  assert.equal(normalizeTargetPath("C:/Windows/*", CWD).toLowerCase(), "c:/windows");
  assert.equal(normalizeTargetPath("`C:\\ProgramData`", CWD).toLowerCase(), "c:/programdata");
});

test("K R1 normalizeTargetPath：先 resolve 再判，C:\\Windows\\..\\Windows 折回 Windows", () => {
  assert.equal(normalizeTargetPath("C:\\Windows\\..\\Windows", CWD).toLowerCase(), "c:/windows");
  assert.equal(normalizeTargetPath("C:/Windows/../../Windows/System32", CWD).toLowerCase(), "c:/windows/system32");
  assert.equal(normalizeTargetPath("/etc/../etc", CWD), "/etc");
});

test("K R1 normalizeTargetPath：相对路径按 cwd 解析，.. 在解析阶段折叠", () => {
  const build = normalizeTargetPath("./build", CWD);
  assert.ok(build.toLowerCase().endsWith("/build"), build);
  assert.equal(build.toLowerCase().startsWith(forward(CWD).toLowerCase()), true);

  const up = normalizeTargetPath("../outside", CWD);
  assert.equal(up.toLowerCase(), forward(path.resolve(CWD, "..", "outside")).toLowerCase());
});

test("K R1 normalizeTargetPath：空值 / 非字符串 / 根路径不抛错", () => {
  assert.equal(normalizeTargetPath("", CWD), "");
  assert.equal(normalizeTargetPath(null, CWD), "");
  assert.equal(normalizeTargetPath(undefined, CWD), "");
  assert.equal(normalizeTargetPath("/", CWD), "/");
  assert.equal(normalizeTargetPath("C:\\", CWD).toLowerCase(), "c:/");
  assert.doesNotThrow(() => normalizeTargetPath(12345, CWD));
});

/* ---------------------------------------------------------------- 表内容 */

test("K R1：子树表就是 Windows 四个系统目录，只保护本身表 21 项", () => {
  assert.deepEqual([...PROTECTED_SUBTREES], [
    "c:/windows",
    "c:/program files",
    "c:/program files (x86)",
    "c:/programdata",
  ]);
  assert.equal(PROTECTED_EXACT.length, 21);
  for (const entry of ["c:/users", "/", "/etc", "/usr", "/var", "/System", "/Library", "/Applications", "/private"]) {
    assert.ok(PROTECTED_EXACT.includes(entry), `${entry} 必须在只保护本身的表里`);
  }
  assert.equal(PROTECTED_EXACT.includes("c:/users/41807"), false, "不许把用户目录放进表里");
  assert.equal(PROTECTED_EXACT.includes("/var/log"), false, "/var/log 是日常可删路径");
});

/* ---------------------------------------------------------------- 子树保护 */

test("K R1：Windows 子树保护（本身 + 任意子路径，大小写与斜杠等价）", () => {
  const cases = [
    "C:\\Windows",
    "c:\\WINDOWS",
    "C:/Windows/",
    "C:\\Windows\\System32",
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
    "C:\\Program Files\\MyApp\\app.exe",
    "C:\\Program Files (x86)\\Old App",
    "C:\\ProgramData\\pkg\\cache",
    "C:\\Windows\\*",
  ];
  for (const target of cases) {
    const verdict = isProtectedTarget(target, CWD);
    assert.equal(verdict.protected, true, `${target} 必须受保护（resolved=${verdict.resolved}）`);
    assert.match(verdict.reason, /系统目录/);
  }
});

test("K R1：只保护本身的表项（子目录不在此列）", () => {
  for (const target of ["C:\\Users", "C:\\Users\\", "/", "/etc", "/etc/", "/usr", "/System", "/Library", "/private"]) {
    assert.equal(isProtectedTarget(target, CWD).protected, true, `${target} 必须受保护`);
  }
});

/* ---------------------------------------------------------------- 不误伤 */

test("K R1：用户自己的目录 / 日常可删路径不误伤", () => {
  const cases = [
    "C:\\Users\\41807",
    "C:\\Users\\41807\\project\\build",
    "C:/Users/41807/magpie-terminal/build",
    "/var/log/app.log",
    "/usr/local/lib/node_modules/foo",
    "C:\\Windows.old",
    "C:\\ProgramDataBackup",
    "C:\\Program FilesOld",
    "./build",
    "../dist",
  ];
  for (const target of cases) {
    const verdict = isProtectedTarget(target, CWD);
    assert.equal(verdict.protected, false, `${target} 不许判成系统目录（resolved=${verdict.resolved}）`);
    assert.equal(verdict.reason, null);
  }
});

/* ---------------------------------------------------------------- 系统变量 */

test("K R1：系统变量写法直接当系统目录（%SystemRoot% / %windir% / $env:SystemRoot）", () => {
  const cases = ["%SystemRoot%", "%SYSTEMROOT%\\System32", "%windir%", "$env:SystemRoot", "${env:SystemRoot}\\System32"];
  for (const target of cases) {
    const verdict = isProtectedTarget(target, CWD);
    assert.equal(verdict.protected, true, `${target} 必须受保护`);
    assert.equal(verdict.reason, "系统目录（环境变量写法）");
  }
});

test("K R1：非系统变量不在这张表里（交给护栏判）", () => {
  for (const target of ["$HOME", "%TEMP%\\x", "$env:TEMP", "~/tmp", "*"]) {
    assert.equal(isProtectedTarget(target, CWD).protected, false, `${target} 不该被系统目录表命中`);
  }
});

/* ---------------------------------------------------------------- 返回值 */

test("K R1 isProtectedTarget 返回 {protected, reason, resolved}，永不抛", () => {
  assert.deepEqual(Object.keys(isProtectedTarget("C:\\Windows", CWD)).sort(), ["protected", "reason", "resolved"]);
  assert.equal(typeof isProtectedTarget("C:\\Windows", CWD).resolved, "string");
  for (const value of [undefined, null, "", "   ", 12345, {}, []]) {
    assert.doesNotThrow(() => isProtectedTarget(value, CWD));
    assert.equal(isProtectedTarget(value, CWD).protected, false);
  }
});
