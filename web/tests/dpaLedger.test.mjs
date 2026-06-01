// node --experimental-strip-types --test tests/dpaLedger.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-dpa-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const dpa = await import(path.join(repoRoot, "lib", "dpaStore.ts"));

test("starts with no acceptance and needs_re_acceptance=true", async () => {
  const s = await dpa.getState();
  assert.equal(s.active, null);
  assert.equal(s.needs_re_acceptance, true);
  assert.deepEqual(s.acceptances, []);
  assert.equal(typeof s.current.version, "string");
  assert.equal(typeof s.current.sha256, "string");
});

test("rejects too-short signatory name", async () => {
  const r = await dpa.accept({
    signatory_name: "",
    signatory_title: "CTO",
    customer_entity: "Acme",
    actor_id: "k_test",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_signatory");
});

test("rejects missing customer entity", async () => {
  const r = await dpa.accept({
    signatory_name: "Maria Chen",
    signatory_title: "CTO",
    customer_entity: "   ",
    actor_id: "k_test",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_entity");
});

test("records an acceptance, pins current version and sha256", async () => {
  const r = await dpa.accept({
    signatory_name: "Maria Chen",
    signatory_title: "Head of Security",
    customer_entity: "Acme Capital, Inc.",
    note: "MSA-2026-051",
    actor_id: "k_admin_42",
    actor_email: "maria@acme.example",
    ip: "203.0.113.7",
    user_agent: "Mozilla/5.0",
  });
  assert.equal(r.ok, true);
  assert.equal(r.acceptance.action, "accepted");
  assert.equal(r.acceptance.dpa_version, dpa.CURRENT_DPA.version);
  assert.equal(r.acceptance.dpa_sha256, dpa.CURRENT_DPA.sha256);
  assert.equal(r.acceptance.customer_entity, "Acme Capital, Inc.");
  assert.equal(r.acceptance.actor_id, "k_admin_42");
  assert.ok(r.acceptance.ip_hash && r.acceptance.ip_hash.length === 32);
  assert.equal(r.superseded, null);

  const s = await dpa.getState();
  assert.equal(s.needs_re_acceptance, false);
  assert.ok(s.active);
  assert.equal(s.active.id, r.acceptance.id);
});

test("second acceptance marks the first as superseded but does not delete it", async () => {
  const before = await dpa.getState();
  const priorId = before.active.id;
  const r = await dpa.accept({
    signatory_name: "Sam Rivera",
    signatory_title: "General Counsel",
    customer_entity: "Acme Capital, Inc.",
    actor_id: "k_admin_99",
  });
  assert.equal(r.ok, true);
  assert.ok(r.superseded);
  assert.equal(r.superseded.id, priorId);
  const s = await dpa.getState();
  // Both rows are in history; the latest is active.
  assert.ok(s.acceptances.length >= 2);
  assert.equal(s.active.id, r.acceptance.id);
});

test("ip hashes are stable but do not reveal the raw ip", async () => {
  // Same ip -> same hash; different ip -> different hash; neither contains the raw ip.
  const a = await dpa.accept({
    signatory_name: "Test One",
    signatory_title: "VP",
    customer_entity: "Acme Capital, Inc.",
    actor_id: "k1",
    ip: "198.51.100.4",
  });
  const b = await dpa.accept({
    signatory_name: "Test Two",
    signatory_title: "VP",
    customer_entity: "Acme Capital, Inc.",
    actor_id: "k2",
    ip: "198.51.100.4",
  });
  const c = await dpa.accept({
    signatory_name: "Test Three",
    signatory_title: "VP",
    customer_entity: "Acme Capital, Inc.",
    actor_id: "k3",
    ip: "198.51.100.5",
  });
  assert.equal(a.acceptance.ip_hash, b.acceptance.ip_hash);
  assert.notEqual(a.acceptance.ip_hash, c.acceptance.ip_hash);
  assert.ok(!a.acceptance.ip_hash.includes("198.51"));
});

test("withdraw requires a reason and produces a 'withdrawn' row, clearing active", async () => {
  const tooShort = await dpa.withdraw({ reason: "x", actor_id: "k_admin_42" });
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.code, "bad_reason");

  const ok = await dpa.withdraw({
    reason: "Counsel review concluded; superseding MSA in progress.",
    actor_id: "k_admin_42",
    ip: "203.0.113.9",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.withdrawal.action, "withdrawn");
  assert.equal(ok.withdrawal.dpa_version, ok.withdrew.dpa_version);

  const s = await dpa.getState();
  assert.equal(s.active, null);
  assert.equal(s.needs_re_acceptance, true);
  // History is fully preserved (the withdrawn row is appended, prior rows kept).
  assert.ok(s.acceptances.length >= 4);
});

test("withdraw with no active acceptance returns no_active", async () => {
  const r = await dpa.withdraw({
    reason: "Trying to withdraw again",
    actor_id: "k_admin_42",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_active");
});

test("ledger file is append-only on disk (entries only grow)", async () => {
  const file = path.join(tmpRoot, ".data", "dpa-ledger.json");
  const raw = await fs.readFile(file, "utf8");
  const j = JSON.parse(raw);
  const before = j.acceptances.length;
  await dpa.accept({
    signatory_name: "Append Test",
    signatory_title: "CTO",
    customer_entity: "Acme Capital, Inc.",
    actor_id: "k_append",
  });
  const raw2 = await fs.readFile(file, "utf8");
  const j2 = JSON.parse(raw2);
  assert.equal(j2.acceptances.length, before + 1);
  // The original rows are still byte-identical (sliced prefix matches).
  for (let i = 0; i < before; i++) {
    assert.deepEqual(j2.acceptances[i], j.acceptances[i]);
  }
});
