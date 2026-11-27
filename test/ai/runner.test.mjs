// PTY 执行通道的行为锁（PROTOCOL-AGENT.md §4，AC8 / AC9）。
//
// 全部用假的 remote 对象（接口与 RemoteRegistry 一致）喂 `pty.output` 事件，不碰真的 SSH：
// 真终端的时序会让单测变 flaky。

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  DEFAULT_MIN_WAIT_MS,
  DEFAULT_QUIET_FACTOR,
  DEFAULT_QUIET_MAX_FACTOR,
  DEFAULT_QUIET_MS,
  DEFAULT_TIMEOUT_MS,
  OUTPUT_MAX_CHARS,
  USER_TEXT_QUIET,
  USER_TEXT_TIMEOUT,
  USER_TEXT_UNSUPPORTED,
  buildPayload,
  buildPowerShellPayload,
  buildPowerShellProbePayload,
  buildProbePayload,
  cleanPowerShellOutput,
  createCommandRunner,
  makeMarks,
  probeMarkerSeen,
  shellFamilyOf,
  splitBuffer,
  stripAnsi,
  stripTerminalNoise,
  truncateOutput,
} from "../../src/ai/runner.mjs";

// Linux 上 node:test 会在事件循环清空时判整轮结束，而 runner 的定时器全 unref（产品设计：命令执行不能拖住服务进程）。
// 这个不 unref 的 interval 只负责把测试进程留住，after 钩子里清掉。
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

/**
 * 假 registry：与 RemoteRegistry 的接口一致（on/off/write/get）。
 * `write` 只把 payload 记下来，由测试决定回什么输出。
 */
