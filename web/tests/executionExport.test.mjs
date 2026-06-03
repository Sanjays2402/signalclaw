// Plain Node test for execution simulator export helpers.
// Run with: node --experimental-strip-types --test tests/executionExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "executionExport.ts"));

function sampleReport(overrides = {}) {
  return {
    ticker: "aapl",
    side: "buy",
    requested_shares: 10000,
    filled_shares: 10000,
    unfilled_shares: 0,
    arrival_price: 200,
    avg_fill_price: 200.1234,
    interval_vwap: 200.05,
    notional: 2001234,
    commission_total: 50,
    slippage_vs_arrival_bps: 6.17,
    slippage_vs_vwap_bps: 3.69,
    fills: [
      { bar_index: 2, shares: 3000, fill_price: 200.5, market_price: 200.4, participation: 0.15, slippage_bps: 5, commission: 15 },
      { bar_index: 0, shares: 4000, fill_price: 199.9, market_price: 200.0, participation: 0.2, slippage_bps: -5, commission: 20 },
      { bar_index: 1, shares: 3000, fill_price: 200.0, market_price: 200.0, participation: 0.1, slippage_bps: 0, commission: 15 },
    ],
    ...overrides,
  };
}

test("executionToCSV emits header and sorts fills by bar_index ascending", () => {
  const csv = mod.executionToCSV(sampleReport());
  const lines = csv.trim().split("\n");
  assert.equal(
    lines[0],
    "ticker,side,bar_index,shares,fill_price,market_price,participation_pct,slippage_bps,commission,arrival_price,avg_fill_price,interval_vwap,slippage_vs_arrival_bps,slippage_vs_vwap_bps",
  );
  assert.equal(lines.length, 4);
  // Bars must appear in order 0,1,2 even though the input was 2,0,1.
  assert.match(lines[1], /^AAPL,buy,0,/);
  assert.match(lines[2], /^AAPL,buy,1,/);
  assert.match(lines[3], /^AAPL,buy,2,/);
});

test("executionToCSV uppercases ticker and formats numerics with fixed decimals", () => {
  const csv = mod.executionToCSV(sampleReport());
  const lines = csv.trim().split("\n");
  // First fill: bar 0, 4000 shares, fill 199.9000, market 200.0000, part 20.00
  assert.equal(
    lines[1],
    "AAPL,buy,0,4000,199.9000,200.0000,20.00,-5.00,20.0000,200.0000,200.1234,200.0500,6.17,3.69",
  );
});

test("executionToCSV handles empty fills array", () => {
  const csv = mod.executionToCSV(sampleReport({ fills: [] }));
  assert.equal(csv.trim().split("\n").length, 1);
  assert.ok(csv.startsWith("ticker,side,"));
});

test("executionToCSV quotes side that contains a comma", () => {
  const csv = mod.executionToCSV(sampleReport({ side: 'buy,maybe' }));
  // The cell containing a comma must be wrapped in quotes per RFC 4180.
  assert.match(csv, /AAPL,"buy,maybe",0,/);
});

test("executionToCSV skips non-finite numerics rather than emitting NaN", () => {
  const r = sampleReport({
    fills: [
      { bar_index: 0, shares: 100, fill_price: NaN, market_price: 200, participation: Infinity, slippage_bps: 0, commission: 0 },
    ],
  });
  const csv = mod.executionToCSV(r);
  const lines = csv.trim().split("\n");
  // fill_price is empty, participation is empty (Infinity, not finite).
  assert.equal(lines[1], "AAPL,buy,0,100,,200.0000,,0.00,0.0000,200.0000,200.1234,200.0500,6.17,3.69");
});

test("executionToJSON round-trips the report with uppercase ticker, sorted fills, and exported_at", () => {
  const json = mod.executionToJSON(sampleReport());
  const parsed = JSON.parse(json);
  assert.ok(typeof parsed.exported_at === "string" && parsed.exported_at.endsWith("Z"));
  assert.equal(parsed.report.ticker, "AAPL");
  assert.deepEqual(
    parsed.report.fills.map((f) => f.bar_index),
    [0, 1, 2],
  );
  // Preserves summary numbers.
  assert.equal(parsed.report.avg_fill_price, 200.1234);
  assert.equal(parsed.report.notional, 2001234);
});

test("executionFilename builds a stamped, slugged name", () => {
  const csv = mod.executionFilename("AAPL", "buy", "csv");
  assert.match(csv, /^signalclaw-execution-AAPL-buy-\d{4}-\d{2}-\d{2}\.csv$/);
  const json = mod.executionFilename("brk.b", "Sell", "json");
  assert.match(json, /^signalclaw-execution-BRK\.B-sell-\d{4}-\d{2}-\d{2}\.json$/);
  // Empty ticker/side fall through gracefully.
  const bare = mod.executionFilename("", "", "csv");
  assert.match(bare, /^signalclaw-execution-\d{4}-\d{2}-\d{2}\.csv$/);
});
