// Plain Node test for sortEntries helper used by /watchlist UI.
// Run with: node --experimental-strip-types --test tests/watchlistSort.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "watchlistSort.ts"));
const { sortEntries, distanceForSort } = mod;

function entry(ticker, added_at, target_low = null, target_high = null) {
  return { ticker, added_at, target_low, target_high };
}

function check(ticker, last_close, target_low = null, target_high = null) {
  return { ticker, last_close, target_low, target_high };
}

test("sort by ticker asc / desc is alphabetical", () => {
  const xs = [entry("MSFT", "2026-01-02"), entry("AAPL", "2026-01-01"), entry("NVDA", "2026-01-03")];
  const asc = sortEntries(xs, "ticker", "asc").map((e) => e.ticker);
  const desc = sortEntries(xs, "ticker", "desc").map((e) => e.ticker);
  assert.deepEqual(asc, ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(desc, ["NVDA", "MSFT", "AAPL"]);
});

test("sort by added date respects direction", () => {
  const xs = [
    entry("A", "2026-01-03"),
    entry("B", "2026-01-01"),
    entry("C", "2026-01-02"),
  ];
  const asc = sortEntries(xs, "added", "asc").map((e) => e.ticker);
  const desc = sortEntries(xs, "added", "desc").map((e) => e.ticker);
  assert.deepEqual(asc, ["B", "C", "A"]);
  assert.deepEqual(desc, ["A", "C", "B"]);
});

test("sort is stable and does not mutate input", () => {
  const xs = [entry("B", "2026-01-01"), entry("A", "2026-01-01"), entry("C", "2026-01-01")];
  const out = sortEntries(xs, "added", "asc").map((e) => e.ticker);
  // All equal dates fall back to ticker asc tiebreaker.
  assert.deepEqual(out, ["A", "B", "C"]);
  // Original order untouched.
  assert.deepEqual(xs.map((e) => e.ticker), ["B", "A", "C"]);
});

test("distanceForSort returns null without close or targets", () => {
  assert.equal(distanceForSort(entry("A", "x"), undefined), null);
  assert.equal(distanceForSort(entry("A", "x"), check("A", null)), null);
  assert.equal(distanceForSort(entry("A", "x", null, null), check("A", 100)), null);
});

test("distanceForSort returns absolute percent to nearest target", () => {
  // close 100, low 90 (10% above low), high 110 (10% below high) -> 10
  const e = entry("A", "x", 90, 110);
  const d = distanceForSort(e, check("A", 100));
  assert.ok(d !== null);
  assert.ok(Math.abs(d - 10) < 1e-9);
});

test("sort by distance puts closest target first, no-distance rows last", () => {
  const a = entry("A", "x", 95, 110); // close 100: 5% to low
  const b = entry("B", "x", 50, 102); // close 100: 2% to high
  const c = entry("C", "x", null, null); // no targets -> null distance
  const checks = {
    A: check("A", 100),
    B: check("B", 100),
    C: check("C", 100),
  };
  const asc = sortEntries([a, b, c], "distance", "asc", checks).map((e) => e.ticker);
  const desc = sortEntries([a, b, c], "distance", "desc", checks).map((e) => e.ticker);
  assert.deepEqual(asc, ["B", "A", "C"]);
  // C still last in desc: null rows always sink.
  assert.deepEqual(desc, ["A", "B", "C"]);
});
