# 编写期工作记录归档（sources）

本目录是文档编写期的工作记录归档，**不是项目事实源**。事实源是 `docs/` 下的 5 份主文档（`architecture.md`、`platform-notes.md`、`pty-notes.md`、`roadmap.md`、`security.md`）与 `.trellis/spec/` 下的 15 份规范（backend 9 份、frontend 6 份）。

| 文件 | 内容 | 行数 |
|---|---|---|
| `brief.md` | 编写期简报：当时逐条列出的事实清单，以及三阶段推进与验收的草案 | 175 |
| `pty-probe-findings.md` | 本机 PTY 探测的原始记录：Q1–Q7 的结论、三处必修坑、日志路径与原始输出 | 489 |

## 为什么保持原样

正文里存在 `F:412`、`BRIEF 2.1` 这类「行号 / 节号」引用：

- `F:行号`、`FINDINGS 6a` → `pty-probe-findings.md`
- `BRIEF §x`、`BRIEF 2.1` → `brief.md`

两份文件逐字节归档，行号与节号有意保持原样。**要改内容就必须同时改引用（全库约 105 处 BRIEF 引用，以及若干 `F:行号`），否则不要动这两个文件。**

## 来源

- 归档日期：2026-11-22
- `brief.md` ← `%LOCALAPPDATA%/hermes/cache/scratch/magpie-terminal-docs/BRIEF.md`
- `pty-probe-findings.md` ← `%LOCALAPPDATA%/hermes/cache/scratch/pty-probe/FINDINGS.md`
- 原始日志 `pty-probe/log/*.log` 未入库（体积与隐私），需要追溯时按 `F` 里记录的路径在写文档的机器上复跑。
