// node --experimental-strip-types --test tests/auditChain.test.mjs
//
// Tamper-evidence test for the audit log hash chain. Proves:
//   - sequential writes form an HMAC chain (each event's prev_hash = prior hash)
//   - verifyChain() returns ok=true for an untouched log
//   - editing a recorded event on disk causes verifyChain() to return ok=false
//     and to point at the broken index
//   - dropping a middle event also breaks verification
//   - legacy lines (no hash field) written before chaining shipped are
//     accepted as a pre-chain prefix and do not fail verification
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-chain-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const as = await import(path.join(repoRoot, "lib", "auditStore.ts"));

const DATA_FILE = path.join(tmpRoot, ".data", "audit.jsonl");

async function readEvents() {
  const raw = await fs.readFile(DATA_FILE, "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
async function writeEvents(events) {
  await fs.writeFile(DATA_FILE, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

test("chain: sequential writes link together and verifyChain reports ok", async () => {
  await as.clearAudit();
  for (let i = 0; i < 5; i++) {
    await as.recordAuditEvent({
      route: "/api/v1/runs",
      method: "GET",
      status: 200,
      key: { id: "k1", label: "demo", prefix: "sc_live_", scopes: ["read"] },
      reason: null,
    });
  }
  const events = await readEvents();
  assert.equal(events.length, 5);
  for (let i = 0; i < events.length; i++) {
    assert.equal(typeof events[i].hash, "string");
    assert.equal(events[i].hash.length, 64);
    assert.equal(typeof events[i].prev_hash, "string");
    assert.equal(events[i].prev_hash.length, 64);
    if (i > 0) assert.equal(events[i].prev_hash, events[i - 1].hash);
  }
  const v = await as.verifyChain();
  assert.equal(v.ok, true, `expected ok, got ${JSON.stringify(v)}`);
  assert.equal(v.checked, 5);
  assert.equal(v.skipped_legacy, 0);
  assert.equal(v.last_hash, events[4].hash);
});

test("chain: editing a stored event field breaks verification", async () => {
  await as.clearAudit();
  for (let i = 0; i < 4; i++) {
    await as.recordAuditEvent({
      route: "/api/v1/usage",
      method: "GET",
      status: 200,
      key: { id: "k2", label: "demo2", prefix: "sc_live_", scopes: ["read"] },
      reason: null,
    });
  }
  const events = await readEvents();
  // Tamper: silently flip a recorded status from 200 -> 500 on row 2 without
  // recomputing the hash, simulating an attacker that edited the log file.
  events[2].status = 500;
  events[2].ok = false;
  await writeEvents(events);
  const v = await as.verifyChain();
  assert.equal(v.ok, false);
  assert.equal(v.break_at_index, 2);
  assert.equal(v.reason, "hash_mismatch");
  assert.equal(v.break_event_id, events[2].id);
});

test("chain: removing a middle event breaks the prev_hash link", async () => {
  await as.clearAudit();
  for (let i = 0; i < 4; i++) {
    await as.recordAuditEvent({
      route: "/api/v1/runs",
      method: "GET",
      status: 200,
      key: { id: "k3", label: "demo3", prefix: "sc_live_", scopes: ["read"] },
      reason: null,
    });
  }
  const events = await readEvents();
  // Drop index 1; row that used to be index 2 now has a stale prev_hash.
  const tampered = [events[0], events[2], events[3]];
  await writeEvents(tampered);
  const v = await as.verifyChain();
  assert.equal(v.ok, false);
  assert.equal(v.break_at_index, 1);
  assert.equal(v.reason, "prev_hash_mismatch");
});

test("chain: legacy unchained events are tolerated as a pre-chain prefix", async () => {
  await as.clearAudit();
  // Hand-write two legacy rows (no hash/prev_hash fields), then let the
  // store append two chained rows on top.
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const legacy = [
    { id: "old1", ts: "2024-01-01T00:00:00.000Z", key_id: "anon", key_label: "", key_prefix: "", scopes: [], route: "/api/v1/runs", method: "GET", status: 200, ok: true, ip_hash: null, user_agent: null, reason: null, details: null, request_id: null },
    { id: "old2", ts: "2024-01-01T00:00:01.000Z", key_id: "anon", key_label: "", key_prefix: "", scopes: [], route: "/api/v1/usage", method: "GET", status: 200, ok: true, ip_hash: null, user_agent: null, reason: null, details: null, request_id: null },
  ];
  await fs.writeFile(DATA_FILE, legacy.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  as._resetChainCache();
  await as.recordAuditEvent({
    route: "/api/v1/runs",
    method: "GET",
    status: 200,
    key: { id: "k4", label: "demo4", prefix: "sc_live_", scopes: ["read"] },
  });
  await as.recordAuditEvent({
    route: "/api/v1/runs",
    method: "GET",
    status: 200,
    key: { id: "k4", label: "demo4", prefix: "sc_live_", scopes: ["read"] },
  });
  const v = await as.verifyChain();
  assert.equal(v.ok, true, `expected ok, got ${JSON.stringify(v)}`);
  assert.equal(v.skipped_legacy, 2);
  assert.equal(v.checked, 2);
  assert.equal(v.first_chained_index, 2);
});
