// TASK-FIX17-H 验收探针：剥离无害重定向 + 扩充只读白名单 + 前端文案说实话。
//
// 三块，全部**真跑**，不 mock 判级：
//   ① classify 真模块：PRD R5.1 表里的 20 条命令逐条断言 decision / hit；
//   ② 负对照：把 `git show HEAD:` 里的**改前版本**落到临时目录再动态 import，
//      证明同一批命令在旧实现下确实是 confirm（数字不是靠嘴说的）；
//   ③ 真服务 + 真 Chrome（CDP）：推两条 `agent.approval` 帧，断言卡片标题/解释行
//      在 `risk:null` 时的两条分支 —— 有 reviewReason 说原因，没有才说「审阅不可用」。
//
// 用法（仓库根）：
//   node scripts/probe-review-redirect.mjs                       # 人读输出 + 截图落 .dispatch/fix17-h/evidence/
//   node scripts/probe-review-redirect.mjs --out result.json     # 额外把原始结果写成 JSON
//
// 退出码：0 全 PASS；1 有任何一条不过（失败项同时写进 --out 的 JSON）。

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { classify } from "../src/policy/classify.mjs";
import { startServer } from "../src/server/http.mjs";
import { openBrowser, sleep } from "./lib/cdp.mjs";

const ROOT = path.resolve(".");
const EVIDENCE_DIR = path.resolve(".dispatch", "fix17-h", "evidence");
const SHOTS_DIR = path.join(EVIDENCE_DIR, "shots");
const NOTE_TEXT = "已忽略无害重定向（2>&1 / /dev/null 一类）";

const results = [];
function record(name, pass, detail, expected) {
  results.push({ group: name.split(".")[0], name, pass: Boolean(pass), detail, expected: expected ?? null });
  if (pass) console.log(`PASS  ${name}`);
  else console.log(`FAIL  ${name}\n      got=${JSON.stringify(detail)}  expected=${JSON.stringify(expected)}`);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/* ---------------------------------------------------------------- ① classify */

// PRD R5.1 的那张表，逐字照抄（命令 / 期望 decision / 期望 hit）。
const CLASSIFY_CASES = [
  { command: "docker version 2>&1 | head -20", decision: "auto", hit: "allow:docker version" },
  { command: "docker ps -a 2>&1 | head -30", decision: "auto", hit: "allow:docker ps" },
  { command: "docker images 2>&1", decision: "auto", hit: "allow:docker images" },
  { command: "docker volume ls 2>&1", decision: "auto", hit: "allow:docker volume ls" },
  { command: "ls -la 2>&1 | head", decision: "auto", hit: "allow:ls" },
  { command: "git status 2>&1", decision: "auto", hit: "allow:git status" },
  { command: "git remote -v", decision: "auto", hit: "allow:git remote" },
  { command: "free -h; echo '---'; free -m 2>&1", decision: "auto", hit: "allow:free" },
  { command: "ls > out.txt", decision: "confirm", hit: "redirect" },
  { command: "echo x >> ~/.bashrc", decision: "confirm", hit: "redirect" },
  { command: "cat /etc/passwd > /tmp/leak.txt", decision: "confirm", hit: "redirect" },
  { command: "ls 2>/dev/null > out.txt", decision: "confirm", hit: "redirect" },
  { command: "docker volume rm v1", decision: "confirm", hit: "default:docker" },
  { command: "docker compose up -d", decision: "confirm", hit: "default:docker" },
  { command: "git remote add origin x", decision: "confirm", hit: "deny:git remote positional:add" },
  { command: "git tag v1.0", decision: "confirm", hit: "deny:git tag positional:v1.0" },
  { command: 'echo "a 2>&1 b"', decision: "auto", hit: "allow:echo" },
  { command: "ls; 2>/dev/null", decision: "confirm", hit: "redirect" },
  { command: "curl -I https://example.com 2>&1", decision: "auto", hit: "allow:curl" },
  { command: "npm install left-pad 2>&1", decision: "confirm", hit: "deny:npm install" },
];

function runClassifyCases() {
  for (const [index, item] of CLASSIFY_CASES.entries()) {
    const result = classify(item.command);
    const pass = result.decision === item.decision && result.hit === item.hit;
    record(
      `classify.${String(index + 1).padStart(2, "0")} ${item.command} → ${item.decision} / ${item.hit}`,
      pass,
      { decision: result.decision, hit: result.hit, reason: result.reason },
      { decision: item.decision, hit: item.hit },
    );
  }

  // note 只在剥离过时出现；不参与 decision。
  const stripped = classify("docker version 2>&1 | head -20");
  record(
    "classify.note 剥离过 → note 有值",
    stripped.note === NOTE_TEXT,
    { note: stripped.note },
    { note: NOTE_TEXT },
  );
  const plain = classify("ls -la");
  record("classify.note 没剥离 → note 为 null", plain.note === null, { note: plain.note }, { note: null });
}

/* ---------------------------------------------------------------- ② 负对照 */

/**
 * 把**改前版本**（git HEAD）的 policy 模块落到临时目录，动态 import 出旧的 classify。
 *
 * 为什么要真跑：只说「以前是 confirm」没有证据。这里用 `git show HEAD:<file>` 取基线
 * 的字节，import 的是**真的旧实现**，不是我们自己写的替身。
 */
async function loadOldClassify() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-h-negctl-"));
  const policyDir = path.join(dir, "src", "policy");
  await mkdir(policyDir, { recursive: true });
  // classify.mjs 的静态 import 全在这几个文件里，一起取 HEAD 版本。
  const files = ["classify.mjs", "segments.mjs", "allowlist.mjs", "sensitive.mjs"];
  const shown = [];
  for (const file of files) {
    const text = execFileSync("git", ["show", `HEAD:src/policy/${file}`], { cwd: ROOT, encoding: "utf8" });
    if (!text || text.length === 0) throw new Error(`git show HEAD:src/policy/${file} 是空的`);
    await writeFile(path.join(policyDir, file), text, "utf8");
    shown.push({ file, bytes: Buffer.byteLength(text, "utf8") });
  }
  const mod = await import(pathToFileURL(path.join(policyDir, "classify.mjs")).href);
  return { classifyOld: mod.classify, dir, shown };
}

