// Plain Node test for the active alerts filter helper.
// Run with: node --experimental-strip-types --test tests/alertFilter.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "alertFilter.ts"));
const { filterAlerts } = mod;

function mk(over) {
  return {
    id: over.id ?? "a1",
    ticker: over.ticker ?? "AAPL",
    condition: over.condition ?? "price_above",
    value: over.value ?? 200,
    note: over.note ?? "",
    cooldown_hours: 12,
    enabled: over.enabled ?? true,
    last_fired_at: null,
  };
}

const alerts = [
  mk({ id: "a", ticker: "AAPL", note: "earnings breakout", enabled: true }),
  mk({ id: "b", ticker: "MSFT", note: "fed week watch", enabled: false }),
  mk({ id: "c", ticker: "NVDA", note: "", enabled: true }),
  mk({ id: "d", ticker: "TSLA", note: "Earnings recap", enabled: false }),
];

test("empty filter returns the input array unchanged", () => {
  const out = filterAlerts(alerts);
  assert.equal(out, alerts);
  const out2 = filterAlerts(alerts, { query: "", state: "" });
  assert.equal(out2, alerts);
});

test("ticker query is case-insensitive and partial", () => {
  const out = filterAlerts(alerts, { query: "nv" });
  assert.deepEqual(out.map((a) => a.id), ["c"]);
});

test("note query is case-insensitive and matches both Earnings and earnings", () => {
  const out = filterAlerts(alerts, { query: "earnings" });
  assert.deepEqual(out.map((a) => a.id), ["a", "d"]);
});

test("state=enabled keeps only enabled alerts", () => {
  const out = filterAlerts(alerts, { state: "enabled" });
  assert.deepEqual(out.map((a) => a.id), ["a", "c"]);
});

test("state=disabled keeps only disabled alerts", () => {
  const out = filterAlerts(alerts, { state: "disabled" });
  assert.deepEqual(out.map((a) => a.id), ["b", "d"]);
});

test("query and state combine with AND semantics", () => {
  const out = filterAlerts(alerts, { query: "earnings", state: "disabled" });
  assert.deepEqual(out.map((a) => a.id), ["d"]);
});

test("query with no match returns empty array", () => {
  const out = filterAlerts(alerts, { query: "zzz" });
  assert.deepEqual(out, []);
});

test("missing note field does not crash and is treated as empty string", () => {
  const noisy = [mk({ id: "x", ticker: "AMD", note: undefined })];
  const out = filterAlerts(noisy, { query: "amd" });
  assert.equal(out.length, 1);
  const none = filterAlerts(noisy, { query: "anything" });
  assert.equal(none.length, 0);
});

test("whitespace-only query is treated as empty filter", () => {
  const out = filterAlerts(alerts, { query: "   " });
  assert.equal(out, alerts);
});
