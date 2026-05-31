// Suspend/unsuspend is the reversible counterpart to revoke. A suspended key
// must fail to authenticate on every route, but the operator must be able
// to lift the hold without rotating the secret.
// Run with: node --experimental-strip-types --test tests/keySuspend.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-key-suspend-"));
process.chdir(tmpRoot);
await fs.mkdir(path.join(tmpRoot, ".data"), { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));

test("new keys are not suspended", async () => {
  const { key } = await ks.createKey({ label: "fresh", scopes: ["read"] });
  assert.equal(!!key.suspended, false);
  const view = ks.publicView(key);
  assert.equal(view.suspended, false);
  assert.equal(view.suspended_at, null);
  assert.equal(view.suspended_reason, null);
});

test("setKeySuspended blocks authenticate, unsuspend restores it without rotating", async () => {
  const { key, secret } = await ks.createKey({ label: "hold", scopes: ["read"] });
  // Baseline: authenticates.
  const okBefore = await ks.authenticate(secret);
  assert.ok(okBefore, "fresh key authenticates");

  // Suspend.
  const sus = await ks.setKeySuspended(key.id, true, "incident-2026-05-31");
  assert.ok(sus);
  assert.equal(sus.suspended, true);
  assert.equal(sus.suspended_reason, "incident-2026-05-31");
  assert.ok(sus.suspended_at);

  // Suspended secret refuses to authenticate.
  const blocked = await ks.authenticate(secret);
  assert.equal(blocked, null, "suspended key must not authenticate");

  // Unsuspend with the SAME secret.
  const back = await ks.setKeySuspended(key.id, false);
  assert.ok(back);
  assert.equal(back.suspended, false);
  assert.equal(back.suspended_reason, null);
  assert.equal(back.suspended_at, null);

  const okAfter = await ks.authenticate(secret);
  assert.ok(okAfter, "unsuspended key authenticates with original secret");
  assert.equal(okAfter.id, key.id);
});

test("setKeySuspended refuses revoked keys and env-admin", async () => {
  const { key } = await ks.createKey({ label: "dead", scopes: ["read"] });
  await ks.revokeKey(key.id);
  const r = await ks.setKeySuspended(key.id, true);
  assert.equal(r, null, "cannot suspend a revoked key");

  const e = await ks.setKeySuspended("env-admin", true);
  assert.equal(e, null, "cannot suspend env-admin");
});

test("reason is capped at 200 chars", async () => {
  const { key } = await ks.createKey({ label: "long", scopes: ["read"] });
  const long = "x".repeat(500);
  const sus = await ks.setKeySuspended(key.id, true, long);
  assert.ok(sus);
  assert.equal(sus.suspended_reason.length, 200);
});
