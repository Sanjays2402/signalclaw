// Plain Node test for earnings export helpers.
// Run with: node --experimental-strip-types --test tests/earningsExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "earningsExport.ts"));

const sample = [
  { ticker: "MSFT", next_report: "2026-07-22", confirmed: true, source: "manual" },
  { ticker: "AAPL", next_report: "2026-07-25", confirmed: false, source: "manual" },
  { ticker: "NVDA", next_report: "2026-07-22", confirmed: true, source: "import" },
];

test("earningsToCSV emits header and rows sorted by date then ticker", () => {
  const csv = mod.earningsToCSV(sample);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "ticker,next_report,confirmed,source");
  assert.equal(lines[1], "MSFT,2026-07-22,true,manual");
  assert.equal(lines[2], "NVDA,2026-07-22,true,import");
  assert.equal(lines[3], "AAPL,2026-07-25,false,manual");
});

test("earningsToCSV ends with a trailing newline", () => {
  assert.ok(mod.earningsToCSV(sample).endsWith("\n"));
});

test("earningsToCSV escapes commas, quotes, and newlines in source", () => {
  const csv = mod.earningsToCSV([
    { ticker: "X", next_report: "2026-08-01", confirmed: false, source: 'a,"b"\nc' },
  ]);
  assert.equal(
    csv,
    'ticker,next_report,confirmed,source\nX,2026-08-01,false,"a,""b""\nc"\n',
  );
});

test("earningsToCSV handles empty list", () => {
  const csv = mod.earningsToCSV([]);
  assert.equal(csv, "ticker,next_report,confirmed,source\n");
});

test("earningsToJSON sorts rows and normalizes booleans and missing source", () => {
  const json = mod.earningsToJSON([
    { ticker: "AAPL", next_report: "2026-07-25", confirmed: false, source: "manual" },
    { ticker: "MSFT", next_report: "2026-07-22", confirmed: true, source: "" },
  ]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].ticker, "MSFT");
  assert.equal(parsed.rows[0].confirmed, true);
  assert.equal(parsed.rows[1].ticker, "AAPL");
  assert.equal(parsed.rows[1].source, "manual");
});

test("earningsFilename encodes window and extension", () => {
  assert.match(mod.earningsFilename(7, "csv"), /^signalclaw-earnings-7d-.+\.csv$/);
  assert.match(mod.earningsFilename(null, "json"), /^signalclaw-earnings-all-.+\.json$/);
});
