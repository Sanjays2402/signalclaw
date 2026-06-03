// Plain Node test for activity export helpers.
// Run with: node --experimental-strip-types --test tests/activityExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "activityExport.ts"));

const sample = [
  {
    id: "a2",
    kind: "webhook.delivered",
    title: "Webhook delivered",
    body: "POST https://example.com/hook -> 200",
    href: "/webhooks",
    created_at: "2026-06-02T10:00:00Z",
    read: true,
  },
  {
    id: "a1",
    kind: "run.saved",
    title: "Run saved",
    body: "AAPL backtest, 1y",
    href: null,
    created_at: "2026-06-01T09:00:00Z",
    read: false,
  },
  {
    id: "a3",
    kind: "alert.fired",
    title: 'Alert: AAPL > $200, watch',
    body: 'multi\nline\nbody with "quotes"',
    href: "/alerts",
    created_at: "2026-06-02T10:00:00Z",
    read: false,
  },
];

test("CSV header is stable", () => {
  const csv = mod.activityEventsToCSV([]);
  assert.equal(csv.split("\n")[0], "created_at,kind,title,body,href,read,id");
});

test("CSV sorts by created_at desc then id asc", () => {
  const csv = mod.activityEventsToCSV(sample);
  // a3's body has embedded newlines (quoted), so split on raw \n would
  // break rows. Just check substring ordering positions.
  const i2 = csv.indexOf(",webhook.delivered,");
  const i3 = csv.indexOf(",alert.fired,");
  const i1 = csv.indexOf(",run.saved,");
  assert.ok(i2 > 0 && i3 > i2 && i1 > i3, `got positions ${i2}, ${i3}, ${i1}`);
});

test("CSV quotes commas, quotes, and newlines", () => {
  const csv = mod.activityEventsToCSV(sample);
  // alert.fired title contains a comma -> must be quoted
  assert.ok(csv.includes('"Alert: AAPL > $200, watch"'));
  // body has embedded quotes -> doubled
  assert.ok(csv.includes('"multi\nline\nbody with ""quotes"""'));
});

test("CSV neutralises formula injection in user-supplied cells", () => {
  const malicious = [
    {
      id: "x1",
      kind: "system",
      title: "=HYPERLINK(\"http://evil\",\"click\")",
      body: "+cmd|' /C calc'!A1",
      href: "-2+3",
      created_at: "2026-06-02T00:00:00Z",
      read: false,
    },
  ];
  const csv = mod.activityEventsToCSV(malicious);
  // Each leading dangerous char must be prefixed with a single quote.
  // Title also has a comma so it's wrapped in quotes; the formula guard sits
  // right after the opening quote.
  assert.ok(csv.includes("\"'=HYPERLINK("));
  // body has no quote-trigger characters, so it appears bare with the guard.
  assert.ok(csv.includes(",'+cmd|"));
  // href has no quote-trigger characters so it appears bare with the guard.
  assert.ok(/,'-2\+3,/.test(csv));
});

test("CSV preserves read flag as boolean text", () => {
  const csv = mod.activityEventsToCSV(sample);
  // a3's body contains literal newlines (quoted), so we can't naively
  // split on newline; check for each tail substring instead.
  assert.ok(csv.includes(",true,a2\n"));
  assert.ok(csv.includes(",false,a3\n"));
  assert.ok(csv.includes(",false,a1\n"));
});

test("JSON output is sorted and stable", () => {
  const json = JSON.parse(mod.activityEventsToJSON(sample));
  assert.equal(json.events.length, 3);
  assert.equal(json.events[0].id, "a2");
  assert.equal(json.events[1].id, "a3");
  assert.equal(json.events[2].id, "a1");
});

test("filename includes kind and unread marker", () => {
  assert.equal(mod.activityFilename("", false, "csv"), "activity.csv");
  assert.equal(mod.activityFilename("alert.fired", false, "json"), "activity-alert-fired.json");
  assert.equal(mod.activityFilename("", true, "csv"), "activity-unread.csv");
  assert.equal(mod.activityFilename("run.saved", true, "csv"), "activity-run-saved-unread.csv");
});

test("empty input still produces header row", () => {
  const csv = mod.activityEventsToCSV([]);
  assert.equal(csv, "created_at,kind,title,body,href,read,id\n");
});