class FakeRegistry extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.sessions = new Map();
  }

  add(id) {
    this.sessions.set(id, { id });
    return id;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  write(id, data) {
    this.writes.push({ id, data });
    // 让测试能挂「看到写入就按剧本回输出」的监听器。
    this.emit("write", { id, data });
    return true;
  }

  emitOutput(id, data) {
    this.emit("pty.output", { id, data });
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 造一个「会按剧本回输出」的 runner。
 * 剧本：看到 probe 就回 ok；看到命令包装串就回 startMark … endMark<code>。
 */
function makeRunner(opts = {}) {
  const registry = new FakeRegistry();
  registry.add("s1");
  const runner = createCommandRunner({
    remote: registry,
    quietMs: opts.quietMs === undefined ? 120 : opts.quietMs,
    maxQuietMs: opts.maxQuietMs,
    minWaitMs: opts.minWaitMs === undefined ? 20 : opts.minWaitMs,
    timeoutMs: opts.timeoutMs === undefined ? 2000 : opts.timeoutMs,
    log: () => {},
  });
  runner.setSessionResolver((id) => (registry.get(id) ? "remote" : null));
  return { registry, runner };
}

/** 起一个「自动应答 probe」的监听器，把 probe 当成已支持。
 *
 * 两种形态都要认：bash 分支是 `printf '__MT_PROBE_<nonce>__%s\n' "ok"`，
 * PowerShell 分支是 `Write-Output '__MT_PROBE_<nonce>__ok'`（TASK-FIX-PS-SHELL §6.3）。
 */
function autoProbe(registry, { supported = true } = {}) {
  const onWrite = ({ id, data }) => {
    const probeMatch = /__MT_PROBE_([0-9a-f]+)__(?:%s|ok)/.exec(data);
    if (!probeMatch) return;
    const nonce = probeMatch[1];
    setTimeout(() => {
      if (supported) registry.emitOutput(id, `__MT_PROBE_${nonce}__ok\r\n`);
      // 不支持时不回任何东西 → probe 超时
    }, 5);
  };
  registry.on("write", onWrite);
  return () => registry.off("write", onWrite);
}

/** 起一个「看到 startMark 就回剧本」的监听器。 */
function autoCommand(registry, plan) {
  const onWrite = ({ id, data }) => {
    const marks = /__MT_S_([0-9a-f]+)__/.exec(data);
    if (!marks) return;
    const nonce = marks[1];
    const endMark = `__MT_E_${nonce}__`;
    const startMark = `__MT_S_${nonce}__`;
    if (plan === "silent") {
      // 只回回声（startMark 出现在 printf 参数里，会被终端回显）——制造「回显干扰」。
      setTimeout(() => registry.emitOutput(id, `$ ${data}\r\n`), 5);
      return;
    }
    setTimeout(() => {
      // 关键：回显里也会出现 startMark（它就是 printf 的实参）。
      registry.emitOutput(id, `$ printf '\\n%s\\n' '${startMark}'; ( ${plan.command}\n ) 2>&1; printf '${endMark}%s\\n' "$?"\r\n`);
      registry.emitOutput(id, `\r\n${startMark}\r\n`);
      for (const chunk of plan.chunks) registry.emitOutput(id, chunk);
      registry.emitOutput(id, `\r\n${endMark}${plan.exitCode}\r\n`);
    }, 5);
  };
  registry.on("write", onWrite);
  return () => registry.off("write", onWrite);
}

// ------------------------------------------------------------------ 纯函数

test("stripAnsi 去掉常见控制序列", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
  assert.equal(stripAnsi("plain"), "plain");
  assert.equal(stripAnsi(undefined), "");
});

test("truncateOutput：不超过 4000 原样返回", () => {
  const text = "x".repeat(OUTPUT_MAX_CHARS);
  const result = truncateOutput(text);
  assert.equal(result.truncated, false);
  assert.equal(result.output, text);
});

test("truncateOutput：超长时头部 1000 + 尾部 3000 + 省略标记", () => {
  const text = `${"a".repeat(1000)}${"M".repeat(500)}${"z".repeat(3000)}`;
  const result = truncateOutput(text);
  assert.equal(result.truncated, true);
  assert.ok(result.output.startsWith("a".repeat(1000)), "头部 1000 字符保留");
  assert.ok(result.output.endsWith("z".repeat(3000)), "尾部 3000 字符保留");
  assert.ok(result.output.includes("中间省略 500 字符"), result.output.slice(990, 1060));
});

test("常量与协议一致", () => {
  assert.equal(DEFAULT_QUIET_MS, 1000);
  assert.equal(DEFAULT_MIN_WAIT_MS, 300);
  assert.equal(DEFAULT_TIMEOUT_MS, 90000);
  assert.equal(OUTPUT_MAX_CHARS, 4000);
  assert.equal(USER_TEXT_TIMEOUT, "命令超过 90 秒还没结束，已放弃等待。");
});

test("buildPayload 逐字等于协议 §4.1-bash 的包装串（TASK-FIX17-A 去掉前导空行）", () => {
  const payload = buildPayload("ls", "__MT_S_ab12__", "__MT_E_ab12__");
  assert.equal(
    payload,
    "printf '%s\\n' '__MT_S_ab12__'; ( ls\n ) 2>&1; printf '__MT_E_ab12__%s\\n' \"$?\"\n",
  );
  // TASK-FIX17-A（问题 2 的另一半）：不许再打前导空行。
  // `printf '\n%s\n'` 会让 AI 每执行一条命令就在终端上先多一个空行。
  assert.equal(payload.includes("printf '\\n%s\\n'"), false, "不得再有前导 \\n 的 printf");
  assert.ok(payload.startsWith("printf '%s\\n'"), payload.slice(0, 30));
  // 其余字节必须原样：子 shell 包裹、2>&1、退出码、末尾提交用换行。
  assert.ok(payload.includes("; ( ls\n ) 2>&1; "), "子 shell 包裹与末尾换行不许变");
  assert.ok(payload.endsWith("printf '__MT_E_ab12__%s\\n' \"$?\"\n"), "出口码行不许变");
});

test("buildProbePayload 是协议 §4.4 的探测串 + 一个提交用的换行", () => {
  // 协议原文只给了命令本体；写进 PTY 必须补 \n 才会被执行（否则停在提示行上）。
  assert.equal(buildProbePayload("ab12"), "printf '__MT_PROBE_ab12__%s\\n' \"ok\"\n");
});

// ------------------------------------------- PowerShell 分支（TASK-FIX-PS-SHELL）
// 这些断言测的是 §6.1–§6.3：bash 分支的字符串一个字节都不许变，PS 分支必须
// 用 CR 提交、用 $? + $Error.Count + $LASTEXITCODE 组合判退出码。

test("PS：shellFamilyOf 只认 bash / powershell 两个家族（§6.1 六条映射）", () => {
  assert.equal(shellFamilyOf("PowerShell 7"), "powershell");
  assert.equal(shellFamilyOf("PowerShell 5"), "powershell");
  assert.equal(shellFamilyOf("pwsh"), "powershell");
  assert.equal(shellFamilyOf("bash"), "bash");
  // 远程会话的 shell.name 是 `ssh <user>@<host>`，远端是 Linux bash。
  assert.equal(shellFamilyOf("ssh u@h"), "bash");
  assert.equal(shellFamilyOf(null), "bash");
  // 其它不该被认成 PowerShell 的名字。
  assert.equal(shellFamilyOf(undefined), "bash");
  assert.equal(shellFamilyOf(""), "bash");
});

test("PS：buildPowerShellPayload 逐字等于 §6.2 的模板", () => {
  const payload = buildPowerShellPayload("ls", "__MT_S_a__", "__MT_E_a__");
  assert.equal(
    payload,
    "Write-Output '__MT_S_a__'\r" +
      "$__mtErr0 = $Error.Count; $__mtLx0 = $LASTEXITCODE\r" +
      "ls 2>&1\r" +
      "$__mtBad = (-not $?) -or ($Error.Count -gt $__mtErr0) -or ($LASTEXITCODE -ne $__mtLx0 -and $LASTEXITCODE -ne 0)\r" +
      "Write-Output ('__MT_E_a__' + $(if ($__mtBad) { 1 } else { 0 }))\r",
  );
  // 行尾必须是 CR：用 \n 会被 PSReadLine 当续行，永远停在 `>>` 上。
  assert.ok(payload.endsWith("\r"), "必须用 CR 结尾");
  assert.equal(payload.includes("\n"), false, "不得含裸 \\n");
  assert.ok(payload.includes("Write-Output '__MT_S_a__'"), "起点标记必须是 Write-Output");
  assert.ok(payload.includes("$__mtBad"), "必须有 $__mtBad 判定行");
  assert.equal(
    payload.split("\r")[4],
    "Write-Output ('__MT_E_a__' + $(if ($__mtBad) { 1 } else { 0 }))",
    "结束行逐字",
  );
});

test("PS：多行命令经 buildPowerShellPayload 后不含裸 \\n（逐行 CR 提交）", () => {
  const payload = buildPowerShellPayload("if ($true) {\n  Write-Output 'x'\n}", "__MT_S_a__", "__MT_E_a__");
  assert.equal(payload.includes("\n"), false, "不得含裸 \\n");
  assert.ok(payload.includes("if ($true) {\r  Write-Output 'x'\r} 2>&1\r"), "块语句逐行换成 CR");
  // CRLF 输入也要归一（不能留下 \r\r）。
  const crlf = buildPowerShellPayload("a\r\nb", "__MT_S_a__", "__MT_E_a__");
  assert.ok(crlf.includes("a\rb 2>&1"), "CRLF 先归一再换 CR");
  assert.equal(crlf.includes("\r\r"), false, "不得出现双 CR");
});

test("PS：buildPowerShellProbePayload 逐字等于 §6.3 的探测串", () => {
  assert.equal(buildPowerShellProbePayload("ab12"), "Write-Output '__MT_PROBE_ab12__ok'\r");
});

test("PS：cleanPowerShellOutput 剥续行提示符 / 提示符回显 / 标记行，并统一换行", () => {
  const echoLines = [
    "Write-Output '__MT_S_a__'",
    "$__mtErr0 = $Error.Count; $__mtLx0 = $LASTEXITCODE",
    "if ($true) { 2>&1",
    "$__mtBad = (-not $?) -or ($__mtErr0)",
    "Write-Output ('__MT_E_a__' + $(if ($__mtBad) { 1 } else { 0 }))",
  ];
  const noisy = [
    "PS C:\\x> Write-Output '__MT_S_a__'",
    "__MT_S_a__",
    ">>   Write-Output 'in-block'",
    ">> }",
    "in-block",
    "$__mtBad = (-not $?) -or ($__mtErr0)",
    "__MT_E_a__0",
    "PS C:\\x> ",
  ].join("\r\n");
  const clean = cleanPowerShellOutput(noisy, { echoLines });
  assert.equal(clean, "in-block", `只剩真输出：${JSON.stringify(clean)}`);
  assert.equal(clean.includes(">> "), false, "不得留续行提示符");
  assert.equal(clean.includes("__MT_S_"), false, "不得留起点标记");
  assert.equal(clean.includes("__MT_E_"), false, "不得留结束标记");
  assert.equal(clean.includes("$__mt"), false, "不得留包装串内部变量");
  assert.equal(clean.includes("Write-Output"), false, "不得留回显碎片");
  assert.equal(clean.includes("\r"), false, "CR 必须统一成 LF");

  // 多行真输出（管道/列表）必须原样保留；行中间嵌的提示符只起分隔作用，
  // 它后面的文本保留（真 PTY 无法区分「回显」与「提示符后面的真输出」，
  // 宁可多留也不丢）。
  const multiline = cleanPowerShellOutput("a\tb\r\nPS C:\\x> noise\r\nc\r\nd", { echoLines });
  assert.equal(multiline, "a\tb\nnoise\nc\nd");

  // 空输入不报错。
  assert.equal(cleanPowerShellOutput(""), "");
  assert.equal(cleanPowerShellOutput(null), "");
});

test("PS：终端变窄时 payload 折行的残片也要丢掉（真 PTY 120 列实测过的 bug）", () => {
  // 120 列 + 长提示符下 PSReadLine 把 `$__mtBad = …` 折成三段：
  //   `…$__mtLx0` / `0` / ` -and $LASTEXITCODE -ne 0)`
  // 孤立的 `0` 既没提示符也不含标记，只能靠「遇到退出码判定行就整体截断」算了。
  const cmd = "(Get-ChildItem -Force -File).Count";
  const startMark = "__MT_S_r__";
  const endMark = "__MT_E_r__";
  const payload = buildPowerShellPayload(cmd, startMark, endMark);
  const wrapped = [
    "PS C:\\x> " + startMark,
    "PS C:\\x> " + `${cmd} 2>&1`,
    "56",
    "PS C:\\x> $__mtBad = (-not $?) -or ($Error.Count -gt $__mtErr0) -or ($LASTEXITCODE -ne $__mtLx0",
    "0",
    " -and $LASTEXITCODE -ne 0)",
    "PS C:\\x> " + `Write-Output ('${endMark}' + $(if ($__mtBad) { 1 } else { 0 }))`,
  ].join("\r\n");
  const split = splitBuffer(wrapped, startMark, endMark);
  const clean = cleanPowerShellOutput(split.output, { echoLines: payload.split("\r") });
  assert.equal(clean, "56", `折行残片必须全部丢掉：${JSON.stringify(clean)}`);

  // 但真输出不能被误杀（`in-block` 是 `Write-Output 'in-block'` 的子串，不是后缀）。
  const realOutput = cleanPowerShellOutput("in-block\nafter", { echoLines: payload.split("\r") });
  assert.equal(realOutput, "in-block\nafter");

  // 不传 echoLines 时退化为「只靠提示符/标记判定」，不能报错。
  assert.equal(cleanPowerShellOutput("56\r\n", {}), "56");
});

test("PS：真输出与提示符重绘粘在一行时，只切掉回显、不丢真输出", () => {
  // 真 PTY 实测（.dispatch/fix-ps/repro3.mjs）：PowerShell 会把真输出和下一次
  // 提示符重绘拼在同一行（`1027511XPS C:\…> $__mtBad = …`）。整行丢弃就丢真输出。
  const cmd = "(Get-ChildItem -Force -File).Count";
  const startMark = "__MT_S_z__";
  const endMark = "__MT_E_z__";
  const payload = buildPowerShellPayload(cmd, startMark, endMark);
  const merged = [
    "PS C:\\x> " + startMark,
    "PS C:\\x> " + `${cmd} 2>&1`,
    "1027511XPS C:\\x> $__mtBad = (-not $?)",
    "PS C:\\x> " + `Write-Output ('${endMark}' + $(if ($__mtBad) { 1 } else { 0 }))`,
  ].join("\r\n");
  const split = splitBuffer(merged, startMark, endMark);
  const clean = cleanPowerShellOutput(split.output, { echoLines: payload.split("\r") });
  assert.equal(clean, "1027511X", `真输出必须保留（含被 CSI 吃掉后残留的 X）：${JSON.stringify(clean)}`);
});

test("PS：stripTerminalNoise 把 OSC / 其它 CSI 都剥干净（bash 分支不用它）", () => {
  assert.equal(
    stripTerminalNoise("\u001b]7;file://HOST/C:/Users/x\u0007hello\u001b]0;title\u0007"),
    "hello",
    "OSC 7 / 标题要整条剥掉，不留 `ile://` 残渣",
  );
  assert.equal(stripTerminalNoise("\u001b]7;file://HOST/C:/x\u001b\\ok"), "ok", "ST 结尾形态也要剥");
  // stripAnsi 不认 `ESC [57X`（ECH），会留一个 X —— stripTerminalNoise 必须把它吃干净。
  assert.equal(stripTerminalNoise("a\u001b[57Xb"), "ab");
  assert.equal(stripTerminalNoise("a\u001b[1;21Hb"), "ab");
  assert.equal(stripTerminalNoise("plain"), "plain");
  assert.equal(stripTerminalNoise(undefined), "");
});

test("PS：stripOsc 把 OSC 7（当前目录）整条剥掉，不留 `ile://` 残渣", () => {
  const withOsc = "\u001b]7;file://HOST/C:/Users/x\u0007hello\u001b]0;title\u0007";
  assert.equal(stripTerminalNoise(withOsc), "hello");
  // ST 结尾的形态（ESC \\）也要剥。
  assert.equal(stripTerminalNoise("\u001b]7;file://HOST/C:/x\u001b\\ok"), "ok");
  // 不碰其它内容。
  assert.equal(stripTerminalNoise("plain"), "plain");
  assert.equal(stripTerminalNoise(undefined), "");
});

test("PS：runner 按 shellNameResolver 选分支（powershell 会话回 CR 包装串）", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  runner.setShellNameResolver(() => "PowerShell 7");
  const writes = [];
  registry.on("write", ({ data }) => writes.push(data));
  // 不回任何输出：只看写进 PTY 的 payload 形态，不等结束。
  const pending = runner.run({ sessionId: "s1", command: "Write-Output 'hi'" });
  await sleep(60);
  const probeWrite = writes.find((data) => data.includes("__MT_PROBE_"));
  assert.ok(probeWrite, "必须发过探测串");
  assert.equal(probeWrite, `Write-Output '__MT_PROBE_${/__MT_PROBE_([0-9a-f]+)__/.exec(probeWrite)[1]}__ok'\r`);
  const runWrite = writes.find((data) => data.includes("__MT_S_"));
  assert.ok(runWrite, "必须发过执行串");
  assert.equal(runWrite.includes("\n"), false, "PS 执行串不得含裸 \\n");
  assert.ok(runWrite.includes("Write-Output '"), "PS 执行串用 Write-Output 打标记");
  assert.ok(runWrite.includes("$__mtBad"), "PS 执行串含退出码判定行");
  runner.dispose("s1");
  await pending;
});

