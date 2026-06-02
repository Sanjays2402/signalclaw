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
