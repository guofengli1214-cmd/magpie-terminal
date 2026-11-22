// 上下文采集：只带 cwd、shell 名与版本、最近输出（40 行 / 2000 字符）。
// 不读文件、不联网、不落盘。

export const CONTEXT_MAX_LINES = 40;
export const CONTEXT_MAX_CHARS = 2000;

export function buildContext(input) {
  const source = input && typeof input === "object" ? input : {};

  const cwd = typeof source.cwd === "string" && source.cwd ? source.cwd : "（未知）";

  let shell = "（未知）";
  if (typeof source.shell === "string" && source.shell) {
    shell = source.shell;
  } else if (source.shell && typeof source.shell === "object") {
    const name = typeof source.shell.name === "string" ? source.shell.name : "";
    const version = typeof source.shell.version === "string" ? source.shell.version : "";
    shell = [name, version].filter(Boolean).join(" ") || "（未知）";
  }

  let recentOutput = typeof source.recentOutput === "string" ? source.recentOutput : "";
  // 去 ANSI 转义，避免把控制序列塞进提示词。
  recentOutput = recentOutput.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const lines = recentOutput.split(/\r?\n/);
  if (lines.length > CONTEXT_MAX_LINES) {
    recentOutput = lines.slice(-CONTEXT_MAX_LINES).join("\n");
  }
  if (recentOutput.length > CONTEXT_MAX_CHARS) {
    recentOutput = recentOutput.slice(-CONTEXT_MAX_CHARS);
  }

  return { cwd, shell, recentOutput };
}