async function runNegativeControl() {
  let loaded;
  try {
    loaded = await loadOldClassify();
  } catch (err) {
    record("negative-control.加载改前版本", false, { error: String(err && err.message) }, "能 import 旧 classify");
    return null;
  }
  console.log(
    `      改前版本落在 ${loaded.dir}（${loaded.shown.map((item) => `${item.file}:${item.bytes}B`).join(", ")}）`,
  );

  // 这 9 条现在必须 auto；改前必须是 confirm。前 7 条的拒绝原因就是 redirect。
  const oldCases = [
    { command: "docker version 2>&1 | head -20", expectHit: "redirect" },
    { command: "docker ps -a 2>&1 | head -30", expectHit: "redirect" },
    { command: "docker images 2>&1", expectHit: "redirect" },
    { command: "docker volume ls 2>&1", expectHit: "redirect" },
    { command: "ls -la 2>&1 | head", expectHit: "redirect" },
    { command: "git status 2>&1", expectHit: "redirect" },
    { command: "free -h; echo '---'; free -m 2>&1", expectHit: "redirect" },
    { command: "git remote -v", expectHit: null }, // 改前是白名单缺口，不是 redirect
    { command: "curl -I https://example.com 2>&1", expectHit: "redirect" },
  ];

  let ok = true;
  for (const item of oldCases) {
    const oldResult = loaded.classifyOld(item.command);
    const pass = oldResult.decision === "confirm" && (item.expectHit === null || oldResult.hit === item.expectHit);
    if (!pass) ok = false;
    record(
      `negative-control.改前 ${item.command} → confirm${item.expectHit ? ` / ${item.expectHit}` : ""}`,
      pass,
      { decision: oldResult.decision, hit: oldResult.hit, reason: oldResult.reason },
      { decision: "confirm", hit: item.expectHit || "(任意)" },
    );
  }

  // 同时确认「改后」这些命令不是 confirm（否则负对照没有意义）。
  for (const item of oldCases) {
    const now = classify(item.command);
    const pass = now.decision === "auto";
    if (!pass) ok = false;
    record(`negative-control.改后 ${item.command} → auto`, pass, { decision: now.decision, hit: now.hit }, { decision: "auto" });
  }

  console.log(ok ? "NEGATIVE-CONTROL ok" : "NEGATIVE-CONTROL FAILED");
  return { ok, dir: loaded.dir, files: loaded.shown };
}

