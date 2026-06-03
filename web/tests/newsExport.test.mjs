// Plain Node test for news export helpers.
// Run with: node --experimental-strip-types --test tests/newsExport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "newsExport.ts"));

const sample = [
  {
    id: "e2",
    ticker: "MSFT",
    headline: "Raises guidance",
    event_date: "2026-03-15",
    tags: ["guidance", "8k"],
    source: "8-K",
    url: "https://example.com/msft",
  },
  {
    id: "e1",
    ticker: "AAPL",
    headline: "CFO transition, effective April 1",
    event_date: "2026-02-01",
    tags: ["personnel"],
    source: "PR",
    url: "",
  },
  {
    id: "e3",
    ticker: "NVDA",
    headline: 'Quoted: "record quarter"',
    event_date: "2026-03-15",
    tags: [],
    source: "",
    url: "https://example.com/nvda,page",
  },
];

test("CSV header is stable", () => {
  const csv = mod.newsEventsToCSV([]);
  assert.equal(csv.split("\n")[0], "event_date,ticker,headline,tags,source,url,id");
});

test("CSV sorts by date desc then ticker asc", () => {
  const csv = mod.newsEventsToCSV(sample);
  const lines = csv.trim().split("\n").slice(1);
  // 2026-03-15 MSFT, 2026-03-15 NVDA, 2026-02-01 AAPL
  assert.match(lines[0], /^2026-03-15,MSFT,/);
  assert.match(lines[1], /^2026-03-15,NVDA,/);
  assert.match(lines[2], /^2026-02-01,AAPL,/);
});

test("CSV joins tags with pipe in a single cell", () => {
  const csv = mod.newsEventsToCSV(sample);
  assert.ok(csv.includes(",guidance|8k,"));
  assert.ok(csv.includes(",personnel,"));
});

test("CSV quotes cells with comma, quote, or newline", () => {
  const csv = mod.newsEventsToCSV(sample);
  // headline has comma -> quoted
  assert.ok(csv.includes('"CFO transition, effective April 1"'));
  // headline has embedded quote -> doubled and wrapped
  assert.ok(csv.includes('"Quoted: ""record quarter"""'));
  // url has comma -> quoted
  assert.ok(csv.includes('"https://example.com/nvda,page"'));
});

test("CSV uppercases ticker", () => {
  const csv = mod.newsEventsToCSV([
    { id: "x", ticker: "tsla", headline: "h", event_date: "2026-01-01", tags: [], source: "", url: "" },
  ]);
  assert.match(csv, /,TSLA,/);
});

test("CSV ends with a trailing newline", () => {
  const csv = mod.newsEventsToCSV(sample);
  assert.ok(csv.endsWith("\n"));
});

test("CSV with no rows is just the header line", () => {
  const csv = mod.newsEventsToCSV([]);
  assert.equal(csv, "event_date,ticker,headline,tags,source,url,id\n");
});

test("JSON mirrors the API shape and is sorted", () => {
  const json = mod.newsEventsToJSON(sample);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.events.map((e) => e.id), ["e2", "e3", "e1"]);
  assert.equal(parsed.events[0].ticker, "MSFT");
  assert.equal(parsed.events[1].tags.length, 0);
});

test("filename includes ticker and tag filters when present", () => {
  assert.equal(mod.newsFilename("", "", "csv"), "news.csv");
  assert.equal(mod.newsFilename("aapl", "", "csv"), "news-AAPL.csv");
  assert.equal(mod.newsFilename("", "Guidance", "json"), "news-guidance.json");
  assert.equal(mod.newsFilename("AAPL", "8-K", "csv"), "news-AAPL-8-k.csv");
});

test("filename sanitizes weird tag characters", () => {
  assert.equal(mod.newsFilename("", "FOO/BAR Baz", "csv"), "news-foo-bar-baz.csv");
});

test("sort is stable when date and ticker match", () => {
  const rows = [
    { id: "b", ticker: "AAA", headline: "h", event_date: "2026-01-01", tags: [], source: "", url: "" },
    { id: "a", ticker: "AAA", headline: "h", event_date: "2026-01-01", tags: [], source: "", url: "" },
  ];
  const csv = mod.newsEventsToCSV(rows);
  const lines = csv.trim().split("\n").slice(1);
  // tiebreak by id ascending: a then b
  assert.match(lines[0], /,a$/);
  assert.match(lines[1], /,b$/);
});
