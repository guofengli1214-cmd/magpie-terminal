// 具名常量集中处。改这里就等于改行为，不要在别处写魔法数字。

const constants = Object.freeze({
  DEFAULT_PORT: 3480,
  WS_PATH: "/ws",
  SCROLLBACK_LINES: 5000,
  RESIZE_DEBOUNCE_MS: 150,
  // 与服务端 WARMUP_MS 对齐的输入封锁窗口。
  INPUT_LOCK_MS: 350,
  CONNECT_TIMEOUT_MS: 5000,
  RECONNECT_BASE_MS: 500,
  RECONNECT_MAX_MS: 10000,
  RECENT_OUTPUT_LINES: 40,
  RECENT_OUTPUT_CHARS: 2000,
  MIN_COLS: 20,
  MIN_ROWS: 5,
  TAB_LIMIT: 8,
  // 空输入提示（TASK-FIX17-L2：抽屉与悬浮球同一句，逐字不许改）。
  EMPTY_QUESTION_TEXT: "先说一句你想干什么。",
  // 有待确认时的门禁提示（同上，逐字）。
  BLOCKED_PENDING_TEXT: "先处理上面的待确认命令（或点停止），再问新的。",
});

export default constants;
