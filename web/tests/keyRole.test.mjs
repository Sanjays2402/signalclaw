// Unit tests for the API-key RBAC role primitive.
//
// Roles are coarse labels that deterministically drive the underlying
// scopes array. setKeyRole() must rewrite both fields atomically so the
// auth path never observes drift, and refuse to mutate the env admin or
// revoked keys. Also verifies that publicView surfaces a `role` and an
// `effective_scopes` field so the admin console can render a stable
// label even for legacy keys that were minted before roles existed.
//
// Run with: node --experimental-strip-types --test tests/keyRole.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function freshTmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-keyrole-"));
  process.chdir(dir);
  return dir;
}

async function loadFresh() {
  // keyStore caches its data dir via process.cwd() at import time of the
  // file operations, but readStore reads cwd on every call, so a chdir
  // before the first call is enough. Use a query-string cache buster so
  // each test gets a clean module instance even if Node caches imports.
  const mod = await import(
    `file://${path.join(repoRoot, "lib", "keyStore.ts")}?t=${Date.now()}_${Math.random()}`
  );
  return mod;
}

test("roleToScopes maps every role to its canonical scope set", async () => {
  await freshTmpDir();
  const mod = await loadFresh();
  assert.deepEqual(mod.roleToScopes("owner").sort(), ["admin", "read", "trade"]);
  assert.deepEqual(mod.roleToScopes("admin").sort(), ["admin", "read", "trade"]);
  assert.deepEqual(mod.roleToScopes("member").sort(), ["read", "trade"]);
  assert.deepEqual(mod.roleToScopes("viewer"), ["read"]);
});

test("createKey stamps an initial role inferred from scopes", async () => {
  await freshTmpDir();
  const mod = await loadFresh();
  const a = await mod.createKey({ label: "trader", scopes: ["read", "trade"] });
  assert.equal(a.key.role, "member");
  const b = await mod.createKey({ label: "readonly", scopes: ["read"] });
  assert.equal(b.key.role, "viewer");
  // admin scope is not assignable via createKey; it gets stripped.
  const c = await mod.createKey({ label: "tries-admin", scopes: ["admin", "read"] });
  assert.equal(c.key.scopes.includes("admin"), false);
  assert.equal(c.key.role, "viewer");
});

test("setKeyRole rewrites role and scopes atomically (downgrade member->viewer drops trade)", async () => {
  await freshTmpDir();
  const mod = await loadFresh();
  const { key } = await mod.createKey({ label: "k", scopes: ["read", "trade"] });
  assert.equal(key.role, "member");
  assert.ok(key.scopes.includes("trade"));

  const downgraded = await mod.setKeyRole(key.id, "viewer");
  assert.ok(downgraded);
  assert.equal(downgraded.role, "viewer");
  assert.deepEqual(downgraded.scopes, ["read"]);

  // Promote to admin: scopes must include admin.
  const promoted = await mod.setKeyRole(key.id, "admin");
  assert.ok(promoted);
  assert.equal(promoted.role, "admin");
  assert.ok(promoted.scopes.includes("admin"));
  assert.ok(promoted.scopes.includes("trade"));
  assert.ok(promoted.scopes.includes("read"));
});

test("setKeyRole refuses env-admin, unknown ids, revoked keys, and bogus roles", async () => {
  await freshTmpDir();
  const mod = await loadFresh();
  // env-admin is hardcoded and must not be mutable.
  assert.equal(await mod.setKeyRole("env-admin", "viewer"), null);
  // Unknown id.
  assert.equal(await mod.setKeyRole("nope", "viewer"), null);
  // Bogus role throws (route handler converts to 400 invalid_role).
  await assert.rejects(
    async () => mod.setKeyRole("anything", "superuser"),
    /invalid_role/,
  );
  // Revoked key cannot be re-roled (caller should revive by minting new).
  const { key } = await mod.createKey({ label: "doomed", scopes: ["read"] });
  await mod.revokeKey(key.id);
  assert.equal(await mod.setKeyRole(key.id, "admin"), null);
});

test("publicView exposes role and effective_scopes for legacy keys with no role field", async () => {
  await freshTmpDir();
  const mod = await loadFresh();
  // Hand-craft a legacy stored shape (no role field) and verify publicView
  // infers a usable role from scopes for the admin console.
  const legacy = {
    id: "legacy",
    label: "legacy",
    prefix: "sc_live_xx",
    hash: "deadbeef",
    scopes: ["read", "trade"],
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked: false,
  };
  const v = mod.publicView(legacy);
  assert.equal(v.role, "member");
  assert.deepEqual(v.effective_scopes, ["read", "trade"]);

  const readOnly = mod.publicView({ ...legacy, scopes: ["read"] });
  assert.equal(readOnly.role, "viewer");

  const adminish = mod.publicView({ ...legacy, scopes: ["admin", "read", "trade"] });
  assert.equal(adminish.role, "admin");
});
