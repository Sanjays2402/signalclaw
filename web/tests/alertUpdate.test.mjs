// Inline edit coverage for the alert store updateAlert helper.
// Run with: node --experimental-strip-types --test tests/alertUpdate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-alerts-update-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "alertStore.ts"));

async function freshAlert(overrides = {}) {
  await fs.rm(path.join(process.cwd(), ".data", "alerts.json"), { force: true });
  const r = await store.createAlert({
    ticker: "AAPL",
    condition: "price_above",
    value: 200,
    note: "hello",
    cooldown_hours: 12,
    ...overrides,
  });
  assert.equal(r.ok, true);
  return r.alert;
}

test("updateAlert edits value, note, cooldown together", async () => {
  const a = await freshAlert();
  const r = await store.updateAlert(a.id, { value: 250, note: "raised", cooldown_hours: 6 });
  assert.equal(r.ok, true);
  assert.equal(r.alert.value, 250);
  assert.equal(r.alert.note, "raised");
  assert.equal(r.alert.cooldown_hours, 6);
  const list = await store.listAlerts();
  const after = list.find((x) => x.id === a.id);
  assert.equal(after.value, 250);
  assert.equal(after.note, "raised");
  assert.equal(after.cooldown_hours, 6);
});

test("updateAlert accepts string value and trims note", async () => {
  const a = await freshAlert();
  const r = await store.updateAlert(a.id, { value: "175.5", note: "   trim me   " });
  assert.equal(r.ok, true);
  assert.equal(r.alert.value, 175.5);
  assert.equal(r.alert.note, "trim me");
});

test("updateAlert rejects non-finite value", async () => {
  const a = await freshAlert();
  const r = await store.updateAlert(a.id, { value: "abc" });
  assert.equal(r.ok, false);
  assert.equal(r.err.code, "bad_value");
  assert.equal(r.status, 400);
});

test("updateAlert rejects non-positive price target", async () => {
  const a = await freshAlert();
  const r = await store.updateAlert(a.id, { value: -1 });
  assert.equal(r.ok, false);
  assert.equal(r.err.code, "bad_value");
});

test("updateAlert allows negative value for pct conditions", async () => {
  const a = await freshAlert({ condition: "pct_change_below", value: -0.05 });
  const r = await store.updateAlert(a.id, { value: -0.1 });
  assert.equal(r.ok, true);
  assert.equal(r.alert.value, -0.1);
});

test("updateAlert rejects negative cooldown", async () => {
  const a = await freshAlert();
  const r = await store.updateAlert(a.id, { cooldown_hours: -3 });
  assert.equal(r.ok, false);
  assert.equal(r.err.code, "bad_cooldown");
});

test("updateAlert empty patch is rejected", async () => {
  const a = await freshAlert();
  const r = await store.updateAlert(a.id, {});
  assert.equal(r.ok, false);
  assert.equal(r.err.code, "no_fields");
});

test("updateAlert unknown id returns 404", async () => {
  await freshAlert();
  const r = await store.updateAlert("nope-not-real", { value: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.err.code, "not_found");
  assert.equal(r.status, 404);
});

test("updateAlert can flip enabled and other fields are untouched", async () => {
  const a = await freshAlert();
  const r = await store.updateAlert(a.id, { enabled: false });
  assert.equal(r.ok, true);
  assert.equal(r.alert.enabled, false);
  assert.equal(r.alert.value, a.value);
  assert.equal(r.alert.note, a.note);
});
