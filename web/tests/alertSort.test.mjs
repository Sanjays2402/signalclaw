// Plain Node test for the alerts sort helper.
// Run with: node --experimental-strip-types --test tests/alertSort.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const { sortAlerts } = await import(path.join(repoRoot, "lib", "alertSort.ts"));

function mk(over) {
  return {
    id: over.id ?? "a1",
    ticker: over.ticker ?? "AAPL",
    condition: over.condition ?? "price_above",
    value: over.value ?? 100,
    note: over.note ?? "",
    cooldown_hours: over.cooldown_hours ?? 12,
    enabled: over.enabled ?? true,
    last_fired_at: over.last_fired_at ?? null,
  };
}

const alerts = [
  mk({ id: "a", ticker: "MSFT", value: 420, cooldown_hours: 24, last_fired_at: "2025-01-10T10:00:00Z" }),
  mk({ id: "b", ticker: "AAPL", value: 200, cooldown_hours: 6,  last_fired_at: null }),
  mk({ id: "c", ticker: "NVDA", value: "950", cooldown_hours: 12, last_fired_at: "2025-02-01T00:00:00Z" }),
  mk({ id: "d", ticker: "TSLA", value: 300, cooldown_hours: 12, last_fired_at: "2024-12-01T00:00:00Z" }),
];

test("does not mutate the input array", () => {
  const before = alerts.map((a) => a.id);
  sortAlerts(alerts, "ticker", "asc");
  assert.deepEqual(alerts.map((a) => a.id), before);
});

test("ticker asc and desc", () => {
  assert.deepEqual(sortAlerts(alerts, "ticker", "asc").map((a) => a.id), ["b", "a", "c", "d"]);
  assert.deepEqual(sortAlerts(alerts, "ticker", "desc").map((a) => a.id), ["d", "c", "a", "b"]);
});

test("value asc parses string values numerically", () => {
  assert.deepEqual(sortAlerts(alerts, "value", "asc").map((a) => a.id), ["b", "d", "a", "c"]);
});

test("value desc", () => {
  assert.deepEqual(sortAlerts(alerts, "value", "desc").map((a) => a.id), ["c", "a", "d", "b"]);
});

test("cooldown asc", () => {
  assert.deepEqual(sortAlerts(alerts, "cooldown", "asc").map((a) => a.id), ["b", "c", "d", "a"]);
});

test("last_fired desc puts most recent first and never-fired last", () => {
  const out = sortAlerts(alerts, "last_fired", "desc").map((a) => a.id);
  assert.deepEqual(out, ["c", "a", "d", "b"]);
});

test("last_fired asc puts oldest fire first but still sinks never-fired to the bottom", () => {
  const out = sortAlerts(alerts, "last_fired", "asc").map((a) => a.id);
  assert.deepEqual(out, ["d", "a", "c", "b"]);
});

test("equal primary keys break ties by ticker then id (stable)", () => {
  const tied = [
    mk({ id: "z", ticker: "AAPL", cooldown_hours: 12 }),
    mk({ id: "a", ticker: "AAPL", cooldown_hours: 12 }),
    mk({ id: "m", ticker: "MSFT", cooldown_hours: 12 }),
  ];
  assert.deepEqual(sortAlerts(tied, "cooldown", "asc").map((a) => a.id), ["a", "z", "m"]);
});

test("empty array returns empty array", () => {
  assert.deepEqual(sortAlerts([], "ticker", "asc"), []);
});
