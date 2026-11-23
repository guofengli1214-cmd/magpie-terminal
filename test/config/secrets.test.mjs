// 凭据加密（TASK-V2-B §2.2 / §5 E7）。
//
// 锁死四件事：
// 1. 加解密往返（password / privateKey / passphrase 都回来）；
// 2. secrets.json 里没有明文；
// 3. 篡改密文一个字节 → 解密失败（GCM 的 auth tag 起作用），不抛到调用方；
// 4. 缺 key 文件 / key 长度不对 → 视为「凭据丢失」，readSecrets 不崩、hasSecret 变 false。

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rename, readdir, stat, writeFile } from "node:fs/promises";
import {
  CONFIG_PATH_ENV,
  addHost,
  deleteSecret,
  listHosts,
  readSecret,
  readSecrets,
  saveSecret,
  secretsPath,
  secretsKeyPath,
  knownHostsPath,
  rememberKnownHost,
  lookupKnownHost,
  forgetKnownHost,
} from "../../src/config/store.mjs";

let dir = "";
let restore = null;

async function withTmp() {
  dir = await mkdtemp(path.join(os.tmpdir(), "mt-secrets-"));
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = path.join(dir, "config.json");
  restore = () => {
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
  };
}

async function sampleHost(suffix = "a") {
  return await addHost({
    name: `host-${suffix}`,
    host: "127.0.0.1",
    port: 22,
    username: "probe",
    authType: "password",
  });
}

