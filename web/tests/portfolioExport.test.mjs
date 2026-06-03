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

test("positionsToMarkdown emits header, totals block, and rows", () => {
  const md = mod.positionsToMarkdown(snap);
  assert.match(md, /^# SignalClaw portfolio\n/);
  assert.match(md, /Exported \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \u00b7 2 positions/);
  assert.match(md, /- Market value: \$2,600\.00/);
  assert.match(md, /- Cost basis: \$2,100\.00/);
  assert.match(md, /- Unrealized: \$500\.00 \(23\.81%\)/);
  assert.match(md, /- Realized: -\$25\.00/);
  // Table header + AAPL row.
  assert.match(md, /\| Ticker \| Qty \| Avg \| Mark \| Mkt val \| Weight \| P&L \| P&L % \| Realized \|/);
  assert.match(md, /\| AAPL \| 10 \| \$150\.00 \| \$200\.00 \| \$2,000\.00 \| 76\.92% \| \$500\.00 \| 33\.33% \| \$0\.00 \|/);
  // Null mark renders as --; ticker with a pipe would be escaped; trailing newline.
  assert.match(md, /\| 2 \| \$300\.00 \| -- \| \$600\.00 \|/);
  assert.ok(md.endsWith("\n"));
});

test("positionsToMarkdown handles empty positions and singular wording", () => {
  const md = mod.positionsToMarkdown({
    positions: [],
    total_cost: 0,
    total_market_value: 0,
    total_unrealized: 0,
    total_realized: 0,
    weights: {},
  });
  assert.match(md, /\u00b7 0 positions/);
  assert.match(md, /_No open positions\._/);
  // No table when empty.
  assert.ok(!md.includes("| Ticker |"));
});

test("positionsToMarkdown escapes pipe characters in ticker", () => {
  const md = mod.positionsToMarkdown({
    positions: [
      {
        ticker: "WEIRD|TKR",
        quantity: 1,
        avg_cost: 10,
        last_price: 11,
        market_value: 11,
        cost: 10,
        unrealized_pnl: 1,
        unrealized_pct: 0.1,
        realized_pnl: 0,
      },
    ],
    total_cost: 10,
    total_market_value: 11,
    total_unrealized: 1,
    total_realized: 0,
    weights: {},
  });
  assert.match(md, /WEIRD\\\|TKR/);
});

test("portfolioExportFilename supports md extension", () => {
  const m = mod.portfolioExportFilename("md");
  assert.match(m, /^signalclaw-portfolio-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/);
});
