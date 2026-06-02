// node --experimental-strip-types --test tests/runMaxBars.test.mjs
//
// queryRuns honors a max_bars filter that pairs with min_bars so the
// history page and the /api/runs/export + /api/v1/runs/export endpoints
// (via parseExportQuery) can bracket a bar-count window (e.g. show only
// runs with 50-200 bars). parseMaxBars accepts non-negative integers and
// floors floats. Negative, non-finite, or unparseable values are ignored,
// matching the lenient policy of the other run filters.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-runmxb-"));
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
    snapshot:
      nBars > 0
        ? { as_of: dates[dates.length - 1], label: "trend_up", confidence: 0.5 }
        : null,
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

test("maxBars keeps runs at or below the bar count ceiling", async () => {
  const { runs, total } = await rs.queryRuns({ maxBars: 100 });
  assert.equal(total, 2);
  assert.deepEqual(tickersOf(runs), ["AAA", "BBB"]);
});

test("maxBars=0 hides every run that has any bars", async () => {
  const { total } = await rs.queryRuns({ maxBars: 0 });
  assert.equal(total, 0);
});

test("maxBars above all rows leaves the full set", async () => {
  const { total } = await rs.queryRuns({ maxBars: 10000 });
  assert.equal(total, 3);
});

test("maxBars non-finite is ignored (no filter applied)", async () => {
  const { total } = await rs.queryRuns({ maxBars: Number.NaN });
  assert.equal(total, 3);
});

test("maxBars negative is ignored (no filter applied)", async () => {
  const { total } = await rs.queryRuns({ maxBars: -5 });
  assert.equal(total, 3);
});

test("maxBars floats are floored", async () => {
  const { runs } = await rs.queryRuns({ maxBars: 50.9 });
  // floor(50.9) = 50, so 5-bar AAA and 50-bar BBB qualify.
  assert.deepEqual(tickersOf(runs), ["AAA", "BBB"]);
});

test("minBars and maxBars bracket a bar-count window", async () => {
  const { runs, total } = await rs.queryRuns({ minBars: 10, maxBars: 100 });
  assert.equal(total, 1);
  assert.deepEqual(tickersOf(runs), ["BBB"]);
});

test("parseMaxBars accepts plain integers and floors floats", () => {
  assert.equal(ep.parseMaxBars("50"), 50);
  assert.equal(ep.parseMaxBars("  100 "), 100);
  assert.equal(ep.parseMaxBars("49.9"), 49);
  assert.equal(ep.parseMaxBars("0"), 0);
});

test("parseMaxBars rejects empty, negative, and garbage values", () => {
  assert.equal(ep.parseMaxBars(""), undefined);
  assert.equal(ep.parseMaxBars(null), undefined);
  assert.equal(ep.parseMaxBars(undefined), undefined);
  assert.equal(ep.parseMaxBars("abc"), undefined);
  assert.equal(ep.parseMaxBars("-5"), undefined);
});

test("parseExportQuery wires max_bars through to QueryOpts.maxBars", () => {
  const sp = new URLSearchParams("max_bars=200&min_bars=50&ticker=BBB");
  const opts = ep.parseExportQuery(sp);
  assert.equal(opts.maxBars, 200);
  assert.equal(opts.minBars, 50);
  assert.equal(opts.ticker, "BBB");
});

test("parseExportQuery omits maxBars when max_bars is absent or invalid", () => {
  assert.equal(ep.parseExportQuery(new URLSearchParams("")).maxBars, undefined);
  assert.equal(
    ep.parseExportQuery(new URLSearchParams("max_bars=abc")).maxBars,
    undefined,
  );
});
