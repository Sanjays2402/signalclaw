// Plain Node test for the run store. Runs with: node --test tests/runStore.test.mjs
// Uses tsx-free path: imports the compiled .ts module via dynamic import after
// running through Node's experimental type stripping (Node >=22 with --experimental-strip-types)
// or via tsx. For portability we register tsx if available.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Use a temp cwd so the store writes into an isolated directory.
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-runstore-"));
process.chdir(tmpRoot);

// Try to load via tsx if present, else native strip-types.
let store;
try {
  // Resolve relative to repo root.
  const repoRoot = path.resolve(import.meta.dirname, "..");
  // Native --experimental-strip-types path: just import the .ts file by URL.
  store = await import(path.join(repoRoot, "lib", "runStore.ts"));
} catch (e) {
  // Fallback: try tsx loader if user pre-registered it.
  throw new Error(
    "Could not import runStore.ts. Run with: node --experimental-strip-types --test tests/runStore.test.mjs",
  );
}

const samplePayload = {
  ticker: "SPY",
  dates: ["2024-01-02", "2024-01-03"],
  close: [470.1, 471.5],
  regime: ["bull", "bull"],
  counts: { bull: 2, chop: 0, bear: 0, crash: 0 },
  snapshot: {
    label: "bull",
    realized_vol: 0.12,
    trend_slope: 0.0008,
    drawdown: -0.01,
    confidence: 0.82,
    risk_scale: 1.0,
    as_of: "2024-01-03",
  },
  disclaimer: "research only",
};

test("create, list, get, rename, delete", async () => {
  await store._resetForTests();

  const created = await store.createRun({
    label: "SPY 2Y",
    ticker: "SPY",
    lookback_days: 504,
    payload: samplePayload,
  });
  assert.equal(typeof created.id, "string");
  assert.equal(created.id.length, 10);
  assert.equal(created.label, "SPY 2Y");

  const listed = await store.listRuns();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const fetched = await store.getRun(created.id);
  assert.ok(fetched);
  assert.equal(fetched.payload.ticker, "SPY");
  assert.equal(fetched.payload.dates.length, 2);

  const renamed = await store.renameRun(created.id, "Custom label");
  assert.ok(renamed);
  assert.equal(renamed.label, "Custom label");

  const missingRename = await store.renameRun("does-not-ex", "x");
  assert.equal(missingRename, null);

  const ok = await store.deleteRun(created.id);
  assert.equal(ok, true);
  const after = await store.listRuns();
  assert.equal(after.length, 0);

  const okAgain = await store.deleteRun(created.id);
  assert.equal(okAgain, false);
});

test("list returns newest first", async () => {
  await store._resetForTests();
  const a = await store.createRun({
    label: "A",
    ticker: "SPY",
    lookback_days: 252,
    payload: samplePayload,
  });
  // Force the second created_at to be later.
  await new Promise((r) => setTimeout(r, 5));
  const b = await store.createRun({
    label: "B",
    ticker: "QQQ",
    lookback_days: 252,
    payload: samplePayload,
  });
  const listed = await store.listRuns();
  assert.equal(listed[0].id, b.id);
  assert.equal(listed[1].id, a.id);
});

test("ids are unique across many runs", async () => {
  await store._resetForTests();
  const ids = new Set();
  for (let i = 0; i < 25; i++) {
    const r = await store.createRun({
      label: `r${i}`,
      ticker: "SPY",
      lookback_days: 252,
      payload: samplePayload,
    });
    ids.add(r.id);
  }
  assert.equal(ids.size, 25);
});

