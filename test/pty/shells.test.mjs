// 本机 shell 枚举的行为锁（TASK-V4-F §5.6 / TASK-FIX17-A AC1、AC9）。
//
// 这些断言直接打这台机器的真实安装状态（cmd / bash / PowerShell 5 / pwsh 7 / WSL），
// 不 mock 进程调用 —— 卡片的质量基准就是「真能跑」。
// 纯函数（WSL UTF-16 解码、JSONC 解析、id 截断、去重）在下面单独用构造输入测，
// 不依赖本机装了什么。

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  BUILTIN_SHELL_IDS,
  SHELL_ID_MAX,
  decodeWslOutput,
  dedupeShells,
  deriveWtProfileShells,
  detectShells,
  detectDefaultShell,
  detectWsl,
  detectWtProfiles,
  expandEnvVars,
  isValidShellId,
  parseCommandline,
  parseJsonc,
  parseWslDistroList,
  resetShellsCache,
  resolveShellById,
  resolveShellForRequest,
  slugifyShellName,
  stripJsoncComments,
  stripTrailingCommas,
  uniqueShellId,
} from "../../src/pty/shells.mjs";

resetShellsCache();
const shells = detectShells();
const byId = (id) => shells.find((item) => item.id === id);

test("BUILTIN_SHELL_IDS 是 cmd / bash / pwsh / powershell（顺序即 UI 顺序）", () => {
  assert.deepEqual([...BUILTIN_SHELL_IDS], ["cmd", "bash", "pwsh", "powershell"]);
});

test("detectShells() 前四条就是内置四项，顺序固定", () => {
  assert.deepEqual(
    shells.slice(0, 4).map((item) => item.id),
    [...BUILTIN_SHELL_IDS],
  );
  for (const item of shells) {
    assert.equal(typeof item.name, "string");
    assert.equal(typeof item.version, "string");
    assert.equal(typeof item.path, "string");
    assert.ok(Array.isArray(item.args));
    assert.equal(typeof item.available, "boolean");
    // TASK-FIX17-A 新增字段：UI 用来分组（本机 / WSL / WT profile）。
    assert.ok(["local", "wsl", "profile"].includes(item.group), `group 异常: ${item.id} → ${item.group}`);
  }
});

test("清单里至少同时有 cmd、bash、pwsh、powershell 四条（AC1）", () => {
  for (const id of BUILTIN_SHELL_IDS) {
    assert.ok(byId(id), `清单里没有 ${id}`);
  }
});

test("每个 available:true 的 id 都过得了格式校验，且长度不超过 64", () => {
  for (const item of shells) {
    assert.equal(isValidShellId(item.id), true, `id 不合法: ${JSON.stringify(item.id)}`);
    assert.ok(item.id.length <= SHELL_ID_MAX, `id 超长: ${item.id} (${item.id.length})`);
  }
  // id 不重复（去重生效）。
  const ids = shells.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, `id 有重复: ${JSON.stringify(ids)}`);
});

test("cmd 在这台机器上 available:true，路径与 COMSPEC/System32 之一一致，版本可读", () => {
  const cmd = byId("cmd");
  assert.ok(cmd, "detectShells() 里没有 cmd");
  assert.equal(cmd.available, true, `cmd 不可用（path=${JSON.stringify(cmd.path)}）`);
  assert.match(cmd.path, /[\\/]cmd\.exe$/i);
  assert.deepEqual(cmd.args, []);
  // 版本来自 `cmd /d /c ver` 的 ASCII 部分（OEM 码页的「版本」二字是乱码，但数字可读）。
  assert.match(cmd.version, /^10\./, `cmd 版本读不出：${cmd.version}`);
});

test("cmd 真的能 spawn：`cmd /c echo` 有输出", () => {
  const cmd = byId("cmd");
  const out = execFileSync(cmd.path, ["/d", "/c", "echo", "cmd-ok"], {
    encoding: "utf8",
    timeout: 8000,
  });
  assert.match(out, /cmd-ok/);
});

