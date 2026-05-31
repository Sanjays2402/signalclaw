// Tests for legal hold: open/release flow plus retention + erase blocking.
// Run with: node --experimental-strip-types --test tests/legalHold.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-lhold-"));
process.chdir(tmpRoot);
await fs.mkdir(path.join(tmpRoot, ".data"), { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const lh = await import(path.join(repoRoot, "lib", "legalHoldStore.ts"));
const ret = await import(path.join(repoRoot, "lib", "retentionStore.ts"));
const priv = await import(path.join(repoRoot, "lib", "privacyStore.ts"));

const DATA = path.join(tmpRoot, ".data");

function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

test("openHold validates matter and scopes", async () => {
  await assert.rejects(
    () => lh.openHold({ matter: "", reason: "x", scopes: ["runs"], opened_by: "k1" }),
    /matter_required/,
  );
  await assert.rejects(
    () => lh.openHold({ matter: "m", reason: "x", scopes: [], opened_by: "k1" }),
    /scopes_required/,
  );
});

test("openHold persists and listActiveHolds returns it", async () => {
  const h = await lh.openHold({
    matter: "Acme v. Doe",
    reason: "discovery preservation",
    scopes: ["runs", "audit"],
    opened_by: "key_admin_1",
  });
  assert.ok(h.id);
  assert.equal(h.released_at, null);
  const active = await lh.listActiveHolds();
  assert.equal(active.length, 1);
  assert.equal(active[0].matter, "Acme v. Doe");
});

test("releaseHold requires a non-trivial reason and marks released_at", async () => {
  const active = await lh.listActiveHolds();
  const target = active[0];
  await assert.rejects(
    () => lh.releaseHold({ id: target.id, released_by: "k", released_reason: "ok" }),
    /release_reason_required/,
  );
  const released = await lh.releaseHold({
    id: target.id,
    released_by: "key_admin_1",
    released_reason: "counsel signed off",
  });
  assert.ok(released.released_at);
  assert.equal(released.released_reason, "counsel signed off");
  const stillActive = await lh.listActiveHolds();
  assert.equal(stillActive.length, 0);
});

test("retention sweep skips held scopes and still runs others", async () => {
  // Seed runs (old + new) and webhook deliveries (old + new).
  await fs.writeFile(
    path.join(DATA, "runs.json"),
    JSON.stringify({
      runs: [
        { id: "old", created_at: iso(60), label: "a", ticker: "SPY", lookback_days: 30, tags: [], payload: { ticker: "SPY", dates: [], close: [], regime: [], counts: {}, snapshot: null, disclaimer: "" } },
        { id: "new", created_at: iso(3), label: "b", ticker: "SPY", lookback_days: 30, tags: [], payload: { ticker: "SPY", dates: [], close: [], regime: [], counts: {}, snapshot: null, disclaimer: "" } },
      ],
    }),
  );
  await fs.writeFile(
    path.join(DATA, "webhook-deliveries.json"),
    JSON.stringify([
      { id: "d1", delivered_at: iso(60) },
      { id: "d2", delivered_at: iso(2) },
    ]),
  );

  await ret.setPolicy({ runs_days: 30, audit_days: 0, webhook_deliveries_days: 30 });

  // Open a hold on runs only. Webhook sweep must still happen.
  const hold = await lh.openHold({
    matter: "Hold-runs-1",
    reason: "",
    scopes: ["runs"],
    opened_by: "tester",
  });

  const res = await ret.runRetentionSweep();
  assert.equal(res.counts.runs, 0, "runs purge must be blocked");
  assert.equal(res.skipped.runs.length, 1);
  assert.equal(res.skipped.runs[0].id, hold.id);
  assert.equal(res.counts.webhook_deliveries, 1, "webhook purge proceeds");

  // Runs file untouched.
  const runs = JSON.parse(await fs.readFile(path.join(DATA, "runs.json"), "utf8"));
  assert.equal(runs.runs.length, 2);

  // Release and re-sweep removes the old run.
  await lh.releaseHold({
    id: hold.id,
    released_by: "tester",
    released_reason: "matter closed",
  });
  const res2 = await ret.runRetentionSweep();
  assert.equal(res2.counts.runs, 1);
  const runs2 = JSON.parse(await fs.readFile(path.join(DATA, "runs.json"), "utf8"));
  assert.equal(runs2.runs.length, 1);
  assert.equal(runs2.runs[0].id, "new");
});

test("eraseAll throws legal_hold_active when user_data is held", async () => {
  // Reopen a user_data hold.
  await lh.openHold({
    matter: "Hold-user-data",
    reason: "",
    scopes: ["user_data"],
    opened_by: "tester",
  });

  // Confirm helper reports the blocker.
  const blockers = await priv.eraseBlockingHolds({});
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].matter, "Hold-user-data");

  await assert.rejects(
    () => priv.eraseAll({}),
    (err) => err && err.code === "legal_hold_active",
  );

  // Sanity: runs.json still exists (was not unlinked).
  const stat = await fs.stat(path.join(DATA, "runs.json"));
  assert.ok(stat.size > 0);
});