test("凭据加密组", async (t) => {
  await withTmp();
  t.after(() => restore());

  await t.test("加解密往返：password / privateKey / passphrase 全都回得来", async () => {
    const host = await sampleHost();
    const saved = await saveSecret(host.id, {
      password: "{{PASSWORD_1qv4l10n}}",
      privateKey: "{{PRIVATE_KEY_r9v0pmoe}}",
      passphrase: "{{PASSWORD_5v3h0fiu}}",
    });
    assert.equal(saved, true);
    const back = await readSecret(host.id);
    assert.deepEqual(back, {
      password: "{{PASSWORD_1qv4l10n}}",
      privateKey: "{{PRIVATE_KEY_r9v0pmoe}}",
      passphrase: "{{PASSWORD_5v3h0fiu}}",
    });
  });

  await t.test("secrets.json 里搜不到明文（前 80 字符也不是明文）", async () => {
    const raw = await readFile(secretsPath(), "utf8");
    assert.equal(raw.includes("{{PASSWORD_1qv4l10n}}"), false);
    assert.equal(raw.includes("{{PRIVATE_KEY_r9v0pmoe}}"), false);
    assert.equal(raw.includes("{{PASSWORD_5v3h0fiu}}"), false);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(typeof parsed.entries, "object");
  });

  await t.test("key 文件是 32 字节随机；POSIX 下 mode 600", async () => {
    const key = await readFile(secretsKeyPath());
    assert.equal(key.length, 32);
    if (process.platform !== "win32") {
      const info = await stat(secretsKeyPath());
      assert.equal(info.mode & 0o777, 0o600);
      const secretInfo = await stat(secretsPath());
      assert.equal(secretInfo.mode & 0o777, 0o600);
    }
  });

  await t.test("篡改密文一个字节 → 这条解不出来（GCM tag 拦下），其余条目不受影响", async () => {
    const hostA = await sampleHost("b");
    const hostB = await sampleHost("c");
    await saveSecret(hostA.id, { password: "{{PASSWORD_8h5gdlrj}}" });
    await saveSecret(hostB.id, { password: "{{PASSWORD_5qgvvxxr}}" });

    const parsed = JSON.parse(await readFile(secretsPath(), "utf8"));
    const entry = parsed.entries[hostA.id];
    const bytes = Buffer.from(entry.data, "base64");
    bytes[0] = bytes[0] ^ 0xff;
    entry.data = bytes.toString("base64");
    await writeFile(secretsPath(), JSON.stringify(parsed, null, 2), "utf8");

    const after = await readSecrets();
    assert.equal(after.ok, true);
    assert.equal(after.byId.has(hostA.id), false, "篡改过的条目必须解不出来");
    assert.equal(after.byId.has(hostB.id), true, "未篡改的条目必须仍然可解");

    // listHosts 的 hasSecret 要跟着变 false，且不能抛错。
    const hosts = await listHosts();
    assert.equal(hosts.find((h) => h.id === hostA.id).hasSecret, false);
    assert.equal(hosts.find((h) => h.id === hostB.id).hasSecret, true);
  });

  await t.test("secrets.key 改名 → readSecrets ok:false reason:key-missing，不抛错；hasSecret 全 false", async () => {
    const host = await sampleHost("d");
    await saveSecret(host.id, { password: "{{PASSWORD_yepuz7tr}}" });
    const before = await listHosts();
    assert.equal(before.find((h) => h.id === host.id).hasSecret, true);

    await rename(secretsKeyPath(), `${secretsKeyPath()}.bak`);
    const result = await readSecrets();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "key-missing");
    assert.equal(result.byId.size, 0);

    const after = await listHosts();
    assert.equal(after.find((h) => h.id === host.id).hasSecret, false);
    assert.equal(await readSecret(host.id), null);

    // 还原，免得影响后续用例。
    await rename(`${secretsKeyPath()}.bak`, secretsKeyPath());
    const restored = await listHosts();
    assert.equal(restored.find((h) => h.id === host.id).hasSecret, true);
  });

  await t.test("secrets.key 内容被截断（长度不是 32）→ 同样视为丢失，不崩", async () => {
    const host = await sampleHost("e");
    await saveSecret(host.id, { password: "{{PASSWORD_a4s2i9u2}}" });
    const original = await readFile(secretsKeyPath());
    await writeFile(secretsKeyPath(), original.subarray(0, 16));
    const result = await readSecrets();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "key-missing");
    await writeFile(secretsKeyPath(), original);
  });

  await t.test("secrets.json 是坏 JSON → 视为凭据丢失，不崩", async () => {
    await writeFile(secretsPath(), "{ not json", "utf8");
    const result = await readSecrets();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "corrupt");
    const hosts = await listHosts();
    assert.equal(hosts.every((h) => h.hasSecret === false), true);
  });

  await t.test("deleteSecret 幂等；secrets.json 不存在时也不抛", async () => {
    const host = await sampleHost("f");
    await saveSecret(host.id, { password: "{{PASSWORD_9b5j0qil}}" });
    assert.equal(await deleteSecret(host.id), true);
    assert.equal(await readSecret(host.id), null);
    assert.equal(await deleteSecret(host.id), true);
    assert.equal(await deleteSecret("h-nope"), true);
  });

  await t.test("原子写：目录里除了状态文件不留下临时文件", async () => {
    const host = await sampleHost("g");
    await saveSecret(host.id, { password: "{{PASSWORD_g2q1jr3n}}" });
    const entries = await readdir(dir);
    const leftovers = entries.filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  });

  await t.test("known_hosts：写→读→删；host:port 做 key", async () => {
    await rememberKnownHost("10.1.2.3", 22, "ssh-ed25519", "SHA256:abc123");
    const hit = await lookupKnownHost("10.1.2.3", 22);
    assert.deepEqual(hit, { algo: "ssh-ed25519", fingerprint: "SHA256:abc123" });
    // 同 host 不同端口是两条独立记录。
    assert.equal(await lookupKnownHost("10.1.2.3", 2222), null);
    await rememberKnownHost("10.1.2.3", 2222, "ssh-rsa", "SHA256:def456");
    assert.deepEqual(await lookupKnownHost("10.1.2.3", 2222), {
      algo: "ssh-rsa",
      fingerprint: "SHA256:def456",
    });
    assert.equal(await forgetKnownHost("10.1.2.3", 22), true);
    assert.equal(await lookupKnownHost("10.1.2.3", 22), null);
    assert.equal(await forgetKnownHost("10.1.2.3", 22), false);
    const raw = JSON.parse(await readFile(knownHostsPath(), "utf8"));
    assert.deepEqual(Object.keys(raw), ["10.1.2.3:2222"]);
  });
});
