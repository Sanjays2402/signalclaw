// node --experimental-strip-types --test tests/runMaxConfidence.test.mjs
//
// queryRuns honors a max_confidence filter that pairs with min_confidence so
// the history page can bracket a confidence window (for example, surfacing
// "uncertain" runs in the 30-60% range for review). Runs without a snapshot
// confidence are excluded when the filter is set, matching the
// min_confidence policy. The export param parser delegates to the same
// numeric parser as min_confidence and accepts fractions, percents, and a
// trailing %; out-of-range or unparseable values are ignored.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-runmaxc-"));
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
  const base = { ticker, dates, close: [100, 101] };
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
await seed("DDD", null);

function tickersOf(runs) {
  return runs.map((r) => r.ticker).sort();
}

test("maxConfidence keeps runs at or below the threshold", async () => {
  const { runs, total } = await rs.queryRuns({ maxConfidence: 0.5 });
  assert.equal(total, 2);
  assert.deepEqual(tickersOf(runs), ["AAA", "BBB"]);
});

test("maxConfidence excludes runs with no snapshot confidence", async () => {
  const { runs } = await rs.queryRuns({ maxConfidence: 1 });
  assert.deepEqual(tickersOf(runs), ["AAA", "BBB", "CCC"]);
});

test("min and max together bracket a confidence window", async () => {
  const { runs, total } = await rs.queryRuns({ minConfidence: 0.3, maxConfidence: 0.8 });
  assert.equal(total, 1);
  assert.deepEqual(tickersOf(runs), ["BBB"]);
});

test("maxConfidence above 1 is ignored (out-of-range, lenient)", async () => {
  const { total } = await rs.queryRuns({ maxConfidence: 2 });
  assert.equal(total, 4);
});

test("maxConfidence non-finite is ignored", async () => {
  const { total } = await rs.queryRuns({ maxConfidence: Number.NaN });
  assert.equal(total, 4);
});

test("parseMaxConfidence accepts fractions, percents, and trailing %", () => {
  assert.equal(ep.parseMaxConfidence("0.6"), 0.6);
  assert.equal(ep.parseMaxConfidence("60"), 0.6);
  assert.equal(ep.parseMaxConfidence("60%"), 0.6);
  assert.equal(ep.parseMaxConfidence("0"), 0);
  assert.equal(ep.parseMaxConfidence("100"), 1);
});

test("parseMaxConfidence ignores junk and out-of-range", () => {
  assert.equal(ep.parseMaxConfidence(""), undefined);
  assert.equal(ep.parseMaxConfidence(null), undefined);
  assert.equal(ep.parseMaxConfidence(undefined), undefined);
  assert.equal(ep.parseMaxConfidence("abc"), undefined);
  assert.equal(ep.parseMaxConfidence("-5"), undefined);
  assert.equal(ep.parseMaxConfidence("150"), undefined);
});

test("parseExportQuery surfaces max_confidence into QueryOpts", () => {
  const sp = new URLSearchParams("max_confidence=60");
  const opts = ep.parseExportQuery(sp);
  assert.equal(opts.maxConfidence, 0.6);

  const sp2 = new URLSearchParams("");
  const opts2 = ep.parseExportQuery(sp2);
  assert.equal(opts2.maxConfidence, undefined);

  const sp3 = new URLSearchParams("min_confidence=30&max_confidence=80");
  const opts3 = ep.parseExportQuery(sp3);
  assert.equal(opts3.minConfidence, 0.3);
  assert.equal(opts3.maxConfidence, 0.8);
});
