# xterm.js 本地副本

| 文件 | 大小（约） | 形态 |
|---|---|---|
| `xterm.js` | 477 KB | UMD，挂到全局 `Terminal` |
| `xterm.css` | 6.9 KB | 样式 |
| `addon-fit.js` | 1.5 KB | UMD，挂到全局 `FitAddon` |

## 来源与版本

- 已由任务方随仓库提供（`app/vendor/xterm/`），**不要重新下载、不要修改这三个文件**。
- 版本号未由提供方显式标注；按文件体积与 API（`Terminal`、`FitAddon.FitAddon`、`terminal.options.scrollback`、
  `terminal._core._renderService.dimensions.css.cell`）判定为 xterm.js 5.x 的 UMD 构建。
- `addon-fit.js` 的 `proposeDimensions()` 使用 `terminal._core._renderService.dimensions.css.cell` 与
  `terminal.options.overviewRuler`，与 xterm.js 5.3+ 的实现一致。

## 使用方式（`app/` 内）

```html
<link rel="stylesheet" href="/vendor/xterm/xterm.css">
<script src="/vendor/xterm/xterm.js"></script>
<script src="/vendor/xterm/addon-fit.js"></script>
```

```js
const term = new Terminal({ /* … */ });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
```

## 升级规则

- 替换文件时必须同时更新本文件的版本说明，并单独提交，不与功能改动混在一起。
- 不要使用 `latest`，不要在 URL 上加 `?v=` 缓存穿透参数。
