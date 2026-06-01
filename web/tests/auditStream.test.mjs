// node --experimental-strip-types --test tests/auditStream.test.mjs
//
// Test for streamAuditFiltered (the bulk-export helper that backs
// /api/audit/export.jsonl). Proves:
//   * yields events newest-first
//   * filter predicates (key_id, method, route substring, ok, since) work
//   * preserves the full event shape (including hash + prev_hash)
//   * exceeds the 1000-row UI cap that queryAudit enforces
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-auditstream-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const as = await import(path.join(repoRoot, "lib", "auditStore.ts"));

async function collect(gen) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("streamAuditFiltered yields all events newest-first with full event shape", async () => {
  await as.clearAudit();
  for (let i = 0; i < 6; i++) {
    await as.recordAuditEvent({
      route: i % 2 === 0 ? "/api/v1/runs" : "/api/v1/watches",
      method: i % 3 === 0 ? "POST" : "GET",
      status: i === 5 ? 500 : 200,
      key: { id: i < 3 ? "k_a" : "k_b", label: "demo", prefix: "sc_live_", scopes: ["read"] },
      reason: null,
    });
  }

  const all = await collect(as.streamAuditFiltered());
  assert.equal(all.length, 6);
  // Newest first.
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1].ts >= all[i].ts, `not newest-first at ${i}`);
  }
  // Full shape including chain fields preserved.
  for (const ev of all) {
    assert.equal(typeof ev.hash, "string");
    assert.equal(ev.hash.length, 64);
    assert.equal(typeof ev.prev_hash, "string");
    assert.equal(ev.prev_hash.length, 64);
    assert.ok(Array.isArray(ev.scopes));
  }

  const onlyA = await collect(as.streamAuditFiltered({ key_id: "k_a" }));
  assert.equal(onlyA.length, 3);
  for (const e of onlyA) assert.equal(e.key_id, "k_a");

  const onlyRuns = await collect(as.streamAuditFiltered({ route: "/runs" }));
  assert.equal(onlyRuns.length, 3);
  for (const e of onlyRuns) assert.ok(e.route.includes("/runs"));

  const onlyPost = await collect(as.streamAuditFiltered({ method: "post" }));
  assert.ok(onlyPost.every((e) => e.method === "POST"));

  const failures = await collect(as.streamAuditFiltered({ ok: false }));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].status, 500);
});

test("streamAuditFiltered respects since= filter and limit cap", async () => {
  await as.clearAudit();
  await as.recordAuditEvent({
    route: "/api/v1/runs", method: "GET", status: 200,
    key: { id: "k1", label: "demo", prefix: "sc_live_", scopes: ["read"] }, reason: null,
  });
  // gap so timestamps differ
  await new Promise((r) => setTimeout(r, 15));
  const cutoff = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 15));
  await as.recordAuditEvent({
    route: "/api/v1/runs", method: "GET", status: 200,
    key: { id: "k1", label: "demo", prefix: "sc_live_", scopes: ["read"] }, reason: null,
  });

  const after = await collect(as.streamAuditFiltered({ since: cutoff }));
  assert.equal(after.length, 1, "since filter should drop the older event");

  const capped = await collect(as.streamAuditFiltered({ limit: 1 }));
  assert.equal(capped.length, 1);
});

test("streamAuditFiltered exceeds the queryAudit 1000-row UI cap", async () => {
  await as.clearAudit();
  // Write 1100 events (under the 50k rotate threshold, well over the
  // queryAudit cap). Keep payload tiny so the run stays fast.
  for (let i = 0; i < 1100; i++) {
    await as.recordAuditEvent({
      route: "/api/v1/runs", method: "GET", status: 200,
      key: { id: "k1", label: "demo", prefix: "sc_live_", scopes: ["read"] },
      reason: null,
    });
  }
  const all = await collect(as.streamAuditFiltered());
  assert.equal(all.length, 1100, "stream must not be capped at 1000");

  // And queryAudit IS capped at 1000 (proves the gap this export fills).
  const ui = await as.queryAudit({ limit: 5000 });
  assert.equal(ui.events.length, 1000);
});
