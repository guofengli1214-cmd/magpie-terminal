// TASK-FIX17-J R4 / AC4：静态护栏（src/policy/destructive-targets.mjs）。
//
// 护栏是不依赖 AI 的第二道闸门，判定式：
//   ok = (在 cwd 树内 || 对话里点名过 basename) && !(盘根 || 家目录 || cwd 或它的祖先 || 通配符)
//
// 本文件全部用**真目录**（os.tmpdir 下现建现删），不写仓库里的任何文件。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractDestructiveTargets,
  guardTargets,
  targetFacts,
  DESTRUCTIVE_HEADS,
} from "../../src/policy/destructive-targets.mjs";

/* ---------------------------------------------------------------- 夹具 */

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-j-guard-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, "empty-dir"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "full-dir"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "full-dir", "a.txt"), "hello");
  fs.writeFileSync(path.join(cwd, "wrong-file.txt"), "oops");
  fs.mkdirSync(path.join(root, "sibling"), { recursive: true });
  return { root, cwd };
}

const SANDBOX = makeSandbox();
const CWD = SANDBOX.cwd;

test.after(() => {
  try {
    fs.rmSync(SANDBOX.root, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言结果。
  }
});

/** 跑一遍「解析目标 + 护栏」。 */
function guard(command, { cwd = CWD, historyText = "" } = {}) {
  const extracted = extractDestructiveTargets(command);
  const verdict = guardTargets({
    targets: extracted.targets,
    cwd,
    historyText,
    targetsUnresolved: extracted.targetsUnresolved,
  });
  return { ...extracted, ...verdict };
}

/* ---------------------------------------------------------------- 目标解析 */

test("R4/K R3：命令头表就是 rm/rmdir/del/erase/mv/move/cp/copy + PowerShell 删除/清空四头", () => {
  // K 批（TASK-FIX17-K R3）加了 remove-item / ri / clear-content / clc：
  // 它们原来不在表里 → 护栏取不到目标 → 直接 ok=true（J 批验收发现的缺口）。
  // 本断言仍是**精确集合**（多了少了都失败），不是放宽。
  assert.deepEqual(
    [...DESTRUCTIVE_HEADS].sort(),
    ["clc", "clear-content", "copy", "cp", "del", "erase", "move", "mv", "remove-item", "ri", "rm", "rmdir"].sort(),
  );
});

test("R4：没有破坏性命令头 → heads=false，护栏直接放行", () => {
  for (const command of ["ls -la", "git status", "echo hi", "cat a.txt"]) {
    const extracted = extractDestructiveTargets(command);
    assert.equal(extracted.heads, false, `${command} 不该算破坏性命令`);
    assert.deepEqual(extracted.targets, []);
    const verdict = guardTargets({ targets: extracted.targets, cwd: CWD });
    assert.equal(verdict.ok, true, `${command} 护栏必须放行`);
  }
});

test("R4：解析目标时跳过 -rf / --recursive 与 cmd 的 /s /q /f 开关", () => {
  assert.deepEqual(extractDestructiveTargets("rm -rf --recursive ./build").targets, ["./build"]);
  assert.deepEqual(extractDestructiveTargets("del /s /q /f ./build").targets, ["./build"]);
  assert.deepEqual(extractDestructiveTargets("rmdir ./empty-dir").targets, ["./empty-dir"]);
  // mv/cp 的源与目标都算（两个都要过护栏，偏保守）。
  assert.deepEqual(extractDestructiveTargets("mv a.txt b.txt").targets, ["a.txt", "b.txt"]);
  assert.deepEqual(extractDestructiveTargets("cp -r src dst").targets, ["src", "dst"]);
});

test("R4：引号路径剥掉引号再解析", () => {
  const extracted = extractDestructiveTargets('rm "wrong-file.txt"');
  assert.deepEqual(extracted.targets, ["wrong-file.txt"]);
  assert.equal(guard('rm "wrong-file.txt"').ok, true);
});

/* ---------------------------------------------------------------- K 批：PowerShell 头 */

test("K R3：Remove-Item / ri / Clear-Content / clc 也能取到目标", () => {
  assert.deepEqual(extractDestructiveTargets("Remove-Item -Recurse -Force C:\\Windows").targets, ["C:\\Windows"]);
  assert.deepEqual(extractDestructiveTargets("Remove-Item C:\\Windows\\System32 -Recurse").targets, [
    "C:\\Windows\\System32",
  ]);
  assert.deepEqual(extractDestructiveTargets("ri -Recurse C:\\Users").targets, ["C:\\Users"]);
  assert.deepEqual(
    extractDestructiveTargets("Clear-Content C:\\Windows\\System32\\drivers\\etc\\hosts").targets,
    ["C:\\Windows\\System32\\drivers\\etc\\hosts"],
  );
  assert.deepEqual(extractDestructiveTargets("clc ./tmp/a.txt").targets, ["./tmp/a.txt"]);
});

test("K R3：-Path / -LiteralPath / -Destination 的下一个 token 是目标", () => {
  assert.deepEqual(extractDestructiveTargets("Remove-Item -Path C:\\ProgramData -Recurse").targets, ["C:\\ProgramData"]);
  assert.deepEqual(extractDestructiveTargets("Remove-Item -LiteralPath 'C:\\Program Files' -Force").targets, [
    "C:\\Program Files",
  ]);
  assert.deepEqual(extractDestructiveTargets("move -Destination D:\\x C:\\Windows").targets, [
    "D:\\x",
    "C:\\Windows",
  ]);
  // 粘连写法也认（PowerShell 两种写法等价）。
  assert.deepEqual(extractDestructiveTargets("Remove-Item -Path:C:\\Windows -Recurse").targets, ["C:\\Windows"]);
});

test("K R3：带空格的引号目标是一个 token（旧 split(' ') 会切碎）", () => {
  assert.deepEqual(extractDestructiveTargets("Remove-Item -Recurse -Force 'C:\\Program Files'").targets, [
    "C:\\Program Files",
  ]);
  assert.deepEqual(extractDestructiveTargets('mv "C:\\Program Files" D:\\backup').targets, [
    "C:\\Program Files",
    "D:\\backup",
  ]);
});

test("K R3：-Recurse:$false 当开关，不污染目标；缺值仍算读不出", () => {
  assert.deepEqual(extractDestructiveTargets("Remove-Item -Recurse:$false C:\\Windows").targets, ["C:\\Windows"]);
  const missing = extractDestructiveTargets("Remove-Item -Path -Recurse");
  assert.deepEqual(missing.targets, []);
  assert.equal(missing.targetsUnresolved, true);
});

test("R4：通配符 / 变量 / 家目录缩写读不出目标 → targetsUnresolved，护栏拦下", () => {
  for (const command of ["rm -rf src/*", "rm -rf $TARGET", "rm -rf %TEMP%/x", "rm -rf ~/tmp", "rm -rf"]) {
    const result = guard(command);
    assert.equal(result.targetsUnresolved, true, `${command} 必须标成读不出目标`);
    assert.equal(result.ok, false, `${command} 护栏必须拦下`);
  }
});

/* ---------------------------------------------------------------- AC4 四条 */

test("AC4：工作目录内的目标 → 放行", () => {
  const result = guard("rm -rf ./empty-dir");
  assert.equal(result.ok, true, `reason=${result.reason}`);
  assert.deepEqual(result.blocked, []);
});

test("AC4：工作目录外、对话里也没提过 → confirm", () => {
  const outside = path.join(SANDBOX.root, "not-mentioned-dir");
  const result = guard(`rm -rf "${outside}"`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocked, [outside]);
  assert.match(result.reason, /工作目录以外/);
  assert.match(result.reason, /没提过/);
});

test("AC4：工作目录外、但对话里点名过 → 放行", () => {
  const outside = path.join(SANDBOX.root, "photos");
  const result = guard(`rm -rf "${outside}"`, { historyText: "[第1轮·用户] 帮我把 photos 里面清掉\n" });
  assert.equal(result.ok, true, `reason=${result.reason}`);
});

test("AC4：basename 太短（<3 字符）不许靠「提到过」蒙混过关", () => {
  const outside = path.join(SANDBOX.root, "ab");
  const result = guard(`rm -rf "${outside}"`, { historyText: "ab" });
  assert.equal(result.ok, false, "两个字母的目录名出现在历史里不算点名");
});

test("AC4：`..` 往上跑（cwd 的兄弟目录）→ confirm", () => {
  const result = guard("rm -rf ../sibling");
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocked, ["../sibling"]);
});

