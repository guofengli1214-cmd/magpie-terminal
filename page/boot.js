// 带路页：把宿主页面导航到本插件的服务。
//
// 这个页面跑在 sandbox="allow-scripts" 的 iframe 里，CSP 是 default-src 'none'
// 且 connect-src 没有单列，所以任何脚本发起的网络请求都会被静默拒绝。
// 唯一能做的联网动作是 location.replace()。因此这里「直接跳」，不探测服务是否活着。
//
// 主题令牌的交接（TASK-FIX17-B R1）：
//   ① 带路页的 CSP 是 `default-src 'none'`，fetch / XHR / WebSocket **全部不可用**
//     （连 no-cors 都被静默拒绕），所以 boot 页**不能**自己 POST 令牌给服务。
//     能做的只有把令牌放进跳转 URL 的 query。服务端在 `GET /` 里把这份令牌
//     顺手存进进程内缓存（`bridgeTheme`），`GET /api/theme` 就靠它 + 现读的
//     `~/.config/magpie/settings.json` 合成主题。这样 magpie 改主题后页面
//     **不刷新**也能跟（app.js 轮询 /api/theme）。
//   ② query 的 `theme` / `tokens` 同时也用于首屏注入，不能等到 JS 跑起来。
//   ③ `onTheme` 照旧注册：bridge 会 push `theme` 事件。但它只能影响
//     **下一次**跳转（跳转后 window.magpie 就没了），所以里面只改内存变量。
(async () => {
  const DEFAULT_PORT = 3480;
  const HTTP_PREFIX = "http" + "://";
  const RETRY_DELAY_MS = 5000;

  let port = DEFAULT_PORT;
  let theme = "";
  let tokens = null;
  let service = "";

  // 第一件事：等 bridge 握手，否则宿主 10 秒后判「页面已停止工作」。
  try {
    const ready = await window.magpie?.ready;
    if (ready) {
      if (typeof ready.dark === "boolean") theme = ready.dark ? "dark" : "light";
      if (ready.tokens && typeof ready.tokens === "object") tokens = ready.tokens;
    }
  } catch {
    // 没有 bridge 就退回默认主题。
  }

  // magpie 运行中换主题时 bridge 会 push `theme` 事件：改写待跳转的令牌，
  // 下一次（重试 / 重开）就带上最新的那一套。不要指望它能穿过跳转。
  try {
    window.magpie?.onTheme?.((next) => {
      if (!next || typeof next !== "object") return;
      if (typeof next.dark === "boolean") theme = next.dark ? "dark" : "light";
      if (next.tokens && typeof next.tokens === "object") tokens = next.tokens;
    });
  } catch {
    // 旧版 magpie 没有 onTheme：不影响跳转。
  }

  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && s.indexOf(HTTP_PREFIX) === 0) service = s;
  } catch {
    // 旧版 magpie 没有 service。
  }

  try {
    const o = await window.magpie?.options?.get?.();
    if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port);
  } catch {
    // 没有 options 就用默认端口。
  }

  const query = new URLSearchParams();
  if (theme) query.set("theme", theme);

  // 只带非空令牌；base64 前先 encodeURIComponent，避免非 Latin-1 字符抛异常。
  const slim = {};
  for (const [key, value] of Object.entries(tokens || {})) {
    const text = String(value ?? "").trim();
    if (text) slim[key] = text;
  }
  if (Object.keys(slim).length > 0) {
    try {
      query.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim)))));
    } catch {
      // 编码不了就只带主题。
    }
  }

  // 把令牌交给自己的服务：带路页的 CSP 不允许任何网络请求（`default-src 'none'`，
  // fetch / XHR / WS 全部静默失败），所以这里**不发请求**，令牌只走 query；
  // 服务端在 `GET /` 里把它存进进程内缓存。保留这段注释是为了不让下一个人
  // 再试一次「在 boot.js 里 POST」—— 那样只会静默失败。

  function said() {
    return document.getElementById("said");
  }

  function armTimeout(p) {
    setTimeout(function () {
      const box = said();
      if (!box) return;
      box.textContent = "本地终端服务没有在运行（127.0.0.1:" + p + "）";
      if (document.getElementById("boot-retry")) return;
      const btn = document.createElement("button");
      btn.id = "boot-retry";
      btn.type = "button";
      btn.textContent = "重试";
      btn.addEventListener("click", function () {
        location.reload();
      });
      box.parentNode.appendChild(btn);
    }, RETRY_DELAY_MS);
  }

  // magpie web 会在自己的地址上转发本服务；有就优先用（远程场景）。
  if (service) {
    armTimeout(port);
    location.replace(service + "?" + query.toString());
    return;
  }

  const target = "http://127.0.0.1:" + port + "/?" + query.toString();

  // 非 loopback 打开时 127.0.0.1 指向的是「看页面那台机器」，服务不在那儿。
  if (!isLoopback(location.hostname)) {
    showRemote(port, target);
    return;
  }

  armTimeout(port);
  location.replace(target);
})();

function isLoopback(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "" || h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);
}

function showRemote(port, target) {
  const box = document.getElementById("said");
  const hint = document.getElementById("hint");
  if (!box) return;
  const host = location.hostname.replace(/^\[|\]$/g, "");
  box.textContent = "";

  const line = (text) => {
    const el = document.createElement("p");
    el.textContent = text;
    box.appendChild(el);
    return el;
  };

  line("终端服务只在运行 magpie 的那台机器上监听 127.0.0.1:" + port + "，从这台电脑连不到它。");
  line("请在本机开一个 SSH 端口转发，然后点「继续」：");
  const code = line("ssh -N -L " + port + ":127.0.0.1:" + port + " <用户名>@" + host);
  const codeEl = document.createElement("code");
  codeEl.textContent = code.textContent;
  code.textContent = "";
  code.appendChild(codeEl);

  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "继续";
  go.addEventListener("click", () => location.replace(target));
  if (hint) hint.appendChild(go);
}