test("queryRuns: search, regime filter, pagination", async () => {
  await store._resetForTests();
  const mk = (label, ticker, regimeLabel) =>
    store.createRun({
      label,
      ticker,
      lookback_days: 252,
      payload: {
        ...samplePayload,
        ticker,
        snapshot: { ...samplePayload.snapshot, label: regimeLabel },
      },
    });
  await mk("SPY bull run", "SPY", "bull");
  await new Promise((r) => setTimeout(r, 2));
  await mk("QQQ chop", "QQQ", "chop");
  await new Promise((r) => setTimeout(r, 2));
  await mk("BTC crash", "BTC", "crash");
  await new Promise((r) => setTimeout(r, 2));
  await mk("AAPL bull", "AAPL", "bull");

  const all = await store.queryRuns({});
  assert.equal(all.total, 4);
  assert.equal(all.runs.length, 4);
  // Newest first.
  assert.equal(all.runs[0].label, "AAPL bull");

  const bulls = await store.queryRuns({ regime: "bull" });
  assert.equal(bulls.total, 2);
  assert.ok(bulls.runs.every((r) => r.payload.snapshot.label === "bull"));

  const search = await store.queryRuns({ q: "qqq" });
  assert.equal(search.total, 1);
  assert.equal(search.runs[0].ticker, "QQQ");

  const labelSearch = await store.queryRuns({ q: "crash" });
  assert.equal(labelSearch.total, 1);

  const ticker = await store.queryRuns({ ticker: "aapl" });
  assert.equal(ticker.total, 1);
  assert.equal(ticker.runs[0].ticker, "AAPL");

  const page1 = await store.queryRuns({ limit: 2, offset: 0 });
  assert.equal(page1.runs.length, 2);
  assert.equal(page1.total, 4);
  const page2 = await store.queryRuns({ limit: 2, offset: 2 });
  assert.equal(page2.runs.length, 2);
  assert.equal(page2.runs[0].id !== page1.runs[0].id, true);

  const none = await store.queryRuns({ q: "zzz-no-match" });
  assert.equal(none.total, 0);
  assert.equal(none.runs.length, 0);

  // Bounds: limit is clamped to >=1 and <=200.
  const clamped = await store.queryRuns({ limit: 0, offset: -5 });
  assert.equal(clamped.limit, 1);
  assert.equal(clamped.offset, 0);
});

test("runsToCSV: header + one row per bar + escaping", async () => {
  await store._resetForTests();
  const created = await store.createRun({
    label: 'has "quotes" and, comma',
    ticker: "SPY",
    lookback_days: 504,
    payload: samplePayload,
  });
  const csv = store.runsToCSV([created]);
  const lines = csv.trim().split("\n");
  // Header + 2 bars.
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("run_id,label,ticker,"));
  assert.ok(lines[0].endsWith(",bar_regime"));
  // Quoted/escaped label appears.
  assert.ok(lines[1].includes('"has ""quotes"" and, comma"'));
  // First bar row contains the first date and close.
  assert.ok(lines[1].includes("2024-01-02"));
  assert.ok(lines[1].includes("470.1"));
  // Second bar row contains the second date.
  assert.ok(lines[2].includes("2024-01-03"));

  // Empty input still returns a header.
  const empty = store.runsToCSV([]);
  assert.equal(empty.trim().split("\n").length, 1);
});

test("normalizeTags: lowercases, slugifies, dedups, caps at 8", async () => {
  const out = store.normalizeTags([
    "Swing",
    "swing", // dup
    "Q2 Watch", // becomes q2-watch
    "!!!", // empty after strip
    "with space",
    "ok",
    "ok2",
    "ok3",
    "ok4",
    "ok5",
    "ok6",
    "ok7", // over the cap
  ]);
  assert.ok(out.includes("swing"));
  assert.ok(out.includes("q2-watch"));
  assert.ok(out.includes("with-space"));
  // No duplicate swing.
  assert.equal(out.filter((t) => t === "swing").length, 1);
  // Capped at 8.
  assert.ok(out.length <= 8);
  assert.equal(store.normalizeTags(null).length, 0);
  assert.equal(store.normalizeTags("not-array").length, 0);
});

test("createRun + setRunTags + queryRuns by tag", async () => {
  await store._resetForTests();
  const a = await store.createRun({
    label: "A",
    ticker: "SPY",
    lookback_days: 252,
    payload: samplePayload,
    tags: ["Swing", "watch"],
  });
  assert.deepEqual(a.tags, ["swing", "watch"]);

  const b = await store.createRun({
    label: "B",
    ticker: "QQQ",
    lookback_days: 252,
    payload: samplePayload,
  });
  assert.deepEqual(b.tags, []);

  const upd = await store.setRunTags(b.id, ["Watch", "Q2"]);
  assert.ok(upd);
  assert.deepEqual(upd.tags.sort(), ["q2", "watch"]);

  const tags = await store.listTags();
  // watch should have count 2.
  const watch = tags.find((t) => t.tag === "watch");
  assert.ok(watch);
  assert.equal(watch.count, 2);

  const byTag = await store.queryRuns({ tag: "swing" });
  assert.equal(byTag.total, 1);
  assert.equal(byTag.runs[0].id, a.id);

  // Search also matches tag substring.
  const bySearch = await store.queryRuns({ q: "swin" });
  assert.equal(bySearch.total, 1);
  assert.equal(bySearch.runs[0].id, a.id);

  // Unknown tag returns empty without crashing.
  const none = await store.queryRuns({ tag: "nope" });
  assert.equal(none.total, 0);

  // Invalid tag chars get ignored as a filter (returns all).
  const all = await store.queryRuns({ tag: "!!!" });
  assert.equal(all.total, 2);
});

