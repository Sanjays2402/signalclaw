// Tests for API key absolute expiry (expires_at).
// Run with: node --experimental-strip-types --test tests/keyExpiry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-key-expiry-"));
process.chdir(tmpRoot);
await fs.mkdir(path.join(tmpRoot, ".data"), { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));

test("createKey defaults to no expiry", async () => {
  const { key } = await ks.createKey({ label: "noexp", scopes: ["read"] });
  assert.equal(key.expires_at ?? null, null);
  const view = ks.publicView(key);
  assert.equal(view.expires_at, null);
  assert.equal(view.expired, false);
});

test("createKey accepts a future expiry and rejects past", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const { key } = await ks.createKey({ label: "fut", scopes: ["read"], expires_at: future });
  assert.equal(key.expires_at, future);

  const past = new Date(Date.now() - 60_000).toISOString();
  await assert.rejects(
    ks.createKey({ label: "past", scopes: ["read"], expires_at: past }),
    /invalid_expiry/,
  );

  await assert.rejects(
    ks.createKey({ label: "junk", scopes: ["read"], expires_at: "not-a-date" }),
    /invalid_expiry/,
  );
});

test("authenticate refuses an expired key", async () => {
  // Mint a key with a near-future expiry, capture plaintext.
  const future = new Date(Date.now() + 1500).toISOString();
  const { key, secret } = await ks.createKey({
    label: "shortlived",
    scopes: ["read"],
    expires_at: future,
  });
  // Still valid right now.
  const okBefore = await ks.authenticate(secret);
  assert.ok(okBefore, "key should authenticate before expiry");
  assert.equal(okBefore.id, key.id);

  // Wait until past the cutoff. Add a safety margin above the
  // 1500ms expiry so timer jitter cannot flake the test.
  await new Promise((r) => setTimeout(r, 2000));

  const okAfter = await ks.authenticate(secret);
  assert.equal(okAfter, null, "expired key must not authenticate");
});

test("setKeyExpiry can clear and re-set, refuses revoked keys", async () => {
  const { key, secret } = await ks.createKey({ label: "edit", scopes: ["read"] });
  const future = new Date(Date.now() + 10_000).toISOString();

  const set = await ks.setKeyExpiry(key.id, future);
  assert.ok(set);
  assert.equal(set.expires_at, future);

  const cleared = await ks.setKeyExpiry(key.id, null);
  assert.ok(cleared);
  assert.equal(cleared.expires_at, null);

  // Past timestamps are rejected.
  await assert.rejects(
    ks.setKeyExpiry(key.id, new Date(Date.now() - 1000).toISOString()),
    /invalid_expiry/,
  );

  // Revoked keys cannot be edited.
  await ks.revokeKey(key.id);
  const onRevoked = await ks.setKeyExpiry(key.id, future);
  assert.equal(onRevoked, null);

  // And of course a revoked key never authenticates regardless of expiry.
  assert.equal(await ks.authenticate(secret), null);
});

test("isExpired is a pure predicate", () => {
  assert.equal(ks.isExpired({ expires_at: null }), false);
  assert.equal(ks.isExpired({}), false);
  assert.equal(ks.isExpired({ expires_at: "not-a-date" }), false);
  assert.equal(
    ks.isExpired({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    true,
  );
  assert.equal(
    ks.isExpired({ expires_at: new Date(Date.now() + 60_000).toISOString() }),
    false,
  );
});
