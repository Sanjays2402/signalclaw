// node --experimental-strip-types --test tests/freezeStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-freeze-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "freezeStore.ts"));
const {
  getFreezeState,
  freezeWorkspace,
  unfreezeWorkspace,
  __resetFreezeCache,
  MAX_REASON_LEN,
} = mod;

test("default state is unfrozen", async () => {
  __resetFreezeCache();
  const s = await getFreezeState();
  assert.equal(s.frozen, false);
  assert.equal(s.reason, null);
  assert.equal(s.frozen_at, null);
});

test("requires non-empty reason", async () => {
  __resetFreezeCache();
  const r = await freezeWorkspace({ reason: "   ", actor: "alice" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_reason");
});

test("rejects oversized reason", async () => {
  __resetFreezeCache();
  const r = await freezeWorkspace({
    reason: "x".repeat(MAX_REASON_LEN + 1),
    actor: "alice",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_reason");
});

test("freeze then double-freeze is rejected", async () => {
  __resetFreezeCache();
  const r1 = await freezeWorkspace({ reason: "leak", actor: "alice" });
  assert.equal(r1.ok, true);
  assert.equal(r1.state.frozen, true);
  assert.equal(r1.state.reason, "leak");
  assert.equal(r1.state.frozen_by, "alice");
  assert.ok(r1.state.frozen_at);
  assert.equal(r1.before.frozen, false);

  const r2 = await freezeWorkspace({ reason: "again", actor: "bob" });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "already_frozen");
});

test("frozen state persists to disk and survives a fresh read", async () => {
  __resetFreezeCache();
  const s = await getFreezeState();
  assert.equal(s.frozen, true);
  assert.equal(s.reason, "leak");
});

test("unfreeze then double-unfreeze is rejected", async () => {
  __resetFreezeCache();
  const u1 = await unfreezeWorkspace({ actor: "bob" });
  assert.equal(u1.ok, true);
  assert.equal(u1.state.frozen, false);
  assert.equal(u1.state.unfrozen_by, "bob");
  assert.equal(u1.before.frozen, true);

  const u2 = await unfreezeWorkspace({ actor: "bob" });
  assert.equal(u2.ok, false);
  assert.equal(u2.code, "not_frozen");
});
