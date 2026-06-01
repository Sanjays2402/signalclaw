// node --experimental-strip-types --test tests/alertTenantIsolation.test.mjs
//
// Pins the per-API-key alert multi-tenancy policy:
//   - alerts armed by tenant A are invisible to tenant B
//   - delete by tenant B against tenant A's id is a no-op (false)
//   - runCheck only sees the caller's own armed alerts
//   - clearHistory only clears the caller's bucket
//   - admin aggregate summary sees every bucket (counts only, never rows)
//   - legacy { alerts, history } file shape migrates into the operator bucket
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-alerts-tenant-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "alertStore.ts"));

const DATA_FILE = path.join(tmpRoot, ".data", "alerts.json");
async function reset() {
  try { await fs.unlink(DATA_FILE); } catch { /* ignore */ }
}

const A = "key_aaaaaa";
const B = "key_bbbbbb";

test("alerts are scoped per ownerId: A cannot see B's alerts", async () => {
  await reset();
  const r1 = await store.createAlert(
    { ticker: "AAPL", condition: "price_above", value: 200 },
    A,
  );
  assert.equal(r1.ok, true);
  const r2 = await store.createAlert(
    { ticker: "NVDA", condition: "price_above", value: 800 },
    B,
  );
  assert.equal(r2.ok, true);

  const aList = await store.listAlerts(A);
  const bList = await store.listAlerts(B);
  assert.equal(aList.length, 1);
  assert.equal(aList[0].ticker, "AAPL");
  assert.equal(bList.length, 1);
  assert.equal(bList[0].ticker, "NVDA");

  // Operator bucket sees neither tenant's alerts.
  const operatorList = await store.listAlerts();
  assert.equal(operatorList.length, 0);
});

test("delete from wrong tenant is a no-op against the owner's bucket", async () => {
  await reset();
  const a = await store.createAlert(
    { ticker: "MSFT", condition: "price_above", value: 300 },
    A,
  );
  assert.equal(a.ok, true);
  const id = a.alert.id;

  // Tenant B attempts to delete A's alert.
  const wrong = await store.deleteAlert(id, B);
  assert.equal(wrong, false, "cross-tenant delete must not affect owner");

  // Operator session also cannot reach into tenant A's bucket.
  const operatorWrong = await store.deleteAlert(id);
  assert.equal(operatorWrong, false);

  // A still has the alert.
  const stillHere = (await store.listAlerts(A)).some((x) => x.id === id);
  assert.equal(stillHere, true);

  // Owner can delete; second delete is then a no-op.
  assert.equal(await store.deleteAlert(id, A), true);
  assert.equal(await store.deleteAlert(id, A), false);
});

test("runCheck only sees the caller's own alerts and writes only their history", async () => {
  await reset();
  const a = await store.createAlert(
    { ticker: "AMD", condition: "price_above", value: 100, cooldown_hours: 0 },
    A,
  );
  assert.equal(a.ok, true);
  const b = await store.createAlert(
    { ticker: "INTC", condition: "price_above", value: 50, cooldown_hours: 0 },
    B,
  );
  assert.equal(b.ok, true);

  const aOut = await store.runCheck({ AMD: 250, INTC: 80 }, { ownerId: A });
  assert.equal(aOut.checked, 1, "A.runCheck must only see A's alerts");
  assert.equal(aOut.hits.length, 1);
  assert.equal(aOut.hits[0].ticker, "AMD");

  // B's history is untouched by A's runCheck.
  const bHist0 = await store.listHistory({ limit: 10, offset: 0, ownerId: B });
  assert.equal(bHist0.total, 0);

  const bOut = await store.runCheck({ AMD: 250, INTC: 80 }, { ownerId: B });
  assert.equal(bOut.checked, 1);
  assert.equal(bOut.hits[0].ticker, "INTC");

  const aHist = await store.listHistory({ limit: 10, offset: 0, ownerId: A });
  const bHist = await store.listHistory({ limit: 10, offset: 0, ownerId: B });
  assert.equal(aHist.total, 1);
  assert.equal(aHist.events[0].ticker, "AMD");
  assert.equal(bHist.total, 1);
  assert.equal(bHist.events[0].ticker, "INTC");
});

test("clearHistory only clears the caller's bucket", async () => {
  await reset();
  const a = await store.createAlert(
    { ticker: "GME", condition: "price_above", value: 10, cooldown_hours: 0 },
    A,
  );
  assert.equal(a.ok, true);
  const b = await store.createAlert(
    { ticker: "AMC", condition: "price_above", value: 5, cooldown_hours: 0 },
    B,
  );
  assert.equal(b.ok, true);

  await store.runCheck({ GME: 50 }, { ownerId: A });
  await store.runCheck({ AMC: 25 }, { ownerId: B });

  const removed = await store.clearHistory(A);
  assert.equal(removed, 1);

  assert.equal((await store.listHistory({ limit: 10, offset: 0, ownerId: A })).total, 0);
  assert.equal((await store.listHistory({ limit: 10, offset: 0, ownerId: B })).total, 1);
});

test("admin aggregate summary lists every tenant with counts only", async () => {
  await reset();
  await store.createAlert({ ticker: "AAPL", condition: "price_above", value: 200 }, A);
  await store.createAlert({ ticker: "MSFT", condition: "price_below", value: 100 }, A);
  await store.createAlert({ ticker: "NVDA", condition: "price_above", value: 800 }, B);

  const sum = await store.listTenantSummary();
  const owners = sum.tenants.map((t) => t.owner_id).sort();
  assert.deepEqual(owners, [A, B].sort());
  assert.equal(sum.total_alerts, 3);

  const aRow = sum.tenants.find((t) => t.owner_id === A);
  const bRow = sum.tenants.find((t) => t.owner_id === B);
  assert.equal(aRow.alert_count, 2);
  assert.equal(aRow.armed, 2);
  assert.equal(bRow.alert_count, 1);

  // Aggregate exposes counts only, never the raw alert rows.
  for (const t of sum.tenants) {
    assert.equal("alerts" in t, false, "aggregate must not expose alert rows");
    assert.equal("history" in t, false, "aggregate must not expose history rows");
  }
});

test("legacy { alerts, history } file shape migrates into the operator bucket", async () => {
  await reset();
  const dir = path.join(tmpRoot, ".data");
  await fs.mkdir(dir, { recursive: true });
  const legacy = {
    alerts: [
      {
        id: "legacy-1",
        ticker: "TSLA",
        condition: "price_above",
        value: 100,
        note: "",
        cooldown_hours: 12,
        enabled: true,
        last_fired_at: null,
        created_at: "2024-01-01T00:00:00.000Z",
      },
    ],
    history: [],
  };
  await fs.writeFile(DATA_FILE, JSON.stringify(legacy));

  // Default (no ownerId) maps to operator bucket and surfaces legacy rows.
  const operatorList = await store.listAlerts();
  assert.equal(operatorList.length, 1);
  assert.equal(operatorList[0].id, "legacy-1");

  // A fresh tenant key sees nothing — no cross-bucket bleed from migration.
  const aList = await store.listAlerts("key_zzzzzz");
  assert.equal(aList.length, 0);
});
