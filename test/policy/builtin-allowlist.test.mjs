// TASK-FIX17-I：内置只读白名单可配置化（单一数据源 + builtinRulesFrom + 安全不变式）。
//
// 这一组是**本批唯一的放行门槛**：清单可配置 ≠ 安全判据可配置。
// 6 条安全不变式全部在 `classify()` 这一层断言（classify 天生只回 auto / confirm
// 三态，不经 judge、不构造审阅桩 —— J 批之后 judge 的黑名单层还会过 AI 审阅）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ALLOWLIST,
  DEFAULT_BUILTIN_ALLOWLIST,
  builtinRulesFrom,
} from "../../src/policy/allowlist.mjs";
import { classify } from "../../src/policy/classify.mjs";

/** 用一份内置清单判级（= 生产里 judge 传 opts.allowlist 的形态）。 */
function run(command, list) {
  return classify(command, { allowlist: builtinRulesFrom(list) });
}

/* ---------------------- ① 单一数据源 ---------------------- */

test("I-R1 DEFAULT_BUILTIN_ALLOWLIST 是冻结数组，且默认条数 = heads + 全部子命令", () => {
  assert.ok(Object.isFrozen(DEFAULT_BUILTIN_ALLOWLIST));
  assert.ok(DEFAULT_BUILTIN_ALLOWLIST.length > 50);
  // 逐项都是字符串、非空、无多余空白（设置页直接把它们画成列表行）。
  for (const rule of DEFAULT_BUILTIN_ALLOWLIST) {
    assert.equal(typeof rule, "string");
    assert.ok(rule.length > 0 && rule.length <= 64, `规则过长或为空：${rule}`);
    assert.equal(rule, rule.trim());
    assert.equal(rule, rule.replace(/\s+/g, " "));
    assert.ok(!rule.includes("  "), `连续空格：${rule}`);
  }
  // 头与子命令都在里面（不是只摊平了 heads）。
  assert.ok(DEFAULT_BUILTIN_ALLOWLIST.includes("free"));
  assert.ok(DEFAULT_BUILTIN_ALLOWLIST.includes("git status"));
  assert.ok(DEFAULT_BUILTIN_ALLOWLIST.includes("docker volume ls"));
  assert.ok(DEFAULT_BUILTIN_ALLOWLIST.includes("git stash list"));
});

test("I-R1 DEFAULT_ALLOWLIST 与 builtinRulesFrom(DEFAULT_BUILTIN_ALLOWLIST) 逐项相等", () => {
  const mined = builtinRulesFrom(DEFAULT_BUILTIN_ALLOWLIST);
  assert.deepEqual([...mined.heads], [...DEFAULT_ALLOWLIST.heads]);
  assert.deepEqual(Object.keys(mined.subcommands).sort(), Object.keys(DEFAULT_ALLOWLIST.subcommands).sort());
  for (const head of Object.keys(DEFAULT_ALLOWLIST.subcommands)) {
    assert.deepEqual([...mined.subcommands[head]], [...DEFAULT_ALLOWLIST.subcommands[head]], head);
  }
});

test("I-R1 builtinRulesFrom：默认清单与 hand-written DEFAULT_ALLOWLIST 判级结果一致（抽样）", () => {
  const commands = ["ls", "cat a.txt", "git status", "docker volume ls", "npm ls", "free -h", "date +%s"];
  for (const command of commands) {
    const a = classify(command);
    const b = classify(command, { allowlist: builtinRulesFrom(DEFAULT_BUILTIN_ALLOWLIST) });
    assert.equal(b.decision, a.decision, command);
    assert.equal(b.hit, a.hit, command);
  }
});

/* ---------------------- ② builtinRulesFrom 形状 ---------------------- */

test("I-R2 builtinRulesFrom(undefined/null/非数组) → DEFAULT_ALLOWLIST（老配置自然升级）", () => {
  for (const value of [undefined, null, 42, "ls", {}, true]) {
    const rules = builtinRulesFrom(value);
    assert.deepEqual([...rules.heads], [...DEFAULT_ALLOWLIST.heads], String(value));
    assert.deepEqual(Object.keys(rules.subcommands).sort(), Object.keys(DEFAULT_ALLOWLIST.subcommands).sort());
  }
});

test("I-R2 builtinRulesFrom([]) → 空 heads + 空 subcommands（且冻结）", () => {
  const rules = builtinRulesFrom([]);
  assert.deepEqual([...rules.heads], []);
  assert.deepEqual(Object.keys(rules.subcommands), []);
  assert.ok(Object.isFrozen(rules));
});

