// L1 分级器单测：表驱动，覆盖 testing-guidelines.md 的 16 条。
// 另外用空白名单 fixture 证明分级由数据驱动，不是硬编码通过。

import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../../src/policy/classify.mjs";
import { EMPTY_ALLOWLIST } from "../fixtures/policy-empty-allowlist.mjs";

const cases = [
  { n: 1, input: "ls -la", expected: "auto", why: "白名单基线" },
  { n: 2, input: "rm -rf /", expected: "confirm", why: "黑名单基线，最不能错" },
  { n: 3, input: "ls > out.txt", expected: "confirm", why: "输出重定向会截断文件" },
  { n: 4, input: "ls -la && rm x", expected: "confirm", why: "多段任一段危险即整体危险" },
  { n: 5, input: "ls | grep foo", expected: "auto", why: "管道两侧都是只读" },
  { n: 6, input: "cat a.txt | xargs rm", expected: "confirm", why: "管道后段是黑名单" },
  { n: 7, input: 'echo "unclosed', expected: "confirm", why: "引号不闭合 = 切不开" },
  { n: 8, input: "find . -delete", expected: "confirm", why: "命令头只读但参数危险" },
  { n: 9, input: "find . -exec rm {} \\;", expected: "confirm", why: "同上" },
  { n: 10, input: "echo $(rm -rf x)", expected: "confirm", why: "命令替换里的危险命令" },
  { n: 11, input: "FOO=1 rm x", expected: "confirm", why: "环境变量前缀包装" },
  { n: 12, input: "sudo ls", expected: "confirm", why: "提权包装" },
  { n: 13, input: "git status", expected: "auto", why: "白名单子命令" },
  { n: 14, input: "git push", expected: "confirm", why: "黑名单 git 写操作" },
  { n: 15, input: "", expected: "confirm", why: "空命令不是成功执行" },
  { n: 16, input: 12345, expected: "confirm", why: "非字符串入参：异常路径也 fail-closed" },
];

for (const item of cases) {
  test(`#${item.n} ${JSON.stringify(item.input)} → ${item.expected}（${item.why}）`, () => {
    const result = classify(item.input);
    assert.equal(result.decision, item.expected);
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
    assert.equal(typeof result.hit, "string");
  });
}

// 安全回归的 6 条单独再断言一次，失败即安全回归。
test("安全回归基线：6 条关键用例", () => {
  const critical = [
    ["rm -rf /", "confirm"],
    ['echo "unclosed', "confirm"],
    ["echo $(rm -rf x)", "confirm"],
    ["FOO=1 rm x", "confirm"],
    ["ls -la", "auto"],
    ["git status", "auto"],
  ];
  for (const [input, expected] of critical) {
    assert.equal(classify(input).decision, expected, `critical case failed: ${input}`);
  }
});

test("negative fixture：空白名单时 ls -la 变成 confirm（分级由数据驱动）", () => {
  const withDefault = classify("ls -la");
  assert.equal(withDefault.decision, "auto");

  const withEmpty = classify("ls -la", { allowlist: EMPTY_ALLOWLIST });
  assert.equal(withEmpty.decision, "confirm");
  assert.notEqual(withEmpty.hit, withDefault.hit);
});

test("空字符串与纯空白都按 noop → confirm", () => {
  assert.equal(classify("").decision, "confirm");
  assert.equal(classify("   ").decision, "confirm");
  assert.equal(classify("").hit, "noop");
});

test("不可解析的尾部反斜杠 → confirm", () => {
  assert.equal(classify("ls \\").decision, "confirm");
});

test("反引号命令替换 → confirm", () => {
  assert.equal(classify("echo `id`").decision, "confirm");
});

test("重定向 >> 也要 confirm", () => {
  assert.equal(classify("echo hi >> log.txt").decision, "confirm");
});

test("curl 参数降级：curl -I 放行但 curl -o 必须 confirm", () => {
  assert.equal(classify("curl -I http://127.0.0.1:3480").decision, "auto");
  assert.equal(classify("curl -o out.txt http://127.0.0.1:3480").decision, "confirm");
});

