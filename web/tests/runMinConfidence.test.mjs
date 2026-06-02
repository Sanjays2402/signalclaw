// node --experimental-strip-types --test tests/runMinConfidence.test.mjs
//
// queryRuns honors a min_confidence filter so the history page (and the
// /api/runs/export + /api/v1/runs/export endpoints, via parseExportQuery)
// can narrow large histories to high-conviction snapshots. Runs without a
// snapshot confidence are excluded when the filter is set. The export
// param parser accepts both fractions (0..1) and percents (1..100, with or
// without a trailing %). Out-of-range or unparseable values are ignored,
// matching the lenient policy of the other run filters.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-runmc-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const rs = await import(path.join(repoRoot, "lib", "runStore.ts"));
const ep = await import(path.join(repoRoot, "lib", "runsExportParams.ts"));

function payload(ticker, confidence) {
  const dates = ["2024-01-01", "2024-01-02"];
  const snapshot =
    confidence === null
      ? null
      : { as_of: dates[1], label: "trend_up", confidence };
  const base = {
    ticker,
    dates,
    close: [100, 101],
  };
  return snapshot ? { ...base, snapshot } : base;
}

async function seed(ticker, confidence) {
  const r = await rs.createRun({
    label: ticker,
    ticker,
    lookback_days: 2,
    payload: payload(ticker, confidence),
    tags: [],
  });
  return r.id;
}

await seed("AAA", 0.2);
await seed("BBB", 0.5);
await seed("CCC", 0.9);
await seed("DDD", null); // no snapshot at all

function tickersOf(runs) {
  return runs.map((r) => r.ticker).sort();
}

test("minConfidence keeps runs at or above the threshold", async () => {
  const { runs, total } = await rs.queryRuns({ minConfidence: 0.5 });
  assert.equal(total, 2);
  assert.deepEqual(tickersOf(runs), ["BBB", "CCC"]);
});

test("minConfidence excludes runs with no snapshot confidence", async () => {
  const { runs } = await rs.queryRuns({ minConfidence: 0 });
  // All three with snapshots qualify; DDD (no snapshot) is dropped.
  assert.deepEqual(tickersOf(runs), ["AAA", "BBB", "CCC"]);
});

test("minConfidence above 1 is ignored (out-of-range, lenient)", async () => {
  const { total } = await rs.queryRuns({ minConfidence: 2 });
  assert.equal(total, 4); // no filter applied
});

test("minConfidence non-finite is ignored", async () => {
  const { total } = await rs.queryRuns({ minConfidence: Number.NaN });
  assert.equal(total, 4);
});

test("parseMinConfidence accepts fractions, percents, and trailing %", () => {
  assert.equal(ep.parseMinConfidence("0.75"), 0.75);
  assert.equal(ep.parseMinConfidence("75"), 0.75);
  assert.equal(ep.parseMinConfidence("75%"), 0.75);
  assert.equal(ep.parseMinConfidence("100"), 1);
  assert.equal(ep.parseMinConfidence("0"), 0);
});

test("parseMinConfidence ignores junk and out-of-range", () => {
  assert.equal(ep.parseMinConfidence(""), undefined);
  assert.equal(ep.parseMinConfidence(null), undefined);
  assert.equal(ep.parseMinConfidence(undefined), undefined);
  assert.equal(ep.parseMinConfidence("abc"), undefined);
  assert.equal(ep.parseMinConfidence("-5"), undefined);
  assert.equal(ep.parseMinConfidence("150"), undefined);
  assert.equal(ep.parseMinConfidence("200%"), undefined);
});

test("parseExportQuery surfaces min_confidence into QueryOpts", () => {
  const sp = new URLSearchParams("min_confidence=80");
  const opts = ep.parseExportQuery(sp);
  assert.equal(opts.minConfidence, 0.8);

  const sp2 = new URLSearchParams("");
  const opts2 = ep.parseExportQuery(sp2);
  assert.equal(opts2.minConfidence, undefined);
});