/* ---------------------------------------------------------------- ③ 真浏览器 */

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const HELPERS = `
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const push = (frame) => window.__termDebugFrame(frame);
  // 卡片标题里有一个装饰字形（「!」）与标题文字同居 .approval-head；
  // 断言的「标题文本」是去掉字形之后的那串字。
  const headTitle = (card) => {
    const head = card.querySelector('.approval-head');
    if (!head) return null;
    const glyph = head.querySelector('.approval-head-glyph');
    return head.textContent.replace(glyph ? glyph.textContent : '', '').trim();
  };
`;

async function waitFor(browser, expression, { timeoutMs = 20000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await browser.evaluate(`(() => { ${HELPERS} return Boolean(${expression}); })()`);
    } catch {
      value = false;
    }
    if (value) return true;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(120);
  }
}

async function shot(browser, name) {
  const buffer = await browser.screenshot();
  const target = path.join(SHOTS_DIR, `${name}.png`);
  if (buffer) await writeFile(target, buffer);
  return target;
}

async function runBrowserChecks() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-h-browser-"));
  process.env.MAGPIE_TERMINAL_CONFIG_PATH = path.join(dir, "config.json");
  // 日志写到仓库外的临时目录，别污染用户真实的 %LOCALAPPDATA%\magpie\logs。
  process.env.MAGPIE_TERMINAL_LOG_DIR = path.join(dir, "logs");

  const port = await freePort();
  const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
  const handle = await startServer({ port, log: quiet });
  const base = `http://127.0.0.1:${port}`;

  await mkdir(SHOTS_DIR, { recursive: true });

  let browser = null;
  const shots = [];
  try {
    browser = await openBrowser({ width: 1360, height: 900 });
    await browser.navigate(`${base}/?token=${handle.token}`);
    await waitFor(browser, "document.readyState === 'complete'", { label: "页面加载" });
    await waitFor(browser, "typeof window.__termDebugFrame === 'function'", { label: "__termDebugFrame" });
    await waitFor(browser, "window.__termDebug().sessions.length >= 1", { timeoutMs: 30000, label: "首个终端" });
    await sleep(400);

    // 打开 AI 抽屉（真实点击把手）。
    await browser.evaluate(`(() => { ${HELPERS}
      const open = document.querySelector('[data-role="app"]').getAttribute('data-ai-open');
      if (open !== 'true') q('[data-role="ai-handle"]').click();
      return true;
    })()`);
    await waitFor(
      browser,
      "document.querySelector('[data-role=\"app\"]').getAttribute('data-ai-open') === 'true'",
      { label: "抽屉打开" },
    );

    // 先来一条 agent.start，把当前会话钉在探针的 requestId 上（帧的归属校验）。
    await browser.evaluate(`(() => { ${HELPERS}
      push({ type: "agent.start", requestId: "probe-h-1", taskId: "t-probe-h", sessionId: "probe-h-session", round: 1 });
      return true;
    })()`);
    await sleep(200);

    // 帧 1：risk=null + reviewReason 非空 → 必须说原因，不许说「审阅不可用」。
    await browser.evaluate(`(() => { ${HELPERS}
      push({
        type: "agent.approval",
        requestId: "probe-h-1",
        taskId: "t-probe-h",
        stepId: "probe-h-step-1",
        approvalId: "probe-h-approval-1",
        command: "docker version 2>&1 | head -20",
        why: "看看 docker 版本对不对",
        risk: null,
        effect: null,
        confirmWhy: null,
        reversible: null,
        reviewModel: null,
        reviewReason: "命令含输出重定向，可能写文件",
        reviewHit: "redirect",
      });
      return true;
    })()`);
    await waitFor(browser, "document.querySelectorAll('[data-role=\"agent-approval\"]').length >= 1", {
      label: "第一张确认卡",
    });

    const first = await browser.evaluate(`(() => { ${HELPERS}
      const card = qa('[data-role="agent-approval"]')[0];
      const head = card.querySelector('.approval-head');
      const tip = card.querySelector('[data-role="approval-review-tip"]');
      const snapshot = window.__termDebugAgent();
      return {
        title: headTitle(card),
        tipText: tip ? tip.textContent : null,
        command: card.querySelector('[data-role="agent-step-cmd"]')?.textContent || null,
        reviewReason: snapshot.pendingApprovals[0]?.reviewReason ?? null,
        reviewHit: snapshot.pendingApprovals[0]?.reviewHit ?? null,
        risk: snapshot.pendingApprovals[0]?.risk ?? null,
        rect: (() => { const r = card.getBoundingClientRect(); return { width: r.width, height: r.height }; })(),
        overflowX: card.scrollWidth > card.clientWidth + 1,
        headOverflow: head ? head.scrollWidth > head.clientWidth + 1 : null,
        headStyle: head ? (() => { const s = getComputedStyle(head); return { whiteSpace: s.whiteSpace, overflowWrap: s.overflowWrap, textOverflow: s.textOverflow }; })() : null,
      };
    })()`);

    record(
      "browser.有 reviewReason → 标题 = 需要你批准：命令含输出重定向，可能写文件",
      first.title === "需要你批准：命令含输出重定向，可能写文件",
      { title: first.title },
      "需要你批准：命令含输出重定向，可能写文件",
    );
    record(
      "browser.有 reviewReason → 标题不含「审阅不可用」",
      typeof first.title === "string" && !first.title.includes("审阅不可用"),
      { title: first.title },
      "不含「审阅不可用」",
    );
    record(
      "browser.有 reviewReason → 解释行按原因说（含「所以没有送审」且不含「审阅不可用」）",
      typeof first.tipText === "string" &&
        first.tipText.includes("命令含输出重定向，可能写文件，所以没有送审") &&
        !first.tipText.includes("审阅不可用"),
      { tipText: first.tipText },
      "含「…，所以没有送审」，不含「审阅不可用」",
    );
    record(
      "browser.store 收到 reviewReason / reviewHit",
      first.reviewReason === "命令含输出重定向，可能写文件" && first.reviewHit === "redirect" && first.risk === null,
      { reviewReason: first.reviewReason, reviewHit: first.reviewHit, risk: first.risk },
      { reviewReason: "命令含输出重定向，可能写文件", reviewHit: "redirect", risk: null },
    );
    record("browser.卡片没有横向溢出（新文案不撑破布局）", first.overflowX === false && first.headOverflow === false, {
      overflowX: first.overflowX,
      headOverflow: first.headOverflow,
      headStyle: first.headStyle,
      rect: first.rect,
    }, { overflowX: false, headOverflow: false });

    shots.push(await shot(browser, "approval-review-reason"));

    // 帧 2：risk=null 且没有 reviewReason → 必须回落到原文案。
    await browser.evaluate(`(() => { ${HELPERS}
      push({
        type: "agent.approval",
        requestId: "probe-h-1",
        taskId: "t-probe-h",
        stepId: "probe-h-step-2",
        approvalId: "probe-h-approval-2",
        command: "npm run build",
        why: "构建一下",
        risk: null,
        effect: null,
        confirmWhy: null,
        reversible: null,
        reviewModel: null,
        reviewReason: null,
        reviewHit: null,
      });
      return true;
    })()`);
    await waitFor(browser, "document.querySelectorAll('[data-role=\"agent-approval\"]').length >= 2", {
      label: "第二张确认卡",
    });

    const second = await browser.evaluate(`(() => { ${HELPERS}
      const card = qa('[data-role="agent-approval"]')[1];
      const tip = card.querySelector('[data-role="approval-review-tip"]');
      return {
        title: headTitle(card),
        tipText: tip ? tip.textContent : null,
        reviewReason: window.__termDebugAgent().pendingApprovals[1]?.reviewReason ?? null,
      };
    })()`);

    record(
      "browser.无 reviewReason → 标题回落到「需要你批准：审阅不可用，请自己看一眼」",
      second.title === "需要你批准：审阅不可用，请自己看一眼",
      { title: second.title },
      "需要你批准：审阅不可用，请自己看一眼",
    );
    record(
      "browser.无 reviewReason → 解释行回落到原文案",
      typeof second.tipText === "string" &&
        second.tipText.includes("审阅不可用，按「需要确认」处理：一定要你亲自看过这条命令才行。"),
      { tipText: second.tipText },
      "含原文案",
    );
    shots.push(await shot(browser, "approval-fallback"));

    // 三态文案一个字都不许改：借 danger 帧再确认一次（TASK-FIX17-H 非目标）。
    await browser.evaluate(`(() => { ${HELPERS}
      push({
        type: "agent.approval",
        requestId: "probe-h-1",
        taskId: "t-probe-h",
        stepId: "probe-h-step-3",
        approvalId: "probe-h-approval-3",
        command: "rm -rf build",
        why: "清理构建产物",
        risk: "danger",
        effect: "会删掉 build 目录",
        confirmWhy: "删除不可逆",
        reversible: false,
        reviewModel: "review/model",
        reviewReason: "AI 审阅：删除不可逆",
        reviewHit: null,
      });
      return true;
    })()`);
    await waitFor(browser, "document.querySelectorAll('[data-role=\"agent-approval\"]').length >= 3", {
      label: "第三张确认卡",
    });
    const third = await browser.evaluate(`(() => { ${HELPERS}
      const card = qa('[data-role="agent-approval"]')[2];
      return { title: headTitle(card) };
    })()`);
    record(
      "browser.danger 三态文案不变（reviewReason 不许覆盖它）",
      third.title === "需要你批准：这条命令不可逆",
      { title: third.title },
      "需要你批准：这条命令不可逆",
    );
    shots.push(await shot(browser, "approval-danger-unchanged"));

    return { shots };
  } finally {
    if (browser) await browser.close();
    await handle.close();
  }
}

