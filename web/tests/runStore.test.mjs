// Plain Node test for the run store. Runs with: node --test tests/runStore.test.mjs
// Uses tsx-free path: imports the compiled .ts module via dynamic import after
// running through Node's experimental type stripping (Node >=22 with --experimental-strip-types)
// or via tsx. For portability we register tsx if available.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Use a temp cwd so the store writes into an isolated directory.
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-runstore-"));
process.chdir(tmpRoot);

// Try to load via tsx if present, else native strip-types.
let store;
try {
  // Resolve relative to repo root.
  const repoRoot = path.resolve(import.meta.dirname, "..");
  // Native --experimental-strip-types path: just import the .ts file by URL.
  store = await import(path.join(repoRoot, "lib", "runStore.ts"));
} catch (e) {
  // Fallback: try tsx loader if user pre-registered it.
  throw new Error(
    "Could not import runStore.ts. Run with: node --experimental-strip-types --test tests/runStore.test.mjs",
  );
}

const samplePayload = {
  ticker: "SPY",
  dates: ["2024-01-02", "2024-01-03"],
  close: [470.1, 471.5],
  regime: ["bull", "bull"],
  counts: { bull: 2, chop: 0, bear: 0, crash: 0 },
  snapshot: {
    label: "bull",
    realized_vol: 0.12,
    trend_slope: 0.0008,
    drawdown: -0.01,
    confidence: 0.82,
    risk_scale: 1.0,
    as_of: "2024-01-03",
  },
  disclaimer: "research only",
};

test("create, list, get, rename, delete", async () => {
  await store._resetForTests();

  const created = await store.createRun({
    label: "SPY 2Y",
    ticker: "SPY",
    lookback_days: 504,
    payload: samplePayload,
  });
  assert.equal(typeof created.id, "string");
  assert.equal(created.id.length, 10);
  assert.equal(created.label, "SPY 2Y");

  const listed = await store.listRuns();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const fetched = await store.getRun(created.id);
  assert.ok(fetched);
  assert.equal(fetched.payload.ticker, "SPY");
  assert.equal(fetched.payload.dates.length, 2);

  const renamed = await store.renameRun(created.id, "Custom label");
  assert.ok(renamed);
  assert.equal(renamed.label, "Custom label");

  const missingRename = await store.renameRun("does-not-ex", "x");
  assert.equal(missingRename, null);

  const ok = await store.deleteRun(created.id);
  assert.equal(ok, true);
  const after = await store.listRuns();
  assert.equal(after.length, 0);

  const okAgain = await store.deleteRun(created.id);
  assert.equal(okAgain, false);
});

test("list returns newest first", async () => {
  await store._resetForTests();
  const a = await store.createRun({
    label: "A",
    ticker: "SPY",
    lookback_days: 252,
    payload: samplePayload,
  });
  // Force the second created_at to be later.
  await new Promise((r) => setTimeout(r, 5));
  const b = await store.createRun({
    label: "B",
    ticker: "QQQ",
    lookback_days: 252,
    payload: samplePayload,
  });
  const listed = await store.listRuns();
  assert.equal(listed[0].id, b.id);
  assert.equal(listed[1].id, a.id);
});

test("ids are unique across many runs", async () => {
  await store._resetForTests();
  const ids = new Set();
  for (let i = 0; i < 25; i++) {
    const r = await store.createRun({
      label: `r${i}`,
      ticker: "SPY",
      lookback_days: 252,
      payload: samplePayload,
    });
    ids.add(r.id);
  }
  assert.equal(ids.size, 25);
});
