// TASK-FIX17-G R1：安装方式判定（local-path / registry / unknown）。
//
// 硬约束：绝不读写真实的 ~/.config/magpie/plugins.json。
// 每个用例都把 `pluginsPath` 指到 mkdtemp 下的临时文件（或直接传纯函数数组）。

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  DEFAULT_PLUGIN_NAME,
  INSTALL_KINDS,
  PLUGINS_PATH_ENV,
  PLUGIN_ROOT,
  detectInstallKind,
  isLocalPathSpec,
  pluginsPath,
  resolveInstallKindFromPlugins,
  splitSpec,
} from "../../src/config/install-kind.mjs";

async function withTempPlugins(content, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fix17g-kind-"));
  const file = path.join(dir, "plugins.json");
  if (content !== undefined) {
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }
  try {
    return await fn({ dir, file });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("INSTALL_KINDS 只包含三种取值", () => {
  assert.deepEqual([...INSTALL_KINDS], ["local-path", "registry", "unknown"]);
});

test("isLocalPathSpec：盘符 / 正斜杠 / UNC 都算裸路径，npm spec 不算", () => {
  assert.equal(isLocalPathSpec("C:\\Users\\me\\repo"), true);
  assert.equal(isLocalPathSpec("C:/Users/me/repo"), true);
  assert.equal(isLocalPathSpec("/opt/repo"), true);
  assert.equal(isLocalPathSpec("\\\\server\\share\\repo"), true);
  assert.equal(isLocalPathSpec("//server/share/repo"), true);
  assert.equal(isLocalPathSpec("magpie-terminal@latest"), false);
  assert.equal(isLocalPathSpec("@scope/name@1.2.3"), false);
  assert.equal(isLocalPathSpec(undefined), false);
});

test("splitSpec：scoped 包的前导 @ 不是版本分隔符", () => {
  assert.deepEqual(splitSpec("@scope/name@1.2.3"), {
    name: "@scope/name",
    range: "1.2.3",
    hasVersion: true,
  });
  assert.deepEqual(splitSpec("magpie-terminal@^0.1.0"), {
    name: "magpie-terminal",
    range: "^0.1.0",
    hasVersion: true,
  });
  assert.deepEqual(splitSpec("@scope/name"), { name: "@scope/name", range: "", hasVersion: false });
  assert.equal(splitSpec(""), null);
});

test("纯函数：裸路径 spec 指向本插件根目录 → local-path（三种路径写法）", () => {
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: "C:\\Users\\me\\repo" }], {
      pluginRoot: "C:\\Users\\me\\repo",
    }),
    "local-path",
  );
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: "/opt/repo" }], { pluginRoot: "/opt/repo" }),
    "local-path",
  );
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: "\\\\server\\share\\repo" }], {
      pluginRoot: "\\\\server\\share\\repo",
    }),
    "local-path",
  );
});

test("纯函数：多条裸路径且都不等于本插件根目录 → unknown（不能乱认）", () => {
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: "C:\\Users\\me\\other-plugin" }, { spec: "D:\\another" }], {
      pluginRoot: "C:\\Users\\me\\repo",
    }),
    "unknown",
  );
});

test("纯函数：唯一一条 spec 时按形状判定（测试夹具 / 新装环境）", () => {
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: "C:\\tmp\\any-plugin-dir" }], {
      pluginRoot: "C:\\Users\\me\\repo",
    }),
    "local-path",
  );
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: "someone-else@1.2.3" }], {
      pluginRoot: "C:\\Users\\me\\repo",
    }),
    "registry",
  );
});

test("纯函数：本插件是文件里唯一的裸路径（其它都是 registry）→ local-path", () => {
  assert.equal(
    resolveInstallKindFromPlugins(
      [
        { spec: "page-chat@latest" },
        { spec: "C:\\tmp\\another-local-plugin" },
        { spec: "page-agent-console@1.3.9" },
      ],
      { pluginRoot: "C:\\Users\\me\\repo" },
    ),
    "local-path",
  );
});

test("纯函数：带版本的本插件 spec → registry（含 scoped 形态）", () => {
  const root = "C:\\Users\\me\\repo";
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: `${DEFAULT_PLUGIN_NAME}@latest` }], { pluginRoot: root }),
    "registry",
  );
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: `${DEFAULT_PLUGIN_NAME}@^0.1.0` }], { pluginRoot: root }),
    "registry",
  );
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: `@magpie-community/${DEFAULT_PLUGIN_NAME}@1.2.3` }], {
      pluginRoot: root,
    }),
    "registry",
  );
});

