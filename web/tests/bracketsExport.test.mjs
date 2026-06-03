// Plain Node test for brackets export helpers.
// Run with: node --experimental-strip-types --test tests/bracketsExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "bracketsExport.ts"));

const samplePlans = [
  {
    id: "b-3",
    ticker: "MSFT",
    side: "long",
    entry: 415,
    stop: 400,
    target: 445,
    shares: 10,
    status: "closed_win",
    note: "took target, comma here",
    created_at: "2026-03-01T10:00:00Z",
    actual_entry: 415.2,
    actual_exit: 445.1,
    exit_reason: "target",
    planned_r_multiple: 2.0,
    planned_risk_dollars: 150,
    realized_r: 1.99,
    realized_pnl: 298.9,
  },
  {
    id: "b-1",
    ticker: "NVDA",
    side: "long",
    entry: 850,
    stop: 800,
    target: 950,
    shares: 5,
    status: "open",
    note: "",
    created_at: "2026-05-15T14:30:00Z",
    actual_entry: null,
    actual_exit: null,
    exit_reason: null,
    planned_r_multiple: 2.0,
    planned_risk_dollars: 250,
    realized_r: null,
    realized_pnl: null,
  },
  {
    id: "b-2",
    ticker: "AAPL",
    side: "short",
    entry: 195,
    stop: 205,
    target: 175,
    shares: 20,
    status: "filled",
    note: "line\nbreak",
    created_at: "2026-05-10T09:30:00Z",
    actual_entry: 195.5,
    actual_exit: null,
    exit_reason: null,
    planned_r_multiple: 2.0,
    planned_risk_dollars: 200,
    realized_r: null,
    realized_pnl: null,
  },
  {
    id: "b-4",
    ticker: "AAPL",
    side: "long",
    entry: 180,
    stop: 175,
    target: 200,
    shares: 10,
    status: "open",
    note: "earlier",
    created_at: "2026-05-10T09:00:00Z",
    actual_entry: null,
    actual_exit: null,
    exit_reason: null,
    planned_r_multiple: 4.0,
    planned_risk_dollars: 50,
    realized_r: null,
    realized_pnl: null,
  },
];

test("bracketsToCSV: header row matches expected columns", () => {
  const csv = mod.bracketsToCSV([]);
  const header = csv.split("\n")[0];
  assert.equal(
    header,
    "ticker,side,shares,entry,stop,target,planned_r,planned_risk_usd,status,actual_entry,actual_exit,exit_reason,realized_r,realized_pnl_usd,created_at,note,id",
  );
});

test("bracketsToCSV: empty input still emits header and trailing newline", () => {
  const csv = mod.bracketsToCSV([]);
  assert.ok(csv.endsWith("\n"));
  assert.equal(csv.trim().split("\n").length, 1);
});

test("bracketsToJSON: sorts open then filled then closed, then by ticker, then by created_at", () => {
  const out = JSON.parse(mod.bracketsToJSON(samplePlans));
  const order = out.plans.map((p) => p.id);
  // open AAPL (b-4) before open NVDA (b-1); filled AAPL (b-2); closed MSFT (b-3) last.
  assert.deepEqual(order, ["b-4", "b-1", "b-2", "b-3"]);
});

test("bracketsToCSV: escapes commas and newlines inside note", () => {
  const csv = mod.bracketsToCSV(samplePlans);
  // line\nbreak must be quoted
  assert.ok(csv.includes('"line\nbreak"'));
  // comma here must be quoted
  assert.ok(csv.includes('"took target, comma here"'));
});

test("bracketsToCSV: blank cells for null numeric fields on open plans", () => {
  const csv = mod.bracketsToCSV(samplePlans);
  const openRow = csv.split("\n").find((l) => l.startsWith("NVDA,"));
  assert.ok(openRow);
  // actual_entry,actual_exit,exit_reason,realized_r,realized_pnl_usd all blank
  assert.ok(openRow.includes(",,,,,"));
});

test("bracketsToJSON: payload has exported_at, count, and sorted plans", () => {
  const out = JSON.parse(mod.bracketsToJSON(samplePlans));
  assert.equal(out.count, 4);
  assert.equal(typeof out.exported_at, "string");
  assert.equal(out.plans.length, 4);
  assert.equal(out.plans[0].id, "b-4");
  assert.equal(out.plans[3].id, "b-3");
});

test("bracketsToJSON: does not mutate input order", () => {
  const before = samplePlans.map((p) => p.id).join(",");
  mod.bracketsToJSON(samplePlans);
  const after = samplePlans.map((p) => p.id).join(",");
  assert.equal(before, after);
});

test("bracketsFilename: shape is signalclaw-brackets-YYYY-MM-DD.ext", () => {
  const csv = mod.bracketsFilename("csv");
  const json = mod.bracketsFilename("json");
  assert.match(csv, /^signalclaw-brackets-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(json, /^signalclaw-brackets-\d{4}-\d{2}-\d{2}\.json$/);
});