test("git branch：裸 branch 放行，-d/-D 必须 confirm", () => {
  assert.equal(classify("git branch").decision, "auto");
  assert.equal(classify("git branch -d feature").decision, "confirm");
  assert.equal(classify("git branch -D feature").decision, "confirm");
});

// fabricated-positive 防护：用 doctor 自己的 assertContains 证明断言不是恒真。
test("fabricated-positive：空输出喂给 doctor 的 assertContains 必须抛错", async () => {
  const { assertContains } = await import("../../scripts/doctor.mjs");
  const { createFakePtyNoop } = await import("../fixtures/fake-pty-noop.mjs");
  const fake = createFakePtyNoop();
  const chunks = [];
  fake.onData((chunk) => chunks.push(chunk));
  fake.emit();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const output = chunks.join("");
  assert.equal(output, "");
  assert.throws(() => assertContains(output, "M-2"), /assertContains failed/);
  // 正对照：真有输出时同一函数不抛。
  assert.doesNotThrow(() => assertContains("$ echo M-2\nM-2\n", "M-2"));
});

// ===========================================================================
// D8：参数级收紧（TASK.md §5 D8 / §4.10.1）
//
// 背景：旧的 DANGEROUS_ARGS / SUBCOMMAND_DANGEROUS_ARGS 是「危险参数黑名单」，
// 实测被 `find -fprint`、`curl -I -T`、`git branch <name>` 绕过并真落盘。
// 现在改成「参数级允许集」+ 把 find 整条移出白名单。
// 本组只新增用例，不改上面任何既有期望。
// ===========================================================================

const D8_ROWS = [
  // # 命令, decision, hit 前缀
  [1, "find . -fprint PWNED.txt", "confirm", "deny"],
  [2, "find . -fprintf EVIL.sh 'x'", "confirm", "deny"],
  [3, "find . -fprint0 out.bin", "confirm", "deny"],
  [4, "find . -fls out.txt", "confirm", "deny"],
  [5, 'find . -name "*.js" -type f', "confirm", "default"],
  [6, 'find . -maxdepth 2 -name "*.md"', "confirm", "default"],
  [7, "find . --delete", "confirm", null], // deny 或 default 均可
  [8, "git branch side-effect-branch", "confirm", "deny"],
  [9, "git branch -f x HEAD", "confirm", "deny"],
  [10, "git branch --unset-upstream", "confirm", "deny"],
  [11, "git branch -a", "auto", "allow"],
  [12, "git branch --show-current", "auto", "allow"],
  [13, "git status", "auto", "allow"],
  [14, "git log --oneline -5", "auto", "allow"],
  [15, "curl -I http://127.0.0.1:3425/", "auto", "allow"],
  [16, "curl -I -T secret.txt http://x/", "confirm", "deny"],
  [17, "curl -I -K evil.cfg", "confirm", "deny"],
  [18, "curl -I -D hdr.txt http://x/", "confirm", "deny"],
  [19, "wc -l README.md", "auto", "allow"],
  [20, "wc -l --files0-from=list", "auto", "allow"],
  [21, "rg --pre ./p x", "confirm", "deny"],
  [22, 'rg -n "TODO" src', "auto", "allow"],
  [23, "ls -la", "auto", "allow"],
  [24, "rm -rf /", "confirm", "deny"],
  [25, "echo $(rm -rf x)", "confirm", "substitution"],
];

for (const [n, command, expectedDecision, hitPrefix] of D8_ROWS) {
  test(`D8#${n} ${command} → ${expectedDecision}${hitPrefix ? ` / ${hitPrefix}*` : ""}`, () => {
    const result = classify(command);
    assert.equal(result.decision, expectedDecision, `D8#${n} decision`);
    if (hitPrefix) {
      assert.ok(
        result.hit.startsWith(hitPrefix),
        `D8#${n} hit should start with "${hitPrefix}", got "${result.hit}"`,
      );
    }
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  });
}

test("D8：find 整条移出白名单，任何不带危险参数的 find 也是 confirm/default:find", () => {
  for (const command of ["find .", "find . -name x", "find /tmp -type d", "find . -newer a"]) {
    const result = classify(command);
    assert.equal(result.decision, "confirm", command);
    assert.ok(
      result.hit === "default:find" || result.hit.startsWith("deny:find"),
      `${command} -> ${result.hit}`,
    );
  }
});

