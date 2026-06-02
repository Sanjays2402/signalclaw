// Plain Node test for alert history export helpers.
// Run with: node --experimental-strip-types --test tests/alertHistoryExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "alertStore.ts"));

const events = [
  {
    alert_id: "a1",
    ticker: "AAPL",
    condition: "price_above",
    value: 200,
    observed: 201.5,
    fired_at: "2025-01-02T10:00:00.000Z",
    note: "breakout",
  },
  {
    alert_id: "a2",
    ticker: "MSFT",
    condition: "pct_change_below",
    value: -0.05,
    observed: -0.061,
    fired_at: "2025-01-01T09:00:00.000Z",
    note: 'with "quotes", and a comma',
  },
];

test("eventsToCSV emits a header and one row per event", () => {
  const csv = store.eventsToCSV(events);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "fired_at,ticker,condition,value,observed,alert_id,note");
  assert.equal(
    lines[1],
    "2025-01-02T10:00:00.000Z,AAPL,price_above,200,201.5,a1,breakout",
  );
  // Note with comma + quotes must be quoted and have doubled quotes.
  assert.ok(lines[2].endsWith(',"with ""quotes"", and a comma"'));
});

test("eventsToCSV handles an empty list with header only", () => {
  const csv = store.eventsToCSV([]);
  assert.equal(csv, "fired_at,ticker,condition,value,observed,alert_id,note\n");
});

test("eventsToJSON wraps events with count and exported_at", () => {
  const json = JSON.parse(store.eventsToJSON(events));
  assert.equal(json.count, 2);
  assert.equal(json.events.length, 2);
  assert.equal(json.events[0].ticker, "AAPL");
  assert.ok(typeof json.exported_at === "string");
});
