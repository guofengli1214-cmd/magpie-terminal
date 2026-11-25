// TASK-FIX17-K R2 / R5：删除 / 清空 / 移动系统目录 = 灾难级，且**不送审**。
//
// 这一组全部走真 judge（假审阅只用来计数），证明三件事：
//   1) 系统目录的删除 / 清空 / 移动在判级第一层就被拦下，review 一次都不调；
//   2) 用户自己目录里的删除（含 PowerShell 头）仍然可以 auto（J 批语义不变）；
//   3) 不误伤：/var/log、/usr/local、C:\Users\<用户名>\...、cp/copy 都不判灾难级。

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { catastrophicReason, forbiddenReason } from "../../src/policy/forbidden.mjs";
import { judge } from "../../src/ai/judge.mjs";

const baseConfig = { model: null, autonomy: "balanced", allowlist: [], reviewModel: null, basePrompt: null };
const CWD = path.resolve(process.cwd());

function countingReviewer(verdict = { risk: "safe", aligned: true, reversible: true, justification: "用户要的" }) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return { ...verdict, effect: "测试用效果", confirmWhy: "测试用理由", model: input.model || "review/model" };
  };
  fn.calls = calls;
  return fn;
}

/* ---------------------------------------------------------------- 灾难级正例 */

const CATASTROPHIC = [
  ["Remove-Item -Recurse -Force C:\\Windows", "PowerShell 删 Windows"],
  ["Remove-Item -Recurse -Force 'C:\\Program Files'", "带空格的引号路径"],
  ["Remove-Item C:\\Windows\\System32 -Recurse", "目标在前、开关在后"],
  ["ri -Recurse C:\\Windows", "ri 别名"],
  ["rm -rf C:/Windows", "正斜杠写法"],
  ["rm -rf C:\\Windows\\*", "通配符尾"],
  ["del /f /s /q C:\\Windows", "cmd 风格开关"],
  ["rmdir /s /q C:\\Windows\\System32", "rmdir 子路径"],
  ["Clear-Content C:\\Windows\\System32\\drivers\\etc\\hosts", "清空 hosts"],
  ["clc C:\\ProgramData\\pkg\\state", "clc 别名"],
  ["mv C:\\Windows D:\\x", "移动系统目录"],
  ["Remove-Item -Path C:\\ProgramData -Recurse", "-Path 命名参数"],
  ["rm -rf /etc", "POSIX 只保护本身"],
  ["Remove-Item -Recurse $env:SystemRoot", "系统变量写法"],
];

test("K R2：14 条删除 / 清空 / 移动系统目录全部命中灾难级", () => {
  for (const [command, why] of CATASTROPHIC) {
    const reason = catastrophicReason(command);
    assert.equal(typeof reason, "string", `${command}（${why}）必须命中灾难级`);
    assert.match(reason, /系统目录/, `${command} 的 reason=${reason}`);
    assert.notEqual(forbiddenReason(command), null, `${command} 的 forbiddenReason 不许回退成 null`);
  }
});

test("K R2：灾难级在任何档位都 confirm，且一次审阅都不调", async () => {
  for (const [command, why] of CATASTROPHIC) {
    for (const autonomy of ["strict", "balanced", "loose"]) {
      const review = countingReviewer({ risk: "safe", aligned: true, reversible: true, justification: "用户明确要清理系统" });
      const verdict = await judge({
        command,
        config: { ...baseConfig, autonomy, reviewModel: "some/model" },
        model: "m/x",
        review,
        cwd: CWD,
        history: [{ role: "user", content: "windows program files programdata users systemroot etc 都提过" }],
      });
      assert.equal(verdict.decision, "confirm", `${why} @${autonomy} 必须 confirm，实际 ${verdict.decision}`);
      assert.equal(verdict.tier, "catastrophic", `${why} @${autonomy} tier 必须是 catastrophic`);
      assert.equal(review.calls.length, 0, `${why} @${autonomy} 灾难级不许送审`);
      assert.match(verdict.reason, /硬性禁止/);
    }
  }
});

/* ---------------------------------------------------------------- 不误伤 */

const NOT_CATASTROPHIC = [
  "rm -rf C:\\Users\\41807\\project\\build",
  "rm -rf /var/log/app.log",
  "rm -rf /usr/local/lib/node_modules/foo",
  "rm -rf ./build",
  "rmdir build",
  "Remove-Item -Recurse ./dist",
  "Clear-Content ./tmp/a.txt",
  "cat /etc/hosts",
  "ls C:\\Windows",
  "Get-ChildItem C:\\Windows",
  "cp -r C:\\Windows D:\\backup",
  "copy C:\\Windows D:\\backup",
  "mv ./a.txt ./b.txt",
];

