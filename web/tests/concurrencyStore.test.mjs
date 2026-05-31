// node --experimental-strip-types --test tests/concurrencyStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-concurrency-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "concurrencyStore.ts"));
const {
  getConcurrencyPolicy,
  setConcurrencyPolicy,
  clearConcurrencyPolicy,
  tryAcquire,
  release,
  getInFlight,
  __resetConcurrency,
  MIN_LIMIT,
  MAX_LIMIT,
} = mod;

test("default policy is uncapped", async () => {
  __resetConcurrency();
  const p = await getConcurrencyPolicy();
  assert.equal(p.limit, null);
  assert.equal(p.updated_at, null);
  assert.equal(getInFlight(), 0);
});

test("rejects non-integer limit", async () => {
  __resetConcurrency();
  const r = await setConcurrencyPolicy({ limit: 3.5, actor: "alice" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_limit");
});

test("rejects out-of-range limit", async () => {
  __resetConcurrency();
  const lo = await setConcurrencyPolicy({ limit: MIN_LIMIT - 1, actor: "alice" });
  assert.equal(lo.ok, false);
  const hi = await setConcurrencyPolicy({ limit: MAX_LIMIT + 1, actor: "alice" });
  assert.equal(hi.ok, false);
});

test("set then get round-trips and records actor", async () => {
  __resetConcurrency();
  const r = await setConcurrencyPolicy({ limit: 5, actor: "alice" });
  assert.equal(r.ok, true);
  assert.equal(r.policy.limit, 5);
  assert.equal(r.policy.updated_by, "alice");
  assert.equal(r.before.limit, null);

  const p = await getConcurrencyPolicy();
  assert.equal(p.limit, 5);
});

test("tryAcquire blocks at the cap and Retry-After is set", async () => {
  __resetConcurrency();
  await setConcurrencyPolicy({ limit: 2, actor: "alice" });
  const p = await getConcurrencyPolicy();

  const a = tryAcquire(p);
  const b = tryAcquire(p);
  const c = tryAcquire(p);

  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(c.allowed, false);
  if (c.allowed === false) {
    assert.equal(c.limit, 2);
    assert.equal(c.inFlight, 2);
    assert.equal(c.retryAfter, 1);
  }
  assert.equal(getInFlight(), 2);
});

test("release frees a slot and a blocked caller can then acquire", async () => {
  __resetConcurrency();
  await setConcurrencyPolicy({ limit: 1, actor: "alice" });
  const p = await getConcurrencyPolicy();

  const a = tryAcquire(p);
  assert.equal(a.allowed, true);
  const blocked = tryAcquire(p);
  assert.equal(blocked.allowed, false);
  release();
  assert.equal(getInFlight(), 0);
  const retry = tryAcquire(p);
  assert.equal(retry.allowed, true);
});

test("release is clamped at zero", async () => {
  __resetConcurrency();
  release();
  release();
  assert.equal(getInFlight(), 0);
});

test("uncapped policy always allows acquire", async () => {
  __resetConcurrency();
  await clearConcurrencyPolicy({ actor: "alice" });
  __resetConcurrency();
  const p = await getConcurrencyPolicy();
  assert.equal(p.limit, null);
  for (let i = 0; i < 50; i += 1) {
    const d = tryAcquire(p);
    assert.equal(d.allowed, true);
  }
  assert.equal(getInFlight(), 50);
});

test("clear removes the cap and records actor", async () => {
  __resetConcurrency();
  await setConcurrencyPolicy({ limit: 3, actor: "alice" });
  const r = await clearConcurrencyPolicy({ actor: "bob" });
  assert.equal(r.policy.limit, null);
  assert.equal(r.policy.updated_by, "bob");
  assert.equal(r.before.limit, 3);
});
