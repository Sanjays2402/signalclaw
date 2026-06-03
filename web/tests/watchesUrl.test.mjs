// Plain Node test for /watches URL state helpers.
// Run with: node --experimental-strip-types --test tests/watchesUrl.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "watchesUrl.ts"));

test("parse: empty search returns defaults", () => {
  const s = mod.parseWatchesUrlState("");
  assert.equal(s.query, "");
  assert.equal(s.state, "all");
});

test("parse: q is trimmed and capped at 64 chars", () => {
  const long = "a".repeat(200);
  const s = mod.parseWatchesUrlState(`q=%20%20${long}%20%20`);
  assert.equal(s.query.length, 64);
});

test("parse: unknown state falls back to all", () => {
  const s = mod.parseWatchesUrlState("state=garbage");
  assert.equal(s.state, "all");
});

test("parse: accepts every known state filter", () => {
  for (const v of ["all", "active", "paused"]) {
    const s = mod.parseWatchesUrlState(`state=${v}`);
    assert.equal(s.state, v);
  }
});

test("parse: accepts URLSearchParams input", () => {
  const sp = new URLSearchParams("q=spy&state=active");
  const s = mod.parseWatchesUrlState(sp);
  assert.equal(s.query, "spy");
  assert.equal(s.state, "active");
});

test("serialize: default state produces empty string", () => {
  const qs = mod.serializeWatchesUrlState({ query: "", state: "all" });
  assert.equal(qs, "");
});

test("serialize: only set keys appear in the output", () => {
  const qs = mod.serializeWatchesUrlState({ query: "SPY", state: "paused" });
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get("q"), "SPY");
  assert.equal(sp.get("state"), "paused");
});

test("serialize: whitespace-only query is dropped", () => {
  const qs = mod.serializeWatchesUrlState({ query: "   ", state: "all" });
  assert.equal(qs, "");
});

test("round-trip: serialize then parse yields the same state", () => {
  const cases = [
    { query: "", state: "all" },
    { query: "SPY", state: "active" },
    { query: "aapl", state: "paused" },
    { query: "nvda", state: "all" },
  ];
  for (const c of cases) {
    const qs = mod.serializeWatchesUrlState(c);
    const out = mod.parseWatchesUrlState(qs);
    assert.equal(out.query, c.query);
    assert.equal(out.state, c.state);
  }
});