test("AC4：盘根 / 家目录 / cwd 本身 / cwd 祖先 → 永远 confirm（对话里提过也不行）", () => {
  const home = os.homedir();
  const grandParent = path.dirname(SANDBOX.root);
  // blocked 里列的是**原始目标**（给用户看的原文），不是解析后的绝对路径。
  const cases = [
    "rm -rf /",
    "rm -rf C:\\",
    `rm -rf "${home}"`,
    "rm -rf .",
    `rm -rf "${CWD}"`,
    `rm -rf "${grandParent}"`,
  ];
  for (const command of cases) {
    const result = guard(command, { historyText: `${home} ${grandParent} ${path.basename(CWD)} 都提过` });
    assert.equal(result.ok, false, `${command} 必须拦下`);
    assert.ok(result.blocked.length > 0, `${command} 的 blocked 不能是空`);
    assert.match(result.reason, /只能你自己确认|需要你确认/, `${command} reason=${result.reason}`);
  }
});

test("K R3：护栏自己也会拦系统目录（不依赖灾难级闸门，独立失效面）", () => {
  const result = guard("rm -rf C:\\Windows", { historyText: "对话里提过 windows" });
  assert.equal(result.ok, false, "对话里点名过也不许放行系统目录");
  assert.match(result.reason, /系统目录/);
  assert.deepEqual(result.blocked, ["C:\\Windows"]);
});

