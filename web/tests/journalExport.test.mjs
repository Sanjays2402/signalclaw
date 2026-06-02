// Plain Node test for journal export helpers.
// Run with: node --experimental-strip-types --test tests/journalExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "journalExport.ts"));

const entries = [
  {
    trade_id: "t1",
    thesis: "breakout above prior pivot",
    conviction: 4,
    tags: ["breakout", "earnings"],
    exit_reason: null,
    created_at: "2025-01-02T10:00:00.000Z",
    updated_at: "2025-01-02T10:05:00.000Z",
  },
  {
    trade_id: "t2,with comma",
    thesis: 'why, "this trade"\nnewline test',
    conviction: 2,
    tags: ["pairs"],
    exit_reason: "stopped out",
    created_at: "2025-01-03T11:00:00.000Z",
    updated_at: "2025-01-03T12:00:00.000Z",
  },
];

test("entriesToCSV emits header + one line per entry, with escaping", () => {
  const csv = mod.entriesToCSV(entries);
  const expected =
    "trade_id,created_at,updated_at,conviction,exit_reason,tags,thesis\n" +
    "t1,2025-01-02T10:00:00.000Z,2025-01-02T10:05:00.000Z,4,,breakout|earnings,breakout above prior pivot\n" +
    '"t2,with comma",2025-01-03T11:00:00.000Z,2025-01-03T12:00:00.000Z,2,stopped out,pairs,' +
    '"why, ""this trade""\nnewline test"\n';
  assert.equal(csv, expected);
});

test("entriesToCSV handles empty list", () => {
  const csv = mod.entriesToCSV([]);
  assert.equal(
    csv,
    "trade_id,created_at,updated_at,conviction,exit_reason,tags,thesis\n",
  );
});

test("entriesToJSON wraps with exported_at + count", () => {
  const payload = JSON.parse(mod.entriesToJSON(entries));
  assert.equal(payload.count, 2);
  assert.equal(payload.entries.length, 2);
  assert.equal(payload.entries[0].trade_id, "t1");
  assert.ok(typeof payload.exported_at === "string");
  assert.ok(!Number.isNaN(Date.parse(payload.exported_at)));
});