test("D8：短/长选项同名判定必须完全一致（对称性）", () => {
  // 只测「同一个名字、1 个连字符 vs 2 个连字符」，这才是规范要求的对称性。
  // 不同名字（-d vs --delete、-l vs --lines）是别名关系，不在本条断言范围内。
  const pairs = [
    ["find . -delete", "find . --delete"],
    ["find . -fprint x", "find . --fprint x"],
    ["find . -fprintf x 'y'", "find . --fprintf x 'y'"],
    ["find . -fprint0 x", "find . --fprint0 x"],
    ["find . -fls x", "find . --fls x"],
    ["find . -exec ls {}", "find . --exec ls {}"],
    ["find . -execdir ls {}", "find . --execdir ls {}"],
    ["find . -ok ls {}", "find . --ok ls {}"],
    ["git branch -f x HEAD", "git branch --f x HEAD"],
    ["rg -pre ./p x", "rg --pre ./p x"],
    ["curl -I -T s.txt http://x/", "curl -I --T s.txt http://x/"],
    ["curl -I -K evil.cfg", "curl -I --K evil.cfg"],
    ["wc -l x", "wc --l x"],
    ["git branch -a", "git branch --a"],
  ];
  for (const [shortForm, longForm] of pairs) {
    const a = classify(shortForm);
    const b = classify(longForm);
    assert.equal(
      a.decision,
      b.decision,
      `symmetry broken: ${shortForm} -> ${a.decision}/${a.hit} vs ${longForm} -> ${b.decision}/${b.hit}`,
    );
  }
});

test("D8：参数级允许集对带值写法也生效（--files0-from=list 命中允许项）", () => {
  assert.equal(classify("wc -l --files0-from=list").decision, "auto");
  assert.equal(classify("wc -l --files0-from=other").decision, "auto");
  // 不在允许集的带值参数必须 confirm
  assert.equal(classify("wc -l --output=x").decision, "confirm");
  assert.equal(classify("rg -n --pre-glob=x y").decision, "confirm");
});

test("D8：curl 必须显式带 -I/--head，否则即使没有危险参数也 confirm", () => {
  assert.equal(classify("curl http://127.0.0.1:3425/").decision, "confirm");
  assert.equal(classify("curl -s http://127.0.0.1:3425/").decision, "confirm");
  assert.equal(classify("curl -I http://127.0.0.1:3425/").decision, "auto");
  assert.equal(classify("curl --head http://127.0.0.1:3425/").decision, "auto");
});

test("D8：git branch 任何位置参数都 confirm（那是在建分支）", () => {
  assert.equal(classify("git branch").decision, "auto");
  assert.equal(classify("git branch newbranch").decision, "confirm");
  assert.equal(classify("git branch -a newbranch").decision, "confirm");
  assert.equal(classify("git branch --list 'feat/*'").decision, "confirm");
});

test("D8：管道任一段参数不合法即整体 confirm", () => {
  assert.equal(classify("curl -I http://x/ | rg -n foo").decision, "auto");
  assert.equal(classify("curl -I http://x/ | curl -I -T s.txt http://y/").decision, "confirm");
});

// ===========================================================================
// 返工第 5 轮：`git show` 归入只读子命令（docs/security.md 3.3 列了它，
// 代码缺了它 → 与文档冲突，按「文档优先」补齐）。
// `--output=<file>` 这个唯一会写盘的参数仍必须被 git 的 -output 粗筛拦住。
// ===========================================================================

test("git show 是只读子命令：git show HEAD → auto", () => {
  const result = classify("git show HEAD");
  assert.equal(result.decision, "auto");
  assert.ok(result.hit.startsWith("allow"), `hit=${result.hit}`);
});

test("git show 带只读选项仍 auto：git show --stat HEAD → auto", () => {
  assert.equal(classify("git show --stat HEAD").decision, "auto");
  // 其他常见只读选项也应当放行（git show 不在参数级允许集里，只看命令头 + -output 粗筛）。
  assert.equal(classify("git show --oneline -1").decision, "auto");
  assert.equal(classify("git show --name-only HEAD").decision, "auto");
});