test("K R2：13 条日常命令 / 用户目录 / cp 不判灾难级", () => {
  for (const command of NOT_CATASTROPHIC) {
    assert.equal(catastrophicReason(command), null, `${command} 不许判灾难级`);
  }
});

test("K R2：/etc、/var、/usr 只保护本身，子路径不动", () => {
  assert.equal(typeof catastrophicReason("rm -rf /etc"), "string");
  assert.equal(typeof catastrophicReason("rm -rf /var"), "string");
  assert.equal(typeof catastrophicReason("rm -rf /usr"), "string");
  assert.equal(catastrophicReason("rm -rf /etc/hosts"), null);
  assert.equal(catastrophicReason("rm -rf /var/log/app.log"), null);
  assert.equal(catastrophicReason("rm -rf /usr/local/bin/x"), null);
});

test("K R2：系统变量只在删除 / 移动头下判灾难级；别的命令头不受影响", () => {
  assert.equal(typeof catastrophicReason("rm -rf %SystemRoot%"), "string");
  assert.equal(typeof catastrophicReason("mv $env:SystemRoot D:\\x"), "string");
  assert.equal(catastrophicReason("echo $env:SystemRoot"), null);
  assert.equal(catastrophicReason("Get-ChildItem C:\\Windows"), null);
});

/* ---------------------------------------------------------------- 用户目录照旧 auto */

test("K R2/R5：用户自己目录里的删除（含 PowerShell 头）仍然 auto", async () => {
  const cases = [
    "rm -rf ./build",
    "rmdir build",
    "rm ./wrong-file.txt",
    "Remove-Item -Recurse ./dist",
    "Clear-Content ./tmp/a.txt",
    "mv ./a.txt ./b.txt",
    `rm -rf "${path.join(CWD, "build")}"`,
    "git push --force origin main",
  ];
  for (const command of cases) {
    const review = countingReviewer();
    const verdict = await judge({
      command,
      config: { ...baseConfig, reviewModel: "some/model" },
      model: "m/x",
      review,
      cwd: CWD,
      history: [{ role: "user", content: "把 build 删了" }],
    });
    assert.equal(verdict.decision, "auto", `${command} 必须 auto（reason=${verdict.reason}）`);
    assert.notEqual(verdict.tier, "catastrophic", `${command} 不该是灾难级`);
    assert.equal(review.calls.length, 1, `${command} 应该走审阅`);
  }
});

test("K R2/R5：C:\\Users\\41807\\project\\build 在 cwd 内必须 auto（Users 只保护本身）", async () => {
  const project = "C:\\Users\\41807\\project";
  const review = countingReviewer();
  const verdict = await judge({
    command: "rm -rf C:\\Users\\41807\\project\\build",
    config: { ...baseConfig, reviewModel: "some/model" },
    model: "m/x",
    review,
    cwd: project,
    history: [{ role: "user", content: "把 build 删了" }],
  });
  assert.equal(verdict.decision, "auto", `reason=${verdict.reason}`);
  assert.equal(verdict.tier, "blacklist");
  assert.equal(review.calls.length, 1);
});

test("K R2/R5：Users 根本身仍然必须 confirm（只保护本身那条腿不能丢）", async () => {
  const review = countingReviewer();
  const verdict = await judge({
    command: "rm -rf C:\\Users",
    config: { ...baseConfig, reviewModel: "some/model" },
    model: "m/x",
    review,
    cwd: CWD,
    history: [{ role: "user", content: "把 users 清掉" }],
  });
  assert.equal(verdict.decision, "confirm");
  assert.equal(verdict.tier, "catastrophic");
  assert.equal(review.calls.length, 0);
});

/* ---------------------------------------------------------------- 解析细节 */

test("K R2：-LiteralPath / -Destination / -Path: 粘连写法都能命中", () => {
  assert.equal(typeof catastrophicReason("Remove-Item -LiteralPath C:\\Windows -Force"), "string");
  assert.equal(typeof catastrophicReason("move -Destination C:\\Windows foo.txt"), "string");
  assert.equal(typeof catastrophicReason("Remove-Item -Path:C:\\Windows -Recurse"), "string");
});

test("K R2：引号内的目标不会被切碎（'C:\\Program Files' 必须能判）", () => {
  assert.equal(typeof catastrophicReason("Remove-Item -Recurse -Force 'C:\\Program Files'"), "string");
  assert.equal(typeof catastrophicReason('Remove-Item -Recurse -Force "C:\\Program Files (x86)"'), "string");
  // 对照：同一串文字在参数位置（echo）不拦。
  assert.equal(catastrophicReason("echo 'C:\\Program Files'"), null);
});
