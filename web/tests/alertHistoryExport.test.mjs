// Plain Node test for alert history export helpers.
// Run with: node --experimental-strip-types --test tests/alertHistoryExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "alertStore.ts"));

const events = [
  {
    alert_id: "a1",
    ticker: "AAPL",
    condition: "price_above",
    value: 200,
    observed: 201.5,
    fired_at: "2025-01-02T10:00:00.000Z",
    note: "breakout",
  },
  {
    alert_id: "a2",
    ticker: "MSFT",
    condition: "pct_change_below",
    value: -0.05,
    observed: -0.061,
    fired_at: "2025-01-01T09:00:00.000Z",
    note: 'with "quotes", and a comma',
  },
];

test("eventsToCSV emits a header and one row per event", () => {
  const csv = store.eventsToCSV(events);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "fired_at,ticker,condition,value,observed,alert_id,note");
  assert.equal(
    lines[1],
    "2025-01-02T10:00:00.000Z,AAPL,price_above,200,201.5,a1,breakout",
  );
  // Note with comma + quotes must be quoted and have doubled quotes.
  assert.ok(lines[2].endsWith(',"with ""quotes"", and a comma"'));
});

test("eventsToCSV handles an empty list with header only", () => {
  const csv = store.eventsToCSV([]);
  assert.equal(csv, "fired_at,ticker,condition,value,observed,alert_id,note\n");
});

test("eventsToJSON wraps events with count and exported_at", () => {
  const json = JSON.parse(store.eventsToJSON(events));
  assert.equal(json.count, 2);
  assert.equal(json.events.length, 2);
  assert.equal(json.events[0].ticker, "AAPL");
  assert.ok(typeof json.exported_at === "string");
});

test("eventsToMarkdown emits a GitHub-flavored table with one row per event", () => {
  const md = store.eventsToMarkdown(events);
  const lines = md.trimEnd().split("\n");
  assert.equal(lines[0], "# SignalClaw alert fire history");
  assert.ok(lines[2].includes("2 fires"));
  // header + separator + 2 data rows
  const tableRows = lines.filter((l) => l.startsWith("|"));
  assert.equal(tableRows.length, 4);
  assert.ok(tableRows[0].includes("Fired at"));
  assert.ok(tableRows[0].includes("Ticker"));
  assert.ok(tableRows[2].includes("AAPL"));
  assert.ok(tableRows[3].includes("MSFT"));
});

test("eventsToMarkdown handles an empty list with a placeholder line", () => {
  const md = store.eventsToMarkdown([]);
  assert.ok(md.includes("# SignalClaw alert fire history"));
  assert.ok(md.includes("0 fires"));
  assert.ok(md.includes("_No fires yet._"));
});

test("eventsToMarkdown escapes pipes and newlines in note and ticker fields", () => {
  const tricky = [
    {
      alert_id: "a3",
      ticker: "X|Y",
      condition: "price_above",
      value: 1,
      observed: 2,
      fired_at: "2025-01-03T00:00:00.000Z",
      note: "line one\nline two | pipe",
    },
  ];
  const md = store.eventsToMarkdown(tricky);
  // The note row must not break the table by containing a raw newline or pipe.
  const row = md.split("\n").find((l) => l.includes("a3"));
  assert.ok(row);
  assert.ok(!row.includes("\n"));
  assert.ok(row.includes("X\\|Y"));
  assert.ok(row.includes("line one line two \\| pipe"));
});
