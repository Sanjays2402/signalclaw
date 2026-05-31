// node --experimental-strip-types --test tests/runAcl.test.mjs
//
// Per-run RBAC: a trade-scoped key may only mutate runs it created. A different
// trade key gets denied; an admin key bypasses ownership; legacy unowned runs
// (created before the field existed, or via the local dashboard) stay mutable
// by any trade key.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-runacl-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const acl = await import(path.join(repoRoot, "lib", "runAcl.ts"));
const rs = await import(path.join(repoRoot, "lib", "runStore.ts"));

const alice = { id: "key_alice", scopes: ["read", "trade"] };
const bob = { id: "key_bob", scopes: ["read", "trade"] };
const root = { id: "key_root", scopes: ["read", "trade", "admin"] };

test("createRun stamps owner when key context is supplied", async () => {
  const run = await rs.createRun({
    label: "alice run",
    ticker: "SPY",
    lookback_days: 30,
    payload: {
      ticker: "SPY",
      dates: ["2024-01-02"],
      close: [100],
      regime: ["bull"],
      counts: { bull: 1, chop: 0, bear: 0, crash: 0 },
      snapshot: null,
      disclaimer: "",
    },
    tags: [],
    created_by_key_id: alice.id,
    created_by_key_label: "alice-key",
  });
  assert.equal(run.created_by_key_id, alice.id);
  assert.equal(run.created_by_key_label, "alice-key");
});

test("owner can mutate own run", () => {
  const d = acl.decideRunMutation({ created_by_key_id: alice.id }, alice);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "owner");
});

test("cross-tenant: bob (trade) is denied on alice's run", () => {
  const d = acl.decideRunMutation({ created_by_key_id: alice.id }, bob);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "not_owner");
  assert.equal(d.ownerKeyId, alice.id);
});

test("admin scope bypasses ownership", () => {
  const d = acl.decideRunMutation({ created_by_key_id: alice.id }, root);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "admin");
});

test("legacy unowned run remains mutable by any trade key", () => {
  const d1 = acl.decideRunMutation({ created_by_key_id: null }, bob);
  const d2 = acl.decideRunMutation({}, bob);
  assert.equal(d1.allowed, true);
  assert.equal(d1.reason, "unowned");
  assert.equal(d2.allowed, true);
  assert.equal(d2.reason, "unowned");
});
