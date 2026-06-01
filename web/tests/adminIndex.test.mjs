// node --experimental-strip-types --test tests/adminIndex.test.mjs
//
// Proves the admin control inventory aggregator returns a coherent set
// of rows whose statuses reflect the underlying policy stores. The route
// itself reuses the shared admin gate (audited by adminGuard.test.mjs);
// what this test owns is the aggregation contract:
//   1. Every category appears and every row has a non-empty summary.
//   2. Flipping the workspace freeze on flips the "freeze" row to
//      enforcing without mutating any other row's status.
//   3. Setting a retention policy with a positive TTL flips the
//      "retention" row to enforcing and surfaces the days in the summary.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-admin-index-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ai = await import(path.join(repoRoot, "lib", "adminIndex.ts"));
const fz = await import(path.join(repoRoot, "lib", "freezeStore.ts"));
const rt = await import(path.join(repoRoot, "lib", "retentionStore.ts"));

test("buildAdminIndex returns the full control inventory", async () => {
  const env = { ...process.env };
  delete env.SIGNALCLAW_ADMIN_KEY;
  const out = await ai.buildAdminIndex(env);

  assert.ok(Array.isArray(out.controls));
  assert.ok(out.controls.length >= 15, `expected >=15 controls, got ${out.controls.length}`);

  const cats = new Set(out.controls.map((c) => c.category));
  for (const required of ["identity", "data", "network", "operations", "observability"]) {
    assert.ok(cats.has(required), `missing category ${required}`);
  }

  for (const row of out.controls) {
    assert.ok(row.label.length > 0, `empty label on ${row.key}`);
    assert.ok(row.summary.length > 0, `empty summary on ${row.key}`);
    assert.ok(row.href.startsWith("/"), `bad href on ${row.key}`);
    assert.ok(
      ["enforcing", "monitoring", "configured", "off", "warning"].includes(row.status),
      `bad status ${row.status} on ${row.key}`,
    );
  }

  // Counts agree with rows.
  const total =
    out.counts.enforcing +
    out.counts.monitoring +
    out.counts.configured +
    out.counts.off +
    out.counts.warning;
  assert.equal(total, out.controls.length);
  assert.equal(out.admin_mode, "local");
});

test("workspace freeze flips only the freeze control to enforcing", async () => {
  const env = { ...process.env };
  delete env.SIGNALCLAW_ADMIN_KEY;

  const before = await ai.buildAdminIndex(env);
  const beforeFreeze = before.controls.find((c) => c.key === "freeze");
  assert.equal(beforeFreeze?.status, "off");

  await fz.freezeWorkspace({ reason: "incident-drill", actor: "test" });

  const after = await ai.buildAdminIndex(env);
  const afterFreeze = after.controls.find((c) => c.key === "freeze");
  assert.equal(afterFreeze?.status, "enforcing");
  assert.match(afterFreeze.summary, /test/);

  // No collateral damage on identity rows.
  const beforeKeys = before.controls.find((c) => c.key === "keys")?.status;
  const afterKeys = after.controls.find((c) => c.key === "keys")?.status;
  assert.equal(afterKeys, beforeKeys);

  await fz.unfreezeWorkspace({ actor: "test" });
});

test("setting retention TTL surfaces in the retention row", async () => {
  const env = { ...process.env };
  delete env.SIGNALCLAW_ADMIN_KEY;

  await rt.setPolicy({
    runs_days: 30,
    audit_days: 365,
    webhook_deliveries_days: 14,
  });

  const out = await ai.buildAdminIndex(env);
  const row = out.controls.find((c) => c.key === "retention");
  assert.equal(row?.status, "enforcing");
  assert.match(row.summary, /365d/);
  assert.match(row.summary, /30d/);
});
