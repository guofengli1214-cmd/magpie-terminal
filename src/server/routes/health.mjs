// GET /api/health 的响应组装。只读，无副作用。

export function buildHealth(input) {
  const src = input && typeof input === "object" ? input : {};
  const shell = src.shell || {};
  return {
    ok: true,
    version: src.version || "0.1.0",
    port: src.port,
    shell: {
      name: shell.name || "unknown",
      version: shell.version || "unknown",
      path: shell.path || "",
      fallback: Boolean(shell.fallback),
    },
    pty: src.pty === "sentinel" ? "sentinel" : "native",
    nodePtyVersion: src.nodePtyVersion || null,
    sessions: Number.isFinite(src.sessions) ? src.sessions : 0,
  };
}
