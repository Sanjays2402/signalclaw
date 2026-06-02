// node --experimental-strip-types --test tests/runMinBars.test.mjs
//
// queryRuns honors a min_bars filter so the history page and the
// /api/runs/export + /api/v1/runs/export endpoints (via parseExportQuery)
// can hide short runs (intraday probes, partial backfills) from a long
// history. The filter pairs naturally with sort=bars. parseMinBars accepts
// non-negative integers and floors floats. Negative, non-finite, or
// unparseable values are ignored, matching the lenient policy of the other
// run filters.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-runmb-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const rs = await import(path.join(repoRoot, "lib", "runStore.ts"));
const ep = await import(path.join(repoRoot, "lib", "runsExportParams.ts"));

function payload(ticker, nBars) {
  const dates = [];
  const close = [];
  for (let i = 0; i < nBars; i++) {
    const d = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    dates.push(d);
    close.push(100 + i);
  }
  return {
    ticker,
    dates,
    close,
    snapshot: nBars > 0 ? { as_of: dates[dates.length - 1], label: "trend_up", confidence: 0.5 } : null,
  };
}

async function seed(ticker, nBars) {
  const r = await rs.createRun({
    label: ticker,
    ticker,
    lookback_days: nBars,
    payload: payload(ticker, nBars),
    tags: [],
  });
  return r.id;
}

await seed("AAA", 5);
await seed("BBB", 50);
await seed("CCC", 250);

function tickersOf(runs) {
  return runs.map((r) => r.ticker).sort();
}

test("minBars keeps runs at or above the bar count threshold", async () => {
  const { runs, total } = await rs.queryRuns({ minBars: 50 });
  assert.equal(total, 2);
  assert.deepEqual(tickersOf(runs), ["BBB", "CCC"]);
});

test("minBars=0 leaves the full set", async () => {
  const { total } = await rs.queryRuns({ minBars: 0 });
  assert.equal(total, 3);
});

test("minBars above all rows yields an empty page", async () => {
  const { runs, total } = await rs.queryRuns({ minBars: 1000 });
  assert.equal(total, 0);
  assert.deepEqual(runs, []);
});

test("minBars non-finite is ignored (no filter applied)", async () => {
  const { total } = await rs.queryRuns({ minBars: Number.NaN });
  assert.equal(total, 3);
});

test("minBars negative is ignored (no filter applied)", async () => {
  const { total } = await rs.queryRuns({ minBars: -5 });
  assert.equal(total, 3);
});

test("minBars floats are floored", async () => {
  const { runs } = await rs.queryRuns({ minBars: 49.9 });
  // floor(49.9) = 49, so 50-bar BBB and 250-bar CCC qualify.
  assert.deepEqual(tickersOf(runs), ["BBB", "CCC"]);
});

test("parseMinBars accepts plain integers and floors floats", () => {
  assert.equal(ep.parseMinBars("50"), 50);
  assert.equal(ep.parseMinBars("  100 "), 100);
  assert.equal(ep.parseMinBars("49.9"), 49);
  assert.equal(ep.parseMinBars("0"), 0);
});

test("parseMinBars rejects empty, negative, and garbage values", () => {
  assert.equal(ep.parseMinBars(""), undefined);
  assert.equal(ep.parseMinBars(null), undefined);
  assert.equal(ep.parseMinBars(undefined), undefined);
  assert.equal(ep.parseMinBars("abc"), undefined);
  assert.equal(ep.parseMinBars("-5"), undefined);
});

test("parseExportQuery wires min_bars through to QueryOpts.minBars", () => {
  const sp = new URLSearchParams("min_bars=100&ticker=BBB");
  const opts = ep.parseExportQuery(sp);
  assert.equal(opts.minBars, 100);
  assert.equal(opts.ticker, "BBB");
});

test("parseExportQuery omits minBars when min_bars is absent or invalid", () => {
  assert.equal(ep.parseExportQuery(new URLSearchParams("")).minBars, undefined);
  assert.equal(ep.parseExportQuery(new URLSearchParams("min_bars=abc")).minBars, undefined);
});
