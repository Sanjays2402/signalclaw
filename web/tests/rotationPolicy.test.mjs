// Workspace API key rotation policy.
// Run with: node --experimental-strip-types --test tests/rotationPolicy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-rotation-"));
process.chdir(tmpRoot);
await fs.mkdir(path.join(tmpRoot, ".data"), { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const rp = await import(path.join(repoRoot, "lib", "rotationPolicy.ts"));

const DAY_MS = 86_400_000;

test("defaults: disabled and warn window of 7 days", async () => {
  const p = await rp.getRotationPolicy();
  assert.equal(p.max_age_days, 0);
  assert.equal(p.warn_days, 7);
});

test("evaluate: disabled policy yields status disabled regardless of age", () => {
  const p = { max_age_days: 0, warn_days: 7, updated_at: "x", updated_by: null };
  const key = { created_at: new Date(Date.now() - 999 * DAY_MS).toISOString() };
  const ev = rp.evaluateKeyRotation(key, p);
  assert.equal(ev.status, "disabled");
  assert.equal(ev.days_until_rotation, null);
  assert.equal(ev.rotate_by, null);
  assert.ok(ev.age_days >= 999);
});

test("evaluate: fresh key under policy is ok", () => {
  const p = { max_age_days: 30, warn_days: 7, updated_at: "x", updated_by: null };
  const key = { created_at: new Date(Date.now() - 3 * DAY_MS).toISOString() };
  const ev = rp.evaluateKeyRotation(key, p);
  assert.equal(ev.status, "ok");
  assert.equal(ev.age_days, 3);
  assert.equal(ev.days_until_rotation, 27);
  assert.ok(typeof ev.rotate_by === "string");
});

test("evaluate: key inside warn window is warning", () => {
  const p = { max_age_days: 30, warn_days: 7, updated_at: "x", updated_by: null };
  const key = { created_at: new Date(Date.now() - 25 * DAY_MS).toISOString() };
  const ev = rp.evaluateKeyRotation(key, p);
  assert.equal(ev.status, "warning");
  assert.equal(ev.days_until_rotation, 5);
});

test("evaluate: key older than max_age_days is stale", () => {
  const p = { max_age_days: 30, warn_days: 7, updated_at: "x", updated_by: null };
  const key = { created_at: new Date(Date.now() - 31 * DAY_MS).toISOString() };
  const ev = rp.evaluateKeyRotation(key, p);
  assert.equal(ev.status, "stale");
  assert.ok(ev.days_until_rotation <= 0);
});

test("setRotationPolicy persists and rejects negatives", async () => {
  const next = await rp.setRotationPolicy({
    max_age_days: 90,
    warn_days: 14,
    updated_by: "k_test",
  });
  assert.equal(next.max_age_days, 90);
  assert.equal(next.warn_days, 14);
  assert.equal(next.updated_by, "k_test");
  const reread = await rp.getRotationPolicy();
  assert.equal(reread.max_age_days, 90);
  await assert.rejects(
    rp.setRotationPolicy({ max_age_days: -1 }),
    /invalid_policy/,
  );
  await assert.rejects(
    rp.setRotationPolicy({ warn_days: -3 }),
    /invalid_policy/,
  );
});

test("decideRotationBlock denies stale keys but lets fresh keys through (real keyStore round-trip)", async () => {
  const sub = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-rotation-enforce-"));
  process.chdir(sub);
  await fs.mkdir(path.join(sub, ".data"), { recursive: true });

  // Reload modules so they pick up the new cwd.
  const ks = await import(path.join(repoRoot, "lib", "keyStore.ts") + "?enforce");
  const policy = await import(path.join(repoRoot, "lib", "rotationPolicy.ts") + "?enforce");

  await policy.setRotationPolicy({ max_age_days: 30, warn_days: 7 });

  const { key: freshKey } = await ks.createKey({ label: "fresh", scopes: ["read"] });
  const { key: staleKey } = await ks.createKey({ label: "stale", scopes: ["read"] });

  // Backdate the stale key directly in the store file.
  const keysFile = path.join(sub, ".data", "keys.json");
  const raw = JSON.parse(await fs.readFile(keysFile, "utf8"));
  for (const k of raw.keys) {
    if (k.id === staleKey.id) {
      k.created_at = new Date(Date.now() - 90 * DAY_MS).toISOString();
    }
  }
  await fs.writeFile(keysFile, JSON.stringify(raw, null, 2));

  const livePolicy = await policy.getRotationPolicy();
  assert.equal(livePolicy.max_age_days, 30);

  // Fresh key passes the guard's deny decision.
  const freshDecision = policy.decideRotationBlock(freshKey, livePolicy);
  assert.equal(freshDecision.blocked, false);
  assert.ok(["ok", "warning"].includes(freshDecision.evaluation.status));

  // Reload the stale key from disk and confirm it is blocked. This proves
  // the same code path v1Guard executes will return 403 instead of running
  // the handler.
  const reloaded = (await ks.listKeys()).find((k) => k.id === staleKey.id);
  assert.ok(reloaded);
  const staleDecision = policy.decideRotationBlock(reloaded, livePolicy);
  assert.equal(staleDecision.blocked, true, "stale key must be blocked");
  assert.equal(staleDecision.reason, "key_rotation_required");
  assert.equal(staleDecision.evaluation.status, "stale");
  assert.ok(staleDecision.evaluation.age_days >= 90);

  // And cross-key isolation: the same policy applied to the fresh key from
  // the same store still passes, so the denial is per-key, not global.
  const freshReloaded = (await ks.listKeys()).find((k) => k.id === freshKey.id);
  assert.ok(freshReloaded);
  assert.equal(
    policy.decideRotationBlock(freshReloaded, livePolicy).blocked,
    false,
    "fresh key must keep working while stale key is denied",
  );
});
