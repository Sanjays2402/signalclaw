import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWatchlistUrlState,
  serializeWatchlistUrlState,
  SORT_KEY_DEFAULT,
  SORT_DIR_DEFAULT,
} from "../lib/watchlistSort.ts";

test("parse: empty query string yields defaults", () => {
  const s = parseWatchlistUrlState("");
  assert.equal(s.filter, "");
  assert.equal(s.sortKey, SORT_KEY_DEFAULT);
  assert.equal(s.sortDir, SORT_DIR_DEFAULT);
});

test("parse: reads q, sort, dir", () => {
  const s = parseWatchlistUrlState("q=AAPL&sort=ticker&dir=asc");
  assert.equal(s.filter, "AAPL");
  assert.equal(s.sortKey, "ticker");
  assert.equal(s.sortDir, "asc");
});

test("parse: unknown sort key falls back to default", () => {
  const s = parseWatchlistUrlState("sort=bogus");
  assert.equal(s.sortKey, SORT_KEY_DEFAULT);
});

test("parse: unknown direction falls back to default", () => {
  const s = parseWatchlistUrlState("dir=sideways");
  assert.equal(s.sortDir, SORT_DIR_DEFAULT);
});

test("parse: long filter is truncated to 200 chars", () => {
  const big = "x".repeat(500);
  const s = parseWatchlistUrlState(`q=${big}`);
  assert.equal(s.filter.length, 200);
});

test("parse: accepts URLSearchParams instance", () => {
  const sp = new URLSearchParams({ q: "TSLA", sort: "distance", dir: "asc" });
  const s = parseWatchlistUrlState(sp);
  assert.equal(s.filter, "TSLA");
  assert.equal(s.sortKey, "distance");
  assert.equal(s.sortDir, "asc");
});

test("serialize: defaults produce an empty string", () => {
  const qs = serializeWatchlistUrlState({
    filter: "",
    sortKey: SORT_KEY_DEFAULT,
    sortDir: SORT_DIR_DEFAULT,
  });
  assert.equal(qs, "");
});

test("serialize: non-default values appear in the query string", () => {
  const qs = serializeWatchlistUrlState({
    filter: "AAPL",
    sortKey: "ticker",
    sortDir: "asc",
  });
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get("q"), "AAPL");
  assert.equal(sp.get("sort"), "ticker");
  assert.equal(sp.get("dir"), "asc");
});

test("serialize: default sort is omitted even when dir is set", () => {
  const qs = serializeWatchlistUrlState({
    filter: "",
    sortKey: SORT_KEY_DEFAULT,
    sortDir: "asc",
  });
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get("sort"), null);
  assert.equal(sp.get("dir"), "asc");
});

test("round-trip: parse then serialize is stable", () => {
  const initial = { filter: "tsla", sortKey: "distance", sortDir: "asc" };
  const qs = serializeWatchlistUrlState(initial);
  const back = parseWatchlistUrlState(qs);
  assert.deepEqual(back, initial);
});
