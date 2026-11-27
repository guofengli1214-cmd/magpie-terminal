// OSC 7 解析器单测（TASK-V4-G §5.6）：
// 跨 chunk 拆分、URL 解码、Windows 路径还原、非法包丢弃、4KB 上限。

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PENDING,
  createOsc7Scanner,
  decodeOsc7,
  extractOsc7Paths,
  toWindowsPath,
} from "../../src/ssh/osc7.mjs";

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\";

function osc7(payload, end = BEL) {
  return `${ESC}]7;${payload}${end}`;
}

test("decodeOsc7 组", async (t) => {
  await t.test("POSIX：file://host/home/user/x → /home/user/x", () => {
    assert.equal(decodeOsc7("file://host/home/user/x", { windows: false }), "/home/user/x");
  });

  await t.test("百分号解码：%20 / 中文 UTF-8", () => {
    assert.equal(
      decodeOsc7("file://h/tmp/a%20b/%E4%B8%AD%E6%96%87", { windows: false }),
      "/tmp/a b/中文",
    );
  });

  await t.test("file:///C:/Users/x（空 host）→ C:\\Users\\x", () => {
    assert.equal(decodeOsc7("file:///C:/Users/x", { windows: true }), "C:\\Users\\x");
  });

  await t.test("file://HOST/C:/Users/x → C:\\Users\\x", () => {
    assert.equal(decodeOsc7("file://MINGW64/C:/Users/x", { windows: true }), "C:\\Users\\x");
  });

  await t.test("MSYS 的 /c/Users/x → C:\\Users\\x（小写盘符转大写）", () => {
    assert.equal(decodeOsc7("file://h/c/Users/x", { windows: true }), "C:\\Users\\x");
  });

  await t.test("MSYS 盘根 /c → C:\\", () => {
    assert.equal(decodeOsc7("file://h/c", { windows: true }), "C:\\");
  });

  await t.test("非 file:// 前缀 → null", () => {
    assert.equal(decodeOsc7("https://x/y", { windows: false }), null);
    assert.equal(decodeOsc7("/plain/path", { windows: false }), null);
  });

  await t.test("空正文 / 只有 host → null", () => {
    assert.equal(decodeOsc7("", { windows: false }), null);
    assert.equal(decodeOsc7("file://host", { windows: false }), null);
  });

  await t.test("坏的百分号编码 → null（不抛）", () => {
    assert.equal(decodeOsc7("file://h/%E0%A4%A", { windows: false }), null);
  });

  await t.test("含 NUL → null", () => {
    assert.equal(decodeOsc7("file://h/a%00b", { windows: false }), null);
  });

  await t.test("query / fragment 被切掉", () => {
    assert.equal(decodeOsc7("file://h/tmp/x?host=a#frag", { windows: false }), "/tmp/x");
  });
});

test("toWindowsPath 组", async (t) => {
  await t.test("/C:/Users/x → C:\\Users\\x", () => {
    assert.equal(toWindowsPath("/C:/Users/x"), "C:\\Users\\x");
  });
  await t.test("/c/Users/x → C:\\Users\\x", () => {
    assert.equal(toWindowsPath("/c/Users/x"), "C:\\Users\\x");
  });
  await t.test("已经是 Windows 形态则原样", () => {
    assert.equal(toWindowsPath("C:\\Users\\x"), "C:\\Users\\x");
  });
  await t.test("/tmp/x 不硬掰成盘符（交给上层判非法）", () => {
    assert.equal(toWindowsPath("/tmp/x"), "/tmp/x");
  });
});

