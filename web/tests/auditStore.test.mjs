// node --experimental-strip-types --test tests/auditStore.test.mjs
//
// Exercises the audit-log store contracts and the auth+audit pairing used by
// every /api/v1/* route. The route handlers are thin wrappers around
// keyStore.authenticate + scope checks + recordAuditEvent, so we test those
// primitives end to end against the file-backed store.
//
// Specifically:
//   - recordAuditEvent appends and queryAudit reads back, newest-first
//   - IP is never persisted raw; only a salted SHA-256 hash
//   - plaintext secrets never leak into the log
//   - filters work (key_id, ok, route substring)
//   - a 403 (wrong scope) is recorded with reason, proving permission denial
//     is auditable
//   - a 401 (anon, no key) is recorded with key_id="anon"
//   - admin-only audit reads: a read-scope key is denied
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-audit-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));
const as = await import(path.join(repoRoot, "lib", "auditStore.ts"));

function makeReq(headers = {}, url = "http://localhost/api/v1/runs") {
  return new Request(url, { headers });
}

test("audit: anon request records as key_id=anon with reason", async () => {
  await as.clearAudit();
  const req = makeReq({ "x-forwarded-for": "203.0.113.7" });
  await as.recordAuditEvent({
    req,
    route: "/api/v1/runs",
    method: "GET",
    status: 401,
    key: null,
    reason: "unauthorized",
  });
  const { events, total } = await as.queryAudit({});
  assert.equal(total, 1);
  assert.equal(events[0].key_id, "anon");
  assert.equal(events[0].status, 401);
  assert.equal(events[0].ok, false);
  assert.equal(events[0].reason, "unauthorized");
});

test("audit: raw IP is never stored; only a salted hash", async () => {
  await as.clearAudit();
  const ip = "198.51.100.42";
  const req = makeReq({ "x-forwarded-for": ip });
  await as.recordAuditEvent({
    req,
    route: "/api/v1/usage",
    method: "GET",
    status: 200,
    key: { id: "k1", label: "test", prefix: "sc_live_aa", scopes: ["read"] },
  });
  const raw = await fs.readFile(path.join(tmpRoot, ".data", "audit.jsonl"), "utf8");
  assert.equal(raw.includes(ip), false, "raw IP must never hit disk");
  const { events } = await as.queryAudit({});
  assert.equal(events[0].ip_hash !== null, true);
  assert.equal(events[0].ip_hash.length, 32);
});

test("audit: plaintext API secrets must never leak into the log", async () => {
  await as.clearAudit();
  const { secret } = await ks.createKey({ label: "leaky", scopes: ["read"] });
  const req = makeReq({ authorization: `Bearer ${secret}` });
  const key = await ks.authenticate(ks.extractKey(req));
  await as.recordAuditEvent({
    req,
    route: "/api/v1/whoami",
    method: "GET",
    status: 200,
    key,
    // Even if a caller wedges the secret into details, recordAuditEvent
    // accepts arbitrary JSON details — but the route layer never passes the
    // secret. We assert the WIRE format we actually emit.
  });
  const raw = await fs.readFile(path.join(tmpRoot, ".data", "audit.jsonl"), "utf8");
  assert.equal(raw.includes(secret), false, "plaintext secret never persisted");
});

test("audit: queryAudit filters by key_id, ok, and route substring", async () => {
  await as.clearAudit();
  const k1 = { id: "alpha", label: "alpha", prefix: "sc_live_a1", scopes: ["read"] };
  const k2 = { id: "beta", label: "beta", prefix: "sc_live_b2", scopes: ["trade"] };
  await as.recordAuditEvent({ route: "/api/v1/runs", method: "GET", status: 200, key: k1 });
  await as.recordAuditEvent({ route: "/api/v1/runs", method: "POST", status: 403, key: k1, reason: "forbidden:trade-required" });
  await as.recordAuditEvent({ route: "/api/v1/alerts", method: "GET", status: 200, key: k2 });

  const byKey = await as.queryAudit({ key_id: "alpha" });
  assert.equal(byKey.total, 2);
  assert.ok(byKey.events.every((e) => e.key_id === "alpha"));

  const denied = await as.queryAudit({ ok: false });
  assert.equal(denied.total, 1);
  assert.equal(denied.events[0].status, 403);
  assert.equal(denied.events[0].reason, "forbidden:trade-required");

  const onlyAlerts = await as.queryAudit({ route: "/alerts" });
  assert.equal(onlyAlerts.total, 1);
  assert.equal(onlyAlerts.events[0].route, "/api/v1/alerts");

  const byMethod = await as.queryAudit({ method: "post" });
  assert.equal(byMethod.total, 1);
  assert.equal(byMethod.events[0].method, "POST");
});

test("audit: read-scope key is denied when the v1/audit handler checks scopes (permission denial)", async () => {
  // The /api/v1/audit route requires admin scope. We simulate the scope
  // check the route performs and assert the denial is recorded.
  await as.clearAudit();
  const { secret } = await ks.createKey({ label: "reader", scopes: ["read"] });
  const req = makeReq({ authorization: `Bearer ${secret}` }, "http://localhost/api/v1/audit");
  const key = await ks.authenticate(ks.extractKey(req));
  assert.ok(key);
  const hasAdmin = key.scopes.includes("admin");
  assert.equal(hasAdmin, false, "read-scope key must NOT have admin");
  // This mirrors the route's denial path verbatim:
  await as.recordAuditEvent({
    req,
    route: "/api/v1/audit",
    method: "GET",
    status: 403,
    key,
    reason: "forbidden:admin-required",
  });
  const { events } = await as.queryAudit({ ok: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].route, "/api/v1/audit");
  assert.equal(events[0].status, 403);
  assert.equal(events[0].reason, "forbidden:admin-required");
  assert.deepEqual(events[0].scopes, ["read"]);
});

test("audit: per-key IP salt → same IP, different keys, different hashes", async () => {
  await as.clearAudit();
  const req = makeReq({ "x-forwarded-for": "192.0.2.99" });
  await as.recordAuditEvent({ req, route: "/x", method: "GET", status: 200, key: { id: "k-a", label: "a", prefix: "p1", scopes: [] } });
  await as.recordAuditEvent({ req, route: "/x", method: "GET", status: 200, key: { id: "k-b", label: "b", prefix: "p2", scopes: [] } });
  const { events } = await as.queryAudit({});
  assert.equal(events.length, 2);
  assert.notEqual(events[0].ip_hash, events[1].ip_hash);
});

test("audit: oversize details blob is truncated, not silently dropped", async () => {
  await as.clearAudit();
  const big = { blob: "x".repeat(5000) };
  await as.recordAuditEvent({ route: "/x", method: "GET", status: 200, key: null, details: big });
  const { events } = await as.queryAudit({});
  assert.equal(events[0].details?._truncated, true);
});
