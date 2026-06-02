// node --experimental-strip-types --test tests/runsExportFilters.test.mjs
//
// Regression: the /api/runs/export and /api/v1/runs/export routes silently
// ignored the `tag` and `pinned` query params. The history page sends those
// when the user has filtered the list, so clicking "Export CSV" while
// viewing only tag=earnings or pinned-only runs returned everything,
// not the filtered selection. Both routes now route their params through
// `lib/runsExportParams.ts`. This test exercises that helper end-to-end
// with the real runStore so the route + filter wiring stays honest.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-expfilt-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const rs = await import(path.join(repoRoot, "lib", "runStore.ts"));
const ep = await import(path.join(repoRoot, "lib", "runsExportParams.ts"));

function fakePayload(ticker) {
  const dates = [];
  const close = [];
  const start = new Date("2024-01-02T00:00:00Z").getTime();
  for (let i = 0; i < 8; i++) {
    dates.push(new Date(start + i * 86400000).toISOString().slice(0, 10));
    close.push(100 + i);
  }
  return { ticker, dates, close, snapshot: { as_of: dates[7], label: "trend_up", confidence: 0.5 } };
}

const r1 = await rs.createRun({
  label: "SPY earnings",
  ticker: "SPY",
  lookback_days: 8,
  payload: fakePayload("SPY"),
  tags: ["earnings"],
});
const r2 = await rs.createRun({
  label: "AAPL noise",
  ticker: "AAPL",
  lookback_days: 8,
  payload: fakePayload("AAPL"),
  tags: ["noise"],
});
const r3 = await rs.createRun({
  label: "MSFT earnings pinned",
  ticker: "MSFT",
  lookback_days: 8,
  payload: fakePayload("MSFT"),
  tags: ["earnings"],
});
await rs.setRunPinned(r3.id, true);

function sp(qs) {
  return new URL("http://x/?" + qs).searchParams;
}

test("parseExportFormat: defaults to csv, rejects unknown, accepts json", () => {
  assert.equal(ep.parseExportFormat(null), "csv");
  assert.equal(ep.parseExportFormat(undefined), "csv");
  assert.equal(ep.parseExportFormat("json"), "json");
  assert.equal(ep.parseExportFormat("JSON"), "json");
  assert.equal(ep.parseExportFormat("xml"), null);
  // Empty string is treated as explicit bad format (matches prior route behavior).
  assert.equal(ep.parseExportFormat(""), null);
});

test("parseExportFormat: accepts md and markdown (both normalize to md)", () => {
  assert.equal(ep.parseExportFormat("md"), "md");
  assert.equal(ep.parseExportFormat("MD"), "md");
  assert.equal(ep.parseExportFormat("markdown"), "md");
  assert.equal(ep.parseExportFormat("Markdown"), "md");
});

test("exportHeaders: md format gets .md extension and text/markdown content type", () => {
  const h = ep.exportHeaders(3, 3, "md");
  assert.equal(h["content-type"], "text/markdown; charset=utf-8");
  assert.match(h["content-disposition"], /signalclaw-runs-.*\.md/);
  assert.equal(h["x-truncated"], "0");
});

