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
  assert.deepEqual(s, { query: "foo", conviction: "4", tag: "earnings", since: "", until: "", sort: "updated_desc" });
});

test("parseJournalUrlState ignores invalid conviction and missing params", () => {
  assert.deepEqual(mod.parseJournalUrlState(""), { query: "", conviction: "", tag: "", since: "", until: "", sort: "updated_desc" });
  assert.deepEqual(mod.parseJournalUrlState("?conviction=9"), { query: "", conviction: "", tag: "", since: "", until: "", sort: "updated_desc" });
  assert.deepEqual(mod.parseJournalUrlState("?conviction=abc"), { query: "", conviction: "", tag: "", since: "", until: "", sort: "updated_desc" });
  assert.deepEqual(mod.parseJournalUrlState("?conviction=0"), { query: "", conviction: "", tag: "", since: "", until: "", sort: "updated_desc" });
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
  assert.equal(mod.serializeJournalUrlState({ query: "", conviction: "", tag: "", since: "", until: "", sort: "updated_desc" }), "");
  assert.equal(
    mod.serializeJournalUrlState({ query: "foo", conviction: "3", tag: "ai", since: "", until: "", sort: "updated_desc" }),
    "q=foo&conviction=3&tag=ai",
  );
  const state = { query: "foo bar", conviction: "5", tag: "earnings", since: "", until: "", sort: "updated_desc" };
  const round = mod.parseJournalUrlState(mod.serializeJournalUrlState(state));
  assert.deepEqual(round, state);
});

