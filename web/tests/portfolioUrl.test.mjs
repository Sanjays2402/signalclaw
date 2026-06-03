// Plain Node test for portfolio URL helpers.
// Run with: node --experimental-strip-types --test tests/portfolioUrl.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "portfolioUrl.ts"));

test("parsePortfolioUrlState returns defaults for empty query", () => {
  const s = mod.parsePortfolioUrlState("");
  assert.equal(s.sortKey, "mv");
  assert.equal(s.sortDir, -1);
});

test("parsePortfolioUrlState reads sort key and direction", () => {
  const s = mod.parsePortfolioUrlState("sort=pnl&dir=asc");
  assert.equal(s.sortKey, "pnl");
  assert.equal(s.sortDir, 1);
});

test("parsePortfolioUrlState accepts numeric direction aliases", () => {
  assert.equal(mod.parsePortfolioUrlState("dir=1").sortDir, 1);
  assert.equal(mod.parsePortfolioUrlState("dir=-1").sortDir, -1);
});

test("parsePortfolioUrlState falls back to defaults on unknown sort key", () => {
  const s = mod.parsePortfolioUrlState("sort=bogus&dir=desc");
  assert.equal(s.sortKey, "mv");
  assert.equal(s.sortDir, -1);
});

test("parsePortfolioUrlState falls back to default direction on garbage", () => {
  const s = mod.parsePortfolioUrlState("sort=ticker&dir=sideways");
  assert.equal(s.sortKey, "ticker");
  assert.equal(s.sortDir, -1);
});

test("parsePortfolioUrlState accepts every documented sort key", () => {
  for (const k of mod.PORTFOLIO_SORT_KEYS) {
    const s = mod.parsePortfolioUrlState(`sort=${k}`);
    assert.equal(s.sortKey, k);
  }
});

test("serializePortfolioUrlState omits defaults entirely", () => {
  const qs = mod.serializePortfolioUrlState({ sortKey: "mv", sortDir: -1 });
  assert.equal(qs, "");
});

test("serializePortfolioUrlState includes only the customized knob", () => {
  assert.equal(
    mod.serializePortfolioUrlState({ sortKey: "pnl", sortDir: -1 }),
    "sort=pnl",
  );
  assert.equal(
    mod.serializePortfolioUrlState({ sortKey: "mv", sortDir: 1 }),
    "dir=asc",
  );
});

test("serializePortfolioUrlState writes asc and desc strings", () => {
  assert.equal(
    mod.serializePortfolioUrlState({ sortKey: "ticker", sortDir: 1 }),
    "sort=ticker&dir=asc",
  );
  assert.equal(
    mod.serializePortfolioUrlState({ sortKey: "ticker", sortDir: -1 }),
    "sort=ticker",
  );
});

test("round trip through URLSearchParams is stable for every non-default combo", () => {
  const combos = [
    { sortKey: "pnl", sortDir: -1, query: "" },
    { sortKey: "pnl", sortDir: 1, query: "" },
    { sortKey: "ticker", sortDir: 1, query: "" },
    { sortKey: "weight", sortDir: -1, query: "" },
    { sortKey: "realized", sortDir: 1, query: "" },
    { sortKey: "mv", sortDir: -1, query: "AAPL" },
    { sortKey: "pnl", sortDir: 1, query: "nvd" },
  ];
  for (const c of combos) {
    const qs = mod.serializePortfolioUrlState(c);
    const parsed = mod.parsePortfolioUrlState(qs);
    assert.deepEqual(parsed, c);
  }
});

test("parsePortfolioUrlState reads ticker query and trims whitespace", () => {
  const s = mod.parsePortfolioUrlState("q=%20AAPL%20");
  assert.equal(s.query, "AAPL");
});

test("parsePortfolioUrlState caps overlong query at 64 chars", () => {
  const long = "A".repeat(200);
  const s = mod.parsePortfolioUrlState(`q=${long}`);
  assert.equal(s.query.length, 64);
});

test("serializePortfolioUrlState omits empty query", () => {
  assert.equal(
    mod.serializePortfolioUrlState({ sortKey: "mv", sortDir: -1, query: "" }),
    "",
  );
  assert.equal(
    mod.serializePortfolioUrlState({ sortKey: "mv", sortDir: -1, query: "   " }),
    "",
  );
});

test("serializePortfolioUrlState includes q when set", () => {
  assert.equal(
    mod.serializePortfolioUrlState({ sortKey: "mv", sortDir: -1, query: "aapl" }),
    "q=aapl",
  );
});

test("parsePortfolioUrlState accepts URLSearchParams directly", () => {
  const sp = new URLSearchParams();
  sp.set("sort", "weight");
  sp.set("dir", "asc");
  const s = mod.parsePortfolioUrlState(sp);
  assert.equal(s.sortKey, "weight");
  assert.equal(s.sortDir, 1);
});