test("git show --output=x.patch 仍必须 confirm（-output 粗筛不能被 show 放行绕过）", () => {
  const result = classify("git show --output=x.patch");
  assert.equal(result.decision, "confirm");
  assert.ok(result.hit.startsWith("deny"), `hit=${result.hit}`);
  assert.ok(result.hit.includes("output"), `hit=${result.hit}`);
});

test("git show 不能顺带放行 git 的写操作或未知子命令", () => {
  assert.equal(classify("git push").decision, "confirm");
  assert.equal(classify("git reset --hard").decision, "confirm");
  assert.equal(classify("git clean -fd").decision, "confirm");
  assert.equal(classify("git checkout main").decision, "confirm");
});

// ===========================================================================
// TASK-V4-S §6.3 S7–S10：敏感路径（P0-3）
// 修之前 `cat ~/.config/magpie-terminal/secrets.key` → auto / allow:cat，
// 用户完全不被告知就读到了自己的密钥（VERIFY-V4-G §4 P0-3）。
// ===========================================================================

test("S7：cat 本插件 secrets.key → confirm / deny:sensitive-path", () => {
  const result = classify("cat ~/.config/magpie-terminal/secrets.key");
  assert.equal(result.decision, "confirm");
  assert.equal(result.hit, "deny:sensitive-path");
  assert.match(result.reason, /密钥|凭据/);
});

test("S8：head -c 100 <ssh 私钥> → confirm（选项与数字不挡判定）", () => {
  const result = classify("head -c 100 /home/u/.ssh/id_rsa");
  assert.equal(result.decision, "confirm");
  assert.equal(result.hit, "deny:sensitive-path");
});

test("S9：cat .env → confirm", () => {
  assert.equal(classify("cat .env").decision, "confirm");
  assert.equal(classify("cat .env.local").decision, "confirm");
  assert.equal(classify("cat /app/.env.production").decision, "confirm");
});

test("S9b：其它读命令同样被拦（tail / grep / stat / type）", () => {
  for (const command of [
    "tail -n 20 ~/.aws/credentials",
    "grep password ~/.config/magpie-terminal/secrets.json",
    "stat C:/Users/x/.ssh/known_hosts",
    "type C:/Users/x/.npmrc",
    "cat certs/server.pem",
  ]) {
    const result = classify(command);
    assert.equal(result.decision, "confirm", `${command} 必须 confirm`);
    assert.equal(result.hit, "deny:sensitive-path", `${command} hit=${result.hit}`);
  }
});

test("S10：普通只读命令不误伤（AC5）", () => {
  assert.equal(classify("cat README.md").decision, "auto");
  assert.equal(classify("cat src/index.mjs").decision, "auto");
  assert.equal(classify("grep foo src/index.mjs").decision, "auto");
  assert.equal(classify("ls -la").decision, "auto");
  assert.equal(classify("head -n 5 package.json").decision, "auto");
  assert.equal(classify("tail -n 5 src/policy/classify.mjs").decision, "auto");
  assert.equal(classify("stat package.json").decision, "auto");
});

test("S10b：敏感路径只在「会吐内容」的命令头上拦 —— ls ~/.ssh 仍是 auto", () => {
  // ls 只列文件名、不吐文件内容（AC5 要求不误伤日常命令）。
  assert.equal(classify("ls ~/.ssh").decision, "auto");
});

// ===========================================================================
// TASK-FIX17-H R1/R2：剥离无害重定向 + 扩充只读白名单
//
// 背景：用户当天 3 条命令全部带 `2>&1`，全部被判 `redirect` → judge 跳过 AI 审阅
// → 卡片一律显示「审阅不可用」。修法是**剥离确定无害**的重定向后再判级，
// 同时把只读白名单扩到日常用的 docker / git / npm 只读子命令。
// 安全边界不变：剥离后仍有写文件的重定向 → 照样 confirm / redirect。
// ===========================================================================

