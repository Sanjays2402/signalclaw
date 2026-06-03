// Plain Node test for webhook delivery export helpers.
// Run with: node --experimental-strip-types --test tests/webhookDeliveriesExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "webhookDeliveriesExport.ts"));

const deliveries = [
  {
    id: "d1",
    subscription_id: "sub_1",
    url: "https://example.com/hook",
    status: 200,
    error: null,
    attempt: 1,
    delivered_at: "2025-01-02T10:00:00.000Z",
    signature: "sig",
    event_count: 3,
    replay_of: null,
  },
  {
    id: "d2",
    subscription_id: "sub_2",
    url: "https://other.example.com/hook",
    status: null,
    error: "timeout, after 5s",
    attempt: 4,
    delivered_at: "2025-01-01T09:00:00.000Z",
    signature: null,
    event_count: 1,
    replay_of: "d0",
  },
];

test("deliveriesToCSV emits a header and one row per delivery", () => {
  const csv = mod.deliveriesToCSV(deliveries);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(
    lines[0],
    "delivered_at,subscription_id,url,status,attempt,event_count,replay_of,error",
  );
  assert.equal(
    lines[1],
    "2025-01-02T10:00:00.000Z,sub_1,https://example.com/hook,200,1,3,,",
  );
  // null status emits empty cell; comma in error must be quoted; replay_of populated.
  assert.ok(lines[2].startsWith("2025-01-01T09:00:00.000Z,sub_2,"));
  assert.ok(lines[2].includes(",,4,1,d0,"));
  assert.ok(lines[2].endsWith(',"timeout, after 5s"'));
});

test("deliveriesToCSV handles an empty list with header only", () => {
  const csv = mod.deliveriesToCSV([]);
  assert.equal(
    csv,
    "delivered_at,subscription_id,url,status,attempt,event_count,replay_of,error\n",
  );
});

test("deliveriesToCSV neutralises spreadsheet formula cells", () => {
  const evil = [
    {
      id: "x",
      subscription_id: "sub",
      url: "=HYPERLINK(\"http://evil\",\"click\")",
      status: 500,
      error: "+CMD|'/c calc'!A1",
      attempt: 1,
      delivered_at: "2025-01-01T00:00:00.000Z",
      signature: null,
      event_count: 0,
      replay_of: "@danger",
    },
  ];
  const row = mod.deliveriesToCSV(evil).trimEnd().split("\n")[1];
  // Leading = + @ must be prefixed with ' so spreadsheets treat them as text.
  // The url cell also contains a comma so it ends up quoted.
  assert.ok(row.includes(",\"'=HYPERLINK("));
  assert.ok(row.includes(",'@danger,"));
  assert.ok(row.endsWith(",'+CMD|'/c calc'!A1"));
});

test("deliveriesToJSON wraps deliveries with count and exported_at", () => {
  const json = JSON.parse(mod.deliveriesToJSON(deliveries));
  assert.equal(json.count, 2);
  assert.equal(json.deliveries.length, 2);
  assert.equal(json.deliveries[0].subscription_id, "sub_1");
  assert.equal(json.deliveries[1].status, null);
  assert.ok(typeof json.exported_at === "string");
});
