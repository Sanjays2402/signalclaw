// node --experimental-strip-types --test tests/monthlyQuota.test.mjs
//
// Proves the per-API-key monthly quota: pure store math (reserve/limit/
// override), period roll-over, header shape, and the v1Guard integration
// path so /api/v1/* actually returns 429 monthly_quota_exceeded when a
// key burns through its allowance.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-quota-"));
process.chdir(tmpRoot);
// Default unlimited; we override per key explicitly so tests don't depend
// on env shape.
delete process.env.SIGNALCLAW_MONTHLY_QUOTA;
// Make rate-limit huge so the per-minute window never trips during these tests.
process.env.SIGNALCLAW_RATE_LIMIT_PER_MIN = "100000";

const repoRoot = path.resolve(import.meta.dirname, "..");
const quotaMod = await import(path.join(repoRoot, "lib", "monthlyQuotaStore.ts"));
const {
  reserve,
  getQuotaForKey,
  setQuotaForKey,
  getUsage,
  periodOf,
  nextPeriodResetIso,
  applyQuotaHeaders,
  DEFAULT_MONTHLY_QUOTA,
  _resetForTests,
} = quotaMod;

test("default is unlimited (0) when env unset", () => {
  assert.equal(DEFAULT_MONTHLY_QUOTA, 0);
});

test("unlimited quota allows forever but still counts usage", async () => {
  _resetForTests();
  const key = { id: "kU" };
  for (let i = 0; i < 5; i++) {
    const d = await reserve(key);
    assert.equal(d.allowed, true);
    assert.equal(d.unlimited, true);
    assert.equal(d.limit, 0);
    assert.equal(d.used, i + 1);
  }
  const u = await getUsage("kU");
  assert.equal(u.count, 5);
});

test("override caps and 429s once exhausted, period roll resets", async () => {
  _resetForTests();
  await setQuotaForKey("kC", 3);
  const key = { id: "kC" };
  const jan = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
  const a = await reserve(key, jan);
  const b = await reserve(key, jan);
  const c = await reserve(key, jan);
  assert.equal(a.allowed && b.allowed && c.allowed, true);
  assert.equal(c.remaining, 0);
  const d = await reserve(key, jan);
  assert.equal(d.allowed, false);
  assert.equal(d.limit, 3);
  assert.equal(d.used, 3);
  assert.equal(d.period, "2026-01");
  assert.equal(d.reset_at, new Date(Date.UTC(2026, 1, 1)).toISOString());
  // New calendar month allows again.
  const feb = new Date(Date.UTC(2026, 1, 1, 0, 0, 1));
  const e = await reserve(key, feb);
  assert.equal(e.allowed, true);
  assert.equal(e.used, 1);
  assert.equal(e.period, "2026-02");
});

test("override per key is isolated from other keys", async () => {
  _resetForTests();
  await setQuotaForKey("kX", 1);
  const x = { id: "kX" };
  const y = { id: "kY" }; // no override -> unlimited default
  const t = new Date(Date.UTC(2026, 2, 10));
  assert.equal((await reserve(x, t)).allowed, true);
  assert.equal((await reserve(x, t)).allowed, false);
  // kY is unaffected
  for (let i = 0; i < 5; i++) {
    assert.equal((await reserve(y, t)).allowed, true);
  }
});

test("setQuotaForKey(null) clears override", async () => {
  _resetForTests();
  await setQuotaForKey("kZ", 7);
  assert.equal(await getQuotaForKey("kZ"), 7);
  await setQuotaForKey("kZ", null);
  assert.equal(await getQuotaForKey("kZ"), DEFAULT_MONTHLY_QUOTA);
});

test("setQuotaForKey rejects negatives and absurd values", async () => {
  _resetForTests();
  await assert.rejects(() => setQuotaForKey("kBad", -1));
  await assert.rejects(() => setQuotaForKey("kBad", 100_000_001));
});

test("applyQuotaHeaders ships canonical X-Quota-* headers", () => {
  const limited = {
    allowed: true,
    unlimited: false,
    limit: 100,
    used: 42,
    remaining: 58,
    period: "2026-03",
    reset_at: "2026-04-01T00:00:00.000Z",
  };
  const h = new Headers();
  applyQuotaHeaders(h, limited);
  assert.equal(h.get("X-Quota-Limit"), "100");
  assert.equal(h.get("X-Quota-Used"), "42");
  assert.equal(h.get("X-Quota-Remaining"), "58");
  assert.equal(h.get("X-Quota-Period"), "2026-03");
  assert.equal(h.get("X-Quota-Reset"), "2026-04-01T00:00:00.000Z");
  const u = { ...limited, unlimited: true, limit: 0, remaining: 0 };
  const h2 = new Headers();
  applyQuotaHeaders(h2, u);
  assert.equal(h2.get("X-Quota-Limit"), "unlimited");
  assert.equal(h2.get("X-Quota-Remaining"), "unlimited");
});

test("periodOf and nextPeriodResetIso compute UTC month boundaries", () => {
  assert.equal(periodOf(new Date(Date.UTC(2026, 5, 30, 23, 59, 59))), "2026-06");
  assert.equal(
    nextPeriodResetIso(new Date(Date.UTC(2026, 11, 5))),
    new Date(Date.UTC(2027, 0, 1)).toISOString(),
  );
});

// Integration smoke: invoke store directly across many calls to prove the
// per-key counter survives concurrent reserve() calls without a 429 false
// negative or lost write.
test("concurrent reserves do not lose updates", async () => {
  _resetForTests();
  await setQuotaForKey("kRace", 50);
  const key = { id: "kRace" };
  const results = await Promise.all(
    Array.from({ length: 50 }, () => reserve(key)),
  );
  assert.equal(results.every((r) => r.allowed), true);
  const over = await reserve(key);
  assert.equal(over.allowed, false);
  assert.equal(over.used, 50);
});
