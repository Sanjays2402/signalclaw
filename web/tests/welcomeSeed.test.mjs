// Test the welcome seed payload builder and end to end persistence via runStore.
// Runs with: node --experimental-strip-types --test tests/welcomeSeed.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-welcome-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const seed = await import(path.join(repoRoot, "lib", "welcomeSeed.ts"));
const store = await import(path.join(repoRoot, "lib", "runStore.ts"));

test("normalizeSeedTicker uppercases, trims, defaults, truncates", () => {
  assert.equal(seed.normalizeSeedTicker("  demo "), "DEMO");
  assert.equal(seed.normalizeSeedTicker(""), "ACME");
  assert.equal(seed.normalizeSeedTicker(undefined), "ACME");
  assert.equal(seed.normalizeSeedTicker("abcdefghijkl"), "ABCDEFGH");
});

test("buildSamplePayload produces a complete 120 bar series", () => {
  const p = seed.buildSamplePayload("DEMO", 120);
  assert.equal(p.dates.length, 120);
  assert.equal(p.close.length, 120);
  assert.equal(p.regime.length, 120);
  const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, 120);
  assert.ok(["bull", "chop", "bear", "crash"].includes(p.snapshot.label));
  assert.equal(typeof p.snapshot.realized_vol, "number");
  assert.equal(p.snapshot.as_of, p.dates[p.dates.length - 1]);
});

test("buildSamplePayload is deterministic for the same inputs", () => {
  const a = seed.buildSamplePayload("DEMO", 120);
  const b = seed.buildSamplePayload("DEMO", 120);
  assert.deepEqual(a.close, b.close);
  assert.deepEqual(a.regime, b.regime);
});

test("createRun persists the seeded payload with onboarding tags", async () => {
  const ticker = seed.normalizeSeedTicker("acme");
  const payload = seed.buildSamplePayload(ticker, 120);
  const run = await store.createRun({
    label: `${ticker} · welcome sample`,
    ticker,
    lookback_days: 120,
    payload,
    tags: ["onboarding", "sample"],
  });
  assert.ok(run.id);
  const fetched = await store.getRun(run.id);
  assert.ok(fetched);
  assert.equal(fetched.ticker, "ACME");
  assert.equal(fetched.lookback_days, 120);
  assert.deepEqual([...fetched.tags].sort(), ["onboarding", "sample"]);
  assert.equal(fetched.payload.dates.length, 120);
});