/* ---------------------------------------------------------------- 主流程 */

const outPath = argValue("--out");
await mkdir(EVIDENCE_DIR, { recursive: true });

console.log("== ① classify（PRD R5.1 表） ==");
runClassifyCases();

console.log("\n== ② 负对照（git show HEAD 的改前实现） ==");
const negative = await runNegativeControl();

console.log("\n== ③ 真服务 + 真浏览器 ==");
let browserInfo = null;
let browserError = null;
try {
  browserInfo = await runBrowserChecks();
} catch (err) {
  browserError = String(err && err.stack ? err.stack : err);
  record("browser.跑得起来", false, { error: String(err && err.message) }, "真浏览器断言全过");
}

const total = results.length;
const passed = results.filter((item) => item.pass).length;
const failed = total - passed;

console.log("");
console.log(`PASS ${passed}/${total}`);
if (failed > 0) {
  console.log("失败项：");
  for (const item of results.filter((entry) => !entry.pass)) console.log(`  - ${item.name}`);
}

if (outPath) {
  const payload = {
    task: "TASK-FIX17-H",
    startedAt: new Date().toISOString(),
    node: process.version,
    total,
    passed,
    failed,
    noteText: NOTE_TEXT,
    negativeControl: negative ? { ok: negative.ok, dir: negative.dir, files: negative.files } : null,
    browser: browserInfo ? { shots: browserInfo.shots } : { error: browserError },
    results,
  };
  const target = path.isAbsolute(outPath) ? outPath : path.resolve(ROOT, outPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`原始结果：${target}`);
}

process.exit(failed === 0 ? 0 : 1);
