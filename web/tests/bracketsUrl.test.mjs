// Plain Node test for /brackets URL state helpers.
// Run with: node --experimental-strip-types --test tests/bracketsUrl.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "bracketsUrl.ts"));

test("parse: empty search returns defaults", () => {
  const s = mod.parseBracketsUrlState("");
  assert.equal(s.query, "");
  assert.equal(s.status, "all");
});

test("parse: q is trimmed and capped at 64 chars", () => {
  const long = "a".repeat(200);
  const s = mod.parseBracketsUrlState(`q=%20%20${long}%20%20`);
  assert.equal(s.query.length, 64);
});

test("parse: unknown status falls back to all", () => {
  const s = mod.parseBracketsUrlState("status=garbage");
  assert.equal(s.status, "all");
});

test("parse: accepts every known status filter", () => {
  for (const v of ["open", "filled", "live", "closed", "closed_win", "closed_loss", "cancelled", "all"]) {
    const s = mod.parseBracketsUrlState(`status=${v}`);
    assert.equal(s.status, v);
  }
});

test("serialize: default state produces empty string", () => {
  const qs = mod.serializeBracketsUrlState({ query: "", status: "all" });
  assert.equal(qs, "");
});

test("serialize: only set keys appear in the output", () => {
  const qs = mod.serializeBracketsUrlState({ query: "AAPL", status: "live" });
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get("q"), "AAPL");
  assert.equal(sp.get("status"), "live");
});

test("serialize: whitespace-only query is dropped", () => {
  const qs = mod.serializeBracketsUrlState({ query: "   ", status: "all" });
  assert.equal(qs, "");
});

test("round-trip: serialize then parse yields the same state", () => {
  const cases = [
    { query: "", status: "all" },
    { query: "MSFT", status: "open" },
    { query: "aap", status: "live" },
    { query: "nvda", status: "closed_win" },
  ];
  for (const c of cases) {
    const qs = mod.serializeBracketsUrlState(c);
    const out = mod.parseBracketsUrlState(qs);
    assert.equal(out.query, c.query);
    assert.equal(out.status, c.status);
  }
});