test("bash 在这台机器上 available:true，版本与 `bash --version` 实测一致", () => {
  const bash = byId("bash");
  assert.ok(bash, "detectShells() 里没有 bash");
  assert.equal(bash.available, true, `bash 不可用（path=${JSON.stringify(bash.path)}）`);
  assert.deepEqual(bash.args, []);
  const out = execFileSync(bash.path, ["--version"], { encoding: "utf8", timeout: 5000 });
  const match = /GNU bash, version (\d+\.\d+(?:\.\d+)?)/i.exec(out);
  assert.ok(match, "读不到 bash --version 的版本号");
  assert.equal(bash.version, match[1]);
});

test("powershell（Windows PowerShell 5.1）在这台机器上可用，版本以 5.1. 开头", () => {
  const ps = byId("powershell");
  assert.equal(ps.available, true, "Windows PowerShell 5.1 不可用");
  assert.match(ps.path, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.deepEqual(ps.args, ["-NoLogo"]);
  assert.match(ps.version, /^5\.1\./);
});

test("WSL 发行版（若本机有）以 wsl:<发行版> 出现，args 是 -d <发行版>", () => {
  const wslItems = shells.filter((item) => item.group === "wsl");
  for (const item of wslItems) {
    assert.match(item.id, /^wsl:/);
    assert.equal(item.id.slice(4), item.detail, "id 后半段必须等于 detail（发行版名）");
    assert.deepEqual(item.args, ["-d", item.detail]);
    assert.match(item.path, /[\\/]wsl\.exe$/i);
    assert.equal(item.available, true);
  }
  // 本机实测有 Ubuntu-24.04（WSL2）。没有发行版时这条自动跳过而不是假失败。
  if (wslItems.length === 0) {
    console.log("（本机没有注册任何 WSL 发行版，wsl:* 断言跳过）");
  }
});

test("resolveShellById 对不认识的 id 返回 null", () => {
  assert.equal(resolveShellById("nope"), null);
  assert.equal(resolveShellById("zsh"), null);
  assert.equal(resolveShellById("nope:xyz"), null);
  assert.equal(resolveShellById(""), null);
  assert.equal(resolveShellById(null), null);
});

test("resolveShellById('cmd') 返回可 spawn 的形状（含 args / fallback）", () => {
  const shell = resolveShellById("cmd");
  assert.ok(shell);
  assert.equal(shell.id, "cmd");
  assert.deepEqual(shell.args, []);
  assert.equal(shell.fallback, false);
  assert.ok(shell.path.length > 0);
});

test("resolveShellById('pwsh') 的 args 含 -NoLogo（若本机装了 pwsh）", () => {
  const pwsh = byId("pwsh");
  if (!pwsh.available) {
    // 本机没装 pwsh7 时这条无法成立，但要报出来而不是静默跳过。
    assert.equal(resolveShellById("pwsh"), null);
    return;
  }
  const shell = resolveShellById("pwsh");
  assert.ok(shell);
  assert.ok(shell.args.includes("-NoLogo"));
  assert.match(shell.version, /^7\./);
});

test("resolveShellById('powershell') 返回可 spawn 的形状（含 fallback 字段）", () => {
  const shell = resolveShellById("powershell");
  assert.ok(shell);
  assert.equal(shell.id, "powershell");
  assert.match(shell.name, /PowerShell/i);
  assert.equal(shell.fallback, false);
  assert.ok(shell.path.length > 0);
});

test("resolveShellForRequest：非法 shellId → PTY_UNKNOWN_SHELL", () => {
  const result = resolveShellForRequest({ shellId: "zsh" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PTY_UNKNOWN_SHELL");
});

test("resolveShellForRequest：带冒号但本机不存在的 id 也是 PTY_UNKNOWN_SHELL", () => {
  const result = resolveShellForRequest({ shellId: "wsl:NoSuchDistro-99" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PTY_UNKNOWN_SHELL");
});

test("resolveShellForRequest：不带 shellId → 走自动探测（bash 优先）", () => {
  const result = resolveShellForRequest({ shellId: null, defaultShell: null });
  assert.equal(result.ok, true);
  assert.equal(result.shell.id, "bash");
});

test("resolveShellForRequest：defaultShell 生效；本机不存在的 defaultShell 静默回落", () => {
  const pwsh = byId("pwsh");
  const result = resolveShellForRequest({ defaultShell: pwsh.available ? "pwsh" : "bash" });
  assert.equal(result.ok, true);
  assert.equal(result.shell.id, pwsh.available ? "pwsh" : "bash");

  // 配置里存了 cmd / wsl:* 也能直接用（TASK-FIX17-A AC4 的解析侧）。
  const cmd = resolveShellForRequest({ defaultShell: "cmd" });
  assert.equal(cmd.ok, true);
  assert.equal(cmd.shell.id, "cmd");

  const fallback = resolveShellForRequest({ defaultShell: "wsl:NoSuchDistro-99" });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.shell.id, "bash");
});

test("detectDefaultShell 复用 bridge.detectShell()：默认是 bash", () => {
  const detected = detectDefaultShell();
  assert.equal(detected.id, "bash");
  assert.match(detected.name, /bash/i);
});

test("resetShellsCache 之后仍能探测（缓存可重置）", () => {
  resetShellsCache();
  const again = detectShells();
  assert.deepEqual(
    again.slice(0, 4).map((item) => item.id),
    [...BUILTIN_SHELL_IDS],
  );
  assert.equal(again.find((item) => item.id === "bash").available, true);
});

// ---------------------------------------------------------------- 纯函数（不依赖本机）

test("isValidShellId：cmd / wsl:* / profile:* 都合法，空格与超长被拒", () => {
  assert.equal(isValidShellId("cmd"), true);
  assert.equal(isValidShellId("wsl:Ubuntu-24.04"), true);
  assert.equal(isValidShellId("profile:git-bash"), true);
  assert.equal(isValidShellId("a.b_c-d"), true);
  assert.equal(isValidShellId(null), false);
  assert.equal(isValidShellId(undefined), false);
  assert.equal(isValidShellId(42), false);
  assert.equal(isValidShellId(""), false);
  assert.equal(isValidShellId("bad shell!"), false);
  assert.equal(isValidShellId("has\nnewline"), false);
  assert.equal(isValidShellId("a".repeat(SHELL_ID_MAX)), true);
  assert.equal(isValidShellId("a".repeat(SHELL_ID_MAX + 1)), false);
});

test("decodeWslOutput：UTF-16LE（无 BOM）/ 带 BOM / UTF-8 三种输入都能解", () => {
  // 本机实测的真实字节：`wsl.exe -l -q` → 55 00 62 00 …（UTF-16LE，无 BOM）。
  const utf16 = Buffer.from("Ubuntu-24.04\r\n", "utf16le");
  assert.equal(utf16.toString("hex").slice(0, 8), "55006200", "构造样本必须与实测一致");
  assert.equal(decodeWslOutput(utf16), "Ubuntu-24.04\r\n");
  assert.equal(decodeWslOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16])), "Ubuntu-24.04\r\n");
  assert.equal(decodeWslOutput(Buffer.from("Ubuntu-24.04\r\n", "utf8")), "Ubuntu-24.04\r\n");
  // 中文发行版名（UTF-16LE 下每字符 4 字节）。
  assert.equal(decodeWslOutput(Buffer.from("Ubuntu 测试版\r\n", "utf16le")), "Ubuntu 测试版\r\n");
  assert.equal(decodeWslOutput(Buffer.alloc(0)), "");
  assert.equal(decodeWslOutput("Ubuntu-24.04\r\n"), "Ubuntu-24.04\r\n");
  // 带 * 的默认标记行（-l -v 的形态）不会因为解码而变成乱码。
  assert.match(decodeWslOutput(Buffer.from("* Ubuntu-24.04    Stopped    2\r\n", "utf16le")), /Ubuntu-24\.04/);
});

test("parseWslDistroList：拆行、去 * 标记、去空行", () => {
  assert.deepEqual(parseWslDistroList(Buffer.from("Ubuntu-24.04\r\n", "utf16le")), ["Ubuntu-24.04"]);
  assert.deepEqual(
    parseWslDistroList(Buffer.from("* Ubuntu-24.04\r\n  Debian\r\n\r\n", "utf16le")),
    ["Ubuntu-24.04", "Debian"],
  );
  assert.deepEqual(parseWslDistroList(Buffer.from("", "utf16le")), []);
  assert.deepEqual(parseWslDistroList(""), []);
  // 「没有已安装的分发」不该被当成发行版名。
  assert.deepEqual(parseWslDistroList("没有已安装的分发。\r\n"), []);
  assert.deepEqual(parseWslDistroList("No installed distributions.\r\n"), []);
});

test("detectWsl：注入 UTF-16LE 输出 → wsl:<发行版> 记录；无 wsl.exe → []", () => {
  const list = Buffer.from("Ubuntu-24.04\r\nDebian\r\n", "utf16le");
  const rows = detectWsl({
    exePath: "C:\\Windows\\System32\\wsl.exe",
    listOutput: list,
    versionOutput: Buffer.from("WSL 版本: 3.0.5.0\r\n内核版本: 6.18.58.1-1\r\n", "utf16le"),
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "wsl:Ubuntu-24.04");
  assert.equal(rows[0].args.join(" "), "-d Ubuntu-24.04");
  assert.equal(rows[0].available, true);
  assert.equal(rows[0].group, "wsl");
  assert.equal(rows[0].detail, "Ubuntu-24.04");
  assert.equal(rows[0].version, "3.0.5.0", "版本取自一次 wsl --version，不逐条跑 uname");
  // 没有 wsl.exe → 空数组（静默跳过，不抛错）。
  assert.deepEqual(detectWsl({ exePath: null }), []);
  // 有 wsl.exe 但没有发行版 → 空数组。
  assert.deepEqual(
    detectWsl({ exePath: "C:\\Windows\\System32\\wsl.exe", listOutput: Buffer.alloc(0) }),
    [],
  );
});

test("stripJsoncComments：剥 // 与 /* */，但不动字符串里的 //", () => {
  assert.equal(stripJsoncComments('{"a":1} // tail'), '{"a":1} ');
  assert.equal(stripJsoncComments('{\n// line\n"a":1\n}'), '{\n\n"a":1\n}');
  assert.equal(stripJsoncComments('{"a":1} /* block */'), '{"a":1} ');
  // 字符串里的 // 必须原样保留（WT 的 commandline 里常见）。
  assert.equal(stripJsoncComments('{"p":"C:\\\\a//b"}'), '{"p":"C:\\\\a//b"}');
  assert.equal(stripJsoncComments('{"u":"https://x/y"}'), '{"u":"https://x/y"}');
  // 转义的引号不结束字符串。
  assert.equal(stripJsoncComments('{"q":"a\\"//b"} // c'), '{"q":"a\\"//b"} ');
});

test("stripTrailingCommas / parseJsonc：尾逗号与注释都能容错", () => {
  assert.equal(stripTrailingCommas('{"a":[1,2,],}'), '{"a":[1,2]}');
  assert.equal(stripTrailingCommas('{"s":"a,b,"}'), '{"s":"a,b,"}');
  const jsonc = `{
    // 行注释
    "profiles": {
      "list": [
        { "name": "Git Bash", "commandline": "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe" },
      ],
    },
  }`;
  const parsed = parseJsonc(jsonc);
  assert.ok(parsed, "JSONC 必须能解析");
  assert.equal(parsed.profiles.list.length, 1);
  assert.equal(parsed.profiles.list[0].name, "Git Bash");
  // 真正坏的 JSON 返回 null（调用方静默跳过整个来源）。
  assert.equal(parseJsonc("{oops"), null);
  assert.equal(parseJsonc(""), null);
});

test("expandEnvVars / parseCommandline：展开 %VAR% 并按引号切参数", () => {
  const env = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\x" };
  assert.equal(expandEnvVars("%SystemRoot%\\System32\\cmd.exe", env), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(expandEnvVars("%systemroot%\\x", env), "C:\\Windows\\x", "变量名大小写不敏感");
  assert.equal(expandEnvVars("%NOPE%\\x", env), "%NOPE%\\x", "未知变量原样保留");

  assert.deepEqual(parseCommandline("%SystemRoot%\\System32\\cmd.exe", env), {
    path: "C:\\Windows\\System32\\cmd.exe",
    args: [],
  });
  assert.deepEqual(
    parseCommandline('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i', env),
    { path: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--login", "-i"] },
  );
  // 路径里的反斜杠不是转义符（Windows 路径），必须原样保留。
  assert.deepEqual(parseCommandline("C:\\a\\b\\c.exe -x", env), { path: "C:\\a\\b\\c.exe", args: ["-x"] });
  assert.equal(parseCommandline("", env), null);
  assert.equal(parseCommandline(null, env), null);
});

test("deriveWtProfileShells：跳过 hidden / 无 commandline / 不存在 / 已覆盖的 exe", () => {
  const env = { SystemRoot: "C:\\Windows" };
  const settings = JSON.stringify({
    profiles: {
      list: [
        { name: "Windows PowerShell", commandline: "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
        { name: "命令提示符", commandline: "%SystemRoot%\\System32\\cmd.exe" },
        { name: "Azure Cloud Shell", source: "Windows.Terminal.Azure" },
        { name: "Git Bash", source: "Git" },
        { name: "Hidden One", hidden: true, commandline: "%SystemRoot%\\System32\\cmd.exe" },
        { name: "Not Installed", commandline: "%SystemRoot%\\System32\\nope.exe" },
        { name: "Nu Shell", commandline: "C:\\tools\\nu\\nu.exe --login" },
      ],
    },
  });
  const exists = (p) => !/nope\.exe$/i.test(p);
  const derived = deriveWtProfileShells(settings, {
    env,
    exists,
    coveredPaths: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
  });
  assert.deepEqual(
    derived.map((item) => item.name),
    ["命令提示符", "Nu Shell"],
    "powershell 被内置项覆盖、nope.exe 不存在、hidden 跳过、无 commandline 跳过",
  );
  assert.deepEqual(derived[1].args, ["--login"]);
});

test("detectWtProfiles：从注入的 settings.json 文本派生；文件不存在 → []", () => {
  const text = JSON.stringify({
    profiles: {
      list: [
        { name: "Git Bash", commandline: '"C:\\Program Files\\Git\\bin\\bash.exe" --login' },
      ],
    },
  });
  const rows = detectWtProfiles(
    { localPaths: [], coveredKeys: [] },
    { settingsPaths: ["C:\\definitely\\missing\\settings.json"], settingsText: text },
  );
  // settingsPaths 指向不存在的文件 → 一条都不产生（先判 fileExists）。
  assert.deepEqual(rows, []);
});

test("deriveWtProfileShells：真实 WT settings.json 里带 commandline 的 profile 都能派生", () => {
  // 用本机真实文件（存在时才跑）验证「WT profile 派生」这条来源确实工作。
  const file = "C:\\Users\\41807\\AppData\\Local\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json";
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.log("（本机没有 WT settings.json，跳过）");
    return;
  }
  const derived = deriveWtProfileShells(text, { coveredPaths: [], exists: () => true });
  // 本机 8 条 profile 里只有 2 条带 commandline（Windows PowerShell / 命令提示符），
  // 其余是 source 派生的动态 profile。
  assert.ok(derived.length >= 1, `没派生出任何 profile: ${JSON.stringify(derived)}`);
  for (const item of derived) {
    assert.ok(item.path.length > 0);
    assert.ok(Array.isArray(item.args));
  }
  const names = derived.map((item) => item.name);
  assert.ok(names.includes("Windows PowerShell"), `缺 Windows PowerShell: ${names.join(",")}`);
});

test("slugifyShellName：小写 + 非 [a-z0-9_-] 换 - + 去重连续 - + 截断", () => {
  assert.equal(slugifyShellName("Git Bash"), "git-bash");
  // 非 [a-z0-9_-] 一律换 `-`（`.` 也会被换掉；id 里保留 `:` 只用于分隔前缀）。
  assert.equal(slugifyShellName("Ubuntu-24.04"), "ubuntu-24-04");
  assert.equal(slugifyShellName("命令提示符"), slugifyShellName("命令提示符"), "中文名要稳定");
  assert.ok(/^[a-z0-9_-]+$/.test(slugifyShellName("命令提示符")), "中文名要落成 ASCII 短名");
  assert.notEqual(slugifyShellName("命令提示符"), slugifyShellName("另一个名字"));
  assert.equal(slugifyShellName("a  --  b"), "a-b");
  assert.equal(slugifyShellName("--x--"), "x");
  assert.ok(slugifyShellName("x".repeat(200)).length <= 48);
});

test("uniqueShellId：撞车加 -2/-3，总长始终 ≤ 64", () => {
  const taken = new Set();
  const first = uniqueShellId("profile", "Git Bash", taken);
  assert.equal(first, "profile:git-bash");
  taken.add(first);
  const second = uniqueShellId("profile", "Git Bash", taken);
  assert.equal(second, "profile:git-bash-2");
  taken.add(second);
  assert.equal(uniqueShellId("profile", "Git Bash", taken), "profile:git-bash-3");

  // 超长名的截断：id 总长必须 ≤ 64，且同一输入稳定。
  const longName = "x".repeat(300);
  const a = uniqueShellId("profile", longName, new Set());
  const b = uniqueShellId("profile", longName, new Set());
  assert.equal(a, b, "同一 profile 每次必须得到同一个 id");
  assert.ok(a.length <= SHELL_ID_MAX, `id 超长: ${a.length}`);
  // 撞车时的后缀也不能把长度顶破。
  const takenLong = new Set([a]);
  const c = uniqueShellId("profile", longName, takenLong);
  assert.ok(c.length <= SHELL_ID_MAX, `带后缀的 id 超长: ${c.length}`);
  assert.notEqual(c, a);
});

test("dedupeShells：同 path+args 只留第一条；不可用项（空 path）不互相吞", () => {
  const list = [
    { id: "bash", name: "bash", path: "C:\\Git\\bin\\bash.exe", args: [], available: true },
    { id: "profile:git-bash", name: "Git Bash", path: "c:\\git\\BIN\\bash.exe", args: [], available: true },
    { id: "pwsh", name: "PowerShell 7", path: "", args: ["-NoLogo"], available: false },
    { id: "powershell", name: "PowerShell 5", path: "", args: ["-NoLogo"], available: false },
    { id: "wsl:A", name: "WSL · A", path: "C:\\Windows\\System32\\wsl.exe", args: ["-d", "A"], available: true },
    { id: "wsl:B", name: "WSL · B", path: "C:\\Windows\\System32\\wsl.exe", args: ["-d", "B"], available: true },
  ];
  const out = dedupeShells(list);
  assert.deepEqual(
    out.map((item) => item.id),
    ["bash", "pwsh", "powershell", "wsl:A", "wsl:B"],
    "bash 与 profile:git-bash 的路径大小写不同但同一个 exe → 只留 bash；两个空 path 都要留",
  );
});

test("dedupeShells：id 撞车时改名（不允许两条同 id）", () => {
  const out = dedupeShells([
    { id: "profile:x", name: "X", path: "C:\\a.exe", args: [], available: true },
    { id: "profile:x", name: "X two", path: "C:\\b.exe", args: [], available: true },
  ]);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].id, out[1].id);
  for (const item of out) assert.equal(isValidShellId(item.id), true);
});
