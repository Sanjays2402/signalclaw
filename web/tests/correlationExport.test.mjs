// Plain Node test for correlation export helpers.
// Run with: node --experimental-strip-types --test tests/correlationExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "correlationExport.ts"));

const sample = {
  window: 60,
  tickers: ["AAPL", "MSFT", "NVDA"],
  matrix: [
    [1, 0.8123, -0.1234],
    [0.8123, 1, 0.4567],
    [-0.1234, 0.4567, 1],
  ],
};

test("correlationToCSV emits header row with empty corner and ticker columns", () => {
  const csv = mod.correlationToCSV(sample);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], ",AAPL,MSFT,NVDA");
  assert.equal(lines[1], "AAPL,1.0000,0.8123,-0.1234");
  assert.equal(lines[2], "MSFT,0.8123,1.0000,0.4567");
  assert.equal(lines[3], "NVDA,-0.1234,0.4567,1.0000");
});

test("correlationToCSV ends with a trailing newline", () => {
  const csv = mod.correlationToCSV(sample);
  assert.ok(csv.endsWith("\n"));
});

test("correlationToCSV handles empty and ragged input safely", () => {
  assert.equal(mod.correlationToCSV({ tickers: [], matrix: [], window: 60 }), "\n");
  const ragged = mod.correlationToCSV({
    tickers: ["A", "B"],
    matrix: [[1]],
    window: 30,
  });
  // Missing cells are emitted as blank to keep the grid rectangular.
  const lines = ragged.trim().split("\n");
  assert.equal(lines[1], "A,1.0000,");
  assert.equal(lines[2], "B,,");
});

test("correlationToCSV quotes ticker labels that contain commas or quotes", () => {
  const csv = mod.correlationToCSV({
    tickers: ['A,B', 'C"D'],
    matrix: [[1, 0], [0, 1]],
    window: 60,
  });
  const lines = csv.split("\n");
  assert.equal(lines[0], ',"A,B","C""D"');
  assert.equal(lines[1], '"A,B",1.0000,0.0000');
  assert.equal(lines[2], '"C""D",0.0000,1.0000');
});

test("correlationToJSON round-trips into a structured payload", () => {
  const json = mod.correlationToJSON(sample);
  const parsed = JSON.parse(json);
  assert.equal(parsed.window, 60);
  assert.deepEqual(parsed.tickers, sample.tickers);
  assert.deepEqual(parsed.matrix, sample.matrix);
});

test("correlationFilename embeds window and extension", () => {
  const csv = mod.correlationFilename(60, "csv");
  const json = mod.correlationFilename(60, "json");
  assert.match(csv, /^signalclaw-correlation-w60-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
  assert.match(json, /^signalclaw-correlation-w60-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
});
