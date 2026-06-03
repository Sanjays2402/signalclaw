// Plain Node test for rotation export helpers.
// Run with: node --experimental-strip-types --test tests/rotationExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "rotationExport.ts"));

const sample = {
  benchmark: "SPY",
  asof: "2026-06-02",
  overweight: ["Technology", "Energy"],
  underweight: ["Utilities"],
  scores: [
    {
      sector: "Utilities",
      n_tickers: 3,
      ret_1m: -0.0123,
      ret_3m: -0.0456,
      ret_6m: -0.0789,
      rs_slope: -0.0012,
      breadth: 0.3333,
      composite: -0.2,
      call: "underweight",
      members: ["NEE", "DUK", "SO"],
    },
    {
      sector: "Technology",
      n_tickers: 4,
      ret_1m: 0.05,
      ret_3m: 0.1234,
      ret_6m: 0.2,
      rs_slope: 0.0021,
      breadth: 0.75,
      composite: 0.5,
      call: "overweight",
      members: ["AAPL", "MSFT", "NVDA", "AMD"],
    },
    {
      sector: "Energy",
      n_tickers: 2,
      ret_1m: 0.02,
      ret_3m: 0.04,
      ret_6m: 0.08,
      rs_slope: 0.0011,
      breadth: 0.5,
      composite: 0.1,
      call: "overweight",
      members: ["XOM", "CVX"],
    },
  ],
  skipped_unknown_sector: ["FOO", "BAR"],
  skipped_short_history: ["NEW"],
};

test("rotationToCSV emits summary, score, and skipped sections", () => {
  const csv = mod.rotationToCSV(sample);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "section,key,value");
  assert.equal(lines[1], "summary,benchmark,SPY");
  assert.equal(lines[2], "summary,as_of,2026-06-02");
  assert.equal(lines[3], "summary,n_sectors,3");
  assert.equal(lines[4], "summary,overweight,Technology Energy");
  assert.equal(lines[5], "summary,underweight,Utilities");
  assert.equal(lines[6], "");
  assert.equal(
    lines[7],
    "rank,sector,call,composite,ret_1m,ret_3m,ret_6m,rs_slope,breadth,n_tickers,members",
  );
  // Sorted by composite descending: Tech (0.5), Energy (0.1), Utilities (-0.2).
  assert.equal(
    lines[8],
    "1,Technology,overweight,0.5000,0.0500,0.1234,0.2000,0.0021,0.7500,4,AAPL MSFT NVDA AMD",
  );
  assert.equal(
    lines[9],
    "2,Energy,overweight,0.1000,0.0200,0.0400,0.0800,0.0011,0.5000,2,XOM CVX",
  );
  assert.equal(
    lines[10],
    "3,Utilities,underweight,-0.2000,-0.0123,-0.0456,-0.0789,-0.0012,0.3333,3,NEE DUK SO",
  );
  assert.equal(lines[11], "");
  assert.equal(lines[12], "skipped_reason,tickers");
  assert.equal(lines[13], "unknown_sector,FOO BAR");
  assert.equal(lines[14], "short_history,NEW");
});

test("rotationToCSV ends with a trailing newline", () => {
  assert.ok(mod.rotationToCSV(sample).endsWith("\n"));
});

test("rotationToCSV handles empty scores and skipped lists", () => {
  const csv = mod.rotationToCSV({
    benchmark: "QQQ",
    asof: "2026-06-02",
    overweight: [],
    underweight: [],
    scores: [],
    skipped_unknown_sector: [],
    skipped_short_history: [],
  });
  const lines = csv.trim().split("\n");
  assert.equal(lines[1], "summary,benchmark,QQQ");
  assert.equal(lines[3], "summary,n_sectors,0");
  assert.ok(
    lines.includes(
      "rank,sector,call,composite,ret_1m,ret_3m,ret_6m,rs_slope,breadth,n_tickers,members",
    ),
  );
  assert.ok(lines.includes("skipped_reason,tickers"));
  assert.ok(lines.includes("unknown_sector,"));
  assert.ok(lines.includes("short_history,"));
});

test("rotationToCSV quotes sector and member fields with commas or quotes", () => {
  const csv = mod.rotationToCSV({
    ...sample,
    overweight: ["A,B"],
    scores: [
      {
        sector: 'Real Estate, REITs',
        n_tickers: 1,
        ret_1m: 0,
        ret_3m: 0,
        ret_6m: 0,
        rs_slope: 0,
        breadth: 0,
        composite: 0,
        call: 'neutral',
        members: ['"Q"', "PLD"],
      },
    ],
    skipped_unknown_sector: [],
    skipped_short_history: [],
  });
  assert.ok(csv.includes('summary,overweight,"A,B"'));
  assert.ok(csv.includes('"Real Estate, REITs"'));
  assert.ok(csv.includes('"""Q"" PLD"'));
});

test("rotationToCSV writes blank cells when numeric values are not finite", () => {
  const csv = mod.rotationToCSV({
    benchmark: "SPY",
    asof: "2026-06-02",
    overweight: [],
    underweight: [],
    scores: [
      {
        sector: "X",
        n_tickers: 1,
        ret_1m: Number.NaN,
        ret_3m: Number.POSITIVE_INFINITY,
        ret_6m: 0,
        rs_slope: 0,
        breadth: 0,
        composite: 0,
        call: "neutral",
        members: ["X1"],
      },
    ],
    skipped_unknown_sector: [],
    skipped_short_history: [],
  });
  // Row begins with rank, sector, call, composite, then ret_1m blank, ret_3m blank.
  assert.ok(csv.includes("1,X,neutral,0.0000,,,0.0000,0.0000,0.0000,1,X1"));
});

test("rotationToJSON round-trips into a structured payload", () => {
  const parsed = JSON.parse(mod.rotationToJSON(sample));
  assert.equal(parsed.benchmark, "SPY");
  assert.equal(parsed.asof, "2026-06-02");
  assert.deepEqual(parsed.overweight, ["Technology", "Energy"]);
  assert.equal(parsed.scores.length, 3);
  assert.equal(parsed.scores[0].sector, "Utilities");
  assert.deepEqual(parsed.skipped_unknown_sector, ["FOO", "BAR"]);
  assert.deepEqual(parsed.skipped_short_history, ["NEW"]);
});

test("rotationFilename embeds a sanitized benchmark and extension", () => {
  const csv = mod.rotationFilename("SPY", "csv");
  const json = mod.rotationFilename("QQQ", "json");
  const messy = mod.rotationFilename("BAD/NAME ?", "csv");
  assert.match(csv, /^signalclaw-rotation-SPY-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
  assert.match(json, /^signalclaw-rotation-QQQ-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
  assert.match(messy, /^signalclaw-rotation-BAD_NAME_-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
});
