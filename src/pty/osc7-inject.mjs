// 把 OSC 7 注入进 shell（TASK-V4-G §5.2）——**绝不改用户的 shell 配置文件**。
//
// bash：生成临时 rc 文件（`os.tmpdir()/magpie-term-rc-<rand>/rc.sh`），
//       里面先 source 用户的 ~/.bashrc（所以用户配置一点不丢），再往
//       PROMPT_COMMAND 前面挂一个打印 OSC 7 的函数。
//       然后用 `bash --rcfile <file> -i` 启动。
// PowerShell / pwsh：不写文件，直接把 prompt 覆盖塞进 `-NoExit -Command`。
//       （实测 PowerShell 5.1 默认 ExecutionPolicy 拒绝跑临时 .ps1，见 PS1_PROMPT_COMMAND）
//
// 注入失败（写文件失败等）一律返回原始 args 并记一条日志，
// 不能因此让终端开不出来。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * bash 的 rc 正文。
 *
 * `\033]7;file://HOST/PWD\033\\` 是 OSC 7 + ST；BEL 版本也接受，这里用 ST
 * （bash 的 printf 不解释 `\e`，必须用 `\033`）。
 * `$PWD` 在 MSYS bash 里是 `/c/Users/x`，解码侧会还原成 `C:\Users\x`（见 osc7.mjs）。
 */
export const BASH_RC_BODY = [
  "# magpie-terminal 临时 rc（TASK-V4-G §5.2）：只注入 OSC 7，不写用户文件。",
  "[ -f ~/.bashrc ] && . ~/.bashrc",
  "__magpie_osc7() { printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"$PWD\"; }",
  'case "$PROMPT_COMMAND" in',
  "  *__magpie_osc7*) ;;",
  '  *) PROMPT_COMMAND="__magpie_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;',
  "esac",
  "",
].join("\n");

/**
 * PowerShell 的 prompt 覆盖（一行，多个语句用 `;` 连接）。
 *
 * **不用 .ps1 文件**：实测 PowerShell 5.1 在默认 ExecutionPolicy 下直接拒绝
 * 跑临时脚本（"在此系统上禁止运行脚本"），那就等于注入失败。`-Command` 走命令行，
 * 不受 ExecutionPolicy 限制。
 *
 * 用 `[char]27` 而不是反引号转义：后者只有 PowerShell 6+ 认，5.1 会原样输出字符 e。
 * `-replace '\','/'` 把 `C:\Users\x` 变成 `C:/Users/x`，解码侧再还原。
 */
export const PS1_PROMPT_COMMAND = [
  "$magpieE=[char]27",
  "function global:prompt{",
  "$magpieH=if($env:COMPUTERNAME){$env:COMPUTERNAME}else{'localhost'}",
  "$magpieP=((Get-Location).Path) -replace '\\\\','/'",
  "Write-Host -NoNewline ($magpieE+']7;file://'+$magpieH+'/'+$magpieP+$magpieE+'\\')",
  "'PS '+(Get-Location).Path+'> '",
  "}",
].join(";");

/** 进程退出时的兜底清理表。 */
const tempDirs = new Set();
let exitHookInstalled = false;

function ensureExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略。
      }
    }
    tempDirs.clear();
  });
}

function makeTempScript(fileName, body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "magpie-term-rc-"));
  tempDirs.add(dir);
  ensureExitHook();
  const file = path.join(dir, fileName);
  writeFileSync(file, body, { encoding: "utf8" });
  return { file, dir };
}

/** shell.id 归一（bridge.detectShell 只给 name，没有 id）。 */
export function shellKindOf(shell) {
  if (!shell) return null;
  if (typeof shell.id === "string" && shell.id.length > 0) return shell.id;
  const name = String(shell.name || "");
  if (/bash/i.test(name)) return "bash";
  if (/pwsh|powershell 7/i.test(name)) return "pwsh";
  if (/powershell/i.test(name)) return "powershell";
  return null;
}

/**
 * 生成一个「带 OSC 7 注入」的 shell 启动描述。
 *
 * @param {object} shell  {id,name,path,args}
 * @param {{log?: (entry:object)=>void}} [opts]
 * @returns {{shell: object, cleanup: () => void}} shell 是副本，args 已改写
 */
export function withOsc7Injection(shell, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const baseArgs = Array.isArray(shell && shell.args) ? shell.args.slice() : [];
  const kind = shellKindOf(shell);
  const cleanup = () => {};
  if (kind !== "bash" && kind !== "powershell" && kind !== "pwsh") {
    return { shell: { ...shell, args: baseArgs }, cleanup };
  }
  try {
    if (kind === "bash") {
      const { file, dir } = makeTempScript("rc.sh", BASH_RC_BODY);
      return {
        // `--rcfile` 必须配 `-i`：非交互 bash 不读 rcfile。
        shell: { ...shell, args: ["--rcfile", file, "-i"] },
        cleanup: () => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // 忽略。
          }
          tempDirs.delete(dir);
        },
      };
    }
    // -NoLogo 保留原样；追加 -NoExit -Command，跑完命令继续交互
    // （用户的 $PROFILE 仍由 PowerShell 自己加载，我们不碰它）。
    return {
      shell: { ...shell, args: [...baseArgs, "-NoExit", "-Command", PS1_PROMPT_COMMAND] },
      cleanup,
    };
  } catch (err) {
    // 注入失败不能崩：退回原始参数，只是 cwd 不会跟随。
    log({
      level: "warn",
      code: "OSC7_INJECT_FAILED",
      msg: "osc7 injection failed, falling back to plain args",
      shell: kind,
      reason: err && err.message ? err.message : String(err),
    });
    return { shell: { ...shell, args: baseArgs }, cleanup };
  }
}

/** 给测试用：当前临时目录数（验证退出时确实清掉了）。 */
export function pendingTempDirs() {
  return [...tempDirs];
}
