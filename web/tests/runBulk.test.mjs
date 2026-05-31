// Test bulk run operations.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-bulk-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "runStore.ts"));

const basePayload = {
  ticker: "SPY",
  dates: ["2024-01-02"],
  close: [470.1],
  regime: ["bull"],
  counts: { bull: 1, chop: 0, bear: 0, crash: 0 },
  snapshot: {
    label: "bull",
    realized_vol: 0.12,
    trend_slope: 0.0008,
    drawdown: -0.01,
    confidence: 0.82,
    risk_scale: 1.0,
    as_of: "2024-01-02",
  },
  disclaimer: "research only",
};

async function seed(n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const r = await store.createRun({
      label: `run-${i}`,
      ticker: "SPY",
      lookback_days: 30,
      payload: basePayload,
      tags: i % 2 === 0 ? ["even"] : ["odd"],
    });
    ids.push(r.id);
  }
  return ids;
}

test("bulkRunOp: delete subset", async () => {
  await store._resetForTests();
  const ids = await seed(4);
  const res = await store.bulkRunOp([ids[0], ids[2], "missing-id"], "delete");
  assert.equal(res.requested, 3);
  assert.equal(res.matched, 2);
  assert.equal(res.affected, 2);
  const remaining = await store.listRuns();
  assert.equal(remaining.length, 2);
  const remainingIds = remaining.map((r) => r.id).sort();
  assert.deepEqual(remainingIds, [ids[1], ids[3]].sort());
});

test("bulkRunOp: pin then unpin idempotent", async () => {
  await store._resetForTests();
  const ids = await seed(3);
  const pinned1 = await store.bulkRunOp(ids, "pin");
  assert.equal(pinned1.affected, 3);
  const pinned2 = await store.bulkRunOp(ids, "pin");
  assert.equal(pinned2.affected, 0, "pinning already-pinned is a noop");
  const unpinned = await store.bulkRunOp(ids, "unpin");
  assert.equal(unpinned.affected, 3);
  const after = await store.listRuns();
  for (const r of after) assert.notEqual(r.pinned, true);
});

test("bulkRunOp: add_tags merges and dedupes", async () => {
  await store._resetForTests();
  const ids = await seed(2);
  const res = await store.bulkRunOp(ids, "add_tags", ["alpha", "beta", "alpha"]);
  assert.equal(res.affected, 2);
  const after = await store.listRuns();
  for (const r of after) {
    const tags = r.tags ?? [];
    assert.ok(tags.includes("alpha"), `missing alpha in ${JSON.stringify(tags)}`);
    assert.ok(tags.includes("beta"));
  }
});

test("bulkRunOp: remove_tags only drops specified", async () => {
  await store._resetForTests();
  const ids = await seed(2);
  await store.bulkRunOp(ids, "add_tags", ["alpha", "beta"]);
  const res = await store.bulkRunOp(ids, "remove_tags", ["beta"]);
  assert.equal(res.affected, 2);
  const after = await store.listRuns();
  for (const r of after) {
    const tags = r.tags ?? [];
    assert.ok(tags.includes("alpha"));
    assert.ok(!tags.includes("beta"));
  }
});

test("bulkRunOp: set_tags replaces", async () => {
  await store._resetForTests();
  const ids = await seed(1);
  await store.bulkRunOp(ids, "add_tags", ["alpha"]);
  const res = await store.bulkRunOp(ids, "set_tags", ["gamma"]);
  assert.equal(res.affected, 1);
  const after = await store.listRuns();
  assert.deepEqual(after[0].tags, ["gamma"]);
});
