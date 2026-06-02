// Date-range filter on alert fire history.
// Run with: node --experimental-strip-types --test tests/alertHistoryDateRange.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-alerts-date-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "alertStore.ts"));

// Seed the store directly so we can pin fired_at timestamps across days
// without depending on real clock motion or check-loop side effects.
const events = [
  { alert_id: "a1", ticker: "AAPL", condition: "price_above", value: 100, observed: 105, note: "", fired_at: "2025-01-01T10:00:00.000Z" },
  { alert_id: "a2", ticker: "AAPL", condition: "price_above", value: 100, observed: 110, note: "", fired_at: "2025-01-05T10:00:00.000Z" },
  { alert_id: "a3", ticker: "MSFT", condition: "price_above", value: 200, observed: 210, note: "", fired_at: "2025-01-10T10:00:00.000Z" },
  { alert_id: "a4", ticker: "NVDA", condition: "price_above", value: 500, observed: 600, note: "", fired_at: "2025-02-01T10:00:00.000Z" },
];
const dataDir = path.join(process.cwd(), ".data");
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(
  path.join(dataDir, "alerts.json"),
  JSON.stringify({ tenants: { [store.OPERATOR_OWNER_ID]: { alerts: [], history: events } } }, null, 2),
);

test("filterHistoryEvents respects inclusive from/to bounds", () => {
  const all = events.slice();
  const got = store.filterHistoryEvents(all, { from: "2025-01-05", to: "2025-01-10" });
  assert.deepEqual(got.map((e) => e.alert_id).sort(), ["a2", "a3"]);
});

test("filterHistoryEvents combines ticker + date range", () => {
  const got = store.filterHistoryEvents(events, { ticker: "AAPL", from: "2025-01-02" });
  assert.deepEqual(got.map((e) => e.alert_id), ["a2"]);
});

test("filterHistoryEvents ignores malformed dates instead of dropping everything", () => {
  const got = store.filterHistoryEvents(events, { from: "yesterday", to: "" });
  assert.equal(got.length, events.length);
});

test("listHistory paginates the filtered window", async () => {
  const page = await store.listHistory({ from: "2025-01-01", to: "2025-01-31", limit: 10, offset: 0 });
  assert.equal(page.total, 3);
  assert.equal(page.events.length, 3);
  // Newest first.
  assert.equal(page.events[0].alert_id, "a3");
  assert.equal(page.events[2].alert_id, "a1");
});

test("listAllHistory mirrors the filter set for exports", async () => {
  const all = await store.listAllHistory({ ticker: "AAPL", to: "2025-01-03" });
  assert.deepEqual(all.map((e) => e.alert_id), ["a1"]);
});

test("from after to yields empty result without throwing", async () => {
  const page = await store.listHistory({ from: "2025-03-01", to: "2025-02-01", limit: 10, offset: 0 });
  assert.equal(page.total, 0);
  assert.equal(page.events.length, 0);
});