test("entriesToMarkdown renders header + GFM table row per entry, escaping pipes and newlines", () => {
  const md = mod.entriesToMarkdown(entries);
  assert.match(md, /^# SignalClaw journal\n/);
  assert.match(md, /Exported \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \u00b7 2 entries/);
  assert.match(md, /\| Trade ID \| Updated \| Conviction \| Exit reason \| Tags \| Thesis \|/);
  assert.match(md, /\| --- \| --- \| --- \| --- \| --- \| --- \|/);
  assert.match(md, /\| t1 \| 2025-01-02 \| 4\/5 \|  \| breakout, earnings \| breakout above prior pivot \|/);
  // Newlines collapse to space; quoted text and commas are fine in MD; no raw \n inside row
  assert.match(md, /why, "this trade" newline test/);
  // Pipes in cell text are escaped
  const piped = mod.entriesToMarkdown([
    { trade_id: "p1", thesis: "a|b", conviction: 3, tags: ["x|y"], exit_reason: null, created_at: "", updated_at: "2025-01-04T00:00:00Z" },
  ]);
  assert.match(piped, /a\\\|b/);
  assert.match(piped, /x\\\|y/);
});

test("entriesToMarkdown handles empty list with a placeholder", () => {
  const md = mod.entriesToMarkdown([]);
  assert.match(md, /^# SignalClaw journal\n/);
  assert.match(md, /\u00b7 0 entries/);
  assert.match(md, /_No journal entries yet\._/);
  assert.ok(!md.includes("| Trade ID |"));
});

test("filterEntries date range filters on updated_at YYYY-MM-DD", () => {
  assert.deepEqual(
    mod.filterEntries(entries, { since: "2025-01-03" }).map((e) => e.trade_id),
    ["t2,with comma"],
  );
  assert.deepEqual(
    mod.filterEntries(entries, { until: "2025-01-02" }).map((e) => e.trade_id),
    ["t1"],
  );
  assert.deepEqual(
    mod.filterEntries(entries, { since: "2025-01-02", until: "2025-01-03" }).map((e) => e.trade_id),
    ["t1", "t2,with comma"],
  );
  // Single-day window (both bounds equal) is inclusive.
  assert.deepEqual(
    mod.filterEntries(entries, { since: "2025-01-02", until: "2025-01-02" }).map((e) => e.trade_id),
    ["t1"],
  );
  // Out of range returns empty.
  assert.deepEqual(mod.filterEntries(entries, { since: "2025-02-01" }), []);
  // Invalid dates are ignored (treated as unset).
  assert.deepEqual(mod.filterEntries(entries, { since: "not-a-date" }), entries);
  assert.deepEqual(mod.filterEntries(entries, { until: "2025/01/02" }), entries);
  // Entries with no updated_at are dropped only when a date filter is active.
  const noDate = [{ trade_id: "t3", thesis: "", conviction: 3, tags: [], exit_reason: null, created_at: "", updated_at: "" }];
  assert.deepEqual(mod.filterEntries(noDate, {}), noDate);
  assert.deepEqual(mod.filterEntries(noDate, { since: "2025-01-01" }), []);
});

test("parseJournalUrlState pulls since/until and validates YYYY-MM-DD", () => {
  assert.deepEqual(
    mod.parseJournalUrlState("?since=2025-01-02&until=2025-01-03"),
    { query: "", conviction: "", tag: "", since: "2025-01-02", until: "2025-01-03", sort: "updated_desc" },
  );
  assert.deepEqual(
    mod.parseJournalUrlState("?since=bad&until=2025/01/02"),
    { query: "", conviction: "", tag: "", since: "", until: "", sort: "updated_desc" },
  );
});

test("serializeJournalUrlState round-trips since/until", () => {
  const state = { query: "", conviction: "", tag: "", since: "2025-01-02", until: "2025-01-03", sort: "updated_desc" };
  assert.equal(
    mod.serializeJournalUrlState(state),
    "since=2025-01-02&until=2025-01-03",
  );
  assert.deepEqual(mod.parseJournalUrlState(mod.serializeJournalUrlState(state)), state);
});

test("exportFilename supports md extension", () => {
  const f = mod.exportFilename("md");
  assert.match(f, /^signalclaw-journal-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/);
});

const sortEntries = [
  { trade_id: "b", thesis: "", conviction: 3, tags: [], exit_reason: null, created_at: "", updated_at: "2025-01-02T10:00:00Z" },
  { trade_id: "a", thesis: "", conviction: 5, tags: [], exit_reason: null, created_at: "", updated_at: "2025-01-01T10:00:00Z" },
  { trade_id: "c", thesis: "", conviction: 1, tags: [], exit_reason: null, created_at: "", updated_at: "2025-01-03T10:00:00Z" },
];

test("sortEntries default sorts by updated_at descending, stable on tie via trade_id", () => {
  assert.deepEqual(mod.sortEntries(sortEntries).map((e) => e.trade_id), ["c", "b", "a"]);
  // Same updated_at falls back to trade_id ascending.
  const tied = [
    { ...sortEntries[0], trade_id: "z", updated_at: "2025-01-05T00:00:00Z" },
    { ...sortEntries[0], trade_id: "m", updated_at: "2025-01-05T00:00:00Z" },
  ];
  assert.deepEqual(mod.sortEntries(tied).map((e) => e.trade_id), ["m", "z"]);
});

test("sortEntries supports updated_asc, conviction_desc/asc, trade_id_asc", () => {
  assert.deepEqual(mod.sortEntries(sortEntries, "updated_asc").map((e) => e.trade_id), ["a", "b", "c"]);
  assert.deepEqual(mod.sortEntries(sortEntries, "conviction_desc").map((e) => e.trade_id), ["a", "b", "c"]);
  assert.deepEqual(mod.sortEntries(sortEntries, "conviction_asc").map((e) => e.trade_id), ["c", "b", "a"]);
  assert.deepEqual(mod.sortEntries(sortEntries, "trade_id_asc").map((e) => e.trade_id), ["a", "b", "c"]);
});

test("sortEntries does not mutate the input array", () => {
  const before = sortEntries.map((e) => e.trade_id);
  mod.sortEntries(sortEntries, "trade_id_asc");
  assert.deepEqual(sortEntries.map((e) => e.trade_id), before);
});

test("parseJournalUrlState reads sort and falls back to updated_desc on unknown", () => {
  assert.equal(mod.parseJournalUrlState("?sort=conviction_desc").sort, "conviction_desc");
  assert.equal(mod.parseJournalUrlState("?sort=trade_id_asc").sort, "trade_id_asc");
  assert.equal(mod.parseJournalUrlState("?sort=bogus").sort, "updated_desc");
  assert.equal(mod.parseJournalUrlState("").sort, "updated_desc");
});

test("serializeJournalUrlState omits sort when it is the default", () => {
  assert.equal(
    mod.serializeJournalUrlState({ query: "", conviction: "", tag: "", since: "", until: "", sort: "updated_desc" }),
    "",
  );
  assert.equal(
    mod.serializeJournalUrlState({ query: "", conviction: "", tag: "", since: "", until: "", sort: "conviction_desc" }),
    "sort=conviction_desc",
  );
});
