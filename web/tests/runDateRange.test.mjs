// node --experimental-strip-types --test tests/runDateRange.test.mjs
//
// `queryRuns` now honors a `since` / `until` date range so the history page
// (and both /api/runs/export and /api/v1/runs/export, via parseExportQuery)
// can narrow large histories to a specific window. Bare YYYY-MM-DD on
// `until` is pinned to end-of-day UTC so the inclusive day is not silently
// dropped. Invalid strings are ignored, matching the lenient policy on the
// other text filters.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-rundr-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const rs = await import(path.join(repoRoot, "lib", "runStore.ts"));
const ep = await import(path.join(repoRoot, "lib", "runsExportParams.ts"));

function fakePayload(ticker) {
  const dates = ["2024-01-01", "2024-01-02"];
  return {
    ticker,
    dates,
    close: [100, 101],
    snapshot: { as_of: dates[1], label: "trend_up", confidence: 0.5 },
  };
}

// Three runs at known instants: 2024-03-10, 2024-03-15 12:00:00, 2024-03-20.
async function seed(ticker, createdAt) {
  const r = await rs.createRun({
    label: ticker + " " + createdAt,
    ticker,
    lookback_days: 2,
    payload: fakePayload(ticker),
    tags: [],
  });
  // The store has no exported createdAt override, so rewrite the JSON file
  // in place. This mirrors how we'd seed historical data in fixtures.
  const dataFile = path.join(tmpRoot, ".data", "runs.json");
  const raw = JSON.parse(await fs.readFile(dataFile, "utf8"));
  const row = raw.runs.find((x) => x.id === r.id);
  row.created_at = createdAt;
  await fs.writeFile(dataFile, JSON.stringify(raw, null, 2), "utf8");
  return r.id;
}

await seed("AAA", "2024-03-10T10:00:00.000Z");
await seed("BBB", "2024-03-15T12:00:00.000Z");
await seed("CCC", "2024-03-20T18:30:00.000Z");

function tickersOf(runs) {
  return runs.map((r) => r.ticker).sort();
}

test("since=YYYY-MM-DD includes runs created on that day or later", async () => {
  const { runs, total } = await rs.queryRuns({ since: "2024-03-15" });
  assert.equal(total, 2);
  assert.deepEqual(tickersOf(runs), ["BBB", "CCC"]);
});

test("until=YYYY-MM-DD is end-of-day inclusive (does not drop same-day runs)", async () => {
  const { runs, total } = await rs.queryRuns({ until: "2024-03-15" });
  assert.equal(total, 2);
  assert.deepEqual(tickersOf(runs), ["AAA", "BBB"]);
});

test("since+until narrows to a single day window", async () => {
  const { runs, total } = await rs.queryRuns({ since: "2024-03-15", until: "2024-03-15" });
  assert.equal(total, 1);
  assert.equal(runs[0].ticker, "BBB");
});

test("full ISO timestamps are honored (sub-day precision)", async () => {
  const r1 = await rs.queryRuns({ since: "2024-03-15T13:00:00.000Z" });
  assert.deepEqual(tickersOf(r1.runs), ["CCC"]);
  const r2 = await rs.queryRuns({ until: "2024-03-15T11:00:00.000Z" });
  assert.deepEqual(tickersOf(r2.runs), ["AAA"]);
});

test("invalid since/until is ignored, not 500'd", async () => {
  const { total } = await rs.queryRuns({ since: "not-a-date", until: "also-bad" });
  assert.equal(total, 3);
});

test("parseExportQuery forwards since/until to queryRuns", async () => {
  const sp = new URL("http://x/?since=2024-03-15&until=2024-03-15").searchParams;
  const opts = ep.parseExportQuery(sp);
  assert.equal(opts.since, "2024-03-15");
  assert.equal(opts.until, "2024-03-15");
  const { runs, total } = await rs.queryRuns(opts);
  assert.equal(total, 1);
  assert.equal(runs[0].ticker, "BBB");
});

test("parseExportQuery omits since/until when blank (no filter applied)", () => {
  const opts = ep.parseExportQuery(new URL("http://x/").searchParams);
  assert.equal(opts.since, undefined);
  assert.equal(opts.until, undefined);
});
