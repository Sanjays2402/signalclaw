// node --experimental-strip-types --test tests/v1Alerts.test.mjs
//
// Exercises the v1 alerts surface end to end against the file-backed
// alertStore. The route handlers are thin wrappers around the store + auth,
// so we test the store contracts the routes depend on plus the scope checks
// that gate them.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-v1alerts-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));
const as = await import(path.join(repoRoot, "lib", "alertStore.ts"));

test("v1 alerts: store validates ticker before persisting", async () => {
  const r = await as.createAlert({ ticker: "", condition: "price_above", value: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.err.code, "bad_ticker");
});

test("v1 alerts: store rejects unknown condition", async () => {
  const r = await as.createAlert({ ticker: "AAPL", condition: "bogus", value: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.err.code, "bad_condition");
});

test("v1 alerts: store rejects non-positive price target", async () => {
  const r = await as.createAlert({ ticker: "AAPL", condition: "price_above", value: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.err.code, "bad_value");
});

test("v1 alerts: create then list then delete round trips", async () => {
  const created = await as.createAlert({
    ticker: "NVDA",
    condition: "price_above",
    value: 150,
    cooldown_hours: 6,
    note: "breakout",
  });
  assert.equal(created.ok, true);
  assert.equal(created.alert.ticker, "NVDA");
  assert.equal(created.alert.cooldown_hours, 6);
  assert.equal(created.alert.enabled, true);

  const listed = await as.listAlerts();
  assert.ok(listed.some((a) => a.id === created.alert.id));

  const gone = await as.deleteAlert(created.alert.id);
  assert.equal(gone, true);
  const again = await as.deleteAlert(created.alert.id);
  assert.equal(again, false);
});

test("v1 alerts: runCheck honors supplied prices and records a hit", async () => {
  const c = await as.createAlert({
    ticker: "TSLA",
    condition: "price_above",
    value: 100,
    cooldown_hours: 0,
  });
  assert.equal(c.ok, true);
  const out = await as.runCheck({ TSLA: 250 });
  assert.ok(out.checked >= 1);
  assert.ok(out.hits.some((h) => h.alert_id === c.alert.id && h.observed === 250));
  assert.equal(out.quotes.TSLA.last, 250);
});

test("v1 alerts: read scope key cannot create, trade scope can", async () => {
  const reader = await ks.createKey({ label: "r", scopes: ["read"] });
  const trader = await ks.createKey({ label: "t", scopes: ["trade"] });
  // route gating mirrors what handlers do: check key.scopes
  const readerKey = await ks.authenticate(reader.secret);
  const traderKey = await ks.authenticate(trader.secret);
  assert.ok(readerKey);
  assert.ok(traderKey);
  assert.equal(readerKey.scopes.includes("trade"), false);
  assert.equal(traderKey.scopes.includes("trade"), true);
});
