// GET /api/health 的响应组装。只读，无副作用。

export function buildHealth(input) {
  const src = input && typeof input === "object" ? input : {};
  return {
    ok: true,
    version: src.version || "0.1.0",
    port: src.port,
    sessions: Number.isFinite(src.sessions) ? src.sessions : 0,
  };
}