test("PS：probeMarkerSeen 不允许被「Write-Output 回显」冒充（只认执行后的输出行）", () => {
  const marker = "__MT_PROBE_ab12__ok";
  // bash 分支：回显里不会出现完整标记（只有 `__%s`），保持原来的 includes 语义。
  assert.equal(probeMarkerSeen(`$ printf '__MT_PROBE_ab12__%s\\n' "ok"`, marker, "bash"), false);
  assert.equal(probeMarkerSeen(`\r\n${marker}\r\n`, marker, "bash"), true);

  // PowerShell 分支：`Write-Output '__MT_PROBE_…__ok'` 回显里就有完整标记，不能算。
  assert.equal(probeMarkerSeen(`PS C:\\x> Write-Output '${marker}'`, marker, "powershell"), false);
  // 真的执行了：输出行里不带 Write-Output。
  assert.equal(probeMarkerSeen(`PS C:\\x> Write-Output '${marker}'\r\n${marker}\r\n`, marker, "powershell"), true);
  // 空输入。
  assert.equal(probeMarkerSeen("", marker, "powershell"), false);
});

test("PS：未注入 shellNameResolver 时落回 bash 分支（零回归）", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  const writes = [];
  registry.on("write", ({ data }) => writes.push(data));
  const pending = runner.run({ sessionId: "s1", command: "ls" });
  await sleep(60);
  const probeWrite = writes.find((data) => data.includes("__MT_PROBE_"));
  assert.ok(probeWrite.startsWith("printf '__MT_PROBE_"), `默认必须是 bash 探测串：${JSON.stringify(probeWrite)}`);
  assert.ok(probeWrite.endsWith("\n"), "bash 探测串仍以 \\n 结尾");
  const runWrite = writes.find((data) => data.includes("__MT_S_"));
  // TASK-FIX17-A：bash 包装串不再打前导空行（startMark 行不再以 \n 开头）。
  assert.ok(runWrite.startsWith("printf '%s\\n' '"), `默认必须是 bash 包装串：${JSON.stringify(runWrite)}`);
  assert.equal(runWrite.includes("printf '\\n%s\\n'"), false, "不得再有前导空行");
  runner.dispose("s1");
  await pending;
});

