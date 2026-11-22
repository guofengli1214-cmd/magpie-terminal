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
});

export default constants;
