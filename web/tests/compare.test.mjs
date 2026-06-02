// Unit tests for compare helpers.
// Run with: node --experimental-strip-types --test tests/compare.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "compare.ts"));

test("regimeMix returns zeros when total is zero", () => {
  const { total, mix } = mod.regimeMix({ counts: { bull: 0, chop: 0, bear: 0, crash: 0 } });
  assert.equal(total, 0);
  assert.deepEqual(mix, { bull: 0, chop: 0, bear: 0, crash: 0 });
});

test("regimeMix normalizes shares to sum to 1", () => {
  const { total, mix } = mod.regimeMix({ counts: { bull: 3, chop: 1, bear: 0, crash: 0 } });
  assert.equal(total, 4);
  assert.equal(mix.bull, 0.75);
  assert.equal(mix.chop, 0.25);
  const sum = mix.bull + mix.chop + mix.bear + mix.crash;
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("pctChange handles empty, single, and normal series", () => {
  assert.equal(mod.pctChange([]), null);
  assert.equal(mod.pctChange([100]), null);
  assert.equal(mod.pctChange([100, 110]), 0.1);
  assert.equal(mod.pctChange([100, 90]), -0.1);
  assert.equal(mod.pctChange([0, 50]), null); // base zero guard
});

test("mixDiff returns b minus a per regime", () => {
  const a = { bull: 0.5, chop: 0.5, bear: 0, crash: 0 };
  const b = { bull: 0.2, chop: 0.6, bear: 0.1, crash: 0.1 };
  const d = mod.mixDiff(a, b);
  assert.ok(Math.abs(d.bull - -0.3) < 1e-9);
  assert.ok(Math.abs(d.chop - 0.1) < 1e-9);
  assert.equal(d.bear, 0.1);
  assert.equal(d.crash, 0.1);
});

test("isValidRunId enforces charset and length bounds", () => {
  assert.equal(mod.isValidRunId("abc123_-XYZ"), true);
  assert.equal(mod.isValidRunId(""), false);
  assert.equal(mod.isValidRunId("short"), false); // 5 chars
  assert.equal(mod.isValidRunId("a".repeat(65)), false);
  assert.equal(mod.isValidRunId("../etc/passwd"), false);
  assert.equal(mod.isValidRunId(null), false);
  assert.equal(mod.isValidRunId(123), false);
});

const sampleMeta = {
  a: { id: "run_aaa111", label: "AAPL 200d", ticker: "AAPL", lookback_days: 200, created_at: "2026-05-01T00:00:00.000Z" },
  b: { id: "run_bbb222", label: "MSFT 200d", ticker: "MSFT", lookback_days: 200, created_at: "2026-05-02T00:00:00.000Z" },
};
const sampleSummary = {
  a: { bars: 200, mix: { bull: 0.5, chop: 0.3, bear: 0.2, crash: 0 }, regime: "bull", confidence: 0.8, pct_change: 0.1 },
  b: { bars: 180, mix: { bull: 0.2, chop: 0.6, bear: 0.1, crash: 0.1 }, regime: "chop", confidence: 0.6, pct_change: -0.05 },
  mix_diff: { bull: -0.3, chop: 0.3, bear: -0.1, crash: 0.1 },
};

test("compareToCSV emits one row per metric with delta column", () => {
  const csv = mod.compareToCSV(sampleMeta, sampleSummary);
  const rows = csv.trim().split("\n");
  // 3 comment/meta lines + header + 4 scalar metrics + 4 mix metrics = 12
  assert.equal(rows.length, 12);
  assert.equal(rows[0], "# signalclaw compare export");
  assert.ok(rows[1].startsWith("# A,run_aaa111,AAPL,"));
  assert.ok(rows[2].startsWith("# B,run_bbb222,MSFT,"));
  assert.equal(rows[3], "metric,a,b,delta");
  assert.equal(rows[4], "bars,200,180,-20");
  assert.equal(rows[5], "regime,bull,chop,");
  // confidence row: delta = 0.6 - 0.8 = -0.2 (allow float)
  const conf = rows[6].split(",");
  assert.equal(conf[0], "confidence");
  assert.ok(Math.abs(Number(conf[3]) - -0.2) < 1e-9);
  // mix_bull delta = -0.3
  const bull = rows.find((r) => r.startsWith("mix_bull,"));
  assert.ok(bull);
  assert.ok(Math.abs(Number(bull.split(",")[3]) - -0.3) < 1e-9);
});

test("compareToCSV leaves delta empty when one side is null", () => {
  const s = {
    a: { ...sampleSummary.a, confidence: null, pct_change: null },
    b: sampleSummary.b,
    mix_diff: sampleSummary.mix_diff,
  };
  const csv = mod.compareToCSV(sampleMeta, s);
  const rows = csv.trim().split("\n");
  const conf = rows.find((r) => r.startsWith("confidence,")).split(",");
  assert.equal(conf[1], "");
  assert.equal(conf[3], "");
  const pct = rows.find((r) => r.startsWith("pct_change,")).split(",");
  assert.equal(pct[1], "");
  assert.equal(pct[3], "");
});

test("compareToCSV escapes labels with commas and quotes", () => {
  const meta = {
    a: { ...sampleMeta.a, label: 'AAPL, "long" 200d' },
    b: sampleMeta.b,
  };
  const csv = mod.compareToCSV(meta, sampleSummary);
  // The escaped label is inside the A comment line. Confirm both the wrapping
  // quotes and the doubled inner quotes survived.
  assert.ok(csv.includes('"AAPL, ""long"" 200d"'));
});

test("compareExportFilename strips unsafe chars and pins extension", () => {
  const meta = {
    a: { ...sampleMeta.a, ticker: "BRK.B" },
    b: { ...sampleMeta.b, ticker: "A/B" },
  };
  assert.equal(
    mod.compareExportFilename(meta, "csv"),
    "signalclaw-compare-BRK.B-vs-A_B-run_aaa111-run_bbb222.csv",
  );
  assert.equal(
    mod.compareExportFilename(meta, "json"),
    "signalclaw-compare-BRK.B-vs-A_B-run_aaa111-run_bbb222.json",
  );
});

test("parseCompareParams pulls valid a and b ids from URLSearchParams", () => {
  const p = new URLSearchParams("a=run_aaa111&b=run_bbb222");
  assert.deepEqual(mod.parseCompareParams(p), { a: "run_aaa111", b: "run_bbb222" });
});

test("parseCompareParams returns nulls for missing or malformed ids", () => {
  assert.deepEqual(mod.parseCompareParams(new URLSearchParams("")), { a: null, b: null });
  assert.deepEqual(
    mod.parseCompareParams(new URLSearchParams("a=../etc/passwd&b=run_okokok")),
    { a: null, b: "run_okokok" },
  );
  assert.deepEqual(
    mod.parseCompareParams(new URLSearchParams("a=run_okokok&b=short")),
    { a: "run_okokok", b: null },
  );
});

test("parseCompareParams refuses self-compare by zeroing b", () => {
  const p = new URLSearchParams("a=run_same01&b=run_same01");
  assert.deepEqual(mod.parseCompareParams(p), { a: "run_same01", b: null });
});

test("parseCompareParams accepts any object exposing get()", () => {
  const fake = { get: (k) => (k === "a" ? "run_aaa111" : k === "b" ? "run_bbb222" : null) };
  assert.deepEqual(mod.parseCompareParams(fake), { a: "run_aaa111", b: "run_bbb222" });
});

test("compareToMarkdown renders summary + mix tables with B minus A deltas", () => {
  const md = mod.compareToMarkdown(sampleMeta, sampleSummary);
  // Header line names both runs.
  assert.ok(md.startsWith("# SignalClaw compare: AAPL (200d) vs MSFT (200d)"));
  // Run ids surfaced for traceability.
  assert.ok(md.includes("`run_aaa111`"));
  assert.ok(md.includes("`run_bbb222`"));
  // Bars row: 200 / 180 / -20.
  assert.ok(md.includes("| Bars | 200 | 180 | -20 |"));
  // Regime row leaves delta blank (categorical).
  assert.ok(md.includes("| Regime | bull | chop |  |"));
  // Confidence delta: 60% - 80% = -20 pts.
  assert.ok(md.includes("| Confidence | 80% | 60% | -20 pts |"));
  // Window return delta: -5% - 10% = -15 pts.
  assert.ok(md.includes("| Window return | +10.00% | -5.00% | -15.00 pts |"));
  // Mix table emits one row per regime in canonical order.
  const lines = md.split("\n");
  const mixIdx = lines.findIndex((l) => l === "## Regime mix");
  assert.ok(mixIdx > 0);
  const order = ["bull", "chop", "bear", "crash"];
  for (let i = 0; i < order.length; i++) {
    assert.ok(lines[mixIdx + 4 + i].startsWith(`| ${order[i]} |`));
  }
});

test("compareToMarkdown handles null regimes and missing pct_change", () => {
  const meta = sampleMeta;
  const s = {
    a: { bars: 0, mix: { bull: 0, chop: 0, bear: 0, crash: 0 }, regime: null, confidence: null, pct_change: null },
    b: { bars: 0, mix: { bull: 0, chop: 0, bear: 0, crash: 0 }, regime: null, confidence: null, pct_change: null },
    mix_diff: { bull: 0, chop: 0, bear: 0, crash: 0 },
  };
  const md = mod.compareToMarkdown(meta, s);
  assert.ok(md.includes("| Regime | -- | -- |  |"));
  assert.ok(md.includes("| Confidence | -- | -- | -- |"));
  assert.ok(md.includes("| Window return | -- | -- | -- |"));
});

test("compareExportFilename supports md format", () => {
  assert.equal(
    mod.compareExportFilename(sampleMeta, "md"),
    "signalclaw-compare-AAPL-vs-MSFT-run_aaa111-run_bbb222.md",
  );
});