test("纯函数：多条 registry 但都不是本插件 / 无版本 spec / 空输入 → unknown", () => {
  const root = "C:\\Users\\me\\repo";
  assert.equal(
    resolveInstallKindFromPlugins(
      [{ spec: "page-chat@latest" }, { spec: "page-agent-console@1.3.9" }],
      { pluginRoot: root },
    ),
    "unknown",
  );
  assert.equal(
    resolveInstallKindFromPlugins([{ spec: DEFAULT_PLUGIN_NAME }], { pluginRoot: root }),
    "unknown",
  );
  assert.equal(resolveInstallKindFromPlugins(null, { pluginRoot: root }), "unknown");
  assert.equal(resolveInstallKindFromPlugins([], { pluginRoot: root }), "unknown");
  assert.equal(resolveInstallKindFromPlugins([{ spec: "" }], { pluginRoot: root }), "unknown");
});

test("detectInstallKind：真实结构 {plugins:[…]} 且 spec 是磁盘上的本插件目录 → local-path", async () => {
  await withTempPlugins(
    { plugins: [{ spec: "C:\\Users\\me\\other", options: {} }, { spec: PLUGIN_ROOT }] },
    async ({ file }) => {
      assert.equal(await detectInstallKind({ pluginsPath: file }), "local-path");
    },
  );
});

test("detectInstallKind：registry spec → registry；外层直接是数组也支持", async () => {
  await withTempPlugins([{ spec: `${DEFAULT_PLUGIN_NAME}@latest` }], async ({ file }) => {
    assert.equal(await detectInstallKind({ pluginsPath: file }), "registry");
  });
});

test("detectInstallKind：临时文件只有一条任意裸路径 → local-path（不依赖真实根目录）", async () => {
  await withTempPlugins({ plugins: [{ spec: "C:\\tmp\\some-plugin-dir" }] }, async ({ file }) => {
    assert.equal(await detectInstallKind({ pluginsPath: file }), "local-path");
  });
});

test("detectInstallKind：文件缺失 / JSON 损坏 / 结构不对 → unknown（永不抛）", async () => {
  await withTempPlugins(undefined, async ({ file }) => {
    assert.equal(await detectInstallKind({ pluginsPath: file }), "unknown");
  });
  await withTempPlugins("{ not json", async ({ file }) => {
    assert.equal(await detectInstallKind({ pluginsPath: file }), "unknown");
  });
  await withTempPlugins({ plugins: "nope" }, async ({ file }) => {
    assert.equal(await detectInstallKind({ pluginsPath: file }), "unknown");
  });
});

test("detectInstallKind：MAGPIE_PLUGINS_PATH 环境变量覆盖默认路径（测试隔离用）", async () => {
  await withTempPlugins({ plugins: [{ spec: `${DEFAULT_PLUGIN_NAME}@latest` }] }, async ({ file }) => {
    const previous = process.env[PLUGINS_PATH_ENV];
    process.env[PLUGINS_PATH_ENV] = file;
    try {
      assert.equal(pluginsPath(), path.resolve(file));
      assert.equal(await detectInstallKind(), "registry");
    } finally {
      if (previous === undefined) delete process.env[PLUGINS_PATH_ENV];
      else process.env[PLUGINS_PATH_ENV] = previous;
    }
  });
});

test("detectInstallKind：显式 pluginsPath 优先于环境变量", async () => {
  await withTempPlugins({ plugins: [{ spec: `${DEFAULT_PLUGIN_NAME}@latest` }] }, async ({ file: registryFile }) => {
    await withTempPlugins({ plugins: [{ spec: PLUGIN_ROOT }] }, async ({ file: localFile }) => {
      const previous = process.env[PLUGINS_PATH_ENV];
      process.env[PLUGINS_PATH_ENV] = registryFile;
      try {
        assert.equal(await detectInstallKind({ pluginsPath: localFile }), "local-path");
      } finally {
        if (previous === undefined) delete process.env[PLUGINS_PATH_ENV];
        else process.env[PLUGINS_PATH_ENV] = previous;
      }
    });
  });
});