test("createOsc7Scanner 跨 chunk 组", async (t) => {
  await t.test("整条一次到达：一条路径", () => {
    const scan = createOsc7Scanner();
    assert.deepEqual(scan.push(osc7("file://h/a/b")), ["file://h/a/b"]);
  });

  await t.test("BEL 与 ESC \\\\ 两种结束符都认", () => {
    const scan = createOsc7Scanner();
    assert.deepEqual(scan.push(osc7("file://h/a", BEL) + osc7("file://h/b", ST)), [
      "file://h/a",
      "file://h/b",
    ]);
  });

  await t.test("8 位 ST（0x9c）也认", () => {
    const scan = createOsc7Scanner();
    assert.deepEqual(scan.push(`${ESC}]7;file://h/a\x9c`), ["file://h/a"]);
  });

  await t.test("在序列头中间被拆开（ESC ] 7 ; 拆两半）", () => {
    const scan = createOsc7Scanner();
    assert.deepEqual(scan.push(`${ESC}]7`), []);
    assert.deepEqual(scan.push(`;file://h/a${BEL}`), ["file://h/a"]);
  });

  await t.test("在路径中间被拆开（逐字符喂）", () => {
    const scan = createOsc7Scanner();
    const whole = osc7("file://h/home/user/very-long-name");
    const found = [];
    for (const ch of whole) found.push(...scan.push(ch));
    assert.deepEqual(found, ["file://h/home/user/very-long-name"]);
  });

  await t.test("ESC \\\\ 的 ESC 落在 chunk 末尾：等下一个 chunk", () => {
    const scan = createOsc7Scanner();
    assert.deepEqual(scan.push(`${ESC}]7;file://h/a${ESC}`), []);
    assert.deepEqual(scan.push("\\"), ["file://h/a"]);
  });

  await t.test("一条序列后面紧跟普通文本 / 下一条序列", () => {
    const scan = createOsc7Scanner();
    assert.deepEqual(scan.push(`hello${osc7("file://h/a")}world${osc7("file://h/b")}`), [
      "file://h/a",
      "file://h/b",
    ]);
  });

  await t.test("非法包：不是 file:// 的正文被解成 null，但不吃后面的好包", () => {
    assert.deepEqual(extractOsc7Paths(`${ESC}]7;garbage${BEL}${ESC}]7;file://h/ok${BEL}`, { windows: false }), [
      "/ok",
    ]);
  });

  await t.test("没有结束符的序列：保留尾巴，不误报", () => {
    const scan = createOsc7Scanner();
    assert.deepEqual(scan.push(`${ESC}]7;file://h/never-ends`), []);
    assert.equal(scan.pending().includes("never-ends"), true);
    // 结束符终于来了，同一条序列仍然能被解出来。
    assert.deepEqual(scan.push(BEL), ["file://h/never-ends"]);
  });

  await t.test(`超过 ${MAX_PENDING} 字节仍无结束符 → 丢弃，不无限增长`, () => {
    const scan = createOsc7Scanner();
    scan.push(`${ESC}]7;file://h/${"x".repeat(MAX_PENDING + 100)}`);
    assert.equal(scan.pending().length <= 8, true);
    // 丢弃之后能正常接新的序列。
    assert.deepEqual(scan.push(osc7("file://h/after")), ["file://h/after"]);
  });

  await t.test("reset 清空 pending", () => {
    const scan = createOsc7Scanner();
    scan.push(`${ESC}]7;file://h/half`);
    scan.reset();
    assert.equal(scan.pending(), "");
  });

  await t.test("extractOsc7Paths 一次性解析：顺序即出现顺序，非法被跳过", () => {
    const paths = extractOsc7Paths(
      `noise${osc7("file://h/first")}${osc7("file://h/second")}${ESC}]7;not-file${BEL}`,
      { windows: false },
    );
    assert.deepEqual(paths, ["/first", "/second"]);
  });
});

test("Osc7 与实际 shell 输出形状组", async (t) => {
  await t.test("bash 的 printf 形态（\\033]7;file://HOST/PWD\\033\\\\）", () => {
    // bash rc 里那条 printf 产出的就是这一串。
    const data = `${ESC}]7;file://MINGW64/c/Users/41807/magpie-terminal${ESC}\\`;
    assert.deepEqual(extractOsc7Paths(data, { windows: true }), [
      "C:\\Users\\41807\\magpie-terminal",
    ]);
  });

  await t.test("PowerShell 的形态（file://COMPUTERNAME/C:/Users/x）", () => {
    const data = `${ESC}]7;file://DESKTOP/C:/Users/41807/docs${BEL}`;
    assert.deepEqual(extractOsc7Paths(data, { windows: true }), ["C:\\Users\\41807\\docs"]);
  });
});
