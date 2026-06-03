// Plain Node test for diversification export helpers.
// Run with: node --experimental-strip-types --test tests/diversificationExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "diversificationExport.ts"));

const sample = {
  window: 60,
  threshold: 0.7,
  n_tickers: 4,
  avg_pairwise_corr: 0.4321,
  max_pairwise_corr: 0.8765,
  most_correlated_pair: ["AAPL", "MSFT"],
  clusters: [
    ["AAPL", "MSFT"],
    ["NVDA", "AMD", "TSM"],
  ],
  warnings: ["Two names above 0.85", "Tech cluster dominates portfolio"],
};

test("diversificationToCSV emits summary, cluster, and warning sections", () => {
  const csv = mod.diversificationToCSV(sample);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "section,key,value");
  assert.equal(lines[1], "summary,window,60");
  assert.equal(lines[2], "summary,threshold,0.7000");
  assert.equal(lines[3], "summary,n_tickers,4");
  assert.equal(lines[4], "summary,avg_pairwise_corr,0.4321");
  assert.equal(lines[5], "summary,max_pairwise_corr,0.8765");
  assert.equal(lines[6], "summary,most_correlated_pair,AAPL / MSFT");
  // Blank separator then cluster header.
  assert.equal(lines[7], "");
  assert.equal(lines[8], "cluster_index,size,members");
  assert.equal(lines[9], "1,2,AAPL MSFT");
  assert.equal(lines[10], "2,3,NVDA AMD TSM");
  assert.equal(lines[11], "");
  assert.equal(lines[12], "warning_index,message");
  assert.equal(lines[13], "1,Two names above 0.85");
  assert.equal(lines[14], "2,Tech cluster dominates portfolio");
});

test("diversificationToCSV ends with a trailing newline", () => {
  assert.ok(mod.diversificationToCSV(sample).endsWith("\n"));
});

test("diversificationToCSV handles missing pair, empty clusters and warnings", () => {
  const csv = mod.diversificationToCSV({
    window: 30,
    threshold: 0.6,
    n_tickers: 0,
    avg_pairwise_corr: NaN,
    max_pairwise_corr: NaN,
    most_correlated_pair: null,
    clusters: [],
    warnings: [],
  });
  const lines = csv.trim().split("\n");
  assert.equal(lines[1], "summary,window,30");
  assert.equal(lines[4], "summary,avg_pairwise_corr,");
  assert.equal(lines[6], "summary,most_correlated_pair,");
  // Cluster and warning headers still present even with no rows.
  assert.ok(lines.includes("cluster_index,size,members"));
  assert.ok(lines.includes("warning_index,message"));
});

test("diversificationToCSV quotes messages containing commas or quotes", () => {
  const csv = mod.diversificationToCSV({
    ...sample,
    clusters: [["A,B", "C"]],
    warnings: ['He said "hi", and left', "plain"],
  });
  assert.ok(csv.includes('1,2,"A,B C"'));
  assert.ok(csv.includes('1,"He said ""hi"", and left"'));
});

test("diversificationToJSON round-trips into a structured payload", () => {
  const parsed = JSON.parse(mod.diversificationToJSON(sample));
  assert.equal(parsed.window, 60);
  assert.equal(parsed.threshold, 0.7);
  assert.equal(parsed.n_tickers, 4);
  assert.deepEqual(parsed.most_correlated_pair, ["AAPL", "MSFT"]);
  assert.deepEqual(parsed.clusters, sample.clusters);
  assert.deepEqual(parsed.warnings, sample.warnings);
});

test("diversificationFilename embeds window, threshold, and extension", () => {
  const csv = mod.diversificationFilename(60, 0.7, "csv");
  const json = mod.diversificationFilename(120, 0.85, "json");
  assert.match(csv, /^signalclaw-diversification-w60-t0\.70-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
  assert.match(json, /^signalclaw-diversification-w120-t0\.85-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
});