test("PS：shellNameResolver 自己抛错时退化为 bash，不把执行带崩", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  runner.setShellNameResolver(() => {
    throw new Error("boom");
  });
  const writes = [];
  registry.on("write", ({ data }) => writes.push(data));
  const pending = runner.run({ sessionId: "s1", command: "ls" });
  await sleep(60);
  const runWrite = writes.find((data) => data.includes("__MT_S_"));
  assert.ok(runWrite && runWrite.startsWith("printf "), "抛错时必须是 bash 包装串");
  runner.dispose("s1");
  await pending;
});

test("makeMarks 生成成对标记，nonce 是 12 位十六进制", () => {
  const { nonce, startMark, endMark } = makeMarks();
  assert.equal(nonce.length, 12);
  assert.equal(startMark, `__MT_S_${nonce}__`);
  assert.equal(endMark, `__MT_E_${nonce}__`);
  const custom = makeMarks("deadbeefcafe");
  assert.equal(custom.startMark, "__MT_S_deadbeefcafe__");
});

// ------------------------------------------------------------------ splitBuffer

test("AC8：splitBuffer 用 lastIndexOf —— 回显里的 startMark 不会把输出截空", () => {
  const { startMark, endMark } = makeMarks("ab12");
  const buffer = [
    `$ printf '\\n%s\\n' '${startMark}'; ( ls\n ) 2>&1; printf '${endMark}%s\\n' "$?"`,
    startMark,
    "a.txt  b.txt",
    `${endMark}0`,
  ].join("\r\n");
  const split = splitBuffer(buffer, startMark, endMark);
  assert.equal(split.found, true);
  assert.equal(split.finished, true);
  assert.equal(split.exitCode, 0);
  assert.equal(split.output, "a.txt  b.txt");
  assert.equal(split.output.includes("__MT_"), false, "output 里不得出现标记");
});

