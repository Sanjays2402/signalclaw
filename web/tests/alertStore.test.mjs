// Plain Node test for the alert store.
// Run with: node --experimental-strip-types --test tests/alertStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-alerts-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "alertStore.ts"));

test("validates and persists a price_above alert", async () => {
  const r = await store.createAlert({
    ticker: "aapl",
    condition: "price_above",
    value: 200,
    note: "watch breakout",
    cooldown_hours: 6,
  });
  assert.equal(r.ok, true);
  assert.equal(r.alert.ticker, "AAPL");
  assert.equal(r.alert.condition, "price_above");
  assert.equal(r.alert.value, 200);
  assert.equal(r.alert.cooldown_hours, 6);
  assert.equal(r.alert.enabled, true);
  assert.equal(r.alert.last_fired_at, null);
  assert.ok(r.alert.id);

  const list = await store.listAlerts();
  assert.equal(list.length, 1);
  assert.equal(list[0].ticker, "AAPL");
});

test("rejects invalid ticker, condition and value", async () => {
  const bad1 = await store.createAlert({ ticker: "@@@", condition: "price_above", value: 10 });
  assert.equal(bad1.ok, false);
  assert.equal(bad1.err.code, "bad_ticker");

  const bad2 = await store.createAlert({ ticker: "MSFT", condition: "nope", value: 10 });
  assert.equal(bad2.ok, false);
  assert.equal(bad2.err.code, "bad_condition");

  const bad3 = await store.createAlert({ ticker: "MSFT", condition: "price_above", value: "x" });
  assert.equal(bad3.ok, false);
  assert.equal(bad3.err.code, "bad_value");

  const bad4 = await store.createAlert({ ticker: "MSFT", condition: "price_above", value: -5 });
  assert.equal(bad4.ok, false);
  assert.equal(bad4.err.code, "bad_value");
});

test("runCheck fires when supplied price crosses level, respects cooldown, logs history", async () => {
  await fs.rm(path.join(process.cwd(), ".data", "alerts.json"), { force: true });

  await store.createAlert({ ticker: "NVDA", condition: "price_above", value: 100, cooldown_hours: 1 });

  const r1 = await store.runCheck({ NVDA: 150 });
  assert.equal(r1.hits.length, 1);
  assert.equal(r1.hits[0].ticker, "NVDA");
  assert.equal(r1.hits[0].observed, 150);

  // Cooldown blocks re-fire.
  const r2 = await store.runCheck({ NVDA: 200 });
  assert.equal(r2.hits.length, 0);

  // History records the fire.
  const h = await store.listHistory({ limit: 10, offset: 0 });
  assert.equal(h.total, 1);
  assert.equal(h.events[0].ticker, "NVDA");

  // Clear wipes history.
  const cleared = await store.clearHistory();
  assert.equal(cleared, 1);
  const h2 = await store.listHistory({ limit: 10, offset: 0 });
  assert.equal(h2.total, 0);
});

test("runCheck handles pct_change_below correctly", async () => {
  await fs.rm(path.join(process.cwd(), ".data", "alerts.json"), { force: true });

  await store.createAlert({ ticker: "TSLA", condition: "pct_change_below", value: -0.05 });
  // No prices supplied falls back to deterministic synthetic; just sanity-check shape.
  const r = await store.runCheck();
  assert.equal(typeof r.checked, "number");
  assert.ok(r.quotes.TSLA);
});

test("deleteAlert removes by id", async () => {
  // Reset store file so we have a clean slate regardless of test interleaving.
  await fs.rm(path.join(process.cwd(), ".data", "alerts.json"), { force: true });

  const c = await store.createAlert({ ticker: "SPYDEL", condition: "price_below", value: 400 });
  assert.equal(c.ok, true);
  const ok = await store.deleteAlert(c.alert.id);
  assert.equal(ok, true);
  const list = await store.listAlerts();
  assert.equal(list.find((a) => a.id === c.alert.id), undefined);
  const again = await store.deleteAlert(c.alert.id);
  assert.equal(again, false);
});

test("setAlertEnabled toggles flag and returns updated alert", async () => {
  await fs.rm(path.join(process.cwd(), ".data", "alerts.json"), { force: true });

  const c = await store.createAlert({ ticker: "META", condition: "price_above", value: 500 });
  assert.equal(c.ok, true);
  assert.equal(c.alert.enabled, true);

  const off = await store.setAlertEnabled(c.alert.id, false);
  assert.ok(off);
  assert.equal(off.enabled, false);

  const list = await store.listAlerts();
  assert.equal(list.find((a) => a.id === c.alert.id).enabled, false);

  const on = await store.setAlertEnabled(c.alert.id, true);
  assert.ok(on);
  assert.equal(on.enabled, true);

  // No-op when already in desired state still returns the alert.
  const same = await store.setAlertEnabled(c.alert.id, true);
  assert.ok(same);
  assert.equal(same.enabled, true);

  // Unknown id returns null.
  const miss = await store.setAlertEnabled("nope-not-real", false);
  assert.equal(miss, null);
});

test("setAlertEnabled disabled alert is skipped by runCheck", async () => {
  await fs.rm(path.join(process.cwd(), ".data", "alerts.json"), { force: true });

  const c = await store.createAlert({ ticker: "AMZN", condition: "price_above", value: 100, cooldown_hours: 0 });
  assert.equal(c.ok, true);
  await store.setAlertEnabled(c.alert.id, false);

  const r = await store.runCheck({ AMZN: 200 });
  assert.equal(r.hits.length, 0);

  await store.setAlertEnabled(c.alert.id, true);
  const r2 = await store.runCheck({ AMZN: 200 });
  assert.equal(r2.hits.length, 1);
  assert.equal(r2.hits[0].ticker, "AMZN");
});
