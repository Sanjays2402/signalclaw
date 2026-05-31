// node --experimental-strip-types --test tests/v1RunsExport.test.mjs
//
// The new /v1 export + usage + delete surface is plumbed through three
// libraries: keyStore (auth + scopes), runStore (queryRuns / runsToCSV /
// deleteRun) and quota (getUsageSummary). We exercise those end-to-end the
// way the routes call them, in an isolated cwd so the file-backed stores
// write into a tmp .data tree.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-v1exp-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));
const rs = await import(path.join(repoRoot, "lib", "runStore.ts"));
const qc = await import(path.join(repoRoot, "lib", "quotaCore.ts"));

function fakePayload(ticker) {
  const dates = [];
  const close = [];
  const start = new Date("2024-01-02T00:00:00Z").getTime();
  for (let i = 0; i < 32; i++) {
    dates.push(new Date(start + i * 86400000).toISOString().slice(0, 10));
    close.push(100 + Math.sin(i / 3) * 4 + i * 0.1);
  }
  return {
    ticker,
    dates,
    close,
    snapshot: {
      as_of: dates[dates.length - 1],
      label: "trend_up",
      confidence: 0.78,
    },
  };
}

const { secret: readKey } = await ks.createKey({
  label: "read-key",
  scopes: ["read"],
});
const { secret: tradeKey, key: tradeKeyRow } = await ks.createKey({
  label: "trade-key",
  scopes: ["read", "trade"],
});

const r1 = await rs.createRun({
  label: "SPY 32d test",
  ticker: "SPY",
  lookback_days: 32,
  payload: fakePayload("SPY"),
  tags: [],
});
const r2 = await rs.createRun({
  label: "AAPL 32d test",
  ticker: "AAPL",
  lookback_days: 32,
  payload: fakePayload("AAPL"),
  tags: [],
});

function reqWith(headers = {}) {
  return new Request("http://localhost/", { headers });
}

test("auth gate: missing bearer leaves request unauthenticated", async () => {
  const k = await ks.authenticate(ks.extractKey(reqWith()));
  assert.equal(k, null);
});

test("read scope can export but cannot delete (route guard mirrors this)", async () => {
  const k = await ks.authenticate(
    ks.extractKey(reqWith({ authorization: `Bearer ${readKey}` })),
  );
  assert.ok(k);
  assert.ok(k.scopes.includes("read"));
  assert.equal(k.scopes.includes("trade"), false);
});

test("bulk export: queryRuns + runsToCSV produces csv with both seeded rows", async () => {
  const { runs } = await rs.queryRuns({ limit: 200, offset: 0 });
  const csv = rs.runsToCSV(runs);
  assert.match(csv, /SPY/);
  assert.match(csv, /AAPL/);
  // Header row + at least 2 data rows.
  assert.ok(csv.split("\n").length >= 3);
});

test("bulk export json filter: ticker=SPY narrows to one run", async () => {
  const { runs, total } = await rs.queryRuns({
    ticker: "SPY",
    limit: 200,
    offset: 0,
  });
  assert.equal(total, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].ticker, "SPY");
});

test("single export: getRun returns the saved payload for known id", async () => {
  const got = await rs.getRun(r1.id);
  assert.ok(got);
  assert.equal(got.ticker, "SPY");
  const csv = rs.runsToCSV([got]);
  assert.match(csv, new RegExp(r1.id));
});

test("usage summary: reflects seeded runs and exposes a numeric limit", async () => {
  const all = await rs.listRuns();
  const u = qc.summarizeUsage(all, new Date(), qc.FREE_TIER_LIMIT);
  assert.equal(typeof u.limit, "number");
  assert.equal(typeof u.used, "number");
  assert.ok(u.used >= 2, "usage should include seeded runs");
});

test("delete: trade key has the scope the route requires, deleteRun removes the run", async () => {
  const authed = await ks.authenticate(
    ks.extractKey(reqWith({ authorization: `Bearer ${tradeKey}` })),
  );
  assert.ok(authed);
  assert.ok(authed.scopes.includes("trade"));
  const ok = await rs.deleteRun(r2.id);
  assert.equal(ok, true);
  assert.equal(await rs.getRun(r2.id), null);
  // Second delete is a no-op the route surfaces as 404.
  assert.equal(await rs.deleteRun(r2.id), false);
});