test("splitBuffer：还没结束时 finished=false，exitCode 为 null", () => {
  const { startMark, endMark } = makeMarks("ab12");
  const split = splitBuffer(`${startMark}\r\npart`, startMark, endMark);
  assert.equal(split.found, true);
  assert.equal(split.finished, false);
  assert.equal(split.exitCode, null);
});

test("splitBuffer：非零退出码能取到", () => {
  const { startMark, endMark } = makeMarks("ab12");
  const split = splitBuffer(`${startMark}\r\nboom\r\n${endMark}2\r\n`, startMark, endMark);
  assert.equal(split.exitCode, 2);
  assert.equal(split.output, "boom");
});

test("splitBuffer：完全没出现 startMark 时 found=false", () => {
  const { startMark, endMark } = makeMarks("ab12");
  assert.equal(splitBuffer("nothing here", startMark, endMark).found, false);
});

// ------------------------------------------------------------------ probe

test("probe：读到 __MT_PROBE_<nonce>__ok → 支持", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  assert.equal(await runner.probe("s1"), true);
  // 第二次走缓存，不再写 PTY。
  const before = registry.writes.length;
  assert.equal(await runner.probe("s1"), true);
  assert.equal(registry.writes.length, before);
});

test("AC9：能力探测失败 → EXEC_UNSUPPORTED，且带协议原文的 userText", async () => {
  const { registry, runner } = makeRunner({ timeoutMs: 300 });
  autoProbe(registry, { supported: false });
  // 探测本身超时（上限 5000ms 或 timeoutMs）
  const result = await runner.run({ sessionId: "s1", command: "ls -la" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "EXEC_UNSUPPORTED");
  assert.equal(result.userText, USER_TEXT_UNSUPPORTED);
});

test("能力探测结果按 sessionId 缓存；dispose 后重新探测", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  assert.equal(await runner.probe("s1"), true);
  runner.dispose("s1");
  const before = registry.writes.length;
  assert.equal(await runner.probe("s1"), true);
  assert.ok(registry.writes.length > before, "dispose 后必须重新探测");
});

// ------------------------------------------------------------------ run

test("AC8：正常结束 —— 输出不含标记行、exitCode 正确（含回显干扰）", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  autoCommand(registry, { command: "ls", chunks: ["a.txt  b.txt\r\n"], exitCode: 0 });
  const result = await runner.run({ sessionId: "s1", command: "ls" });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "a.txt  b.txt");
  assert.equal(result.truncated, false);
});

test("非零退出码原样带回来", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  autoCommand(registry, { command: "false", chunks: ["nope\r\n"], exitCode: 7 });
  const result = await runner.run({ sessionId: "s1", command: "false" });
  assert.equal(result.exitCode, 7);
  assert.equal(result.output, "nope");
});

test("多段输出按顺序拼接", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  autoCommand(registry, { command: "x", chunks: ["one\r\n", "two\r\n", "three\r\n"], exitCode: 0 });
  const result = await runner.run({ sessionId: "s1", command: "x" });
  assert.equal(result.output, "one\r\ntwo\r\nthree");
});

test("输出里的 ANSI 被剥掉再回给模型", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  autoCommand(registry, { command: "x", chunks: ["\u001b[32mgreen\u001b[0m\r\n"], exitCode: 0 });
  const result = await runner.run({ sessionId: "s1", command: "x" });
  assert.equal(result.output, "green");
});

test("AC9：静默超时 → exitCode null + 协议原文的中文 userText", async () => {
  const { registry, runner } = makeRunner({ quietMs: 80, minWaitMs: 20, timeoutMs: 2000 });
  autoProbe(registry);
  autoCommand(registry, "silent");
  const startedAt = Date.now();
  const result = await runner.run({ sessionId: "s1", command: "interactive" });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.code, "EXEC_QUIET");
  assert.equal(result.userText, USER_TEXT_QUIET);
  assert.ok(elapsed < 1500, `不该等到总超时，实际 ${elapsed}ms`);
});

test("AC9：总超时 → exitCode null + 协议原文的中文 userText", async () => {
  const { registry, runner } = makeRunner({ quietMs: 10000, minWaitMs: 20, timeoutMs: 150 });
  autoProbe(registry);
  autoCommand(registry, "silent");
  const result = await runner.run({ sessionId: "s1", command: "hang" });
  assert.equal(result.exitCode, null);
  assert.equal(result.code, "EXEC_TIMEOUT");
  assert.equal(result.userText, USER_TEXT_TIMEOUT);
});

test("静默判定只算本命令自己的输出（别的会话的输出不算数）", async () => {
  // 钉住静默天花板（= 首轮 300ms），验证「只算本命令自己的输出」。
  const { registry, runner } = makeRunner({ quietMs: 100, maxQuietMs: 300, minWaitMs: 20, timeoutMs: 3000 });
  autoProbe(registry);
  registry.add("s2");
  autoCommand(registry, "silent");
  // 另一个会话持续输出，本命令必须照旧按自己的静默计时结束。
  const noise = setInterval(() => registry.emitOutput("s2", "noise\r\n"), 20);
  try {
    const startedAt = Date.now();
    const result = await runner.run({ sessionId: "s1", command: "quiet" });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.code, "EXEC_QUIET");
    assert.ok(elapsed < 1200, `不该被别的会话刷活，实际 ${elapsed}ms`);
  } finally {
    clearInterval(noise);
  }
});

