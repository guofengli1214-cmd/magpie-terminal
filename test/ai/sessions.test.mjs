// AI 会话存储的行为锁（TASK-V4-H §5.1 / AC2）。
//
// 全部在临时目录里跑：绝不碰真的 ~/.config/magpie-terminal/ai-sessions/。

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  MAX_MESSAGES,
  MAX_SESSIONS,
  TRIM_KEEP_MESSAGES,
  createSessionStore,
  titleFromQuestion,
  trimSession,
} from "../../src/ai/sessions.mjs";

/**
 * 跑一段用例。
 *
 * `opts.now` 是 store 暴露给测试的注入点（src/ai/sessions.mjs 的 createSessionStore 的
 * `opts.now`，注释写明「仅供测试」）。需要断言 updatedAt 先后顺序的用例必须用它，
 * 不能靠 `setTimeout(12)` 等真实时钟：CI runner 上时钟可能被容器暂停/回拨，两个会话
 * 会拿到同一个 `Date.now()`，排序退化成 readdir 顺序，用例随机变红
 * （ubuntu-latest / node 24 上 46057939357 就是这样红过一次）。
 */
async function withStore(fn, opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mt-ai-sessions-"));
  const store = createSessionStore({ dir, log: () => {}, ...opts });
  return fn({ store, dir });
}

test("createSession 落盘：目录 700、文件 600、原子写不留 .tmp", async () => {
  await withStore(async ({ store, dir }) => {
    const session = await store.createSession({
      terminalId: "t1",
      terminalKind: "local",
      shell: "bash 5.2.37",
      title: "第一个会话",
    });
    assert.match(session.id, /^s-[0-9a-f]{8}$/);
    // Windows 上 chmod 语义有限，只在 POSIX 断言 mode（与 test/config/store.test.mjs 同一口径）。
    if (process.platform !== "win32") {
      const dirMode = (await stat(dir)).mode & 0o777;
      assert.equal(dirMode, 0o700, `目录权限应为 700，实际 ${dirMode.toString(8)}`);
      const file = path.join(dir, `${session.id}.json`);
      const fileMode = (await stat(file)).mode & 0o777;
      assert.equal(fileMode, 0o600, `文件权限应为 600，实际 ${fileMode.toString(8)}`);
    }
    const names = await readdir(dir);
    assert.deepEqual(
      names.filter((name) => name.includes(".tmp")),
      [],
      "写完不该留下临时文件",
    );
  });
});

test("写入后回读：消息、步骤、归属字段都在", async () => {
  await withStore(async ({ store }) => {
    const created = await store.createSession({
      terminalId: "t9",
      terminalKind: "remote",
      shell: "ssh deploy@10.0.4.21",
      hostId: "h-abc",
      hostName: "prod-web-01",
      hostAddr: "10.0.4.21",
    });
    await store.appendMessage(created.id, { role: "user", text: "看看磁盘", round: 1 });
    await store.appendMessage(created.id, {
      role: "assistant",
      text: "根分区用了 71%",
      reasoning: "先 df -h 再看最大的目录",
      round: 1,
    });
    await store.upsertStep(created.id, {
      stepId: "st1",
      command: "df -h",
      decision: "auto",
      status: "done",
      output: "/dev/sda1 71%",
      startedAt: 1000,
      endedAt: 1200,
      round: 1,
    });

    const back = await store.getSession(created.id);
    assert.equal(back.title, "看看磁盘");
    assert.equal(back.terminalKind, "remote");
    assert.equal(back.hostName, "prod-web-01");
    assert.equal(back.hostAddr, "10.0.4.21");
    assert.deepEqual(
      back.messages.map((item) => item.role),
      ["user", "assistant"],
    );
    assert.equal(back.messages[1].reasoning, "先 df -h 再看最大的目录");
    assert.equal(back.steps.length, 1);
    assert.equal(back.steps[0].command, "df -h");
    assert.equal(back.steps[0].endedAt, 1200);
  });
});

test("listSessions 只回摘要（不含 messages/steps），按 updatedAt 倒序，current 标记正确", async () => {
  // 用固定步进的注入时钟，不依赖真实时间（setTimeout 在 CI 上会拿到并列 timestamp，
  // 排序退化成 readdir 顺序 → 随机红）。这里让每次 now() 前进 1000ms，顺序确定可断言。
  let clock = 1_000_000;
  const stepNow = () => (clock += 1000);
  await withStore(async ({ store }) => {
    const a = await store.createSession({ terminalId: "t1", title: "A" });
    const b = await store.createSession({ terminalId: "t1", title: "B" });
    await store.appendMessage(a.id, { role: "user", text: "你好" });

    const list = await store.listSessions({ currentId: a.id });
    assert.equal(list.length, 2);
    assert.equal(list[0].id, a.id, "最近更新的排前面");
    assert.equal(list[0].current, true);
    assert.equal(list[1].current, false);
    assert.equal(typeof list[0].messageCount, "number");
    assert.equal(list[0].messageCount, 1);
    for (const item of list) {
      assert.equal(item.messages, undefined, "摘要里不许出现全文");
      assert.equal(item.steps, undefined);
    }
    assert.ok(b.id);
  }, { now: stepNow });
});

