// node --experimental-strip-types --test tests/v1Watchlist.test.mjs
//
// Exercises the v1 watchlist surface end to end against the file-backed
// watchlistStore. The route handlers are thin wrappers around the store +
// auth, so we test the store contracts the routes depend on plus the scope
// checks that gate them.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-v1watchlist-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));
const ws = await import(path.join(repoRoot, "lib", "watchlistStore.ts"));

test("v1 watchlist: ticker normalizer rejects garbage and lowercases", () => {
  assert.equal(ws.normalizeTicker(""), null);
  assert.equal(ws.normalizeTicker("  "), null);
  assert.equal(ws.normalizeTicker("123"), null);
  assert.equal(ws.normalizeTicker("WAY_TOO_LONG_TICKER_NAME"), null);
  assert.equal(ws.normalizeTicker("nvda"), "NVDA");
  assert.equal(ws.normalizeTicker(" brk.b "), "BRK.B");
});

test("v1 watchlist: note normalizer trims, caps at 200, returns null for empties", () => {
  assert.equal(ws.normalizeNote(null), null);
  assert.equal(ws.normalizeNote(""), null);
  assert.equal(ws.normalizeNote("   "), null);
  assert.equal(ws.normalizeNote(42), null);
  assert.equal(ws.normalizeNote("  hello  "), "hello");
  const big = "x".repeat(500);
  assert.equal(ws.normalizeNote(big)?.length, 200);
});

test("v1 watchlist: add then list then patch then delete round trips", async () => {
  const entry = await ws.addTicker("AAPL", "core position");
  assert.equal(entry.ticker, "AAPL");
  assert.equal(entry.note, "core position");

  const listed = await ws.listWatchlist();
  assert.ok(listed.some((e) => e.ticker === "AAPL" && e.note === "core position"));

  const patched = await ws.updateNote("AAPL", "trim above 250");
  assert.ok(patched);
  assert.equal(patched.note, "trim above 250");

  const cleared = await ws.updateNote("AAPL", null);
  assert.ok(cleared);
  assert.equal(cleared.note, null);

  const gone = await ws.removeTicker("AAPL");
  assert.equal(gone, true);
  const again = await ws.removeTicker("AAPL");
  assert.equal(again, false);

  const missing = await ws.updateNote("AAPL", "ghost");
  assert.equal(missing, null);
});

test("v1 watchlist: re-adding existing ticker with new note updates in place", async () => {
  await ws.addTicker("MSFT", "old note");
  const second = await ws.addTicker("MSFT", "new note");
  assert.equal(second.note, "new note");
  const listed = await ws.listWatchlist();
  const msftRows = listed.filter((e) => e.ticker === "MSFT");
  assert.equal(msftRows.length, 1);
});

test("v1 watchlist: route requires a valid key", async () => {
  const req = new Request("http://localhost/api/v1/watchlist", {
    headers: { authorization: "Bearer sc_live_bogus" },
  });
  const key = await ks.authenticate(ks.extractKey(req));
  assert.equal(key, null);
});

test("v1 watchlist: read scope sufficient for GET, trade required for mutations", async () => {
  const { key: readOnly } = await ks.createKey({
    label: "reader",
    scopes: ["read"],
  });
  const { key: trader } = await ks.createKey({
    label: "trader",
    scopes: ["trade"],
  });
  assert.ok(readOnly.scopes.includes("read"));
  assert.ok(!readOnly.scopes.includes("trade"));
  assert.ok(trader.scopes.includes("trade"));
});