test("setRunTags returns null for missing id", async () => {
  await store._resetForTests();
  const res = await store.setRunTags("doesnotexs", ["x"]);
  assert.equal(res, null);
});

test("setRunNotes saves, trims, strips control chars, caps length", async () => {
  await store._resetForTests();
  const r = await store.createRun({
    label: "notes test",
    ticker: "SPY",
    lookback_days: 30,
    payload: samplePayload,
  });

  // Save with surrounding whitespace and a bell control char in the middle.
  const updated = await store.setRunNotes(r.id, "  rate cut day\u0007clean breakout  ");
  assert.ok(updated);
  assert.equal(updated.notes, "rate cut dayclean breakout");

  // Empty string clears.
  const cleared = await store.setRunNotes(r.id, "");
  assert.equal(cleared.notes, "");

  // Long input is capped to MAX_NOTES_LEN.
  const huge = "x".repeat(store.MAX_NOTES_LEN + 500);
  const capped = await store.setRunNotes(r.id, huge);
  assert.equal(capped.notes.length, store.MAX_NOTES_LEN);

  // Newlines are preserved.
  const multi = await store.setRunNotes(r.id, "line1\nline2\tindented");
  assert.equal(multi.notes, "line1\nline2\tindented");

  // Non-string input becomes empty string.
  const nonstr = await store.setRunNotes(r.id, 123);
  assert.equal(nonstr.notes, "");
});

test("setRunNotes returns null for missing id", async () => {
  await store._resetForTests();
  const res = await store.setRunNotes("doesnotexs", "hi");
  assert.equal(res, null);
});

test("queryRuns q searches inside notes (case-insensitive substring)", async () => {
  await store._resetForTests();
  const a = await store.createRun({
    label: "alpha",
    ticker: "SPY",
    lookback_days: 30,
    payload: samplePayload,
  });
  const b = await store.createRun({
    label: "beta",
    ticker: "QQQ",
    lookback_days: 30,
    payload: samplePayload,
  });
  await store.setRunNotes(a.id, "Watching breakout above 440 into FOMC");
  await store.setRunNotes(b.id, "thin volume, fade rallies");

  // Note-only substring (not in label/ticker/id/tags) finds the run.
  const fomc = await store.queryRuns({ q: "fomc" });
  assert.equal(fomc.total, 1);
  assert.equal(fomc.runs[0].id, a.id);

  // Mixed-case match works.
  const fade = await store.queryRuns({ q: "FADE" });
  assert.equal(fade.total, 1);
  assert.equal(fade.runs[0].id, b.id);

  // Empty-notes runs don't crash and aren't matched by arbitrary text.
  const c = await store.createRun({
    label: "gamma",
    ticker: "IWM",
    lookback_days: 30,
    payload: samplePayload,
  });
  const none = await store.queryRuns({ q: "definitely-not-anywhere" });
  assert.equal(none.total, 0);
  // And searching the label still works for the no-notes run.
  const gamma = await store.queryRuns({ q: "gamma" });
  assert.equal(gamma.total, 1);
  assert.equal(gamma.runs[0].id, c.id);
});

test("notes persist across reads and survive ensureTags backfill", async () => {
  await store._resetForTests();
  const r = await store.createRun({
    label: "persist",
    ticker: "QQQ",
    lookback_days: 30,
    payload: samplePayload,
  });
  await store.setRunNotes(r.id, "watching breakout above 440");
  const fetched = await store.getRun(r.id);
  assert.equal(fetched.notes, "watching breakout above 440");
});