test("findByTerminal 找该终端最近的会话，没有就 null", async () => {
  // 同上：并列 timestamp 会让「最近」退化成 readdir 顺序，用注入时钟把顺序钉死。
  let clock = 2_000_000;
  const stepNow = () => (clock += 1000);
  await withStore(async ({ store }) => {
    assert.equal(await store.findByTerminal("t-x"), null);
    const first = await store.createSession({ terminalId: "t-x", title: "旧" });
    const second = await store.createSession({ terminalId: "t-x", title: "新" });
    const found = await store.findByTerminal("t-x");
    assert.equal(found.id, second.id);
    assert.notEqual(found.id, first.id);
    assert.equal(await store.findByTerminal(""), null);
  }, { now: stepNow });
});

test("renameSession 改标题，空标题与超长都归一", async () => {
  await withStore(async ({ store }) => {
    const session = await store.createSession({ terminalId: "t1" });
    const renamed = await store.renameSession(session.id, "  修 PTY 尺寸同步  ");
    assert.equal(renamed.title, "修 PTY 尺寸同步");
    assert.equal(await store.renameSession(session.id, "   "), null, "空标题不写");
    const long = "长".repeat(120);
    const capped = await store.renameSession(session.id, long);
    assert.equal(capped.title.length, 80);
  });
});

test("deleteSession 删掉文件；未知 id 回 SESSION_NOT_FOUND", async () => {
  await withStore(async ({ store, dir }) => {
    const session = await store.createSession({ terminalId: "t1" });
    const ok = await store.deleteSession(session.id);
    assert.equal(ok.ok, true);
    assert.equal(await store.getSession(session.id), null);
    assert.deepEqual(await readdir(dir), []);
    const missing = await store.deleteSession("s-doesnotexist");
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "SESSION_NOT_FOUND");
  });
});

test("deleteSession：正在跑的会话拒绝 SESSION_BUSY，文件留着", async () => {
  await withStore(async ({ store }) => {
    const session = await store.createSession({ terminalId: "t1" });
    store.markBusy(session.id, true);
    assert.equal(store.isBusy(session.id), true);
    const denied = await store.deleteSession(session.id);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "SESSION_BUSY");
    assert.ok(await store.getSession(session.id), "忙会话不能被删");
    store.markBusy(session.id, false);
    const ok = await store.deleteSession(session.id);
    assert.equal(ok.ok, true);
  });
});

test("并发写同一会话要串行：20 条追加不丢、不交错覆盖", async () => {
  await withStore(async ({ store }) => {
    const session = await store.createSession({ terminalId: "t1" });
    await Promise.all(
      Array.from({ length: 20 }, (_item, index) =>
        store.appendMessage(session.id, { role: "user", text: `第 ${index} 条`, round: 1 }),
      ),
    );
    const back = await store.getSession(session.id);
    assert.equal(back.messages.length, 20, `并发追加丢了消息：${back.messages.length}`);
    const texts = back.messages.map((item) => item.text);
    assert.equal(new Set(texts).size, 20, "有重复消息说明写交错");
    // 顺序必须与提交顺序一致（写链不是乱序执行）。
    assert.deepEqual(texts, Array.from({ length: 20 }, (_item, index) => `第 ${index} 条`));
  });
});

test("并发 createSession 不会互相覆盖（各自一个文件）", async () => {
  await withStore(async ({ store, dir }) => {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_item, index) => store.createSession({ terminalId: "t1", title: `C${index}` })),
    );
    const ids = new Set(created.map((item) => item.id));
    assert.equal(ids.size, 5);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 5);
  });
});

test("裁剪：超过 MAX_MESSAGES 就裁到 TRIM_KEEP_MESSAGES 以内，并写明 trimNote", async () => {
  await withStore(async ({ store }) => {
    const session = await store.createSession({ terminalId: "t1" });
    for (let index = 0; index < MAX_MESSAGES + 5; index += 1) {
      await store.appendMessage(session.id, { role: "user", text: `m${index}`, round: index + 1 });
    }
    const back = await store.getSession(session.id);
    assert.ok(back.messages.length <= MAX_MESSAGES, `消息数不能超过 ${MAX_MESSAGES}，实际 ${back.messages.length}`);
    assert.ok(back.messages.length >= TRIM_KEEP_MESSAGES);
    assert.equal(back.messages.at(-1).text, `m${MAX_MESSAGES + 4}`, "保留的是最近的");
    assert.equal(back.messages.some((item) => item.text === "m0"), false, "最旧的必须被丢掉");
    assert.match(back.trimNote, /更早的对话已裁剪/);
  });
});

