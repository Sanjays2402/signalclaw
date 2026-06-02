// Plain Node test for the watchlist store.
// Run with: node --experimental-strip-types --test tests/watchlistStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-watchlist-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "watchlistStore.ts"));

test("normalizeTicker accepts and rejects", () => {
  assert.equal(store.normalizeTicker("aapl"), "AAPL");
  assert.equal(store.normalizeTicker("  BRK.B "), "BRK.B");
  assert.equal(store.normalizeTicker("spy "), "SPY");
  assert.equal(store.normalizeTicker(""), null);
  assert.equal(store.normalizeTicker("1AAPL"), null);
  assert.equal(store.normalizeTicker("toolongtickersymbolxyz"), null);
  assert.equal(store.normalizeTicker(42), null);
});

test("add, list, update note, remove", async () => {
  const entry = await store.addTicker("aapl", "earnings 2/1");
  assert.equal(entry.ticker, "AAPL");
  assert.equal(entry.note, "earnings 2/1");

  await store.addTicker("spy");
  const list = await store.listWatchlist();
  assert.equal(list.length, 2);
  assert.equal(list[0].ticker, "SPY"); // newest first

  // Re-adding updates note when provided
  const again = await store.addTicker("AAPL", "updated note");
  assert.equal(again.note, "updated note");
  const list2 = await store.listWatchlist();
  assert.equal(list2.length, 2);

  const updated = await store.updateNote("aapl", "another");
  assert.equal(updated.note, "another");

  const ok = await store.removeTicker("aapl");
  assert.equal(ok, true);
  const missing = await store.removeTicker("aapl");
  assert.equal(missing, false);

  const final = await store.listWatchlist();
  assert.equal(final.length, 1);
  assert.equal(final[0].ticker, "SPY");
});

test("entriesToCSV escapes quotes and writes header", () => {
  const csv = store.entriesToCSV([
    { ticker: "AAPL", added_at: "2025-01-01T00:00:00Z", note: 'has "quote"', target_high: null, target_low: null, last_cross: null },
    { ticker: "SPY", added_at: "2025-01-02T00:00:00Z", note: null, target_high: 500, target_low: 400, last_cross: null },
  ]);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "ticker,added_at,note,target_low,target_high");
  assert.equal(lines[1], 'AAPL,2025-01-01T00:00:00Z,"has ""quote""",,');
  assert.equal(lines[2], 'SPY,2025-01-02T00:00:00Z,"",400,500');
});

test("normalizePrice rejects garbage and accepts numbers", () => {
  assert.equal(store.normalizePrice("abc"), null);
  assert.equal(store.normalizePrice(""), null);
  assert.equal(store.normalizePrice(null), null);
  assert.equal(store.normalizePrice(-1), null);
  assert.equal(store.normalizePrice(0), null);
  assert.equal(store.normalizePrice(1e9), null);
  assert.equal(store.normalizePrice("150.25"), 150.25);
  assert.equal(store.normalizePrice(42), 42);
});

test("setTargets validates and persists, recordCross writes state", async () => {
  await store.addTicker("NVDA");
  const entry = await store.setTargets("NVDA", 200, 100);
  assert.equal(entry.target_high, 200);
  assert.equal(entry.target_low, 100);
  assert.equal(entry.last_cross, null);

  await assert.rejects(() => store.setTargets("NVDA", 100, 150));

  const crossed = await store.recordCross("NVDA", { side: "above_high", price: 210, at: "2025-01-03T00:00:00Z" });
  assert.equal(crossed.last_cross.side, "above_high");
  assert.equal(crossed.last_cross.price, 210);

  // Changing targets clears the previous cross
  const reset = await store.setTargets("NVDA", 300, null);
  assert.equal(reset.target_high, 300);
  assert.equal(reset.target_low, null);
  assert.equal(reset.last_cross, null);

  // Missing ticker returns null
  const miss = await store.setTargets("ZZZZ", 1, null);
  assert.equal(miss, null);
});

test("bad ticker throws on add", async () => {
  await assert.rejects(() => store.addTicker("1bad"));
});

test("entriesToJSON wraps entries with exported_at and count", () => {
  const out = store.entriesToJSON([
    {
      ticker: "AAPL",
      added_at: "2025-01-01T00:00:00Z",
      note: "earnings",
      target_high: 200,
      target_low: 150,
      last_cross: null,
    },
  ]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.entries[0].ticker, "AAPL");
  assert.equal(parsed.entries[0].target_low, 150);
  assert.match(parsed.exported_at, /^\d{4}-\d{2}-\d{2}T/);
  // Pretty-printed and newline-terminated for diff friendliness.
  assert.ok(out.endsWith("\n"));
  assert.ok(out.includes("\n  "));

  const empty = JSON.parse(store.entriesToJSON([]));
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.entries, []);
});

test("entriesToMarkdown emits table with header, escapes pipes, and handles empty", () => {
  const empty = store.entriesToMarkdown([]);
  assert.match(empty, /# SignalClaw watchlist/);
  assert.match(empty, /No tickers tracked yet/);

  const md = store.entriesToMarkdown([
    {
      ticker: "AAPL",
      added_at: "2025-01-01T00:00:00Z",
      note: "has | pipe",
      target_high: 200,
      target_low: 150,
      last_cross: { side: "above_high", price: 210, at: "2025-01-03T00:00:00Z" },
    },
    {
      ticker: "SPY",
      added_at: "2025-01-02T00:00:00Z",
      note: null,
      target_high: null,
      target_low: null,
      last_cross: null,
    },
  ]);
  assert.match(md, /\| Ticker \| Added \| Target low \| Target high \| Note \| Last cross \|/);
  assert.match(md, /\| AAPL \| 2025-01-01 \| 150 \| 200 \| has \\\| pipe \| above @ 210 on 2025-01-03 \|/);
  assert.match(md, /\| SPY \| 2025-01-02 \|  \|  \|  \|  \|/);
  assert.match(md, /2 tickers/);
});
