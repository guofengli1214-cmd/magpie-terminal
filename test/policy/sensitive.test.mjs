// 敏感路径判定的行为锁（TASK-V4-S §6.3，P0-3 / AC4 / AC5 / AC13）。
//
// 为什么必须锁住：内置只读白名单含 cat / head / tail，
// 没有这张表时 `cat ~/.config/magpie-terminal/secrets.key` 会被自动执行。

import test from "node:test";
import assert from "node:assert/strict";
import {
  SENSITIVE_BASENAMES,
  SENSITIVE_DIRS,
  isSensitivePath,
  sensitiveReadTarget,
} from "../../src/policy/sensitive.mjs";

test("S1：SSH 私钥目录命中", () => {
  assert.equal(isSensitivePath("C:/Users/x/.ssh/id_rsa"), true);
  assert.equal(isSensitivePath("C:\\Users\\x\\.ssh\\id_rsa"), true, "反斜杠写法也要命中");
});

test("S2：本插件配置目录命中", () => {
  assert.equal(isSensitivePath("~/.config/magpie-terminal/secrets.key"), true);
  assert.equal(isSensitivePath("/home/u/.config/magpie-terminal/secrets.json"), true);
});

test("S3：.env 家族命中", () => {
  assert.equal(isSensitivePath(".env"), true);
  assert.equal(isSensitivePath(".env.local"), true);
  assert.equal(isSensitivePath(".env.production"), true);
  assert.equal(isSensitivePath("/app/.env"), true);
  assert.equal(isSensitivePath(".envrc"), false, "`.envrc` 不是 .env 家族");
});

test("S4：Hermes 数据目录整棵拒", () => {
  assert.equal(isSensitivePath("C:/Users/x/AppData/Local/hermes/cache/a.txt"), true);
  assert.equal(isSensitivePath("C:/Users/x/AppData/Roaming/hermes/cache/a.txt"), true);
  assert.equal(isSensitivePath("C:/Users/x/AppData/Local/hermes/openviking/a.txt"), true);
});

test("S5：普通文件不误伤", () => {
  assert.equal(isSensitivePath("README.md"), false);
  assert.equal(isSensitivePath("src/index.mjs"), false);
  assert.equal(isSensitivePath("C:/Users/x/project/app.js"), false);
  assert.equal(isSensitivePath("/tmp/mydir/a.txt"), false);
  assert.equal(isSensitivePath("package.json"), false);
});

test("S6：非字符串 / 空串不抛且 false", () => {
  assert.equal(isSensitivePath(null), false);
  assert.equal(isSensitivePath(undefined), false);
  assert.equal(isSensitivePath(""), false);
  assert.equal(isSensitivePath(123), false);
  assert.equal(isSensitivePath({}), false);
  assert.equal(isSensitivePath([]), false);
});

test("S6b：后缀与凭据文件名命中（.pem / .npmrc / known_hosts）", () => {
  assert.equal(isSensitivePath("certs/server.pem"), true);
  assert.equal(isSensitivePath("C:/Users/x/.npmrc"), true);
  assert.equal(isSensitivePath("C:/Users/x/.ssh/known_hosts"), true);
  assert.equal(isSensitivePath("C:/Users/x/.git-credentials"), true);
  assert.equal(isSensitivePath("deploy/keystore.jks"), true);
  assert.equal(isSensitivePath("deploy/cert.txt"), false, "普通 .txt 不命中");
});

test("S6c：AC13 —— %USERPROFILE% 与 .config/gcloud 形态", () => {
  assert.equal(isSensitivePath("%USERPROFILE%/.aws/credentials"), true);
  assert.equal(isSensitivePath("%USERPROFILE%/.ssh/id_ed25519"), true);
  assert.equal(isSensitivePath("C:/Users/x/.config/gcloud/application_default_credentials.json"), true);
  assert.equal(isSensitivePath("$HOME/.aws/config"), true);
  assert.equal(isSensitivePath("${HOME}/.ssh/config"), true);
});

test("S6d：表本身是冻结的（防止运行期被改宽 / 改窄）", () => {
  assert.equal(Object.isFrozen(SENSITIVE_DIRS), true);
  assert.equal(Object.isFrozen(SENSITIVE_BASENAMES), true);
  assert.ok(SENSITIVE_DIRS.includes(".ssh"));
  assert.ok(SENSITIVE_BASENAMES.includes("secrets.key"));
});

test("S6e：sensitiveReadTarget 粗筛 —— 命中返回 token，选项跳过", () => {
  assert.equal(sensitiveReadTarget("cat ~/.ssh/id_rsa"), "~/.ssh/id_rsa");
  assert.equal(sensitiveReadTarget("head -c 100 /home/u/.ssh/id_rsa"), "/home/u/.ssh/id_rsa");
  assert.equal(sensitiveReadTarget("cat README.md"), null);
  assert.equal(sensitiveReadTarget(""), null);
  assert.equal(sensitiveReadTarget(null), null);
  assert.equal(sensitiveReadTarget("cat a.txt && rm -rf b"), null, "非敏感路径不命中");
});
