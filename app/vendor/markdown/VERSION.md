# markdown 渲染库本地副本（TASK-FIX17-D R5）

| 文件 | 大小（约） | 形态 | 全局名 |
|---|---|---|---|
| `marked.umd.js` | 98 KB | UMD（普通 `<script>`） | `window.marked` |
| `purify.min.js` | 30 KB | UMD（普通 `<script>`） | `window.DOMPurify` |
| `markdown.js` | 5 KB | 本项目封装（ES 模块） | `default` / 具名导出 |

## 来源与版本

| 包 | 版本 | 许可 | 包内路径 | 落地文件 |
|---|---|---|---|---|
| `marked` | **12.0.2** | **MIT** | `package/lib/marked.umd.js` | `marked.umd.js` |
| `dompurify` | **3.5.0** | **Apache-2.0 OR MPL-2.0** | `package/dist/purify.min.js` | `purify.min.js` |

- 来源：**npm registry**（`https://registry.npmjs.org/`），用 `npm pack` 取 tarball 后解包。
  本地 GitHub release CDN 整段不可达，所以不用 GitHub 下载。
- tarball 校验（sha256，落地时实测一致）：

  | tarball | 大小 | sha256 |
  |---|---|---|
  | `marked-12.0.2.tgz` | 166.1 KB | `6cfd2d09c6bce2541558a1547e5f3b9895ed743f0d287536ff2280e318e8a074` |
  | `dompurify-3.5.0.tgz` | 330.0 KB | `faa5f2bfe2814384b83d6edb4ed66812fbfdb2a654b4d59edd4b12304058ec20` |

- `package.json` 的 `dependencies` **不含**这两个包：它们是 vendor 文件，不进依赖树（R5 明确要求）。
  静态服务已放行 `/vendor/`（`src/server/static.mjs` 的 `STATIC_PREFIXES`），无需改服务端。

## 使用方式（`app/` 内）

```html
<!-- index.html：普通 script（不是 module），必须在 app.js 之前 -->
<script src="/vendor/markdown/marked.umd.js"></script>
<script src="/vendor/markdown/purify.min.js"></script>
<script type="module" src="/app.js"></script>
```

```js
// app/ui/ai-drawer.js
import { renderMarkdown } from "/vendor/markdown/markdown.js";
const html = renderMarkdown(text); // 失败返回 null，调用方降级成纯文本
```

执行顺序：两个 UMD 脚本是同步 `<script>`，在 `type="module"` 的 `app.js` 之前执行，
所以 `markdown.js` 里可以假定 `globalThis.marked` / `globalThis.DOMPurify` 已就绪；
仍然保留「不存在就返回 null」的分支（离线文件缺失时不白屏，AI 消息降级成纯文本）。

## 升级规则

- 替换文件时必须同时更新本文件的版本号与 sha256，并单独提交，不与功能改动混在一起。
- 不要使用 `latest`，不要在 URL 上加 `?v=` 缓存穿透参数。
- 升级后必须重跑 `node scripts/probe-drawer.mjs`（AC8/AC9 的 XSS 三例挂在 DOM 契约上）
  与 `node --test` 里 `test/app/markdown.test.mjs` 的那组断言。
