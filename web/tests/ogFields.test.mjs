import { test } from "node:test";
import assert from "node:assert/strict";

// node --experimental-strip-types lets us import .ts directly.
const { ogFields, OG_REGIME_COLORS } = await import("../lib/ogFields.ts");

function makeRun(overrides = {}) {
  return {
    id: "abc123",
    label: "AAPL bull run",
    ticker: "AAPL",
    lookback_days: 180,
    created_at: new Date().toISOString(),
    tags: [],
    payload: {
      ticker: "AAPL",
      dates: ["2025-01-01", "2025-01-02", "2025-01-03"],
      close: [100, 101, 102],
      regime: ["bull", "bull", "bull"],
      counts: { bull: 3 },
      snapshot: {
        label: "bull",
        realized_vol: 0.1234,
        trend_slope: 0.001,
        drawdown: -0.0567,
        confidence: 0.876,
        risk_scale: 1,
        as_of: "2025-01-03",
      },
      disclaimer: "x",
    },
    ...overrides,
  };
}

test("ogFields: formats snapshot numbers with sane precision", () => {
  const f = ogFields(makeRun(), "abc123");
  assert.equal(f.ticker, "AAPL");
  assert.equal(f.label, "BULL");
  assert.equal(f.conf, "88%");
  assert.equal(f.vol, "12.3%");
  assert.equal(f.dd, "-5.7%");
  assert.equal(f.bars, 3);
  assert.equal(f.color, OG_REGIME_COLORS.bull);
});

test("ogFields: null run yields safe placeholders", () => {
  const f = ogFields(null, "missing");
  assert.equal(f.ticker, "UNKNOWN");
  assert.equal(f.label, "NO-SNAPSHOT");
  assert.equal(f.conf, "--");
  assert.equal(f.vol, "--");
  assert.equal(f.dd, "--");
  assert.equal(f.bars, 0);
  assert.equal(f.color, "#a3a3a3");
});

test("ogFields: missing snapshot keeps ticker but defaults label", () => {
  const run = makeRun();
  run.payload.snapshot = null;
  const f = ogFields(run, run.id);
  assert.equal(f.ticker, "AAPL");
  assert.equal(f.label, "NO-SNAPSHOT");
  assert.equal(f.color, "#a3a3a3");
  assert.equal(f.bars, 3);
});

test("ogFields: bear regime gets bear color", () => {
  const run = makeRun();
  run.payload.snapshot.label = "bear";
  const f = ogFields(run, run.id);
  assert.equal(f.label, "BEAR");
  assert.equal(f.color, OG_REGIME_COLORS.bear);
});
