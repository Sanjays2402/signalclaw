// node --experimental-strip-types --test tests/keyUsageStore.test.mjs
//
// Proves per-API-key usage analytics: counters are bucketed by UTC day,
// status class, and route_class; lifetime totals roll up; cross-key
// isolation holds (one key's traffic never leaks into another key's
// summary); the dense daily axis is the requested length even when the
// store is empty; and the public summariser never returns the raw hash
// or any other secret-shaped field.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-keyusage-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "keyUsageStore.ts"));
const { recordRequest, getUsage, summarise, RETENTION_DAYS, _resetForTests } =
  store;

await _resetForTests();

test("recordRequest buckets by status class and route_class", async () => {
  await recordRequest({ key_id: "k1", route_class: "runs", status: 200 });
  await recordRequest({ key_id: "k1", route_class: "runs", status: 200 });
  await recordRequest({ key_id: "k1", route_class: "runs", status: 404 });
  await recordRequest({ key_id: "k1", route_class: "alerts", status: 500 });
  const u = await getUsage("k1");
  assert.ok(u);
  assert.equal(u.total, 4);
  assert.equal(u.buckets.length, 1, "all writes land in today's bucket");
  const today = u.buckets[0];
  assert.equal(today.routes.runs["2xx"], 2);
  assert.equal(today.routes.runs["4xx"], 1);
  assert.equal(today.routes.alerts["5xx"], 1);
});

test("summarise returns a dense daily axis of the requested length", async () => {
  const s = await summarise(await getUsage("k1"), 7);
  assert.equal(s.daily.length, 7);
  assert.equal(s.window_days, 7);
  // last entry of the axis is today, and it should hold the 4 calls above
  const last = s.daily[s.daily.length - 1];
  assert.equal(last.total, 4);
  assert.equal(last.success, 2);
  assert.equal(last.client_error, 1);
  assert.equal(last.server_error, 1);
  assert.equal(s.window_total, 4);
});

test("cross-key isolation: k1 traffic does not appear in k2 summary", async () => {
  await recordRequest({ key_id: "k2", route_class: "runs", status: 200 });
  const u2 = await getUsage("k2");
  assert.equal(u2.total, 1);
  const s2 = await summarise(u2, 7);
  assert.equal(s2.window_total, 1);
  // critical procurement claim: summary for k2 must not include k1's 4 calls
  assert.notEqual(s2.window_total, 5);
  const s1 = await summarise(await getUsage("k1"), 7);
  assert.equal(s1.window_total, 4);
});

test("summarise on unknown key returns an empty dense window, no leak", async () => {
  const s = await summarise(await getUsage("does-not-exist"), 14);
  assert.equal(s.window_days, 14);
  assert.equal(s.daily.length, 14);
  assert.equal(s.window_total, 0);
  assert.equal(s.last_request_at, null);
  assert.deepEqual(s.by_route, []);
  // never returns anything that looks like a secret
  for (const k of Object.keys(s)) {
    assert.equal(/hash|secret|token/i.test(k), false);
  }
});

test("RETENTION_DAYS bounds the bucket history", async () => {
  // simulate ancient buckets by writing many requests across synthetic days
  for (let i = 0; i < RETENTION_DAYS + 5; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    await recordRequest({ key_id: "k3", route_class: "runs", status: 200, at: d });
  }
  const u = await getUsage("k3");
  assert.ok(u.buckets.length <= RETENTION_DAYS, "ring buffer caps history");
});
