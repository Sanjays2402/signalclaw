// Plain Node test for /stops URL state helpers.
// Run with: node --experimental-strip-types --test tests/stopsUrl.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "stopsUrl.ts"));

test("parse: empty search returns defaults", () => {
  const s = mod.parseStopsUrlState("");
  assert.equal(s.query, "");
  assert.equal(s.kind, "all");
});

test("parse: q is trimmed and capped at 64 chars", () => {
  const long = "a".repeat(200);
  const s = mod.parseStopsUrlState(`q=%20%20${long}%20%20`);
  assert.equal(s.query.length, 64);
});

test("parse: unknown kind falls back to all", () => {
  const s = mod.parseStopsUrlState("kind=garbage");
  assert.equal(s.kind, "all");
});

test("parse: accepts every known kind filter", () => {
  for (const v of ["all", "stop_loss", "take_profit", "trailing"]) {
    const s = mod.parseStopsUrlState(`kind=${v}`);
    assert.equal(s.kind, v);
  }
});

test("parse: accepts URLSearchParams input", () => {
  const sp = new URLSearchParams("q=aapl&kind=trailing");
  const s = mod.parseStopsUrlState(sp);
  assert.equal(s.query, "aapl");
  assert.equal(s.kind, "trailing");
});

test("serialize: default state produces empty string", () => {
  const qs = mod.serializeStopsUrlState({ query: "", kind: "all" });
  assert.equal(qs, "");
});

test("serialize: only set keys appear in the output", () => {
  const qs = mod.serializeStopsUrlState({ query: "AAPL", kind: "stop_loss" });
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get("q"), "AAPL");
  assert.equal(sp.get("kind"), "stop_loss");
});

test("serialize: whitespace-only query is dropped", () => {
  const qs = mod.serializeStopsUrlState({ query: "   ", kind: "all" });
  assert.equal(qs, "");
});

test("round-trip: serialize then parse yields the same state", () => {
  const cases = [
    { query: "", kind: "all" },
    { query: "AAPL", kind: "trailing" },
    { query: "msft", kind: "take_profit" },
    { query: "spy", kind: "stop_loss" },
  ];
  for (const c of cases) {
    const qs = mod.serializeStopsUrlState(c);
    const out = mod.parseStopsUrlState(qs);
    assert.equal(out.query, c.query);
    assert.equal(out.kind, c.kind);
  }
});
