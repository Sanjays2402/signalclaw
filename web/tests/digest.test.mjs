// Plain Node test for the digest builder.
// Run with: node --experimental-strip-types --test tests/digest.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const { buildDigest, renderDigestText, renderDigestHtml, renderDigest, clampDays } =
  await import(path.join(repoRoot, "lib", "digest.ts"));

function mkRun(over = {}) {
  return {
    id: over.id ?? "r1",
    label: over.label ?? "SPY · 90d",
    ticker: over.ticker ?? "SPY",
    lookback_days: 90,
    created_at: over.created_at ?? "2025-01-05T00:00:00.000Z",
    tags: [],
    payload: {
      ticker: over.ticker ?? "SPY",
      dates: ["2025-01-01", "2025-01-02"],
      close: [100, 101],
      regime: ["bull", "bull"],
      counts: { bull: 2 },
      snapshot: over.snapshot ?? {
        label: "bull",
        realized_vol: 0.1,
        trend_slope: 0.001,
        drawdown: -0.02,
        confidence: 0.82,
        risk_scale: 1,
        as_of: "2025-01-02",
      },
      disclaimer: "test",
    },
  };
}

function mkEvent(kind, created_at, id) {
  return {
    id: id ?? Math.random().toString(36).slice(2),
    kind,
    title: kind,
    body: "",
    href: null,
    created_at,
    read: false,
  };
}

test("clampDays bounds to [1, 90] and defaults to 7", () => {
  assert.equal(clampDays(undefined), 7);
  assert.equal(clampDays(NaN), 7);
  assert.equal(clampDays(0), 1);
  assert.equal(clampDays(-5), 1);
  assert.equal(clampDays(1000), 90);
  assert.equal(clampDays("14"), 14);
});

test("buildDigest filters by window and aggregates stats", () => {
  const now = "2025-01-10T00:00:00.000Z";
  const inWindow = mkRun({ id: "a", created_at: "2025-01-08T00:00:00.000Z" });
  const oldRun = mkRun({ id: "b", created_at: "2024-12-01T00:00:00.000Z" });
  const events = [
    mkEvent("webhook.delivered", "2025-01-09T00:00:00.000Z"),
    mkEvent("webhook.delivered", "2025-01-09T01:00:00.000Z"),
    mkEvent("webhook.failed", "2025-01-09T02:00:00.000Z"),
    mkEvent("batch.completed", "2025-01-09T03:00:00.000Z"),
    mkEvent("alert.fired", "2025-01-09T04:00:00.000Z"),
    mkEvent("key.created", "2025-01-09T05:00:00.000Z"),
    mkEvent("webhook.delivered", "2024-11-01T00:00:00.000Z"), // out of window
  ];
  const d = buildDigest({ events, runs: [inWindow, oldRun], days: 7, now });
  assert.equal(d.range.days, 7);
  assert.equal(d.stats.runs, 1);
  assert.equal(d.stats.webhook_deliveries, 2);
  assert.equal(d.stats.webhook_failures, 1);
  assert.equal(d.stats.batch_completions, 1);
  assert.equal(d.stats.alerts_fired, 1);
  assert.equal(d.stats.keys_changed, 1);
  assert.equal(d.by_regime.bull, 1);
  assert.equal(d.top_runs.length, 1);
  assert.equal(d.top_runs[0].id, "a");
  assert.equal(d.empty, false);
});

test("buildDigest empty window produces quiet headline", () => {
  const d = buildDigest({
    events: [],
    runs: [],
    days: 3,
    now: "2025-01-10T00:00:00.000Z",
  });
  assert.equal(d.empty, true);
  assert.match(d.headline, /Quiet 3-day window/);
  assert.equal(d.top_runs.length, 0);
});

test("top_runs sorts by confidence desc and caps at 5", () => {
  const now = "2025-01-10T00:00:00.000Z";
  const runs = Array.from({ length: 8 }, (_, i) =>
    mkRun({
      id: `r${i}`,
      created_at: "2025-01-09T00:00:00.000Z",
      snapshot: {
        label: "bull",
        realized_vol: 0.1,
        trend_slope: 0,
        drawdown: 0,
        confidence: i / 10,
        risk_scale: 1,
        as_of: "2025-01-09",
      },
    }),
  );
  const d = buildDigest({ events: [], runs, days: 7, now });
  assert.equal(d.top_runs.length, 5);
  assert.equal(d.top_runs[0].id, "r7");
  assert.equal(d.top_runs[4].id, "r3");
});

test("renderDigestText includes stats and headline", () => {
  const d = buildDigest({
    events: [mkEvent("webhook.delivered", "2025-01-09T00:00:00.000Z")],
    runs: [mkRun({ created_at: "2025-01-09T00:00:00.000Z" })],
    days: 7,
    now: "2025-01-10T00:00:00.000Z",
  });
  const text = renderDigestText(d);
  assert.match(text, /SignalClaw digest/);
  assert.match(text, /Runs saved/);
  assert.match(text, /Webhook delivered : 1/);
  assert.match(text, /SPY/);
});

test("renderDigestHtml is well-formed and escapes content", () => {
  const d = buildDigest({
    events: [],
    runs: [
      mkRun({
        id: "x",
        label: "<script>alert(1)</script>",
        created_at: "2025-01-09T00:00:00.000Z",
      }),
    ],
    days: 7,
    now: "2025-01-10T00:00:00.000Z",
  });
  const html = renderDigestHtml(d);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /SignalClaw digest/);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renderDigest bundles text and html", () => {
  const d = buildDigest({
    events: [],
    runs: [],
    days: 7,
    now: "2025-01-10T00:00:00.000Z",
  });
  const r = renderDigest(d);
  assert.equal(typeof r.text, "string");
  assert.equal(typeof r.html, "string");
  assert.ok(r.text.length > 0);
  assert.ok(r.html.length > 0);
});
