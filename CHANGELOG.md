# Changelog

本文件记录 magpie-terminal 的显著变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.3.0 — 2026-11-28

### 破坏性变更（Breaking）

- **删除本地终端**：不再内置本机 PTY（`node-pty` 依赖与 `src/pty/` 全部模块一并移除）。终端只能连 SSH 主机使用。本机要当主机，请自行在系统里装 sshd 并作为普通主机添加。
- **删除本机文件面板**：文件面板只对已连接的主机生效。「下载到本机」保留。
- **删除 `GET /api/shells`**、**删除 `config.defaultShell`**：老配置文件里的该字段会被静默忽略，不需要手工清理，也不会报错。
- **`/api/fs/*` 只剩 `POST /api/fs/reveal`**：本机文件读写接口全部移除，文件读写一律走 `/api/hosts/:id/fs/*`。
- `GET /api/health` 不再返回 `shell` / `pty` / `nodePtyVersion`，只返回 `ok`、`version`、`port`、`sessions`。

### 平台

- 去掉唯一的原生模块后，Windows / macOS / Linux 三平台共用同一份纯 JS 实现，不需要 node-gyp、VS Build Tools 或本地编译。
- 日志目录按平台标准位置落盘（`MAGPIE_TERMINAL_LOG_DIR` 优先）：Windows 为 `%LOCALAPPDATA%\magpie\logs`，macOS 为 `~/Library/Logs/magpie`，Linux 为 `$XDG_STATE_HOME/magpie/logs`（未设则为 `~/.local/state/magpie/logs`）。

### 新增

- 三平台 CI（ubuntu / macos / windows × Node 20 / 22 / 24）。
- 终端空态改为引导添加主机：未连接任何主机时显示「添加主机」入口，不再自动创建本机会话。

## 0.2.4 — 上一个版本

（历史请见 git tag / npm 版本记录）