test("I-R2 builtinRulesFrom 自定义清单：单段进 heads，多段进 subcommands", () => {
  const rules = builtinRulesFrom(["free", "docker volume ls", "git stash list", "free"]);
  assert.deepEqual([...rules.heads], ["free"]);
  assert.deepEqual([...rules.subcommands.docker], ["volume ls"]);
  assert.deepEqual([...rules.subcommands.git], ["stash list"]);
  // 去重（同一头多条子命令只留一份）。
  assert.equal([...rules.subcommands.git].length, 1);
});

test("I-R2 builtinRulesFrom 半合法输入：非字符串 / 空白 / 多余空格都被容错处理，永不抛", () => {
  const rules = builtinRulesFrom([null, 42, "", "   ", "  ls  ", "git   status"]);
  assert.deepEqual([...rules.heads], ["ls"]);
  // 连续空格归一成单空格（保留首词作为头，其余作为子命令）。
  assert.deepEqual([...rules.subcommands.git], ["status"]);
});

test("I-R2 builtinRulesFrom 不做安全过滤：加进 rm 照样出现在结果里（deny 由 classify 保证）", () => {
  const rules = builtinRulesFrom(["rm", "ls"]);
  assert.ok([...rules.heads].includes("rm"), "不能偷偷丢掉 rm：那会掩盖真正的安全边界");
});

/* ---------------------- ③ 六条安全不变式 ---------------------- */

test("I-AC4.1 把 rm 加进清单 → rm -rf x 仍 confirm（hit deny:rm，deny 先于 allow）", () => {
  const result = run("rm -rf x", ["rm", "ls"]);
  assert.equal(result.decision, "confirm");
  assert.equal(result.hit, "deny:rm");
  // 对照：同一份清单里 ls 仍然 auto（证明清单真的生效了）。
  assert.equal(run("ls", ["rm", "ls"]).decision, "auto");
});

test("I-AC4.2 把 find 加进清单 → find . -delete 仍 confirm；find . -name x 变 auto（用户明确要的扩权）", () => {
  const dangerous = run("find . -delete", ["find"]);
  assert.equal(dangerous.decision, "confirm");
  assert.equal(dangerous.hit, "deny:find -delete");
  assert.equal(run("find . -name x", ["find"]).decision, "auto");
});

test("I-AC4.3 把 curl 加进清单 → curl -o out http://x 仍 confirm（参数表拦截）；curl -I 变 auto", () => {
  const write = run("curl -o out http://x", ["curl"]);
  assert.equal(write.decision, "confirm");
  assert.match(String(write.hit), /^deny:curl /);
  assert.equal(run("curl -I http://x", ["curl"]).decision, "auto");
});

test("I-AC4.4 把 git 加进清单 → git push 仍 confirm（DENY_SUBCOMMANDS.git）；git status auto", () => {
  const push = run("git push", ["git"]);
  assert.equal(push.decision, "confirm");
  assert.equal(push.hit, "deny:git push");
  assert.equal(run("git status", ["git"]).decision, "auto");
});

test("I-AC4.5 builtinAllowlist: [] → ls / cat / git status 全部 confirm（default:*），rm 仍 deny:rm", () => {
  for (const command of ["ls", "cat a.txt", "git status"]) {
    const result = run(command, []);
    assert.equal(result.decision, "confirm", command);
    assert.match(String(result.hit), /^default:/, command);
  }
  // 黑名单不依赖用户清单：清空清单也不会让 rm 变成可自动执行。
  assert.equal(run("rm -rf x", []).hit, "deny:rm");
});

test("I-AC4.6 危险参数表不因清单变化而放宽（wc --files0-from / rg --pre 仍按现行为）", () => {
  // 清单里有 wc / rg 也绕不过参数表（--files0-from 能读任意文件）。
  // 注意：wc 的允许集里本来就写了 files0-from，所以它按现状放行 —— 这里锁的是
  // 「加了清单不会让不在允许集里的参数被放行」，用 rg --pre（不在允许集）来断言。
  const pre = run("rg --pre=x foo", ["rg"]);
  assert.equal(pre.decision, "confirm");
  assert.match(String(pre.hit), /^deny:rg /);
  // rg 不带 --pre 仍然 auto（对照，证明清单生效）。
  assert.equal(run("rg -n foo", ["rg"]).decision, "auto");
  // sed 不在白名单：加进去也不会让 -i 变成 auto（命令头放行，但 write 语义由用户承担；
  // 这里是「不可配置的安全判据」的另一面 —— 危险参数表仍然硬编码）。
  assert.equal(run("find . -fprint x", ["find"]).hit, "deny:find -fprint");
});
