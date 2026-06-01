// node --experimental-strip-types --test tests/breakGlass.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-bg-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const bg = await import(path.join(repoRoot, "lib", "breakGlassStore.ts"));

test("default state has no active grant", async () => {
  const s = await bg.getState();
  assert.equal(s.active, null);
  assert.deepEqual(s.history, []);
  assert.equal(await bg.getActive(), null);
});

test("rejects empty reason", async () => {
  const r = await bg.grant({ reason: "", actor: "test" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_reason");
});

test("rejects short reason", async () => {
  const r = await bg.grant({ reason: "too short", actor: "test" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_reason");
});

test("rejects ttl below 60s", async () => {
  const r = await bg.grant({
    reason: "valid reason for a real incident",
    ttl_seconds: 30,
    actor: "test",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_ttl");
});

test("rejects ttl above 60 minutes", async () => {
  const r = await bg.grant({
    reason: "valid reason for a real incident",
    ttl_seconds: 60 * 60 + 1,
    actor: "test",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_ttl");
});

test("grants an active break-glass with reason and TTL", async () => {
  const r = await bg.grant({
    reason: "revoking compromised key sk_live_xxx from offsite",
    ttl_seconds: 600,
    actor: "owner@example.com",
  });
  assert.equal(r.ok, true);
  assert.ok(r.grant.id);
  assert.equal(r.grant.granted_by, "owner@example.com");
  assert.equal(r.grant.ttl_seconds, 600);
  assert.equal(r.superseded, null);

  const active = await bg.getActive();
  assert.ok(active);
  assert.equal(active.id, r.grant.id);
});

test("second grant supersedes (and audits) the first", async () => {
  const second = await bg.grant({
    reason: "second incident requires fresh window",
    ttl_seconds: 900,
    actor: "owner@example.com",
  });
  assert.equal(second.ok, true);
  assert.ok(second.superseded);
  assert.ok(second.superseded.revoked_at);
  const state = await bg.getState();
  assert.equal(state.active.id, second.grant.id);
  // First grant should now be in history as revoked.
  assert.ok(state.history.some((g) => g.id === second.superseded.id && g.revoked_at));
});

test("recordUse increments the counter", async () => {
  await bg.recordUse();
  await bg.recordUse();
  const active = await bg.getActive();
  assert.equal(active.uses, 2);
  assert.ok(active.last_used_at);
});

test("revoke removes the active grant", async () => {
  const r = await bg.revoke("auditor@example.com");
  assert.equal(r.ok, true);
  assert.equal(r.revoked.revoked_by, "auditor@example.com");
  assert.equal(await bg.getActive(), null);
});

test("revoke with no active returns no_active", async () => {
  const r = await bg.revoke("auditor@example.com");
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_active");
});

test("expired grant is NOT returned by getActive (the security guarantee)", async () => {
  const past = new Date(Date.now() - 1000);
  const r = await bg.grant({
    reason: "this should be considered expired immediately",
    ttl_seconds: 60,
    actor: "test",
    now: new Date(past.getTime() - 120 * 1000),
  });
  assert.equal(r.ok, true);
  // The synthetic grant was created with a "now" 3 minutes ago and a
  // 60-second TTL, so right now it must be expired.
  const active = await bg.getActive();
  assert.equal(active, null, "expired grant must not be returned as active");

  // describeRemaining agrees.
  const desc = bg.describeRemaining(r.grant);
  assert.equal(desc.expired, true);
  assert.equal(desc.seconds_remaining, 0);

  // recordUse on an expired grant must be a no-op (no increment).
  await bg.recordUse();
  const state = await bg.getState();
  assert.equal(state.active.uses, 0, "recordUse must not advance an expired grant");
});

test("constants are sane (procurement-grade defaults)", () => {
  assert.ok(bg.MAX_TTL_SECONDS <= 60 * 60, "TTL cap must be no more than one hour");
  assert.ok(bg.MIN_REASON_LEN >= 10, "reason floor must require substance");
});
