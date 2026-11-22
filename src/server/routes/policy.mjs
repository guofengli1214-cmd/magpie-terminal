// GET /api/policy：当前白名单 / 黑名单，供 UI 展示（只读）。

import { DEFAULT_ALLOWLIST, DEFAULT_DENYLIST } from "../../policy/allowlist.mjs";

export function buildPolicy() {
  return {
    allowlist: {
      heads: [...DEFAULT_ALLOWLIST.heads],
      subcommands: Object.fromEntries(
        Object.entries(DEFAULT_ALLOWLIST.subcommands).map(([key, value]) => [key, [...value]]),
      ),
    },
    denylist: {
      heads: [...DEFAULT_DENYLIST.heads],
      subcommands: Object.fromEntries(
        Object.entries(DEFAULT_DENYLIST.subcommands).map(([key, value]) => [key, [...value]]),
      ),
    },
  };
}