test("裁剪：单条超大消息也会被裁到 512KB 以内", async () => {
  await withStore(async ({ store, dir }) => {
    const session = await store.createSession({ terminalId: "t1" });
    await store.appendMessage(session.id, { role: "user", text: "小".repeat(600 * 1024), round: 1 });
    const file = path.join(dir, `${session.id}.json`);
    const size = (await stat(file)).size;
    assert.ok(size < 512 * 1024 + 2048, `文件应被裁到 512KB 以内，实际 ${size}`);
  });
});

test("trimSession 纯函数：消息与步骤都会被收", () => {
  const session = {
    id: "s-1",
    title: "t",
    createdAt: 1,
    updatedAt: 1,
    terminalId: "x",
    terminalKind: "local",
    shell: "bash",
    hostId: null,
    hostName: null,
    hostAddr: null,
    messages: Array.from({ length: 260 }, (_item, index) => ({
      role: "user",
      text: `m${index}`,
      at: 1,
      reasoning: null,
      round: index + 1,
    })),
    steps: Array.from({ length: 150 }, (_item, index) => ({
      stepId: `st${index}`,
      command: "ls",
      decision: "auto",
      status: "done",
      output: "x".repeat(2000),
      startedAt: 1,
      endedAt: 2,
      round: 1,
    })),
    status: "open",
    trimNote: null,
  };
  const trimmed = trimSession(session);
  assert.equal(trimmed, true);
  assert.ok(session.messages.length <= TRIM_KEEP_MESSAGES);
  assert.equal(session.steps.length, 100);
  assert.ok(session.steps.every((step) => step.output.length <= 801));
  assert.match(session.trimNote, /裁剪/);
});

test("会话总数 ≤ 100：超了删最久未更新的，keep 里的不动", async () => {
  await withStore(async ({ store, dir }) => {
    const keep = await store.createSession({ terminalId: "keep", title: "keep" });
    // 造 101 个文件：直接写文件比走 API 快，形状仍被 normalize 认。
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      const body = {
        id: `s-${String(index).padStart(8, "0")}`,
        title: `old-${index}`,
        createdAt: 1,
        updatedAt: 1,
        terminalId: "t",
        terminalKind: "local",
        shell: "bash",
        messages: [],
        steps: [],
        status: "open",
      };
      await writeFile(path.join(dir, `${body.id}.json`), JSON.stringify(body), "utf8");
    }
    await store.prune({ keep: [keep.id] });
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, MAX_SESSIONS);
    assert.ok(await store.getSession(keep.id), "keep 里的会话不能被删");
  });
});

test("titleFromQuestion 取前 24 字并压成一行", () => {
  assert.equal(titleFromQuestion("  你好  世界 "), "你好 世界");
  assert.equal(titleFromQuestion(""), "新会话");
  const long = titleFromQuestion("一".repeat(40));
  assert.equal(long.length, 25, "24 字 + 省略号");
  assert.ok(long.endsWith("…"));
});

test("损坏的会话文件不影响其它会话（不抛错）", async () => {
  await withStore(async ({ store, dir }) => {
    const good = await store.createSession({ terminalId: "t1", title: "好" });
    await writeFile(path.join(dir, "s-broken.json"), "{ not json", "utf8");
    assert.equal(await store.getSession("s-broken"), null);
    const list = await store.listSessions({});
    assert.deepEqual(
      list.map((item) => item.id),
      [good.id],
    );
  });
});

test("getSession 拒绝目录穿越 id", async () => {
  await withStore(async ({ store }) => {
    assert.equal(await store.getSession("../../etc/passwd"), null);
    assert.equal(await store.getSession("s-x/../y"), null);
  });
});

test("setStatus 记「已停止」（AC12）", async () => {
  await withStore(async ({ store }) => {
    const session = await store.createSession({ terminalId: "t1" });
    assert.equal(session.status, "open");
    await store.setStatus(session.id, "stopped");
    const back = await store.getSession(session.id);
    assert.equal(back.status, "stopped");
    await store.setStatus(session.id, "whatever");
    assert.equal((await store.getSession(session.id)).status, "open");
  });
});

test("落盘文件里不出现 undefined / 函数等非 JSON 值", async () => {
  await withStore(async ({ store, dir }) => {
    const session = await store.createSession({ terminalId: "t1" });
    await store.appendMessage(session.id, { role: "assistant", text: "ok" });
    const raw = await readFile(path.join(dir, `${session.id}.json`), "utf8");
    assert.equal(raw.includes("undefined"), false);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.messages[0].reasoning, null);
  });
});
