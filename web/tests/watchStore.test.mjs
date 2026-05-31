// Plain Node test for the watch store.
// Run with: node --experimental-strip-types --test tests/watchStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-watches-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "watchStore.ts"));

test("creates a watch with normalized ticker and defaults", async () => {
  const r = await store.createWatch({
    ticker: "spy",
    lookback_days: 180,
    cadence_hours: 24,
  });
  assert.equal(r.ok, true);
  assert.equal(r.watch.ticker, "SPY");
  assert.equal(r.watch.lookback_days, 180);
  assert.equal(r.watch.cadence_hours, 24);
  assert.equal(r.watch.enabled, true);
  assert.equal(r.watch.runs_count, 0);
  assert.equal(r.watch.last_run_at, null);
  assert.ok(r.watch.id);
  assert.match(r.watch.label, /SPY/);
});

test("rejects bad ticker, lookback, cadence", async () => {
  const a = await store.createWatch({ ticker: "??", lookback_days: 30, cadence_hours: 24 });
  assert.equal(a.ok, false);
  assert.equal(a.err.code, "bad_ticker");

  const b = await store.createWatch({ ticker: "AAPL", lookback_days: 5, cadence_hours: 24 });
  assert.equal(b.ok, false);
  assert.equal(b.err.code, "bad_lookback");

  const c = await store.createWatch({ ticker: "AAPL", lookback_days: 180, cadence_hours: 7 });
  assert.equal(c.ok, false);
  assert.equal(c.err.code, "bad_cadence");
});

test("blocks duplicates with same ticker/lookback/cadence", async () => {
  const dup = await store.createWatch({ ticker: "SPY", lookback_days: 180, cadence_hours: 24 });
  assert.equal(dup.ok, false);
  assert.equal(dup.err.code, "duplicate");
});

test("isDue: never-run watch is due, paused watch is not", async () => {
  const list = await store.listWatches();
  const w = list[0];
  assert.equal(store.isDue(w), true);

  const updated = await store.setEnabled(w.id, false);
  assert.equal(updated.enabled, false);
  assert.equal(store.isDue(updated), false);
  await store.setEnabled(w.id, true);
});

test("recordRunResult stamps last_run + counts on success only", async () => {
  const list = await store.listWatches();
  const w = list[0];

  // Failed run: no run_id, no counter bump
  const failed = await store.recordRunResult(w.id, { run_id: null, regime: null, error: "boom" });
  assert.equal(failed.runs_count, 0);
  assert.equal(failed.last_error, "boom");
  assert.ok(failed.last_run_at);

  // Successful run: counter bumps, error clears
  const ok = await store.recordRunResult(w.id, { run_id: "abc123", regime: "bull", error: null });
  assert.equal(ok.runs_count, 1);
  assert.equal(ok.last_run_id, "abc123");
  assert.equal(ok.last_regime, "bull");
  assert.equal(ok.last_error, null);

  // After a fresh run, watch is not due until cadence elapses
  assert.equal(store.isDue(ok, new Date(Date.parse(ok.last_run_at) + 60_000)), false);
  // After cadence elapses it is due
  assert.equal(store.isDue(ok, new Date(Date.parse(ok.last_run_at) + 25 * 3600_000)), true);
});

test("deleteWatch removes the row", async () => {
  const before = await store.listWatches();
  const id = before[0].id;
  const ok = await store.deleteWatch(id);
  assert.equal(ok, true);
  const after = await store.listWatches();
  assert.equal(after.find((w) => w.id === id), undefined);
});
