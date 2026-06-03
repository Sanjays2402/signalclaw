// Plain Node test for usage page export helpers.
// Run with: node --experimental-strip-types --test tests/usageExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "usageExport.ts"));

function sample(overrides = {}) {
  return {
    used: 7,
    limit: 25,
    remaining: 18,
    pct: 0.28,
    over_quota: false,
    period_start: "2026-06-01",
    period_end: "2026-06-30",
    resets_at: "2026-07-01T00:00:00Z",
    days_remaining: 28,
    lifetime: 142,
    by_day: [
      { date: "2026-06-03", count: 4 },
      { date: "2026-06-01", count: 2 },
      { date: "2026-06-02", count: 1 },
    ],
    by_ticker: [
      { ticker: "AAPL", count: 3 },
      { ticker: "MSFT", count: 2 },
    ],
    by_regime: [
      { regime: "bull", count: 5 },
      { regime: "chop", count: 2 },
    ],
    ...overrides,
  };
}

test("usageToCSV emits header and sorts days ascending with running cumulative", () => {
  const csv = mod.usageToCSV(sample());
  const lines = csv.trim().split("\n");
  assert.equal(
    lines[0],
    "date,count,cumulative,used,limit,remaining,period_start,period_end",
  );
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith("2026-06-01,2,2,"));
  assert.ok(lines[2].startsWith("2026-06-02,1,3,"));
  assert.ok(lines[3].startsWith("2026-06-03,4,7,"));
  // Period columns carry the quota context on every row.
  assert.ok(lines[1].endsWith(",2026-06-01,2026-06-30"));
});

test("usageToCSV neutralises spreadsheet formula injection in date cells", () => {
  const csv = mod.usageToCSV(
    sample({ by_day: [{ date: "=cmd|' /C calc'!A1", count: 1 }] }),
  );
  const row = csv.trim().split("\n")[1];
  // Leading single quote tells Excel/Sheets to treat the cell as text.
  assert.ok(row.startsWith("'=cmd"), `got: ${row}`);
  // Also confirm a cell containing a comma still gets RFC 4180 quoted with the prefix.
  const csv2 = mod.usageToCSV(
    sample({ by_day: [{ date: "=a,b", count: 1 }] }),
  );
  const row2 = csv2.trim().split("\n")[1];
  assert.ok(row2.startsWith('"\'=a,b"'), `got: ${row2}`);
});

test("usageToCSV with empty by_day returns just the header line", () => {
  const csv = mod.usageToCSV(sample({ by_day: [] }));
  assert.equal(csv, "date,count,cumulative,used,limit,remaining,period_start,period_end\n");
});

test("usageToJSON is self-describing with exported_at and sorted by_day", () => {
  const json = JSON.parse(mod.usageToJSON(sample()));
  assert.ok(typeof json.exported_at === "string" && json.exported_at.endsWith("Z"));
  assert.equal(json.summary.used, 7);
  assert.equal(json.summary.limit, 25);
  assert.equal(json.summary.over_quota, false);
  assert.deepEqual(
    json.by_day.map((d) => d.date),
    ["2026-06-01", "2026-06-02", "2026-06-03"],
  );
  assert.equal(json.by_ticker.length, 2);
  assert.equal(json.by_regime[0].regime, "bull");
});

test("usageFilename embeds the period month and today's date", () => {
  const name = mod.usageFilename(sample(), "csv");
  assert.match(name, /^signalclaw-usage-2026-06-\d{4}-\d{2}-\d{2}\.csv$/);
});

test("usageFilename omits the period when period_start is malformed", () => {
  const name = mod.usageFilename(sample({ period_start: "" }), "json");
  assert.match(name, /^signalclaw-usage-\d{4}-\d{2}-\d{2}\.json$/);
});

test("usageToCSV tolerates non-finite counts", () => {
  const csv = mod.usageToCSV(
    sample({ by_day: [{ date: "2026-06-01", count: Number.NaN }] }),
  );
  const row = csv.trim().split("\n")[1];
  // count cell empty, cumulative resets to 0.
  assert.equal(row, "2026-06-01,,0,7,25,18,2026-06-01,2026-06-30");
});
