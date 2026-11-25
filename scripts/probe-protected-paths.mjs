// TASK-FIX17-K R5 / AC5：系统目录保护探针。
//
// 三组断言，全部用**真 judge + 假审阅**（不调真模型）：
//   ① 灾难级（12+ 条）：系统目录的删除 / 清空 / 移动 → confirm、tier=catastrophic、reviewCalls=0；
//   ② 正常放行（10+ 条）：用户自己目录里的删除 / 强制推送 → aligned=true 时必须 auto；
//   ③ 不误伤（8+ 条）：用户目录、/var/log、/usr/local、cp/copy 不许判灾难级；
//      其中 `rm -rf C:\Users\41807\project\build` 在 cwd 内必须 auto。
//
// 用法（仓库根）：node scripts/probe-protected-paths.mjs
// 退出码：0 全 PASS；1 有任何一条不过。

import path from "node:path";

import { judge } from "../src/ai/judge.mjs";
import { catastrophicReason } from "../src/policy/forbidden.mjs";

const results = [];

function record(name, pass, detail, expected) {
  results.push({ name, pass: Boolean(pass), detail, expected: expected ?? null });
  if (pass) console.log(`PASS  ${name}`);
  else console.log(`FAIL  ${name}\n      got=${JSON.stringify(detail)}  expected=${JSON.stringify(expected)}`);
}

const CWD = path.resolve(process.cwd());

function countingReviewer(verdict = { risk: "safe", aligned: true, reversible: true, justification: "符合用户在对话里说过的意图" }) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return { ...verdict, effect: "探针用效果", confirmWhy: "探针用理由", model: input.model || "probe/review-model" };
  };
  fn.calls = calls;
  return fn;
}

async function runJudge(command, { cwd = CWD, history = [{ role: "user", content: "把 build 删了，清一下 dist" }] } = {}) {
  const review = countingReviewer();
  const verdict = await judge({
    command,
    config: { model: null, autonomy: "balanced", allowlist: [], reviewModel: "probe/review-model", basePrompt: null },
    model: "probe/model",
    review,
    cwd,
    history,
  });
  return { verdict, reviewCalls: review.calls.length };
}

/* ---------------------------------------------------------------- ① 灾难级 */

const CATASTROPHIC = [
  String.raw`Remove-Item -Recurse -Force C:\Windows`,
  String.raw`Remove-Item -Recurse -Force 'C:\Program Files'`,
  String.raw`Remove-Item C:\Windows\System32 -Recurse`,
  "rm -rf C:/Windows",
  String.raw`rm -rf C:\Windows\*`,
  String.raw`del /f /s /q C:\Windows`,
  String.raw`rmdir /s /q C:\Windows\System32`,
  String.raw`Clear-Content C:\Windows\System32\drivers\etc\hosts`,
  String.raw`mv C:\Windows D:\x`,
  String.raw`Remove-Item -Path C:\ProgramData -Recurse`,
  "rm -rf /etc",
  String.raw`Remove-Item -Recurse $env:SystemRoot`,
  String.raw`clc C:\ProgramData\pkg\state`,
];

console.log("== ① 灾难级：系统目录删除 / 清空 / 移动（reviewCalls 必须为 0） ==");
for (const command of CATASTROPHIC) {
  // 对话里故意点名 windows / program files / etc：护栏的「点名过就放行」不许救它。
  const history = [{ role: "user", content: "windows program files programdata systemroot etc 都提过，全删了" }];
  const { verdict, reviewCalls } = await runJudge(command, { history });
  const catastrophic = catastrophicReason(command);
  const pass =
    verdict.decision === "confirm" &&
    verdict.tier === "catastrophic" &&
    reviewCalls === 0 &&
    typeof catastrophic === "string" &&
    verdict.guardOk === false;
  record(command, pass, { decision: verdict.decision, tier: verdict.tier, reviewCalls, reason: verdict.reason, guardOk: verdict.guardOk, catastrophic }, {
    decision: "confirm",
    tier: "catastrophic",
    reviewCalls: 0,
    guardOk: false,
  });
}

