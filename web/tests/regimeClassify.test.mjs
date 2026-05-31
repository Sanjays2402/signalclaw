// Test for the regime classifier used by POST /v1/runs.
// Run with: node --experimental-strip-types --test tests/regimeClassify.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const { classifyRegime } = await import(path.join(repoRoot, "lib", "regimeClassify.ts"));

function series(n, fn) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p = Math.max(1, fn(i, p));
    out.push(Number(p.toFixed(4)));
  }
  return out;
}

test("rejects too-short series", () => {
  const r = classifyRegime({ ticker: "SPY", close: [100, 101, 102] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "series_too_short");
});

test("rejects bad ticker", () => {
  const r = classifyRegime({ ticker: "", close: series(40, (i, p) => p * 1.001) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "bad_ticker");
});

test("rejects non-positive close values", () => {
  const arr = series(40, (i, p) => p * 1.001);
  arr[10] = -1;
  const r = classifyRegime({ ticker: "SPY", close: arr });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "bad_close");
});

test("strong uptrend classifies as bull", () => {
  // 80 bars of steady +0.1%/bar drift, tiny noise.
  const close = series(80, (i, p) => p * (1 + 0.0012 + (((i * 9301 + 49297) % 233280) / 233280 - 0.5) * 0.002));
  const r = classifyRegime({ ticker: "SPY", close });
  assert.equal(r.ok, true);
  assert.equal(r.payload.snapshot.label, "bull");
  assert.ok(r.payload.snapshot.confidence >= 0.6);
  assert.equal(r.payload.regime.length, close.length);
  // First WINDOW bars are null (insufficient history).
  assert.equal(r.payload.regime[0], null);
  assert.equal(typeof r.payload.regime[r.payload.regime.length - 1], "string");
});

test("steady downtrend classifies as bear", () => {
  const close = series(80, (i, p) => p * (1 - 0.0015 + (((i * 7919 + 2003) % 65537) / 65537 - 0.5) * 0.002));
  const r = classifyRegime({ ticker: "ACME", close });
  assert.equal(r.ok, true);
  assert.equal(r.payload.snapshot.label, "bear");
  assert.ok(r.payload.snapshot.drawdown <= 0);
});

test("payload has UI-compatible shape", () => {
  const close = series(40, (i, p) => p * (1 + 0.0005));
  const r = classifyRegime({ ticker: "abc", close });
  assert.equal(r.ok, true);
  const p = r.payload;
  assert.equal(p.ticker, "ABC"); // normalized upper
  assert.equal(p.dates.length, p.close.length);
  assert.equal(p.regime.length, p.close.length);
  assert.ok(["bull", "chop", "bear", "crash"].includes(p.snapshot.label));
  assert.ok(Number.isFinite(p.snapshot.realized_vol));
  assert.ok(Number.isFinite(p.snapshot.trend_slope));
  assert.ok(p.snapshot.risk_scale > 0 && p.snapshot.risk_scale <= 1);
  for (const k of ["bull", "chop", "bear", "crash"]) {
    assert.ok(typeof p.counts[k] === "number");
  }
});

test("explicit dates must match close length and format", () => {
  const close = series(30, (i, p) => p * 1.001);
  const bad = classifyRegime({ ticker: "X", close, dates: ["2024-01-01"] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "bad_dates");

  const dates = close.map((_, i) => {
    const d = new Date(Date.UTC(2024, 0, 1 + i));
    return d.toISOString().slice(0, 10);
  });
  const good = classifyRegime({ ticker: "X", close, dates });
  assert.equal(good.ok, true);
  assert.equal(good.payload.dates[0], "2024-01-01");
});