test("minWaitMs 之前不会被判静默（300ms 默认值的效果）", async () => {
  const { registry, runner } = makeRunner({ quietMs: 30, minWaitMs: 250, timeoutMs: 3000 });
  autoProbe(registry);
  autoCommand(registry, "silent");
  const startedAt = Date.now();
  const result = await runner.run({ sessionId: "s1", command: "slow-start" });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.code, "EXEC_QUIET");
  assert.ok(elapsed >= 250, `必须等到 minWaitMs 之后，实际 ${elapsed}ms`);
});

test("会话不存在 → 不抛错，返回 SESSION_GONE", async () => {
  const { runner } = makeRunner();
  const result = await runner.run({ sessionId: "nope", command: "ls" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SESSION_GONE");
});

test("空命令 → EMPTY_COMMAND，不写 PTY", async () => {
  const { registry, runner } = makeRunner();
  const before = registry.writes.length;
  const result = await runner.run({ sessionId: "s1", command: "   " });
  assert.equal(result.code, "EMPTY_COMMAND");
  assert.equal(registry.writes.length, before);
});

test("命令里带 startMark 风格的字符串也不会串台（每次 nonce 不同）", async () => {
  const { registry, runner } = makeRunner();
  autoProbe(registry);
  // 命令本身打印一个旧标记：不应被当成本次的 startMark。
  autoCommand(registry, {
    command: "echo __MT_S_aaaaaaaaaaaa__",
    chunks: ["__MT_S_aaaaaaaaaaaa__\r\n", "real output\r\n"],
    exitCode: 0,
  });
  const result = await runner.run({ sessionId: "s1", command: "echo __MT_S_aaaaaaaaaaaa__" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "__MT_S_aaaaaaaaaaaa__\r\nreal output");
});

test("日志不含完整命令（只打长度 + 前 40 字符）", async () => {
  const logs = [];
  const registry = new FakeRegistry();
  registry.add("s1");
  const runner = createCommandRunner({
    remote: registry,
    quietMs: 80,
    minWaitMs: 20,
    timeoutMs: 1000,
    log: (entry) => logs.push(entry),
  });
  runner.setSessionResolver((id) => (registry.get(id) ? "remote" : null));
  autoProbe(registry);
  autoCommand(registry, "silent");
  const command = `echo ${"secret".repeat(40)}`;
  await runner.run({ sessionId: "s1", command });
  const start = logs.find((entry) => entry.code === "COMMAND_RUN_START");
  assert.ok(start, "必须有 COMMAND_RUN_START 日志");
  assert.equal(start.commandLength, command.length);
  assert.equal(start.commandHead, command.slice(0, 40));
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("secret".repeat(40)), false, "日志里不得出现完整命令");
});

test("并发：同一会话第二次 run 直接 BUSY_SESSION（不排队、不改终端尺寸）", async () => {
  const { registry, runner } = makeRunner({ quietMs: 400, minWaitMs: 20, timeoutMs: 3000 });
  autoProbe(registry);
  autoCommand(registry, "silent");
  const first = runner.run({ sessionId: "s1", command: "long" });
  await sleep(30);
  const second = await runner.run({ sessionId: "s1", command: "other" });
  assert.equal(second.code, "BUSY_SESSION");
  await first;
});

// ------------------------------------------------- 修复 1（M1）：自适应静默阈值
// TASK-V3-D-FIX1：静默阈值 = quietMs × DEFAULT_QUIET_FACTOR（默认 1000 × 3 = 3000ms），
// 「还没收到任何输出」和「收到过输出后」用同一个阈值；minWaitMs 与总超时都不变。

test("修复1：常量默认值 —— 首轮 1000×3 = 3000ms，天花板 1000×16 = 16000ms", () => {
  assert.equal(DEFAULT_QUIET_FACTOR, 3);
  assert.equal(DEFAULT_QUIET_MAX_FACTOR, 16);
  assert.equal(DEFAULT_QUIET_MS * DEFAULT_QUIET_FACTOR, 3000, "首轮静默阈值必须是 3000ms");
  assert.equal(DEFAULT_QUIET_MS * DEFAULT_QUIET_MAX_FACTOR, 16000, "静默阈值天花板是 16000ms");
});

test("修复1：默认 quietMs=1000 时静默判定不早于 3000ms（旧实现 1000ms 就切）", async () => {
  // quietMs=1000（默认值）× 3 = 3000ms 首轮。这里把天花板钉在 3200ms，
  // 只验证「首轮阈值确实是 3000ms 而不是 1000ms」，不让单测等 16 秒。
  const { registry, runner } = makeRunner({ quietMs: 1000, maxQuietMs: 3200, minWaitMs: 20, timeoutMs: 20000 });
  autoProbe(registry);
  autoCommand(registry, "silent");
  const startedAt = Date.now();
  const result = await runner.run({ sessionId: "s1", command: "slow" });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.code, "EXEC_QUIET");
  assert.ok(elapsed >= 2900, `首轮阈值必须是 3000ms（旧实现 1000ms 就切），实际 ${elapsed}ms`);
  assert.ok(elapsed <= 5000, `钉住天花板后应很快结束，实际 ${elapsed}ms`);
});

test("修复1：阶梯式宽限 —— 到点没结束标记就升一档（300 → 600 → 1200 → 1600 封顶）", async () => {
  // quietMs=100 × 3 = 300ms 首轮；天花板默认 100 × 16 = 1600ms。
  const { registry, runner } = makeRunner({ quietMs: 100, minWaitMs: 20, timeoutMs: 10000 });
  autoProbe(registry);
  autoCommand(registry, "silent");
  const startedAt = Date.now();
  const result = await runner.run({ sessionId: "s1", command: "hang" });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.code, "EXEC_QUIET");
  assert.ok(elapsed >= 1500, `必须爬完 300+600+1200 才到 1600ms 封顶，实际 ${elapsed}ms`);
  assert.ok(elapsed < 3000, `不该拖太久，实际 ${elapsed}ms`);
});

