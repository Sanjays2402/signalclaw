// Plain Node test for watches export helpers.
// Run with: node --experimental-strip-types --test tests/watchesExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "watchesExport.ts"));

const sample = [
  {
    id: "w2",
    ticker: "SPY",
    lookback_days: 180,
    cadence_hours: 24,
    enabled: true,
    label: "SPY daily check",
    created_at: "2026-05-10T00:00:00Z",
    last_run_at: "2026-06-02T12:00:00Z",
    last_run_id: "r1",
    last_regime: "trend-up",
    last_error: null,
    runs_count: 12,
  },
  {
    id: "w1",
    ticker: "AAPL",
    lookback_days: 365,
    cadence_hours: 4,
    enabled: false,
    label: "Apple, watchlist",
    created_at: "2026-04-01T00:00:00Z",
    last_run_at: null,
    last_run_id: null,
    last_regime: null,
    last_error: "fetch failed: 500",
    runs_count: 0,
  },
];

test("CSV header is stable", () => {
  const csv = mod.watchesToCSV([]);
  assert.equal(
    csv.split("\n")[0],
    "ticker,label,cadence_hours,lookback_days,enabled,last_regime,last_run_at,runs_count,last_error,created_at,id",
  );
});

test("CSV sorts by ticker asc", () => {
  const csv = mod.watchesToCSV(sample);
  const iAAPL = csv.indexOf("AAPL,");
  const iSPY = csv.indexOf("SPY,");
  assert.ok(iAAPL > 0 && iSPY > iAAPL, `got AAPL@${iAAPL}, SPY@${iSPY}`);
});

test("CSV quotes commas in labels", () => {
  const csv = mod.watchesToCSV(sample);
  assert.ok(csv.includes('"Apple, watchlist"'));
});

test("CSV serialises enabled flag and numeric counts", () => {
  const csv = mod.watchesToCSV(sample);
  assert.ok(csv.includes(",false,"));
  assert.ok(csv.includes(",true,"));
  assert.ok(/,12,/.test(csv));
});

test("CSV neutralises formula injection in label and last_error", () => {
  const malicious = [
    {
      id: "x1",
      ticker: "XYZ",
      lookback_days: 90,
      cadence_hours: 24,
      enabled: true,
      label: "=HYPERLINK(\"http://evil\",\"x\")",
      created_at: "2026-06-02T00:00:00Z",
      last_run_at: null,
      last_run_id: null,
      last_regime: null,
      last_error: "+cmd|' /C calc'!A1",
      runs_count: 0,
    },
  ];
  const csv = mod.watchesToCSV(malicious);
  assert.ok(csv.includes("\"'=HYPERLINK("));
  assert.ok(csv.includes("'+cmd|' /C calc'!A1") || csv.includes("\"'+cmd|"));
});

test("JSON wraps in {watches: [...]} sorted", () => {
  const json = JSON.parse(mod.watchesToJSON(sample));
  assert.equal(json.watches.length, 2);
  assert.equal(json.watches[0].ticker, "AAPL");
  assert.equal(json.watches[1].ticker, "SPY");
});

test("Filename helper", () => {
  assert.equal(mod.watchesFilename("csv"), "watches.csv");
  assert.equal(mod.watchesFilename("json"), "watches.json");
});
