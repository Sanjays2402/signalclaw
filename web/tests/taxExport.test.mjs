// Plain Node test for tax export helpers.
// Run with: node --experimental-strip-types --test tests/taxExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "taxExport.ts"));

const sampleEvents = [
  {
    ticker: "MSFT",
    sell_trade_id: "t-2",
    sell_date: "2026-03-15",
    quantity: 10,
    proceeds: 4200.5,
    cost_basis: 4000,
    realized_pnl: 200.5,
    lot_acquired: "2025-01-10",
    holding_days: 429,
    long_term: true,
  },
  {
    ticker: "AAPL",
    sell_trade_id: "t-1",
    sell_date: "2026-02-01",
    quantity: 5.25,
    proceeds: 900,
    cost_basis: 1000,
    realized_pnl: -100,
    lot_acquired: "2025-12-01",
    holding_days: 62,
    long_term: false,
  },
  {
    ticker: "NVDA",
    sell_trade_id: "t-3",
    sell_date: "2026-03-15",
    quantity: 2,
    proceeds: 1200,
    cost_basis: 900,
    realized_pnl: 300,
    lot_acquired: null,
    holding_days: null,
    long_term: null,
  },
];

const sampleReport = {
  method: "fifo",
  events: sampleEvents,
  realized_total: 400.5,
  realized_short_term: -100,
  realized_long_term: 500.5,
  wash_sales: [
    {
      ticker: "AAPL",
      sell_trade_id: "t-1",
      sell_date: "2026-02-01",
      loss: -100,
      triggering_buy_id: "b-9",
      triggering_buy_date: "2026-02-20",
      days_between: 19,
    },
  ],
};

test("taxEventsToCSV emits header and rows sorted by date then ticker", () => {
  const csv = mod.taxEventsToCSV(sampleEvents);
  const lines = csv.trim().split("\n");
  assert.equal(
    lines[0],
    "sell_date,ticker,quantity,proceeds,cost_basis,realized_pnl,holding_days,long_term,lot_acquired,sell_trade_id",
  );
  assert.equal(lines[1].split(",")[0], "2026-02-01");
  assert.equal(lines[1].split(",")[1], "AAPL");
  assert.equal(lines[2].split(",")[1], "MSFT");
  assert.equal(lines[3].split(",")[1], "NVDA");
});

test("taxEventsToCSV ends with a trailing newline", () => {
  assert.ok(mod.taxEventsToCSV(sampleEvents).endsWith("\n"));
});

test("taxEventsToCSV leaves long_term blank when unknown and writes empty lot_acquired", () => {
  const csv = mod.taxEventsToCSV([sampleEvents[2]]);
  const fields = csv.trim().split("\n")[1].split(",");
  assert.equal(fields[6], ""); // holding_days
  assert.equal(fields[7], ""); // long_term
  assert.equal(fields[8], ""); // lot_acquired
});

test("taxEventsToCSV escapes commas, quotes, and newlines in ticker and lot_acquired", () => {
  const csv = mod.taxEventsToCSV([
    {
      ticker: 'X,"Y"',
      sell_trade_id: "id\n1",
      sell_date: "2026-05-01",
      quantity: 1,
      proceeds: 1,
      cost_basis: 1,
      realized_pnl: 0,
      lot_acquired: "a,b",
      holding_days: 1,
      long_term: false,
    },
  ]);
  // sell_trade_id contains a literal newline, so don't split by line.
  assert.ok(csv.includes('"X,""Y"""'));
  assert.ok(csv.includes('"a,b"'));
  assert.ok(csv.includes('"id\n1"'));
});

test("taxEventsToCSV handles empty list", () => {
  const csv = mod.taxEventsToCSV([]);
  assert.equal(
    csv,
    "sell_date,ticker,quantity,proceeds,cost_basis,realized_pnl,holding_days,long_term,lot_acquired,sell_trade_id\n",
  );
});

test("taxReportToJSON includes method, totals, sorted events, and wash sales", () => {
  const json = mod.taxReportToJSON(sampleReport);
  const parsed = JSON.parse(json);
  assert.equal(parsed.method, "fifo");
  assert.equal(parsed.totals.realized_total, 400.5);
  assert.equal(parsed.totals.realized_short_term, -100);
  assert.equal(parsed.totals.realized_long_term, 500.5);
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[0].ticker, "AAPL");
  assert.equal(parsed.events[1].ticker, "MSFT");
  assert.equal(parsed.wash_sales.length, 1);
  assert.equal(parsed.wash_sales[0].ticker, "AAPL");
  assert.equal(parsed.wash_sales[0].days_between, 19);
});

test("taxFilename encodes method, wash window, and extension", () => {
  assert.match(mod.taxFilename("FIFO", 30, "csv"), /^signalclaw-tax-fifo-w30-.+\.csv$/);
  assert.match(mod.taxFilename("hifo", 0, "json"), /^signalclaw-tax-hifo-w0-.+\.json$/);
});
