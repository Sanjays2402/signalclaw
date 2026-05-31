// node --experimental-strip-types --test tests/rateLimitStore.test.mjs
//
// Proves: per-key sliding window, 429 when over cap, override beats default,
// and X-RateLimit headers carry the right numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-ratelimit-"));
process.chdir(tmpRoot);
process.env.SIGNALCLAW_RATE_LIMIT_PER_MIN = "3";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "rateLimitStore.ts"));
const {
  consume,
  applyRateHeaders,
  getLimitForKey,
  setLimitForKey,
  DEFAULT_PER_MINUTE,
  WINDOW_SECONDS,
  _resetForTests,
} = mod;

test("default cap pulled from env", () => {
  assert.equal(DEFAULT_PER_MINUTE, 3);
  assert.equal(WINDOW_SECONDS, 60);
});

test("consume permits up to the cap then 429s, then rolls on next window", async () => {
  _resetForTests();
  const key = { id: "k1" };
  const t0 = new Date("2025-01-01T00:00:00.000Z");
  const d1 = await consume(key, t0);
  const d2 = await consume(key, t0);
  const d3 = await consume(key, t0);
  assert.equal(d1.allowed, true);
  assert.equal(d2.allowed, true);
  assert.equal(d3.allowed, true);
  assert.equal(d3.remaining, 0);
  const d4 = await consume(key, t0);
  assert.equal(d4.allowed, false);
  assert.equal(d4.remaining, 0);
  assert.ok(d4.retry_after >= 1 && d4.retry_after <= 60);
  // New window resets.
  const next = new Date(t0.getTime() + 61_000);
  const d5 = await consume(key, next);
  assert.equal(d5.allowed, true);
  assert.equal(d5.remaining, 2);
});

test("per-key override beats default and isolates from other keys", async () => {
  _resetForTests();
  await setLimitForKey("k2", 1);
  const k2 = { id: "k2" };
  const k3 = { id: "k3" };
  const t = new Date("2025-01-01T00:00:00.000Z");
  const a = await consume(k2, t);
  assert.equal(a.limit, 1);
  assert.equal(a.allowed, true);
  const b = await consume(k2, t);
  assert.equal(b.allowed, false, "k2 cap is 1");
  // k3 still on default (3).
  const c = await consume(k3, t);
  assert.equal(c.limit, 3);
  assert.equal(c.allowed, true);
  // Cross-key isolation: consuming k3 must not affect k2.
  const d = await consume(k2, t);
  assert.equal(d.allowed, false);
  assert.equal(await getLimitForKey("k2"), 1);
  assert.equal(await getLimitForKey("k99"), 3);
});

test("override can be cleared back to the default", async () => {
  _resetForTests();
  await setLimitForKey("k4", 7);
  assert.equal(await getLimitForKey("k4"), 7);
  await setLimitForKey("k4", null);
  assert.equal(await getLimitForKey("k4"), 3);
});

test("setLimitForKey rejects out-of-range values", async () => {
  _resetForTests();
  await assert.rejects(() => setLimitForKey("k5", 0));
  await assert.rejects(() => setLimitForKey("k5", -1));
  await assert.rejects(() => setLimitForKey("k5", 100001));
});

test("applyRateHeaders writes standard headers including Retry-After on block", () => {
  _resetForTests();
  const h = new Headers();
  applyRateHeaders(h, {
    allowed: false,
    limit: 10,
    remaining: 0,
    reset_at: 1234567890,
    retry_after: 17,
    window_start: 1234567830,
    used: 10,
  });
  assert.equal(h.get("X-RateLimit-Limit"), "10");
  assert.equal(h.get("X-RateLimit-Remaining"), "0");
  assert.equal(h.get("X-RateLimit-Reset"), "1234567890");
  assert.equal(h.get("X-RateLimit-Window"), "60");
  assert.equal(h.get("Retry-After"), "17");
});

test("applyRateHeaders omits Retry-After on allowed", () => {
  const h = new Headers();
  applyRateHeaders(h, {
    allowed: true,
    limit: 10,
    remaining: 4,
    reset_at: 1,
    retry_after: 0,
    window_start: 0,
    used: 6,
  });
  assert.equal(h.get("Retry-After"), null);
  assert.equal(h.get("X-RateLimit-Remaining"), "4");
});
