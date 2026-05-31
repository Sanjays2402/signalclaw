// End-to-end tests for invite + seat enforcement.
// Run with: node --experimental-strip-types --test tests/invites.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-invites-"));
process.chdir(tmpRoot);
await fs.mkdir(path.join(tmpRoot, ".data"), { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const invites = await import(path.join(repoRoot, "lib", "inviteStore.ts"));
const seats = await import(path.join(repoRoot, "lib", "seats.ts"));
const keys = await import(path.join(repoRoot, "lib", "keyStore.ts"));

test("create + listing returns the invite with pending status", async () => {
  const inv = await invites.createInvite({
    label: "alice",
    scopes: ["read"],
    max_uses: 2,
    expires_in_seconds: 3600,
    created_by_key_id: "admin1",
  });
  assert.ok(inv.token.startsWith("inv_"));
  assert.equal(inv.used_count, 0);
  assert.equal(invites.statusOf(inv), "pending");
  const list = await invites.listInvites();
  assert.ok(list.find((i) => i.token === inv.token));
});

test("scopes are sanitized and admin is never grantable via invite", async () => {
  const inv = await invites.createInvite({
    scopes: ["read", "admin", "trade", "garbage"],
    label: "noisy",
  });
  assert.deepEqual([...inv.scopes].sort(), ["read", "trade"]);
});

test("consumeInvite mints + accounts; second redeem on single-use fails", async () => {
  const inv = await invites.createInvite({
    label: "single",
    scopes: ["read"],
    max_uses: 1,
  });
  const first = await invites.consumeInvite(inv.token, "key_a", "1.2.3.4");
  assert.ok(first, "first consume should succeed");
  assert.equal(first.used_count, 1);
  assert.equal(invites.statusOf(first), "exhausted");
  const second = await invites.consumeInvite(inv.token, "key_b", "5.6.7.8");
  assert.equal(second, null, "second consume must fail");
});

test("expired invite cannot be consumed", async () => {
  const inv = await invites.createInvite({
    label: "expiring",
    scopes: ["read"],
    expires_in_seconds: 1,
  });
  const file = path.join(tmpRoot, ".data", "invites.json");
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const row = raw.invites.find((i) => i.token === inv.token);
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(file, JSON.stringify(raw));
  const got = await invites.getInvite(inv.token);
  assert.equal(invites.statusOf(got), "expired");
  const consumed = await invites.consumeInvite(inv.token, "k", "");
  assert.equal(consumed, null);
});

test("revoked invite cannot be consumed", async () => {
  const inv = await invites.createInvite({ label: "rev", scopes: ["read"] });
  assert.ok(await invites.revokeInvite(inv.token));
  const got = await invites.getInvite(inv.token);
  assert.equal(invites.statusOf(got), "revoked");
  assert.equal(await invites.consumeInvite(inv.token, "k", ""), null);
});

test("redeemerView never leaks creator id or accept log", async () => {
  const inv = await invites.createInvite({
    label: "hidden",
    scopes: ["read"],
    created_by_key_id: "admin-secret-id",
  });
  await invites.consumeInvite(inv.token, "leakcheck", "9.9.9.9");
  const fresh = await invites.getInvite(inv.token);
  const view = invites.redeemerView(fresh);
  assert.equal(view.created_by_key_id, undefined);
  assert.equal(view.accepted_by, undefined);
  assert.equal(view.token, inv.token);
  assert.equal(view.label, "hidden");
});

test("seat limit denies further mints once reached", async () => {
  await fs.rm(path.join(tmpRoot, ".data", "keys.json"), { force: true });
  process.env.SIGNALCLAW_SEAT_LIMIT = "2";
  await keys.createKey({ label: "k1", scopes: ["read"] });
  await keys.createKey({ label: "k2", scopes: ["read"] });
  const u = await seats.getSeatUsage();
  assert.equal(u.used, 2);
  assert.equal(u.limit, 2);
  assert.equal(u.remaining, 0);
  await assert.rejects(() => seats.ensureSeatAvailable(), /seat limit/);
  const all = await keys.listKeys();
  await keys.revokeKey(all[0].id);
  await seats.ensureSeatAvailable();
  delete process.env.SIGNALCLAW_SEAT_LIMIT;
});

test("unlimited (env unset) never blocks", async () => {
  delete process.env.SIGNALCLAW_SEAT_LIMIT;
  const u = await seats.getSeatUsage();
  assert.equal(u.unlimited, true);
  await seats.ensureSeatAvailable();
});