test("修复1：quietFactor 可用构造参数改成 1（回到协议里 1000ms 的语义）", async () => {
  const registry = new FakeRegistry();
  registry.add("s1");
  const runner = createCommandRunner({
    remote: registry,
    quietMs: 150,
    quietFactor: 1,
    maxQuietMs: 150, // 钉住天花板，验证 150 × 1 = 150ms 的语义
    minWaitMs: 20,
    timeoutMs: 3000,
    log: () => {},
  });
  runner.setSessionResolver((id) => (registry.get(id) ? "remote" : null));
  autoProbe(registry);
  autoCommand(registry, "silent");
  const startedAt = Date.now();
  const result = await runner.run({ sessionId: "s1", command: "x" });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.code, "EXEC_QUIET");
  assert.ok(elapsed < 900, `quietFactor=1 时 150ms 就该判静默，实际 ${elapsed}ms`);
});

test("修复1：quietFactor 可用环境变量覆盖，非法值回落默认 3", async () => {
  const previous = process.env.MAGPIE_TERMINAL_QUIET_FACTOR;
  try {
    process.env.MAGPIE_TERMINAL_QUIET_FACTOR = "2";
    const registry = new FakeRegistry();
    registry.add("s1");
    const runner = createCommandRunner({
      remote: registry,
      quietMs: 100,
      maxQuietMs: 200, // 钉住天花板：100 × 2 = 200ms
      minWaitMs: 20,
      timeoutMs: 4000,
      log: () => {},
    });
    runner.setSessionResolver((id) => (registry.get(id) ? "remote" : null));
    autoProbe(registry);
    autoCommand(registry, "silent");
    const startedAt = Date.now();
    const result = await runner.run({ sessionId: "s1", command: "x" });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.code, "EXEC_QUIET");
    assert.ok(elapsed >= 190, `环境变量 quietFactor=2 应生效（≥190ms），实际 ${elapsed}ms`);
    assert.ok(elapsed < 800, `实际 ${elapsed}ms`);

    process.env.MAGPIE_TERMINAL_QUIET_FACTOR = "not-a-number";
    const registry2 = new FakeRegistry();
    registry2.add("s1");
    const runner2 = createCommandRunner({
      remote: registry2,
      quietMs: 100,
      maxQuietMs: 300, // 钉住天花板：非法值回落默认 3 → 100 × 3 = 300ms
      minWaitMs: 20,
      timeoutMs: 4000,
      log: () => {},
    });
    runner2.setSessionResolver((id) => (registry2.get(id) ? "remote" : null));
    autoProbe(registry2);
    autoCommand(registry2, "silent");
    const startedAt2 = Date.now();
    const result2 = await runner2.run({ sessionId: "s1", command: "x" });
    const elapsed2 = Date.now() - startedAt2;
    assert.equal(result2.code, "EXEC_QUIET");
    assert.ok(elapsed2 >= 290, `非法值必须回落默认 3（≥290ms），实际 ${elapsed2}ms`);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_TERMINAL_QUIET_FACTOR;
    else process.env.MAGPIE_TERMINAL_QUIET_FACTOR = previous;
  }
});

test("修复1：慢启动命令（1.5s 后才出第一段输出）不会被静默切断", async () => {
  const registry = new FakeRegistry();
  registry.add("s1");
  // quietMs=600 × 3 = 1800ms 阈值；第一段输出在 1500ms 才来 → 旧实现 300+600=900ms 就切了。
  const runner = createCommandRunner({
    remote: registry,
    quietMs: 600,
    minWaitMs: 300,
    timeoutMs: 8000,
    log: () => {},
  });
  runner.setSessionResolver((id) => (registry.get(id) ? "remote" : null));
  autoProbe(registry);
  registry.on("write", ({ id, data }) => {
    const marks = /__MT_S_([0-9a-f]+)__/.exec(data);
    if (!marks) return;
    const nonce = marks[1];
    const startMark = `__MT_S_${nonce}__`;
    const endMark = `__MT_E_${nonce}__`;
    setTimeout(() => registry.emitOutput(id, `\r\n${startMark}\r\n`), 5);
    setTimeout(() => registry.emitOutput(id, "slow output\r\n"), 1500);
    setTimeout(() => registry.emitOutput(id, `\r\n${endMark}0\r\n`), 1700);
  });
  const result = await runner.run({ sessionId: "s1", command: "sleep 1.5; echo slow output" });
  assert.equal(result.exitCode, 0, "必须拿到真实 exitCode（旧实现是 null + EXEC_QUIET）");
  assert.ok(result.output.includes("slow output"), `输出不能丢：${JSON.stringify(result.output)}`);
  assert.equal(result.code, undefined);
});

