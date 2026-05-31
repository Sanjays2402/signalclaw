// Tests for the retention policy + sweep engine.
// Run with: node --experimental-strip-types --test tests/retention.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-retention-"));
process.chdir(tmpRoot);
await fs.mkdir(path.join(tmpRoot, ".data"), { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const ret = await import(path.join(repoRoot, "lib", "retentionStore.ts"));

const DATA = path.join(tmpRoot, ".data");

function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

test("default policy is retain-forever (all zeros)", async () => {
  const p = await ret.getPolicy();
  assert.equal(p.runs_days, 0);
  assert.equal(p.audit_days, 0);
  assert.equal(p.webhook_deliveries_days, 0);
  assert.equal(p.last_sweep_at, null);
});

test("setPolicy validates and clamps non-numbers to zero", async () => {
  const p = await ret.setPolicy({
    runs_days: "abc",
    audit_days: 30,
    webhook_deliveries_days: -5,
  });
  assert.equal(p.runs_days, 0);
  assert.equal(p.audit_days, 30);
  assert.equal(p.webhook_deliveries_days, 0);
});

test("sweep with zero policy is a no-op", async () => {
  await ret.setPolicy({ runs_days: 0, audit_days: 0, webhook_deliveries_days: 0 });
  const r = await ret.runRetentionSweep();
  assert.equal(r.counts.runs, 0);
  assert.equal(r.counts.audit, 0);
  assert.equal(r.counts.webhook_deliveries, 0);
});

test("sweep purges only runs older than runs_days", async () => {
  const runs = {
    runs: [
      { id: "old1", created_at: iso(40), label: "a", ticker: "SPY", lookback_days: 30, tags: [], payload: { ticker: "SPY", dates: [], close: [], regime: [], counts: {}, snapshot: null, disclaimer: "" } },
      { id: "new1", created_at: iso(5), label: "b", ticker: "SPY", lookback_days: 30, tags: [], payload: { ticker: "SPY", dates: [], close: [], regime: [], counts: {}, snapshot: null, disclaimer: "" } },
      { id: "edge", created_at: iso(29), label: "c", ticker: "SPY", lookback_days: 30, tags: [], payload: { ticker: "SPY", dates: [], close: [], regime: [], counts: {}, snapshot: null, disclaimer: "" } },
    ],
  };
  await fs.writeFile(path.join(DATA, "runs.json"), JSON.stringify(runs));
  await ret.setPolicy({ runs_days: 30, audit_days: 0, webhook_deliveries_days: 0 });
  const r = await ret.runRetentionSweep();
  assert.equal(r.counts.runs, 1);
  const after = JSON.parse(await fs.readFile(path.join(DATA, "runs.json"), "utf8"));
  const ids = after.runs.map((x) => x.id).sort();
  assert.deepEqual(ids, ["edge", "new1"]);
});

test("sweep purges only audit lines older than audit_days", async () => {
  const lines = [
    { id: "1", ts: iso(100), key_id: "k", route: "/x", method: "GET", status: 200, ok: true, scopes: [], key_label: "", key_prefix: "", ip_hash: null, user_agent: null, reason: null, details: null, request_id: null },
    { id: "2", ts: iso(2), key_id: "k", route: "/x", method: "GET", status: 200, ok: true, scopes: [], key_label: "", key_prefix: "", ip_hash: null, user_agent: null, reason: null, details: null, request_id: null },
  ];
  await fs.writeFile(
    path.join(DATA, "audit.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  // Also write a rotated file
  await fs.writeFile(
    path.join(DATA, "audit.jsonl.1"),
    JSON.stringify({ id: "old", ts: iso(500), key_id: "k", route: "/y", method: "GET", status: 200, ok: true, scopes: [], key_label: "", key_prefix: "", ip_hash: null, user_agent: null, reason: null, details: null, request_id: null }) + "\n",
  );
  await ret.setPolicy({ runs_days: 0, audit_days: 7, webhook_deliveries_days: 0 });
  const r = await ret.runRetentionSweep();
  assert.equal(r.counts.audit, 2);
  const remaining = (await fs.readFile(path.join(DATA, "audit.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean);
  assert.equal(remaining.length, 1);
  assert.equal(JSON.parse(remaining[0]).id, "2");
  const rolled = await fs.readFile(path.join(DATA, "audit.jsonl.1"), "utf8");
  assert.equal(rolled, "");
});

test("sweep purges only webhook deliveries older than window", async () => {
  const log = [
    { id: "a", subscription_id: "s1", url: "https://x", status: 200, error: null, attempt: 1, delivered_at: iso(60), signature: null, event_count: 0 },
    { id: "b", subscription_id: "s1", url: "https://x", status: 200, error: null, attempt: 1, delivered_at: iso(3), signature: null, event_count: 0 },
  ];
  await fs.writeFile(path.join(DATA, "webhook-deliveries.json"), JSON.stringify(log));
  await ret.setPolicy({ runs_days: 0, audit_days: 0, webhook_deliveries_days: 14 });
  const r = await ret.runRetentionSweep();
  assert.equal(r.counts.webhook_deliveries, 1);
  const after = JSON.parse(
    await fs.readFile(path.join(DATA, "webhook-deliveries.json"), "utf8"),
  );
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "b");
});

test("policy persists last_sweep_at and counts", async () => {
  await ret.setPolicy({ runs_days: 1, audit_days: 1, webhook_deliveries_days: 1 });
  await ret.runRetentionSweep();
  const p = await ret.getPolicy();
  assert.ok(p.last_sweep_at);
  assert.ok(p.last_sweep_counts);
});

test("maybeAutoSweep is throttled and returns null on second call", async () => {
  await ret._resetAutoSweepThrottle();
  await ret.setPolicy({ runs_days: 1, audit_days: 0, webhook_deliveries_days: 0 });
  const a = await ret.maybeAutoSweep();
  const b = await ret.maybeAutoSweep();
  assert.ok(a);
  assert.equal(b, null);
});

test("maybeAutoSweep returns null when policy is all zero", async () => {
  await ret._resetAutoSweepThrottle();
  await ret.setPolicy({ runs_days: 0, audit_days: 0, webhook_deliveries_days: 0 });
  const r = await ret.maybeAutoSweep();
  assert.equal(r, null);
});