/* ---------------------------------------------------------------- ② 正常放行 */

const ALLOWED = [
  "rmdir build",
  "rm -rf ./dist",
  String.raw`Remove-Item -Recurse ./dist`,
  String.raw`Clear-Content ./tmp/a.txt`,
  String.raw`rm -rf ${CWD}${path.sep}build`,
  "rm -rf C:/Users/41807/magpie-terminal/build",
  "git push --force origin main",
  "rm ./wrong-file.txt",
  "mv ./a.txt ./b.txt",
  "del /f /q ./dist",
  "rm -rf build",
];

console.log("\n== ② 正常放行：用户自己目录里的删除（aligned=true 必须 auto） ==");
for (const command of ALLOWED) {
  const { verdict, reviewCalls } = await runJudge(command);
  const pass =
    verdict.decision === "auto" &&
    verdict.tier !== "catastrophic" &&
    reviewCalls === 1 &&
    catastrophicReason(command) === null;
  record(command, pass, { decision: verdict.decision, tier: verdict.tier, reviewCalls, reason: verdict.reason, catastrophic: catastrophicReason(command) }, {
    decision: "auto",
    tier: "blacklist",
    reviewCalls: 1,
    catastrophic: null,
  });
}

/* ---------------------------------------------------------------- ③ 不误伤 */

console.log("\n== ③ 不误伤：不许判灾难级（其中 cwd 内的 build 必须 auto） ==");

const NOT_HIT = [
  { command: String.raw`rm -rf C:\Users\41807\project\build`, cwd: "C:/Users/41807/project", expectAuto: true },
  { command: "rm -rf /var/log/app.log", expectAuto: false },
  { command: "rm -rf /usr/local/lib/node_modules/foo", expectAuto: false },
  { command: "cat /etc/hosts", expectAuto: true },
  { command: String.raw`ls C:\Windows`, expectAuto: true },
  { command: String.raw`cp -r C:\Windows D:\backup`, expectAuto: false },
  { command: String.raw`copy C:\Windows D:\backup`, expectAuto: false },
  { command: "rm -rf ./build", expectAuto: true },
  { command: "rmdir build", expectAuto: true },
  { command: String.raw`Clear-Content ./tmp/a.txt`, expectAuto: true },
  { command: String.raw`Remove-Item -Recurse ./dist`, expectAuto: true },
  { command: "mv ./a.txt ./b.txt", expectAuto: true },
  { command: String.raw`rm -rf C:\Windows.old`, expectAuto: false },
];

for (const item of NOT_HIT) {
  const { verdict, reviewCalls } = await runJudge(item.command, { cwd: item.cwd ? path.resolve(item.cwd) : CWD });
  const noCatastrophic = catastrophicReason(item.command) === null && verdict.tier !== "catastrophic";
  const autoOk = item.expectAuto ? verdict.decision === "auto" && verdict.guardOk === true : true;
  const pass = noCatastrophic && autoOk;
  record(
    `${item.command}${item.expectAuto ? "（必须 auto）" : ""}`,
    pass,
    { decision: verdict.decision, tier: verdict.tier, reviewCalls, reason: verdict.reason, catastrophic: catastrophicReason(item.command) },
    { catastrophic: null, decision: item.expectAuto ? "auto" : "(任意)", tier: item.expectAuto ? "blacklist" : "(非 catastrophic)" },
  );
}

/* ---------------------------------------------------------------- 汇总 */

const total = results.length;
const passed = results.filter((item) => item.pass).length;
const failed = total - passed;

console.log("");
console.log(`${passed}/${total} passed`);
if (failed > 0) {
  console.log("失败项：");
  for (const item of results.filter((entry) => !entry.pass)) console.log(`  - ${item.name}`);
}
process.exitCode = failed === 0 ? 0 : 1;