test("exportFilename has expected shape", () => {
  const f = mod.exportFilename("csv");
  assert.match(f, /^signalclaw-journal-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
  const j = mod.exportFilename("json");
  assert.ok(j.endsWith(".json"));
});

test("filterEntries returns input as-is for empty filter", () => {
  assert.deepEqual(mod.filterEntries(entries, {}), entries);
  assert.deepEqual(mod.filterEntries(entries, { query: "", conviction: null }), entries);
});

test("filterEntries query matches trade_id, thesis, tags, exit_reason; case insensitive", () => {
  assert.deepEqual(mod.filterEntries(entries, { query: "BREAKOUT" }).map((e) => e.trade_id), ["t1"]);
  assert.deepEqual(mod.filterEntries(entries, { query: "pairs" }).map((e) => e.trade_id), ["t2,with comma"]);
  assert.deepEqual(mod.filterEntries(entries, { query: "stopped" }).map((e) => e.trade_id), ["t2,with comma"]);
  assert.deepEqual(mod.filterEntries(entries, { query: "t1" }).map((e) => e.trade_id), ["t1"]);
  assert.deepEqual(mod.filterEntries(entries, { query: "no-such-token" }), []);
});

test("filterEntries conviction filter requires exact match in 1..5", () => {
  assert.deepEqual(mod.filterEntries(entries, { conviction: 4 }).map((e) => e.trade_id), ["t1"]);
  assert.deepEqual(mod.filterEntries(entries, { conviction: 2 }).map((e) => e.trade_id), ["t2,with comma"]);
  assert.deepEqual(mod.filterEntries(entries, { conviction: 99 }), entries);
  assert.deepEqual(mod.filterEntries(entries, { conviction: 0 }), entries);
});

test("filterEntries combines query and conviction with AND semantics", () => {
  assert.deepEqual(
    mod.filterEntries(entries, { query: "breakout", conviction: 4 }).map((e) => e.trade_id),
    ["t1"],
  );
  assert.deepEqual(
    mod.filterEntries(entries, { query: "breakout", conviction: 2 }),
    [],
  );
});

test("filterEntries tag filter is exact-match and case insensitive", () => {
  assert.deepEqual(mod.filterEntries(entries, { tag: "breakout" }).map((e) => e.trade_id), ["t1"]);
  assert.deepEqual(mod.filterEntries(entries, { tag: "BREAKOUT" }).map((e) => e.trade_id), ["t1"]);
  assert.deepEqual(mod.filterEntries(entries, { tag: "pairs" }).map((e) => e.trade_id), ["t2,with comma"]);
  assert.deepEqual(mod.filterEntries(entries, { tag: "break" }), []); // substring should not match
  assert.deepEqual(mod.filterEntries(entries, { tag: "no-such" }), []);
  assert.deepEqual(mod.filterEntries(entries, { tag: "" }), entries);
  assert.deepEqual(mod.filterEntries(entries, { tag: null }), entries);
});

test("filterEntries combines tag with query and conviction (AND)", () => {
  assert.deepEqual(
    mod.filterEntries(entries, { tag: "breakout", conviction: 4 }).map((e) => e.trade_id),
    ["t1"],
  );
  assert.deepEqual(mod.filterEntries(entries, { tag: "breakout", conviction: 2 }), []);
  assert.deepEqual(
    mod.filterEntries(entries, { tag: "breakout", query: "pivot" }).map((e) => e.trade_id),
    ["t1"],
  );
  assert.deepEqual(mod.filterEntries(entries, { tag: "breakout", query: "pairs" }), []);
});

test("collectTags returns sorted, deduped, case-insensitive union", () => {
  const entriesWithDupes = [
    { ...entries[0], tags: ["Breakout", "earnings"] },
    { ...entries[1], tags: ["pairs", "breakout", "Earnings"] },
    { trade_id: "t3", thesis: "", conviction: 3, tags: ["", "  ", "zeta"], exit_reason: null, created_at: "", updated_at: "" },
  ];
  assert.deepEqual(mod.collectTags(entriesWithDupes), ["Breakout", "earnings", "pairs", "zeta"]);
  assert.deepEqual(mod.collectTags([]), []);
});

test("parseJournalUrlState pulls q, conviction, tag from URL search", () => {
  const s = mod.parseJournalUrlState("?q=foo&conviction=4&tag=earnings");
  assert.deepEqual(s, { query: "foo", conviction: "4", tag: "earnings" });
});

test("parseJournalUrlState ignores invalid conviction and missing params", () => {
  assert.deepEqual(mod.parseJournalUrlState(""), { query: "", conviction: "", tag: "" });
  assert.deepEqual(mod.parseJournalUrlState("?conviction=9"), { query: "", conviction: "", tag: "" });
  assert.deepEqual(mod.parseJournalUrlState("?conviction=abc"), { query: "", conviction: "", tag: "" });
  assert.deepEqual(mod.parseJournalUrlState("?conviction=0"), { query: "", conviction: "", tag: "" });
});

test("parseJournalUrlState accepts URLSearchParams and clamps lengths", () => {
  const longQ = "x".repeat(500);
  const longTag = "y".repeat(200);
  const sp = new URLSearchParams();
  sp.set("q", longQ);
  sp.set("tag", longTag);
  const s = mod.parseJournalUrlState(sp);
  assert.equal(s.query.length, 200);
  assert.equal(s.tag.length, 64);
});

test("serializeJournalUrlState skips empty fields and roundtrips", () => {
  assert.equal(mod.serializeJournalUrlState({ query: "", conviction: "", tag: "" }), "");
  assert.equal(
    mod.serializeJournalUrlState({ query: "foo", conviction: "3", tag: "ai" }),
    "q=foo&conviction=3&tag=ai",
  );
  const state = { query: "foo bar", conviction: "5", tag: "earnings" };
  const round = mod.parseJournalUrlState(mod.serializeJournalUrlState(state));
  assert.deepEqual(round, state);
});
