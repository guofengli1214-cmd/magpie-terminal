// TASK-FIX17-G R1/R3：版本比较 + GitHub 更新检查（纯函数，全部注入）。
//
// 硬约束：单测**绝不真连 GitHub**。`fetchImpl` 与时钟都由用例传入；
// 缓存用每个用例自己的 Map，避免跨用例串味。

import test from "node:test";
import assert from "node:assert/strict";
import {
  UPDATE_CACHE_TTL_MS,
  checkForUpdate,
  compareSemver,
  normalizeRepository,
} from "../../src/config/update-check.mjs";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

test("compareSemver：数字段比较 / v 前缀 / 构建元数据", () => {
  assert.equal(compareSemver("0.1.0", "0.1.0"), 0);
  assert.equal(compareSemver("v0.1.0", "0.1.0"), 0);
  assert.equal(compareSemver("0.1.1", "0.1.0"), 1);
  assert.equal(compareSemver("0.1.0", "0.1.1"), -1);
  assert.equal(compareSemver("0.2.0", "0.1.9"), 1);
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
  assert.equal(compareSemver("0.1", "0.1.0"), 0);
  assert.equal(compareSemver("0.1.0+build.7", "0.1.0"), 0);
});

test("compareSemver：预发布后缀按字符串比，无后缀的一侧更大", () => {
  assert.equal(compareSemver("0.1.0-beta", "0.1.0"), -1);
  assert.equal(compareSemver("0.1.0", "0.1.0-beta"), 1);
  assert.equal(compareSemver("0.1.0-beta", "0.1.0-beta"), 0);
  assert.equal(compareSemver("0.1.0-beta", "0.1.0-alpha"), 1);
});

test("compareSemver：非法输入不抛，按 0 段处理", () => {
  assert.equal(compareSemver("", ""), 0);
  assert.equal(compareSemver("x", "0.0.0"), 0);
  assert.equal(compareSemver(null, "0.0.0"), 0);
});

test("normalizeRepository：字符串 / {type,url} / git 写法都归一成 https", () => {
  assert.equal(normalizeRepository("https://github.com/o/r").url, "https://github.com/o/r");
  assert.equal(normalizeRepository("https://github.com/o/r.git").url, "https://github.com/o/r");
  assert.equal(
    normalizeRepository({ type: "git", url: "git+https://github.com/o/r.git" }).url,
    "https://github.com/o/r",
  );
  assert.equal(normalizeRepository("git@github.com:o/r.git").url, "https://github.com/o/r");
  assert.equal(normalizeRepository("github:o/r").url, "https://github.com/o/r");
  assert.equal(normalizeRepository("o/r").url, "https://github.com/o/r");
  assert.equal(normalizeRepository("ssh://git@github.com/o/r.git").url, "https://github.com/o/r");
});

test("normalizeRepository：GitHub 才给 owner/repo；非 GitHub / 非法值不冒充", () => {
  const github = normalizeRepository("https://github.com/o/r");
  assert.deepEqual({ owner: github.owner, repo: github.repo, github: github.github }, {
    owner: "o",
    repo: "r",
    github: true,
  });
  const gitlab = normalizeRepository("https://gitlab.com/o/r");
  assert.equal(gitlab.github, false);
  assert.equal(gitlab.owner, null);
  assert.equal(normalizeRepository(null), null);
  assert.equal(normalizeRepository({}), null);
  assert.equal(normalizeRepository("not a url"), null);
  assert.equal(normalizeRepository("file:///C:/repo"), null);
});

test("checkForUpdate：local-path 不发网络请求，返回 note（不是 error）", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("local-path 绝不该发请求");
  });
  const result = await checkForUpdate({
    repository: "https://github.com/o/r",
    installKind: "local-path",
    currentVersion: "0.1.0",
    fetchImpl,
    cache: new Map(),
  });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latest, null);
  assert.equal(result.error, undefined);
  assert.match(result.note, /git pull/);
  assert.match(result.note, /重启 magpie/);
});

test("checkForUpdate：unknown / 无 repository / 非 GitHub 都给 error 且不联网", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ tag_name: "v9.9.9" }));
  const unknown = await checkForUpdate({ installKind: "unknown", fetchImpl, cache: new Map() });
  assert.equal(unknown.hasUpdate, false);
  assert.match(unknown.error, /无法判断安装方式/);

  const noRepo = await checkForUpdate({ installKind: "registry", fetchImpl, cache: new Map() });
  assert.equal(noRepo.hasUpdate, false);
  assert.match(noRepo.error, /未配置仓库地址/);

  const gitlab = await checkForUpdate({
    repository: "https://gitlab.com/o/r",
    installKind: "registry",
    currentVersion: "0.1.0",
    fetchImpl,
    cache: new Map(),
  });
  assert.equal(gitlab.hasUpdate, false);
  assert.match(gitlab.error, /不在 GitHub/);

  assert.equal(fetchImpl.calls.length, 0);
});

