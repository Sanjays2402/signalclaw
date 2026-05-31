// Unit tests for the key-expiry watch helpers.
//
// We exercise the pure classifier and the summary so the route handler and
// the UI agree on bucket boundaries: anything in the past is `expired`,
// <=24h is `critical`, <=7d is `soon`, <=30d is `upcoming`. Revoked or
// suspended keys never appear in the watch list, and keys with no expiry
// are counted but not surfaced.
//
// Run with: node --experimental-strip-types --test tests/keyExpiry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "keyExpiry.ts"));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-05-31T12:00:00.000Z");

function k(over) {
  return {
    id: over.id ?? "k_x",
    label: over.label ?? "test",
    prefix: over.prefix ?? "sc_live_a",
    scopes: over.scopes ?? ["read"],
    expires_at: over.expires_at ?? null,
    revoked: !!over.revoked,
    suspended: !!over.suspended,
  };
}

test("classifyKey buckets respect 24h / 7d / 30d boundaries", () => {
  const expired = mod.classifyKey(
    k({ id: "a", expires_at: new Date(NOW - 2 * DAY).toISOString() }),
    NOW,
  );
  assert.equal(expired.bucket, "expired");
  assert.ok(expired.expires_in_ms < 0);
  assert.equal(expired.expires_in_days, -2);

  const critical = mod.classifyKey(
    k({ id: "b", expires_at: new Date(NOW + 12 * HOUR).toISOString() }),
    NOW,
  );
  assert.equal(critical.bucket, "critical");

  const soon = mod.classifyKey(
    k({ id: "c", expires_at: new Date(NOW + 5 * DAY).toISOString() }),
    NOW,
  );
  assert.equal(soon.bucket, "soon");

  const upcoming = mod.classifyKey(
    k({ id: "d", expires_at: new Date(NOW + 20 * DAY).toISOString() }),
    NOW,
  );
  assert.equal(upcoming.bucket, "upcoming");
});

test("classifyKey returns null for keys with no expiry or in dead states", () => {
  assert.equal(mod.classifyKey(k({ expires_at: null }), NOW), null);
  assert.equal(
    mod.classifyKey(
      k({ expires_at: new Date(NOW + DAY).toISOString(), revoked: true }),
      NOW,
    ),
    null,
  );
  assert.equal(
    mod.classifyKey(
      k({ expires_at: new Date(NOW + DAY).toISOString(), suspended: true }),
      NOW,
    ),
    null,
  );
  assert.equal(
    mod.classifyKey(k({ expires_at: "not-a-date" }), NOW),
    null,
  );
});

test("summarizeExpiry counts buckets and excludes far-future from the list", () => {
  const keys = [
    k({ id: "exp", expires_at: new Date(NOW - 3 * DAY).toISOString() }),
    k({ id: "crit", expires_at: new Date(NOW + 6 * HOUR).toISOString() }),
    k({ id: "soon", expires_at: new Date(NOW + 3 * DAY).toISOString() }),
    k({ id: "up", expires_at: new Date(NOW + 20 * DAY).toISOString() }),
    k({ id: "far", expires_at: new Date(NOW + 120 * DAY).toISOString() }),
    k({ id: "no-exp", expires_at: null }),
    k({
      id: "rev",
      expires_at: new Date(NOW + DAY).toISOString(),
      revoked: true,
    }),
    k({
      id: "susp",
      expires_at: new Date(NOW + DAY).toISOString(),
      suspended: true,
    }),
  ];
  const s = mod.summarizeExpiry(keys, { now: NOW, windowDays: 30 });
  assert.equal(s.counts.expired, 1);
  assert.equal(s.counts.critical, 1);
  assert.equal(s.counts.soon, 1);
  assert.equal(s.counts.upcoming, 1);
  assert.equal(s.counts.no_expiry, 1);
  assert.equal(s.counts.revoked_or_suspended, 2);
  // active_with_expiry counts every non-revoked, non-suspended key with an
  // expiry, including the "far" one outside the window.
  assert.equal(s.counts.active_with_expiry, 5);
  const ids = s.keys.map((x) => x.id);
  assert.deepEqual(ids, ["exp", "crit", "soon", "up"]);
});

test("summarizeExpiry always surfaces already-expired keys even outside the window", () => {
  const keys = [
    k({ id: "long-dead", expires_at: new Date(NOW - 200 * DAY).toISOString() }),
    k({ id: "ok", expires_at: new Date(NOW + 60 * DAY).toISOString() }),
  ];
  const s = mod.summarizeExpiry(keys, { now: NOW, windowDays: 7 });
  assert.equal(s.counts.expired, 1);
  assert.equal(s.counts.upcoming, 0);
  assert.equal(s.keys.length, 1);
  assert.equal(s.keys[0].id, "long-dead");
});

test("summarizeExpiry clamps the window to sane bounds", () => {
  const a = mod.summarizeExpiry([], { windowDays: 0 });
  assert.equal(a.window_days, 1);
  const b = mod.summarizeExpiry([], { windowDays: 99999 });
  assert.equal(b.window_days, mod.MAX_WITHIN_DAYS);
  const c = mod.summarizeExpiry([], { windowDays: 7.9 });
  assert.equal(c.window_days, 7);
});