test("修复1：输出中途停 1 秒以上（每秒一行）不会被静默切断", async () => {
  const registry = new FakeRegistry();
  registry.add("s1");
  const runner = createCommandRunner({
    remote: registry,
    quietMs: 500, // ×3 = 1500ms，故意大于 1.2s 的输出空窗
    minWaitMs: 300,
    timeoutMs: 8000,
    log: () => {},
  });
  runner.setSessionResolver((id) => (registry.get(id) ? "remote" : null));
  autoProbe(registry);
  registry.on("write", ({ id, data }) => {
    const marks = /__MT_S_([0-9a-f]+)__/.exec(data);
    if (!marks) return;
    const nonce = marks[1];
    const startMark = `__MT_S_${nonce}__`;
    const endMark = `__MT_E_${nonce}__`;
    setTimeout(() => registry.emitOutput(id, `\r\n${startMark}\r\n`), 5);
    setTimeout(() => registry.emitOutput(id, "line1\r\n"), 50);
    setTimeout(() => registry.emitOutput(id, "line2\r\n"), 1250); // 1.2s 空窗
    setTimeout(() => registry.emitOutput(id, `\r\n${endMark}0\r\n`), 1400);
  });
  const result = await runner.run({ sessionId: "s1", command: "for i in 1 2; do echo line$i; sleep 1; done" });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes("line1"), result.output);
  assert.ok(result.output.includes("line2"), `1.2s 空窗后不能切断，实际输出：${JSON.stringify(result.output)}`);
});

test("修复1：总超时不随静默阈值放宽（挂住的命令仍按 timeoutMs 返回 EXEC_TIMEOUT）", async () => {
  const { registry, runner } = makeRunner({ quietMs: 5000, minWaitMs: 20, timeoutMs: 300 });
  autoProbe(registry);
  autoCommand(registry, "silent");
  const startedAt = Date.now();
  const result = await runner.run({ sessionId: "s1", command: "sleep 200" });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.code, "EXEC_TIMEOUT");
  assert.equal(result.exitCode, null);
  assert.equal(result.userText, USER_TEXT_TIMEOUT);
  assert.ok(elapsed >= 290 && elapsed < 1500, `必须在总超时附近返回，实际 ${elapsed}ms`);
});

test("修复1：minWaitMs 仍然生效（静默阈值再大也要等过 minWaitMs）", async () => {
  // quietMs=200 × 3 = 600ms 阈值，minWaitMs=800 → 必须在 800ms 之后才允许判静默。
  const { registry, runner } = makeRunner({ quietMs: 200, maxQuietMs: 600, minWaitMs: 800, timeoutMs: 5000 });
  autoProbe(registry);
  autoCommand(registry, "silent");
  const startedAt = Date.now();
  const result = await runner.run({ sessionId: "s1", command: "no-such-command" });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.code, "EXEC_QUIET");
  assert.ok(elapsed >= 790, `必须等到 minWaitMs 之后，实际 ${elapsed}ms`);
  assert.ok(elapsed < 2000, `不该拖太久，实际 ${elapsed}ms`);
});

// ------------------------------------------------------------ 修复 3（m3）：endMark 取最后一个

test("修复3：输出里含伪造的 endMark+数字时取最后一个，exitCode 是真实的", () => {
  const { startMark, endMark } = makeMarks("ab12");
  const buffer = [
    `$ printf '\n%s\n' '${startMark}'; ( echo "__MT_E_ab12__99"\n ) 2>&1; printf '${endMark}%s\n' "$?"`,
    startMark,
    `__MT_E_ab12__99`,
    `${endMark}0`,
  ].join("\r\n");
  const split = splitBuffer(buffer, startMark, endMark);
  assert.equal(split.found, true);
  assert.equal(split.finished, true);
  assert.equal(split.exitCode, 0, `必须拿真实 exitCode 0，不是伪造的 99`);
  assert.equal(split.output, "__MT_E_ab12__99", "echo 出来的文本必须保留");
});

test("修复3：多个伪造 endMark 时仍取最后一个", () => {
  const { startMark, endMark } = makeMarks("ab12");
  const buffer = `${startMark}\r\nA ${endMark}99\r\nB ${endMark}7\r\nC\r\n${endMark}3`;
  const split = splitBuffer(buffer, startMark, endMark);
  assert.equal(split.exitCode, 3);
  assert.equal(split.output, `A ${endMark}99\r\nB ${endMark}7\r\nC`);
});

test("修复3：只有伪造 endMark、真实结束标记还没到时 finished=false", () => {
  const { startMark, endMark } = makeMarks("ab12");
  const split = splitBuffer(`${startMark}\r\npartial`, startMark, endMark);
  assert.equal(split.finished, false);
  assert.equal(split.exitCode, null);
});

test("修复3：命令输出里含本命令 nonce 的 endMark+数字时，仍拿真实 exitCode（F8 验收原样）", async () => {
  const registry = new FakeRegistry();
  registry.add("s1");
  const runner = createCommandRunner({ remote: registry, quietMs: 120, minWaitMs: 20, timeoutMs: 3000, log: () => {} });
  runner.setSessionResolver((id) => (registry.get(id) ? "remote" : null));
  autoProbe(registry);
  registry.on("write", ({ id, data }) => {
    const marks = /__MT_S_([0-9a-f]+)__/.exec(data);
    if (!marks) return;
    const nonce = marks[1];
    const startMark = `__MT_S_${nonce}__`;
    const endMark = `__MT_E_${nonce}__`;
    setTimeout(() => {
      registry.emitOutput(id, `\r\n${startMark}\r\n`);
      // 命令自己的输出里就含「本命令 nonce 的 endMark + 99」——真实结束标记随后才到。
      registry.emitOutput(id, `${endMark}99\r\n`);
      registry.emitOutput(id, "real-output\r\n");
      registry.emitOutput(id, `\r\n${endMark}0\r\n`);
    }, 5);
  });
  const result = await runner.run({ sessionId: "s1", command: "echo fake" });
  assert.equal(result.exitCode, 0, "必须拿真实 exitCode 0，不是伪造的 99");
  assert.ok(result.output.includes("__99"), `echo 出来的伪造标记文本必须保留：${JSON.stringify(result.output)}`);
  assert.ok(result.output.includes("real-output"), `真实输出不能丢：${JSON.stringify(result.output)}`);
});
