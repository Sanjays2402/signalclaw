// Tests for monthly quota summarization. Pure-function tests over fixed input.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const { summarizeUsage } = await import(path.join(repoRoot, "lib", "quotaCore.ts"));

function mkRun(id, ticker, iso, label = "bull") {
  return {
    id,
    label: `${ticker} run`,
    ticker,
    lookback_days: 60,
    created_at: iso,
    payload: {
      ticker,
      dates: ["2024-01-02"],
      close: [100],
      regime: [label],
      counts: { [label]: 1 },
      snapshot: {
        label,
        realized_vol: 0.1,
        trend_slope: 0,
        drawdown: 0,
        confidence: 0.8,
        risk_scale: 1,
        as_of: iso,
      },
      disclaimer: "x",
    },
  };
}

test("summarizeUsage counts only runs in current month UTC", () => {
  const now = new Date("2024-06-15T12:00:00Z");
  const runs = [
    mkRun("a", "SPY", "2024-06-01T01:00:00Z"),
    mkRun("b", "QQQ", "2024-06-15T11:59:00Z", "chop"),
    mkRun("c", "SPY", "2024-05-31T23:59:00Z"),
    mkRun("d", "IWM", "2024-07-01T00:00:00Z"),
  ];
  const s = summarizeUsage(runs, now, 50);
  assert.equal(s.used, 2);
  assert.equal(s.limit, 50);
  assert.equal(s.remaining, 48);
  assert.equal(s.lifetime, 4);
  assert.equal(s.over_quota, false);
  assert.equal(s.period_start, "2024-06-01T00:00:00.000Z");
  assert.equal(s.period_end, "2024-07-01T00:00:00.000Z");
  assert.equal(s.by_day.length, 30); // June has 30 days
  // Daily buckets sum equals used.
  const total = s.by_day.reduce((acc, d) => acc + d.count, 0);
  assert.equal(total, s.used);
});

test("summarizeUsage flags over_quota and clamps pct", () => {
  const now = new Date("2024-02-20T00:00:00Z");
  const runs = Array.from({ length: 7 }, (_, i) =>
    mkRun(String(i), "SPY", `2024-02-1${i}T00:00:00Z`),
  );
  const s = summarizeUsage(runs, now, 5);
  assert.equal(s.used, 7);
  assert.equal(s.remaining, 0);
  assert.equal(s.over_quota, true);
  assert.equal(s.pct, 1);
  assert.ok(s.by_ticker[0].ticker === "SPY");
  assert.equal(s.by_ticker[0].count, 7);
});

test("summarizeUsage handles empty runs", () => {
  const s = summarizeUsage([], new Date("2024-03-10T00:00:00Z"), 10);
  assert.equal(s.used, 0);
  assert.equal(s.remaining, 10);
  assert.equal(s.over_quota, false);
  assert.equal(s.lifetime, 0);
  assert.equal(s.by_ticker.length, 0);
  assert.equal(s.by_regime.length, 0);
  assert.equal(s.by_day.length, 31); // March has 31 days
});
