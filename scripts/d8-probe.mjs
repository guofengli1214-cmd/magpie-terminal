// D8 验收表输出：逐条打印 classify() 的 decision + hit。
// 用法：node scripts/d8-probe.mjs
// 退出码：0 = 25 行全部符合期望；1 = 有偏差。

import { classify } from "../src/policy/classify.mjs";

export const D8_ROWS = [
  [1, "find . -fprint PWNED.txt", "confirm", "deny"],
  [2, "find . -fprintf EVIL.sh 'x'", "confirm", "deny"],
  [3, "find . -fprint0 out.bin", "confirm", "deny"],
  [4, "find . -fls out.txt", "confirm", "deny"],
  [5, 'find . -name "*.js" -type f', "confirm", "default"],
  [6, 'find . -maxdepth 2 -name "*.md"', "confirm", "default"],
  [7, "find . --delete", "confirm", null],
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

/** 短/长同名参数必须判定一致。 */
export const SYMMETRY_PAIRS = [
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

const isMain = Boolean(process.argv[1]) && process.argv[1].endsWith("d8-probe.mjs");
if (isMain) {
  let failures = 0;

  console.log("=== D8 table (TASK.md §5 D8) ===");
  console.log(" #  decision  hit                                  command");
  for (const [n, command, expectedDecision, hitPrefix] of D8_ROWS) {
    const result = classify(command);
    const decisionOk = result.decision === expectedDecision;
    const hitOk = hitPrefix ? result.hit.startsWith(hitPrefix) : true;
    const ok = decisionOk && hitOk;
    if (!ok) failures += 1;
    console.log(
      `${String(n).padStart(2)}  ${result.decision.padEnd(8)}  ${result.hit.padEnd(35)}  ${command}` +
        (ok ? "" : `   <-- EXPECTED ${expectedDecision}${hitPrefix ? `/${hitPrefix}*` : ""}`),
    );
  }

  console.log("");
  console.log("=== symmetry: -name vs --name must decide the same ===");
  for (const [shortForm, longForm] of SYMMETRY_PAIRS) {
    const a = classify(shortForm);
    const b = classify(longForm);
    const ok = a.decision === b.decision;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "same" : "DIFF"}  ${a.decision.padEnd(8)} ${a.hit.padEnd(28)} ${shortForm}` +
        `\n      ${b.decision.padEnd(8)} ${b.hit.padEnd(28)} ${longForm}`,
    );
  }

  console.log("");
  console.log(JSON.stringify({ summary: { rows: D8_ROWS.length, symmetryPairs: SYMMETRY_PAIRS.length, failures } }));
  process.exit(failures === 0 ? 0 : 1);
}
