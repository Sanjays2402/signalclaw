// Plain Node test for stops export helpers.
// Run with: node --experimental-strip-types --test tests/stopsExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "stopsExport.ts"));

const sampleRules = [
  {
    id: "r-2",
    ticker: "MSFT",
    kind: "take_profit",
    value: 480.25,
    high_water: null,
    armed_at: "2026-04-10T12:00:00Z",
    note: "trim, comma here",
  },
  {
    id: "r-1",
    ticker: "AAPL",
    kind: "trailing",
    value: 0.07,
    high_water: 232.5,
    armed_at: "2026-04-09T09:30:00Z",
    note: "",
  },
  {
    id: "r-3",
    ticker: "AAPL",
    kind: "stop_loss",
    value: 195,
    high_water: null,
    armed_at: "2026-04-08T15:45:00Z",
    note: "line; break",
  },
];

test("stopsToCSV: header row matches expected columns", () => {
  const csv = mod.stopsToCSV([]);
  const first = csv.split("\n")[0];
  assert.equal(first, "ticker,kind,value,high_water,armed_at,note,id");
});

test("stopsToCSV: empty rows still emits header with trailing newline", () => {
  const csv = mod.stopsToCSV([]);
  assert.ok(csv.endsWith("\n"));
  assert.equal(csv.split("\n").filter(Boolean).length, 1);
});

test("stopsToCSV: rows are sorted by ticker then kind", () => {
  const csv = mod.stopsToCSV(sampleRules);
  const lines = csv.trim().split("\n");
  // AAPL stop_loss, AAPL trailing, MSFT take_profit
  assert.match(lines[1], /^AAPL,stop_loss,195/);
  assert.match(lines[2], /^AAPL,trailing,0\.07/);
  assert.match(lines[3], /^MSFT,take_profit,480\.25/);
});

test("stopsToCSV: high_water null becomes empty cell, set becomes number", () => {
  const csv = mod.stopsToCSV(sampleRules);
  const lines = csv.trim().split("\n");
  // AAPL trailing has high_water 232.5
  const trailingCols = lines[2].split(",");
  assert.equal(trailingCols[3], "232.5");
  // MSFT take_profit has null high_water
  const tpCols = lines[3].split(",");
  assert.equal(tpCols[3], "");
});

test("stopsToCSV: commas and newlines in note are quoted and escaped", () => {
  const csv = mod.stopsToCSV(sampleRules);
  // MSFT note contains a comma
  assert.ok(csv.includes('"trim, comma here"'));
  // newline in note is quoted when present
  const withNl = mod.stopsToCSV([
    { id: "r", ticker: "Z", kind: "stop_loss", value: 1, high_water: null, armed_at: "", note: "line\nbreak" },
  ]);
  assert.ok(withNl.includes('"line\nbreak"'));
});

test("stopsToCSV: embedded double quote is doubled per RFC 4180", () => {
  const out = mod.stopsToCSV([
    {
      id: "r",
      ticker: "X",
      kind: "stop_loss",
      value: 1,
      high_water: null,
      armed_at: "",
      note: 'he said "no"',
    },
  ]);
  assert.ok(out.includes('"he said ""no"""'));
});

test("stopsToJSON: payload has exported_at, count, rules in sorted order", () => {
  const json = JSON.parse(mod.stopsToJSON(sampleRules));
  assert.equal(json.count, 3);
  assert.match(json.exported_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(json.rules.length, 3);
  assert.equal(json.rules[0].ticker, "AAPL");
  assert.equal(json.rules[0].kind, "stop_loss");
  assert.equal(json.rules[2].ticker, "MSFT");
});

test("stopsToJSON: original input array is not mutated", () => {
  const before = sampleRules.map((r) => r.id).join(",");
  mod.stopsToJSON(sampleRules);
  mod.stopsToCSV(sampleRules);
  const after = sampleRules.map((r) => r.id).join(",");
  assert.equal(before, after);
});

test("stopsFilename: csv and json have ISO date and right extension", () => {
  const csv = mod.stopsFilename("csv");
  const json = mod.stopsFilename("json");
  assert.match(csv, /^signalclaw-stops-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(json, /^signalclaw-stops-\d{4}-\d{2}-\d{2}\.json$/);
});

test("stopsToCSV: non-finite values become empty cells", () => {
  const out = mod.stopsToCSV([
    {
      id: "r",
      ticker: "X",
      kind: "stop_loss",
      value: Number.NaN,
      high_water: Number.POSITIVE_INFINITY,
      armed_at: "",
      note: "",
    },
  ]);
  const cols = out.trim().split("\n")[1].split(",");
  assert.equal(cols[2], "");
  assert.equal(cols[3], "");
});
