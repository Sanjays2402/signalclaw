// Plain Node test for /earnings URL state helpers.
// Run with: node --experimental-strip-types --test tests/earningsUrl.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "earningsUrl.ts"));

test("parse: empty search returns defaults", () => {
  const s = mod.parseEarningsUrlState("");
  assert.equal(s.query, "");
  assert.equal(s.within, null);
});

test("parse: q is trimmed and capped at 64 chars", () => {
  const long = "a".repeat(200);
  const s = mod.parseEarningsUrlState(`q=%20%20${long}%20%20`);
  assert.equal(s.query.length, 64);
});

test("parse: accepts URLSearchParams", () => {
  const sp = new URLSearchParams("q=AAPL&within=14");
  const s = mod.parseEarningsUrlState(sp);
  assert.equal(s.query, "AAPL");
  assert.equal(s.within, 14);
});

test("parse: within accepts 7, 14, 30 only", () => {
  for (const n of [7, 14, 30]) {
    assert.equal(mod.parseEarningsUrlState(`within=${n}`).within, n);
  }
});

test("parse: unknown within falls back to null", () => {
  assert.equal(mod.parseEarningsUrlState("within=999").within, null);
  assert.equal(mod.parseEarningsUrlState("within=abc").within, null);
  assert.equal(mod.parseEarningsUrlState("within=").within, null);
});

test("serialize: default state produces empty string", () => {
  const qs = mod.serializeEarningsUrlState({ query: "", within: null });
  assert.equal(qs, "");
});

test("serialize: whitespace-only query is dropped", () => {
  const qs = mod.serializeEarningsUrlState({ query: "   ", within: null });
  assert.equal(qs, "");
});

test("serialize: only set keys appear in the output", () => {
  const qs = mod.serializeEarningsUrlState({ query: "MSFT", within: 7 });
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get("q"), "MSFT");
  assert.equal(sp.get("within"), "7");
});

test("serialize: caps stored query at 64 chars", () => {
  const long = "z".repeat(200);
  const qs = mod.serializeEarningsUrlState({ query: long, within: null });
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get("q")?.length, 64);
});

test("round-trip: serialize then parse yields the same state", () => {
  const cases = [
    { query: "", within: null },
    { query: "AAPL", within: null },
    { query: "nvda", within: 7 },
    { query: "tsla", within: 14 },
    { query: "", within: 30 },
  ];
  for (const c of cases) {
    const qs = mod.serializeEarningsUrlState(c);
    const out = mod.parseEarningsUrlState(qs);
    assert.deepEqual(out, c);
  }
});

test("tickerMatchesEarningsQuery: empty query matches all", () => {
  assert.equal(mod.tickerMatchesEarningsQuery("AAPL", ""), true);
  assert.equal(mod.tickerMatchesEarningsQuery("AAPL", "   "), true);
});

test("tickerMatchesEarningsQuery: case-insensitive substring", () => {
  assert.equal(mod.tickerMatchesEarningsQuery("AAPL", "aap"), true);
  assert.equal(mod.tickerMatchesEarningsQuery("aapl", "AAP"), true);
  assert.equal(mod.tickerMatchesEarningsQuery("MSFT", "aap"), false);
});

test("tickerMatchesEarningsQuery: trims query", () => {
  assert.equal(mod.tickerMatchesEarningsQuery("AAPL", "  aap  "), true);
});

test("EARNINGS_WITHIN_CHOICES is the canonical set", () => {
  assert.deepEqual(mod.EARNINGS_WITHIN_CHOICES, [null, 7, 14, 30]);
});