const H_REDIRECT_AUTO = [
  // [命令, 期望 hit, 为什么]
  ["docker version 2>&1 | head -20", "allow:docker version", "真实事故命令：docker version 是只读子命令"],
  ["docker ps -a 2>&1 | head -30", "allow:docker ps", "docker ps 只列容器"],
  ["docker images 2>&1", "allow:docker images", "docker images 只列镜像"],
  ["docker volume ls 2>&1", "allow:docker volume ls", "两词子命令：volume ls"],
  ["ls -la 2>&1 | head", "allow:ls", "最常见的形态"],
  ["git status 2>&1", "allow:git status", "git status 只读"],
  ["free -h; echo '---'; free -m 2>&1", "allow:free", "free/echo 都在白名单"],
  ["curl -I https://example.com 2>&1", "allow:curl", "-I 已在参数允许集内"],
];

for (const [command, expectedHit, why] of H_REDIRECT_AUTO) {
  test(`H-R1 剥离后 auto：${command}（${why}）`, () => {
    const result = classify(command);
    assert.equal(result.decision, "auto", `${command} decision=${result.decision} hit=${result.hit}`);
    assert.equal(result.hit, expectedHit);
    assert.equal(result.note, "已忽略无害重定向（2>&1 / /dev/null 一类）");
  });
}

const H_REDIRECT_CONFIRM = [
  // 工作单 §6 的 9 条安全反例，一条都不许变成 auto。
  ["ls > out.txt", "redirect"],
  ["echo x >> ~/.bashrc", "redirect"],
  ["cat /etc/passwd > /tmp/leak.txt", "redirect"],
  ["ls >&out.txt", "redirect"],
  ["ls 2>&12", "redirect"],
  ["ls >NUL", "redirect"],
  ["ls 2>$null", "redirect"],
  ["ls 2>/dev/null > out.txt", "redirect"],
  ["ls; 2>/dev/null", "redirect"],
];

for (const [command, expectedHit] of H_REDIRECT_CONFIRM) {
  test(`H-R1 安全反例仍 confirm：${command} → ${expectedHit}`, () => {
    const result = classify(command);
    assert.equal(result.decision, "confirm", `${command} 不许变成 auto`);
    assert.equal(result.hit, expectedHit, `${command} hit=${result.hit}`);
  });
}

test("H-R1：note 只在剥离过时出现（别的命令不许带，避免误读日志）", () => {
  assert.equal(classify("ls -la").note, null);
  assert.equal(classify("git status").note, null);
  assert.equal(classify("ls > out.txt").note, null);
  assert.equal(classify("docker version 2>&1").note, "已忽略无害重定向（2>&1 / /dev/null 一类）");
});

test("H-R1：剥离不改变段数 —— ls 2>&1; rm -rf x 的第二段照样 deny:rm", () => {
  const result = classify("ls 2>&1; rm -rf x");
  assert.equal(result.decision, "confirm");
  assert.equal(result.hit, "deny:rm");
});

test("H-R1：引号内不动 —— echo \"a 2>&1 b\" 仍 auto / allow:echo", () => {
  const result = classify('echo "a 2>&1 b"');
  assert.equal(result.decision, "auto");
  assert.equal(result.hit, "allow:echo");
  assert.equal(result.note, null);
});

test("H-R1：引号内不动 —— echo '> x' 仍 auto / allow:echo", () => {
  const result = classify("echo '> x'");
  assert.equal(result.decision, "auto");
  assert.equal(result.hit, "allow:echo");
});

test("H-R1：黑名单优先于剥离 —— npm install left-pad 2>&1 仍 deny", () => {
  const result = classify("npm install left-pad 2>&1");
  assert.equal(result.decision, "confirm");
  assert.equal(result.hit, "deny:npm install");
});

// ---------------------------------------------------------------- R2：只读白名单

const H_R2_AUTO = [
  // [命令, 期望 hit]
  ["free -h", "allow:free"],
  ["df -h", "allow:df"],
  ["uptime", "allow:uptime"],
  ["uname -a", "allow:uname"],
  ["whoami", "allow:whoami"],
  ["hostname", "allow:hostname"],
  ["nproc", "allow:nproc"],
  ["date", "allow:date"],
  ["docker volume ls", "allow:docker volume ls"],
  ["docker network ls", "allow:docker network ls"],
  ["docker system df", "allow:docker system df"],
  ["docker compose ps", "allow:docker compose ps"],
  ["docker compose logs web", "allow:docker compose logs"],
  ["git remote -v", "allow:git remote"],
  ["git remote", "allow:git remote"],
  ["git tag", "allow:git tag"],
  ["git tag -l", "allow:git tag"],
  ["git rev-parse HEAD", "allow:git rev-parse"],
  ["git describe --tags", "allow:git describe"],
  ["git blame src/policy/classify.mjs", "allow:git blame"],
  ["git stash list", "allow:git stash list"],
  ["npm ls", "allow:npm ls"],
  ["npm list", "allow:npm list"],
  ["npm outdated", "allow:npm outdated"],
];