test("checkForUpdate：registry + GitHub → 调 releases/latest，解析 latest / hasUpdate / url", async () => {
  const fetchImpl = fakeFetch((url) => {
    assert.equal(url, "https://api.github.com/repos/o/r/releases/latest");
    return jsonResponse({
      tag_name: "v0.2.0",
      html_url: "https://github.com/o/r/releases/tag/v0.2.0",
    });
  });
  const result = await checkForUpdate({
    repository: { type: "git", url: "https://github.com/o/r.git" },
    installKind: "registry",
    currentVersion: "0.1.0",
    fetchImpl,
    cache: new Map(),
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(result.current, "0.1.0");
  assert.equal(result.latest, "0.2.0");
  assert.equal(result.hasUpdate, true);
  assert.equal(result.url, "https://github.com/o/r/releases/tag/v0.2.0");
  assert.equal(result.error, undefined);
  // 请求必须带 UA（GitHub 会拒绝没有 UA 的客户端），且不能塞 token。
  assert.equal(fetchImpl.calls[0].init.headers["user-agent"], "magpie-terminal");
  assert.equal(fetchImpl.calls[0].init.headers.authorization, undefined);
});

test("checkForUpdate：同版本 → hasUpdate:false，note 为空（由 UI 显示「已是最新」）", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ tag_name: "v0.1.0" }));
  const result = await checkForUpdate({
    repository: "https://github.com/o/r",
    installKind: "registry",
    currentVersion: "0.1.0",
    fetchImpl,
    cache: new Map(),
  });
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latest, "0.1.0");
  assert.equal(result.note, "");
  assert.equal(result.error, undefined);
});

test("checkForUpdate：没有 html_url 时自己拼发布页地址，且 tag 做 URL 编码", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ tag_name: "v0.3.0-beta 1" }));
  const result = await checkForUpdate({
    repository: "https://github.com/o/r",
    installKind: "registry",
    currentVersion: "0.1.0",
    fetchImpl,
    cache: new Map(),
  });
  assert.equal(result.url, "https://github.com/o/r/releases/tag/v0.3.0-beta%201");
});

test("checkForUpdate：404 / 403 / 5xx 都翻成人话，绝不回 stack", async () => {
  const cases = [
    { status: 404, pattern: /找不到这个仓库|没有发布版本/ },
    { status: 403, pattern: /访问受限|限流/ },
    { status: 500, pattern: /暂时不可用/ },
  ];
  for (const item of cases) {
    const fetchImpl = fakeFetch(() => jsonResponse({ message: "nope" }, item.status));
    const result = await checkForUpdate({
      repository: "https://github.com/o/r",
      installKind: "registry",
      currentVersion: "0.1.0",
      fetchImpl,
      cache: new Map(),
    });
    assert.equal(result.hasUpdate, false);
    assert.match(result.error, item.pattern);
    assert.equal(result.stack, undefined);
    assert.equal(String(result.error).includes("    at "), false, "error 里不能有 stack");
  }
});

test("checkForUpdate：超时 / 网络错误 / 响应不是 JSON 都降级成 error", async () => {
  const timeoutFetch = fakeFetch(() => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  });
  const timeout = await checkForUpdate({
    repository: "https://github.com/o/r",
    installKind: "registry",
    currentVersion: "0.1.0",
    fetchImpl: timeoutFetch,
    cache: new Map(),
  });
  assert.equal(timeout.hasUpdate, false);
  assert.match(timeout.error, /超时/);

  const networkFetch = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const network = await checkForUpdate({
    repository: "https://github.com/o/r",
    installKind: "registry",
    currentVersion: "0.1.0",
    fetchImpl: networkFetch,
    cache: new Map(),
  });
  assert.equal(network.hasUpdate, false);
  assert.match(network.error, /网络错误/);

  const badJsonFetch = fakeFetch(
    () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
  );
  const badJson = await checkForUpdate({
    repository: "https://github.com/o/r",
    installKind: "registry",
    currentVersion: "0.1.0",
    fetchImpl: badJsonFetch,
    cache: new Map(),
  });
  assert.equal(badJson.hasUpdate, false);
  assert.match(badJson.error, /无法解析/);
});

test("checkForUpdate：成功结果缓存 5 分钟；过期后重新请求", async () => {
  let clock = 1000;
  let count = 0;
  const fetchImpl = fakeFetch(() => {
    count += 1;
    return jsonResponse({ tag_name: "v0.2.0" });
  });
  const cache = new Map();
  const options = {
    repository: "https://github.com/o/r",
    installKind: "registry",
    currentVersion: "0.1.0",
    fetchImpl,
    cache,
    now: () => clock,
  };

  const first = await checkForUpdate(options);
  assert.equal(first.hasUpdate, true);
  assert.equal(count, 1);

  const second = await checkForUpdate(options);
  assert.equal(second.hasUpdate, true);
  assert.equal(count, 1, "5 分钟内必须复用缓存");

  clock += UPDATE_CACHE_TTL_MS - 1;
  await checkForUpdate(options);
  assert.equal(count, 1, "TTL 边界前一毫秒仍是缓存");

  clock += 1;
  await checkForUpdate(options);
  assert.equal(count, 2, "TTL 到期必须重新请求");
});

test("checkForUpdate：失败结果也缓存（避免狂点打爆 GitHub），但仍是人话错误", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({}, 404));
  const cache = new Map();
  const options = {
    repository: "https://github.com/o/r",
    installKind: "registry",
    currentVersion: "0.1.0",
    fetchImpl,
    cache,
    now: () => 0,
  };
  const first = await checkForUpdate(options);
  const second = await checkForUpdate(options);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(first.error, /找不到这个仓库/);
  assert.deepEqual(second, first);
});