test("runsToMarkdown: header, one row per run, escapes pipes, empty fallback", async () => {
  const md = rs.runsToMarkdown([r1, r3]);
  assert.match(md, /# SignalClaw runs \(2\)/);
  assert.match(md, /\| Ticker \| Label \|/);
  assert.match(md, /\| SPY \|/);
  assert.match(md, /\| MSFT \|/);
  assert.match(md, /`#earnings`/);
  assert.match(md, /research tooling/);
  // One header line + separator + 2 rows + spacing/footer
  const rows = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---") && !l.startsWith("| Ticker"));
  assert.equal(rows.length, 2);

  const empty = rs.runsToMarkdown([]);
  assert.match(empty, /# SignalClaw runs \(0\)/);
  assert.match(empty, /No runs matched/);
});

test("parseExportLimit: clamps to [1, 200] and tolerates junk", () => {
  assert.equal(ep.parseExportLimit(null), 200);
  assert.equal(ep.parseExportLimit("50"), 50);
  assert.equal(ep.parseExportLimit("9999"), 200);
  // 0 and negatives fall back to the 200 default (then clamped).
  assert.equal(ep.parseExportLimit("0"), 200);
  assert.equal(ep.parseExportLimit("-3"), 200);
  assert.equal(ep.parseExportLimit("abc"), 200);
  assert.equal(ep.parseExportLimit("1"), 1);
});

test("parseExportQuery: forwards tag and pinned (regression - both were dropped)", () => {
  const opts = ep.parseExportQuery(sp("q=foo&regime=bear&ticker=spy&tag=earnings&pinned=1&limit=10"));
  assert.equal(opts.q, "foo");
  assert.equal(opts.regime, "bear");
  assert.equal(opts.ticker, "spy");
  assert.equal(opts.tag, "earnings");
  assert.equal(opts.pinned, true);
  assert.equal(opts.limit, 10);
  assert.equal(opts.offset, 0);
});

test("parseExportQuery: pinned omitted (not false) when flag absent so queryRuns won't filter", () => {
  const opts = ep.parseExportQuery(sp(""));
  assert.equal(opts.pinned, undefined);
  assert.equal(opts.tag, "");
});

test("end-to-end: queryRuns(parseExportQuery(tag=earnings)) returns only earnings runs", async () => {
  const opts = ep.parseExportQuery(sp("tag=earnings"));
  const { runs, total } = await rs.queryRuns(opts);
  assert.equal(total, 2);
  const tickers = runs.map((r) => r.ticker).sort();
  assert.deepEqual(tickers, ["MSFT", "SPY"]);
});

test("end-to-end: pinned=1 narrows to pinned runs only", async () => {
  const opts = ep.parseExportQuery(sp("pinned=1"));
  const { runs, total } = await rs.queryRuns(opts);
  assert.equal(total, 1);
  assert.equal(runs[0].ticker, "MSFT");
});

test("parseExportQuery: forwards both min_confidence and max_confidence (regression - max was dropped from history export URL)", () => {
  const opts = ep.parseExportQuery(sp("min_confidence=40&max_confidence=60"));
  // parseMinConfidence converts percent inputs to fractions in [0, 1].
  assert.ok(opts.minConfidence !== undefined && Math.abs(opts.minConfidence - 0.4) < 1e-9);
  assert.ok(opts.maxConfidence !== undefined && Math.abs(opts.maxConfidence - 0.6) < 1e-9);
});

test("end-to-end: max_confidence bounds the result set (excludes confidence=0.5 run when max=40%)", async () => {
  const opts = ep.parseExportQuery(sp("max_confidence=40"));
  const { total } = await rs.queryRuns(opts);
  // All seeded runs have snapshot confidence 0.5, so a 40% ceiling excludes them all.
  assert.equal(total, 0);
});

test("end-to-end: tag + pinned combine", async () => {
  const opts = ep.parseExportQuery(sp("tag=earnings&pinned=true"));
  const { runs, total } = await rs.queryRuns(opts);
  assert.equal(total, 1);
  assert.equal(runs[0].ticker, "MSFT");
});

test("exportHeaders: x-truncated flips when exported < total", () => {
  const h1 = ep.exportHeaders(3, 3, "csv");
  assert.equal(h1["x-total-count"], "3");
  assert.equal(h1["x-exported-count"], "3");
  assert.equal(h1["x-truncated"], "0");
  assert.match(h1["content-disposition"], /\.csv"$/);
  assert.match(h1["content-type"], /text\/csv/);

  const h2 = ep.exportHeaders(500, 200, "json");
  assert.equal(h2["x-total-count"], "500");
  assert.equal(h2["x-exported-count"], "200");
  assert.equal(h2["x-truncated"], "1");
  assert.match(h2["content-disposition"], /\.json"$/);
  assert.match(h2["content-type"], /application\/json/);
});
