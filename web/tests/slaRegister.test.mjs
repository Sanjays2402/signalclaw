// node --experimental-strip-types --test tests/slaRegister.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-sla-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const sla = await import(path.join(repoRoot, "lib", "slaStore.ts"));

const VALID = {
  uptime_target_bps: 9995,
  response_targets: { sev1: 15, sev2: 60, sev3: 240, sev4: 1440 },
  credit_ladder: [
    { below_uptime_bps: 9900, credit_pct: 25 },
    { below_uptime_bps: 9500, credit_pct: 50 },
    { below_uptime_bps: 9000, credit_pct: 100 },
  ],
  notes: "Maintenance window Sunday 02:00-04:00 UTC. Excludes force majeure.",
  support_email: "support@example.com",
  status_page_url: "https://status.example.com",
  security_email: "security@example.com",
  actor_id: "k_admin_1",
};

test("starts empty", async () => {
  await sla.__resetForTests();
  const s = await sla.getState();
  assert.equal(s.current, null);
  assert.deepEqual(s.history, []);
});

test("rejects uptime below floor", async () => {
  await sla.__resetForTests();
  const r = await sla.publish({ ...VALID, uptime_target_bps: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_uptime");
});

test("rejects response targets out of order (sev1 > sev2)", async () => {
  await sla.__resetForTests();
  const r = await sla.publish({
    ...VALID,
    response_targets: { sev1: 240, sev2: 60, sev3: 120, sev4: 1440 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_response_order");
});

test("rejects credit ladder tier at or above uptime target", async () => {
  await sla.__resetForTests();
  const r = await sla.publish({
    ...VALID,
    credit_ladder: [{ below_uptime_bps: 9995, credit_pct: 10 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_ladder");
});

test("rejects credit ladder not sorted by below_uptime_bps desc", async () => {
  await sla.__resetForTests();
  const r = await sla.publish({
    ...VALID,
    credit_ladder: [
      { below_uptime_bps: 9500, credit_pct: 25 },
      { below_uptime_bps: 9900, credit_pct: 50 },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_ladder_order");
});

test("rejects bad support email", async () => {
  await sla.__resetForTests();
  const r = await sla.publish({ ...VALID, support_email: "not-an-email" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_contact");
});

test("rejects http (non-https) status page", async () => {
  await sla.__resetForTests();
  const r = await sla.publish({ ...VALID, status_page_url: "http://status.example.com" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_contact");
});

test("publishes v1 and pins notes sha256", async () => {
  await sla.__resetForTests();
  const r = await sla.publish(VALID);
  assert.equal(r.ok, true);
  assert.equal(r.commitment.version, 1);
  assert.equal(r.commitment.uptime_target_bps, 9995);
  assert.match(r.commitment.notes_sha256, /^[a-f0-9]{64}$/);
  assert.equal(r.commitment.contacts.support_email, "support@example.com");
  const s = await sla.getState();
  assert.equal(s.current.version, 1);
  assert.deepEqual(s.history, []);
});

test("publishing again appends previous to history and bumps version", async () => {
  await sla.__resetForTests();
  await sla.publish(VALID);
  const r2 = await sla.publish({ ...VALID, uptime_target_bps: 9990, notes: "Updated SLA after Q2 review." });
  assert.equal(r2.ok, true);
  assert.equal(r2.commitment.version, 2);
  const s = await sla.getState();
  assert.equal(s.current.version, 2);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].version, 1);
  // notes_sha256 must change when notes change.
  assert.notEqual(s.current.notes_sha256, s.history[0].notes_sha256);
});

test("evaluateCredit returns null when target met", async () => {
  await sla.__resetForTests();
  const r = await sla.publish(VALID);
  assert.equal(sla.evaluateCredit(r.commitment, 9999), null);
  assert.equal(sla.evaluateCredit(r.commitment, 9995), null);
});

test("evaluateCredit picks largest matching credit tier", async () => {
  await sla.__resetForTests();
  const r = await sla.publish(VALID);
  // 9990 < target 9995 but above the top ladder threshold (9900):
  // missed target but no tier matched -> null (under-target with no
  // ladder rung is a documented procurement edge case).
  assert.equal(sla.evaluateCredit(r.commitment, 9990), null);
  // 9899 < 9900 -> 25% credit
  assert.equal(sla.evaluateCredit(r.commitment, 9899).credit_pct, 25);
  // 9499 < 9500 -> 50% credit
  assert.equal(sla.evaluateCredit(r.commitment, 9499).credit_pct, 50);
  // 8000 < 9000 -> 100% credit (largest)
  assert.equal(sla.evaluateCredit(r.commitment, 8000).credit_pct, 100);
});
