// Plain Node test for /tax URL state helpers.
// Run with: node --experimental-strip-types --test tests/taxUrl.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "taxUrl.ts"));

test("parse: empty search returns defaults", () => {
  const s = mod.parseTaxUrlState("");
  assert.equal(s.query, "");
});

test("parse: q is trimmed and capped at 64 chars", () => {
  const long = "a".repeat(200);
  const s = mod.parseTaxUrlState(`q=%20%20${long}%20%20`);
  assert.equal(s.query.length, 64);
});

test("parse: accepts URLSearchParams", () => {
  const sp = new URLSearchParams("q=AAPL");
  const s = mod.parseTaxUrlState(sp);
  assert.equal(s.query, "AAPL");
});

test("serialize: default state produces empty string", () => {
  const qs = mod.serializeTaxUrlState({ query: "" });
  assert.equal(qs, "");
});

test("serialize: whitespace-only query is dropped", () => {
  const qs = mod.serializeTaxUrlState({ query: "   " });
  assert.equal(qs, "");
});

test("serialize: only set keys appear in the output", () => {
  const qs = mod.serializeTaxUrlState({ query: "MSFT" });
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get("q"), "MSFT");
});

test("serialize: caps stored query at 64 chars", () => {
  const long = "z".repeat(200);
  const qs = mod.serializeTaxUrlState({ query: long });
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get("q")?.length, 64);
});

test("round-trip: serialize then parse yields the same state", () => {
  const cases = [
    { query: "" },
    { query: "AAPL" },
    { query: "nvda" },
    { query: "tsla" },
  ];
  for (const c of cases) {
    const qs = mod.serializeTaxUrlState(c);
    const out = mod.parseTaxUrlState(qs);
    assert.deepEqual(out, c);
  }
});

test("tickerMatchesTaxQuery: empty query matches all", () => {
  assert.equal(mod.tickerMatchesTaxQuery("AAPL", ""), true);
  assert.equal(mod.tickerMatchesTaxQuery("AAPL", "   "), true);
});

test("tickerMatchesTaxQuery: case-insensitive substring", () => {
  assert.equal(mod.tickerMatchesTaxQuery("AAPL", "aap"), true);
  assert.equal(mod.tickerMatchesTaxQuery("aapl", "AAP"), true);
  assert.equal(mod.tickerMatchesTaxQuery("MSFT", "aap"), false);
});

test("tickerMatchesTaxQuery: trims query", () => {
  assert.equal(mod.tickerMatchesTaxQuery("AAPL", "  aap  "), true);
});