test("setRunPinned toggles pinned + pinned_at and queryRuns filters", async () => {
  await store._resetForTests();
  const a = await store.createRun({ label: "a", ticker: "SPY", lookback_days: 30, payload: samplePayload });
  const b = await store.createRun({ label: "b", ticker: "QQQ", lookback_days: 30, payload: samplePayload });
  const c = await store.createRun({ label: "c", ticker: "IWM", lookback_days: 30, payload: samplePayload });

  // Default: not pinned.
  const beforeFetch = await store.getRun(a.id);
  assert.equal(beforeFetch.pinned, false);
  assert.equal(beforeFetch.pinned_at, null);

  // Pin a and c.
  const pinnedA = await store.setRunPinned(a.id, true);
  assert.equal(pinnedA.pinned, true);
  assert.ok(typeof pinnedA.pinned_at === "string" && pinnedA.pinned_at.length > 0);
  await store.setRunPinned(c.id, true);

  // Filter pinned only.
  const onlyPinned = await store.queryRuns({ pinned: true, limit: 50 });
  assert.equal(onlyPinned.total, 2);
  const ids = new Set(onlyPinned.runs.map((r) => r.id));
  assert.ok(ids.has(a.id));
  assert.ok(ids.has(c.id));
  assert.ok(!ids.has(b.id));

  // Unpin.
  const unpinned = await store.setRunPinned(a.id, false);
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.pinned_at, null);

  // listPinnedRuns sorts by pinned_at desc.
  const list = await store.listPinnedRuns(5);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, c.id);

  // Missing id returns null.
  const miss = await store.setRunPinned("zzzzzzzzzz", true);
  assert.equal(miss, null);
});

test("queryRuns sort: recent (default), oldest, ticker, confidence, bars", async () => {
  await store._resetForTests();

  function payloadWith({ bars, confidence }) {
    const dates = Array.from({ length: bars }, (_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`);
    const close = Array.from({ length: bars }, (_, i) => 100 + i);
    const regime = Array.from({ length: bars }, () => "bull");
    return {
      ticker: "X",
      dates,
      close,
      regime,
      counts: { bull: bars, chop: 0, bear: 0, crash: 0 },
      snapshot: {
        label: "bull",
        realized_vol: 0.1,
        trend_slope: 0.001,
        drawdown: -0.01,
        confidence,
        risk_scale: 1.0,
        as_of: dates[dates.length - 1],
      },
      disclaimer: "research only",
    };
  }

  const a = await store.createRun({ label: "a", ticker: "ZZZ", lookback_days: 30, payload: payloadWith({ bars: 2, confidence: 0.5 }) });
  await new Promise((r) => setTimeout(r, 5));
  const b = await store.createRun({ label: "b", ticker: "AAA", lookback_days: 30, payload: payloadWith({ bars: 10, confidence: 0.9 }) });
  await new Promise((r) => setTimeout(r, 5));
  const c = await store.createRun({ label: "c", ticker: "MMM", lookback_days: 30, payload: payloadWith({ bars: 5, confidence: 0.7 }) });

  const recent = await store.queryRuns({ limit: 10 });
  assert.deepEqual(recent.runs.map((r) => r.id), [c.id, b.id, a.id]);

  const oldest = await store.queryRuns({ sort: "oldest", limit: 10 });
  assert.deepEqual(oldest.runs.map((r) => r.id), [a.id, b.id, c.id]);

  const byTicker = await store.queryRuns({ sort: "ticker", limit: 10 });
  assert.deepEqual(byTicker.runs.map((r) => r.id), [b.id, c.id, a.id]);

  const byConf = await store.queryRuns({ sort: "confidence", limit: 10 });
  assert.deepEqual(byConf.runs.map((r) => r.id), [b.id, c.id, a.id]);

  const byBars = await store.queryRuns({ sort: "bars", limit: 10 });
  assert.deepEqual(byBars.runs.map((r) => r.id), [b.id, c.id, a.id]);

  // Unknown sort value falls back to recent via API; the store treats unknown
  // values as default since the type is constrained.
  const fallback = await store.queryRuns({ sort: undefined, limit: 10 });
  assert.deepEqual(fallback.runs.map((r) => r.id), [c.id, b.id, a.id]);
});