test("R4：Windows 路径比较不分大小写（C:\\PROJECT 与 c:\\project 同一处）", () => {
  const upper = CWD.toUpperCase();
  const result = guard(`rm -rf "${path.join(upper, "empty-dir")}"`);
  assert.equal(result.ok, true, `大小写不该让 cwd 内的目标被判成外部：${result.reason}`);
});

/* ---------------------------------------------------------------- targetFacts */

test("AC5 / R4：targetFacts 对空目录 entries === 0，对文件给字节数，对不存在的给 missing", () => {
  const facts = targetFacts(["./empty-dir", "./wrong-file.txt", "./nope.txt"], CWD);
  const [empty, file, missing] = facts.targets;
  assert.equal(empty.type, "dir");
  assert.equal(empty.exists, true);
  assert.equal(empty.entries, 0);
  assert.equal(empty.insideCwd, true);

  assert.equal(file.type, "file");
  assert.equal(file.exists, true);
  assert.equal(file.bytes, Buffer.byteLength("oops", "utf8"));

  assert.equal(missing.type, "missing");
  assert.equal(missing.exists, false);
  assert.equal(missing.entries, null);
  assert.equal(missing.bytes, null);

  assert.equal(facts.emptyDirs, 1, "空目录计数必须是 1");
});

test("R4：targetFacts 对非空目录给条目数，且只读一层", () => {
  const facts = targetFacts(["./full-dir"], CWD);
  assert.equal(facts.targets[0].type, "dir");
  assert.equal(facts.targets[0].entries, 1);
  assert.equal(facts.emptyDirs, 0);
});

test("R4：targetFacts 是纯读 —— 不改文件、不创建目标、不抛", () => {
  const target = path.join(CWD, "wrong-file.txt");
  const before = fs.statSync(target);
  const missing = path.join(CWD, "should-not-be-created.txt");
  const facts = targetFacts(["./wrong-file.txt", "./should-not-be-created.txt"], CWD);
  const after = fs.statSync(target);
  assert.equal(before.size, after.size);
  assert.equal(before.mtimeMs, after.mtimeMs, "targetFacts 不许 touch 目标文件");
  assert.equal(fs.existsSync(missing), false, "targetFacts 不许创建目标");
  assert.equal(facts.targets.length, 2);

  // 不存在的路径 / 非法字符都不许抛。
  assert.doesNotThrow(() => targetFacts(["./a\u0000b"], CWD));
  assert.doesNotThrow(() => targetFacts([], CWD));
  assert.deepEqual(targetFacts([], CWD), { targets: [], emptyDirs: 0 });
});

test("R4：护栏的 reason 是给普通用户看的中文（不是英文、不是空串）", () => {
  const result = guard("rm -rf ../sibling");
  assert.equal(typeof result.reason, "string");
  assert.ok(/[\u4e00-\u9fa5]/.test(result.reason), `必须是中文：${result.reason}`);
  assert.ok(result.reason.length > 8);
});
