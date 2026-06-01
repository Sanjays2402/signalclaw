// node --experimental-strip-types --test tests/runReadTenantIsolation.test.mjs
//
// Pins the per-API-key /api/v1/runs READ tenancy policy:
//   - runs created by key A are not visible to key B via list, get, export, pdf
//   - admin keys see everything
//   - legacy/dashboard rows (no created_by_key_id) stay visible to any read key
//   - queryRuns({ ownerFilter }) excludes other tenants from totals + page
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-runs-tenant-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const runStore = await import(path.join(repoRoot, "lib", "runStore.ts"));
const runAcl = await import(path.join(repoRoot, "lib", "runAcl.ts"));

const DATA_FILE = path.join(tmpRoot, ".data", "runs.json");
async function reset() {
  try { await fs.unlink(DATA_FILE); } catch { /* ignore */ }
}

const KEY_A = { id: "key_aaaaaa", scopes: ["read", "trade"] };
const KEY_B = { id: "key_bbbbbb", scopes: ["read", "trade"] };
const KEY_ADMIN = { id: "key_admin1", scopes: ["admin"] };

function basePayload(ticker) {
  return {
    ticker,
    dates: ["2026-01-01"],
    close: [100],
    regime: ["calm"],
    counts: { calm: 1 },
    snapshot: {
      label: "calm",
      realized_vol: 0.1,
      trend_slope: 0,
      drawdown: 0,
      confidence: 0.9,
      risk_scale: 1,
      as_of: "2026-01-01",
    },
    disclaimer: "test",
  };
}

async function mkRun(ticker, ownerKey) {
  return runStore.createRun({
    label: `${ticker} run`,
    ticker,
    lookback_days: 30,
    tags: [],
    notes: "",
    pinned: false,
    pinned_at: null,
    created_by_key_id: ownerKey ? ownerKey.id : null,
    created_by_key_label: ownerKey ? `label-${ownerKey.id}` : null,
    payload: basePayload(ticker),
  });
}

test("decideRunRead: owner allowed, non-owner denied, admin allowed, unowned shared", () => {
  const owned = { created_by_key_id: KEY_A.id };
  const legacy = { created_by_key_id: null };

  assert.equal(runAcl.decideRunRead(owned, KEY_A).allowed, true);
  const denied = runAcl.decideRunRead(owned, KEY_B);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "not_owner");
  assert.equal(denied.ownerKeyId, KEY_A.id);
  assert.equal(runAcl.decideRunRead(owned, KEY_ADMIN).allowed, true);
  assert.equal(runAcl.decideRunRead(legacy, KEY_B).allowed, true);
});

test("queryRuns ownerFilter: key B never sees key A's owned rows", async () => {
  await reset();
  const a1 = await mkRun("AAPL", KEY_A);
  const a2 = await mkRun("MSFT", KEY_A);
  const b1 = await mkRun("NVDA", KEY_B);
  const legacy = await mkRun("SPY", null);

  const bView = await runStore.queryRuns({
    ownerFilter: runAcl.ownerFilterForKey(KEY_B),
    limit: 100,
  });
  const bIds = bView.runs.map((r) => r.id).sort();
  assert.deepEqual(bIds, [b1.id, legacy.id].sort());
  assert.equal(bView.total, 2, "totals must reflect tenant view, not global");

  const aView = await runStore.queryRuns({
    ownerFilter: runAcl.ownerFilterForKey(KEY_A),
    limit: 100,
  });
  const aIds = aView.runs.map((r) => r.id).sort();
  assert.deepEqual(aIds, [a1.id, a2.id, legacy.id].sort());

  const adminView = await runStore.queryRuns({
    ownerFilter: runAcl.ownerFilterForKey(KEY_ADMIN),
    limit: 100,
  });
  assert.equal(adminView.total, 4);
});

test("queryRuns without ownerFilter returns every row (internal callers)", async () => {
  await reset();
  await mkRun("AAPL", KEY_A);
  await mkRun("NVDA", KEY_B);
  const all = await runStore.queryRuns({ limit: 100 });
  assert.equal(all.total, 2);
});

test("non-owner cannot probe a sibling tenant's run via decideRunRead chain", async () => {
  await reset();
  const a = await mkRun("AAPL", KEY_A);
  // Simulate what the route does: fetch then ACL.
  const fetched = await runStore.getRun(a.id);
  assert.ok(fetched);
  const decision = runAcl.decideRunRead(fetched, KEY_B);
  assert.equal(decision.allowed, false);
  // Route must translate this to 404, never 403, to avoid id-existence leak.
});