for (const [command, expectedHit] of H_R2_AUTO) {
  test(`H-R2 只读白名单：${command} → ${expectedHit}`, () => {
    const result = classify(command);
    assert.equal(result.decision, "auto", `${command} decision=${result.decision} hit=${result.hit}`);
    assert.equal(result.hit, expectedHit);
  });
}

const H_R2_CONFIRM = [
  // 工作单 R2 指定的反例 + 同类写操作
  ["docker volume rm v1", "default:docker"],
  ["docker compose up -d", "default:docker"],
  ["docker rmi x", "default:docker"],
  ["docker run --rm alpine", "default:docker"],
  ["git remote add origin x", "deny:git remote positional:add"],
  ["git tag v1.0", "deny:git tag positional:v1.0"],
  ["git stash", "default:git"],
  ["git stash drop", "default:git"],
  ["npm run build", "default:npm"],
  ["ps aux", "default:ps"],
];

for (const [command, expectedHit] of H_R2_CONFIRM) {
  test(`H-R2 反例仍 confirm：${command} → ${expectedHit}`, () => {
    const result = classify(command);
    assert.equal(result.decision, "confirm", `${command} 不许自动执行`);
    assert.equal(result.hit, expectedHit, `${command} hit=${result.hit}`);
  });
}

test("H-R2：ps 故意不在白名单（命令行里常带明文口令，属信息泄露）", () => {
  assert.equal(classify("ps aux").decision, "confirm");
  assert.equal(classify("ps -ef").decision, "confirm");
  assert.equal(classify("ps").decision, "confirm");
});

// H-R2 追加：`date` / `hostname` 的「同名不同义」参数。
// `date 010100002020`（设系统时间）与 `hostname newname`（改主机名）都是写操作，
// 命令头在白名单里也必须 confirm；只读形态（`date +%s`、`date -d …`、`hostname -f`）要放行。
test("H-R2：date 只读形态 auto，改时间形态 confirm", () => {
  assert.equal(classify("date").decision, "auto");
  assert.equal(classify("date +%s").decision, "auto");
  assert.equal(classify("date -u").decision, "auto");
  assert.equal(classify("date -d '2020-01-01'").decision, "auto");
  assert.equal(classify("date -r package.json").decision, "auto");
  // 不带 `+` 的位置参数是「设系统时间」；-s/--set 同理。
  const setByPositional = classify("date 010100002020");
  assert.equal(setByPositional.decision, "confirm");
  assert.equal(setByPositional.hit, "deny:date positional:010100002020");
  assert.equal(classify("date -s '2020-01-01'").decision, "confirm");
  assert.equal(classify("date --set=2020").decision, "confirm");
});

test("H-R2：hostname 只读形态 auto，改主机名形态 confirm", () => {
  assert.equal(classify("hostname").decision, "auto");
  assert.equal(classify("hostname -f").decision, "auto");
  assert.equal(classify("hostname -I").decision, "auto");
  const rename = classify("hostname newname");
  assert.equal(rename.decision, "confirm");
  assert.equal(rename.hit, "deny:hostname positional:newname");
  assert.equal(classify("hostname -F /tmp/newname").decision, "confirm");
});

test("H-R2：带值选项的值不当作位置参数（git tag/branch 的 --contains 等）", () => {
  assert.equal(classify("git tag --contains HEAD").decision, "auto");
  assert.equal(classify("git tag -l 'v1*'").decision, "auto");
  assert.equal(classify("git branch --contains HEAD").decision, "auto");
  assert.equal(classify("git branch --merged main").decision, "auto");
  // 值后面再跟真正的位置参数，仍然是写操作。
  assert.equal(classify("git branch --contains HEAD newbranch").decision, "confirm");
  assert.equal(classify("git tag -d v1").decision, "confirm");
});
