// Plain Node test for portfolio export helpers.
// Run with: node --experimental-strip-types --test tests/portfolioExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "portfolioExport.ts"));

const snap = {
  positions: [
    {
      ticker: "AAPL",
      quantity: 10,
      avg_cost: 150,
      last_price: 200,
      market_value: 2000,
      cost: 1500,
      unrealized_pnl: 500,
      unrealized_pct: 0.3333,
      realized_pnl: 0,
    },
    {
      ticker: "BRK,B",
      quantity: 2,
      avg_cost: 300,
      last_price: null,
      market_value: 600,
      cost: 600,
      unrealized_pnl: 0,
      unrealized_pct: 0,
      realized_pnl: -25,
    },
  ],
  total_cost: 2100,
  total_market_value: 2600,
  total_unrealized: 500,
  total_realized: -25,
  weights: { AAPL: 0.7692 },
};

test("positionsToCSV emits header + escaped rows with derived weight", () => {
  const csv = mod.positionsToCSV(snap);
  const lines = csv.split("\n");
  assert.equal(
    lines[0],
    "ticker,quantity,avg_cost,last_price,market_value,cost,weight,unrealized_pnl,unrealized_pct,realized_pnl",
  );
  assert.equal(lines[1], "AAPL,10,150,200,2000,1500,0.7692,500,0.3333,0");
  // Ticker with a comma is quoted; null last_price becomes empty; weight is
  // derived from market_value / total_market_value when missing.
  assert.equal(lines[2], `"BRK,B",2,300,,600,600,${600 / 2600},0,0,-25`);
  assert.equal(lines[3], "");
});

test("positionsToCSV handles empty positions", () => {
  const csv = mod.positionsToCSV({
    positions: [],
    total_cost: 0,
    total_market_value: 0,
    total_unrealized: 0,
    total_realized: 0,
    weights: {},
  });
  assert.equal(
    csv,
    "ticker,quantity,avg_cost,last_price,market_value,cost,weight,unrealized_pnl,unrealized_pct,realized_pnl\n",
  );
});

test("positionsToJSON wraps with exported_at, totals, count, derived weight", () => {
  const payload = JSON.parse(mod.positionsToJSON(snap));
  assert.equal(payload.count, 2);
  assert.equal(payload.positions.length, 2);
  assert.equal(payload.positions[0].ticker, "AAPL");
  assert.equal(payload.positions[0].weight, 0.7692);
  // Derived weight when not present in weights map.
  assert.equal(payload.positions[1].weight, 600 / 2600);
  assert.deepEqual(payload.totals, {
    cost: 2100,
    market_value: 2600,
    unrealized: 500,
    realized: -25,
  });
  assert.ok(typeof payload.exported_at === "string");
  assert.ok(!Number.isNaN(Date.parse(payload.exported_at)));
});

test("portfolioExportFilename has expected shape", () => {
  const f = mod.portfolioExportFilename("csv");
  assert.match(f, /^signalclaw-portfolio-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
  const j = mod.portfolioExportFilename("json");
  assert.match(j, /^signalclaw-portfolio-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
});
