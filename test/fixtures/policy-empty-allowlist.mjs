// negative fixture：空白名单。
// 用它跑同一个 classify，`ls -la` 必须变成 confirm —— 证明分级由数据驱动。

export const EMPTY_ALLOWLIST = Object.freeze({
  heads: Object.freeze([]),
  subcommands: Object.freeze({}),
});

export default EMPTY_ALLOWLIST;
