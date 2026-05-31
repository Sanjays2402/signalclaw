import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "batch.ts"));
const { parseTickers, rowsToCSV, mapConcurrent } = mod;

test("parseTickers splits commas, whitespace, semicolons, newlines", () => {
  const out = parseTickers("spy, qqq;iwm\n tlt\tgld");
  assert.deepEqual(out, ["SPY", "QQQ", "IWM", "TLT", "GLD"]);
});

test("parseTickers dedupes and uppercases", () => {
  const out = parseTickers("spy, SPY, Spy, qqq");
  assert.deepEqual(out, ["SPY", "QQQ"]);
});

test("parseTickers strips a leading 'ticker' or 'symbol' header cell", () => {
  assert.deepEqual(parseTickers("ticker\nSPY\nQQQ"), ["SPY", "QQQ"]);
  assert.deepEqual(parseTickers("symbol,SPY,QQQ"), ["SPY", "QQQ"]);
});

test("parseTickers drops junk and enforces format", () => {
  const out = parseTickers("SPY,@bad,toolongtickername123,QQQ,BTC-USD,$$$");
  assert.deepEqual(out, ["SPY", "QQQ", "BTC-USD"]);
});

test("parseTickers respects max cap", () => {
  const big = Array.from({ length: 80 }, (_, i) => `T${i}`).join(",");
  const out = parseTickers(big, 10);
  assert.equal(out.length, 10);
  assert.equal(out[0], "T0");
  assert.equal(out[9], "T9");
});

test("parseTickers handles empty and whitespace-only input", () => {
  assert.deepEqual(parseTickers(""), []);
  assert.deepEqual(parseTickers("   \n\t  "), []);
});

test("rowsToCSV emits header and escapes commas/quotes/newlines", () => {
  const csv = rowsToCSV([
    {
      ticker: "SPY",
      ok: true,
      status: 200,
      regime: "bull",
      confidence: 0.87,
      risk_scale: 1.0,
      as_of: "2025-01-15",
      run_id: "abc123",
      error: null,
    },
    {
      ticker: "BAD",
      ok: false,
      status: 400,
      regime: null,
      confidence: null,
      risk_scale: null,
      as_of: null,
      run_id: null,
      error: 'bad, "quoted"\nmessage',
    },
  ]);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "ticker,ok,status,regime,confidence,risk_scale,as_of,run_id,error");
  assert.equal(lines[1], "SPY,true,200,bull,0.87,1,2025-01-15,abc123,");
  assert.match(lines[2], /^BAD,false,400,,,,,,"bad, ""quoted""/);
});

test("mapConcurrent preserves input order with concurrency", async () => {
  const items = [50, 10, 30, 5, 20, 40];
  const out = await mapConcurrent(items, 3, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return { i, ms };
  });
  assert.deepEqual(
    out.map((o) => o.ms),
    items,
  );
});

test("mapConcurrent handles empty input", async () => {
  const out = await mapConcurrent([], 4, async () => 1);
  assert.deepEqual(out, []);
});
