// node --experimental-strip-types --test tests/keyStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-keystore-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "keyStore.ts"));
const { createKey, listKeys, revokeKey, authenticate, extractKey, publicView, rotateKey } =
  store;

test("createKey mints a secret, hashes at rest, returns public view without hash", async () => {
  const { key, secret } = await createKey({ label: "laptop", scopes: ["read"] });
  assert.ok(secret.startsWith("sc_live_"), "secret has product prefix");
  assert.equal(key.scopes.includes("read"), true);
  assert.equal(key.revoked, false);
  const pub = publicView(key);
  assert.equal("hash" in pub, false, "publicView strips hash");
  assert.equal(pub.prefix.length, 10);
});

test("createKey defaults to read scope when none given and never grants admin", async () => {
  const { key } = await createKey({ label: "x", scopes: [] });
  assert.deepEqual(key.scopes, ["read"]);
  const { key: k2 } = await createKey({
    label: "esc",
    // @ts-expect-error: intentionally try to escalate
    scopes: ["admin", "read"],
  });
  assert.equal(k2.scopes.includes("admin"), false);
});

test("authenticate accepts a valid secret and bumps last_used_at", async () => {
  const { secret } = await createKey({ label: "auth", scopes: ["read"] });
  const k = await authenticate(secret);
  assert.ok(k);
  assert.ok(k.last_used_at);
});

test("authenticate rejects unknown and revoked keys", async () => {
  assert.equal(await authenticate(""), null);
  assert.equal(await authenticate("sc_live_not_a_real_key"), null);
  const { key, secret } = await createKey({ label: "kill", scopes: ["read"] });
  await revokeKey(key.id);
  assert.equal(await authenticate(secret), null);
});

test("listKeys returns newest first and includes revoked entries", async () => {
  const before = (await listKeys()).length;
  await createKey({ label: "newest", scopes: ["read"] });
  const all = await listKeys();
  assert.ok(all.length > before);
  assert.equal(all[0].label, "newest");
});

test("extractKey reads Authorization Bearer and falls back to x-api-key", () => {
  const r1 = new Request("http://x/", {
    headers: { authorization: "Bearer sc_live_abc" },
  });
  assert.equal(extractKey(r1), "sc_live_abc");
  const r2 = new Request("http://x/", { headers: { "x-api-key": "sc_live_xyz" } });
  assert.equal(extractKey(r2), "sc_live_xyz");
  const r3 = new Request("http://x/");
  assert.equal(extractKey(r3), "");
});

test("rotateKey mints a new secret, invalidates the old one, and preserves id/label/scopes", async () => {
  const { key, secret: oldSecret } = await createKey({
    label: "rotate-me",
    scopes: ["read", "trade"],
  });
  // Use it once so last_used_at is set, to prove rotation resets it.
  await authenticate(oldSecret);
  const before = await listKeys();
  const beforeRec = before.find((k) => k.id === key.id);
  assert.ok(beforeRec?.last_used_at, "precondition: last_used_at populated");

  const out = await rotateKey(key.id);
  assert.ok(out, "rotate returns a result");
  assert.notEqual(out.secret, oldSecret, "new secret differs");
  assert.ok(out.secret.startsWith("sc_live_"), "new secret has product prefix");
  assert.equal(out.key.id, key.id, "id preserved");
  assert.equal(out.key.label, key.label, "label preserved");
  assert.deepEqual(out.key.scopes, key.scopes, "scopes preserved");
  assert.equal(out.key.last_used_at, null, "last_used_at reset");
  assert.equal(out.key.prefix, out.secret.slice(0, 10), "prefix matches new secret");

  // Old secret no longer authenticates.
  assert.equal(await authenticate(oldSecret), null, "old secret rejected");
  // New secret does.
  const k = await authenticate(out.secret);
  assert.ok(k, "new secret accepted");
  assert.equal(k.id, key.id);
});

test("rotateKey returns null for unknown or revoked keys", async () => {
  assert.equal(await rotateKey("does-not-exist"), null);
  const { key } = await createKey({ label: "dead", scopes: ["read"] });
  await revokeKey(key.id);
  assert.equal(await rotateKey(key.id), null);
});
