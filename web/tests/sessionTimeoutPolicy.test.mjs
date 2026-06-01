// node --experimental-strip-types --test tests/sessionTimeoutPolicy.test.mjs
//
// Proves the session idle + absolute timeout policy actually rejects
// stale cookies through verifySessionCookie, not just in a unit
// helper. Touches disk like every other registry test.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-sess-to-"));
process.chdir(tmpRoot);
delete process.env.SIGNALCLAW_ADMIN_KEY;
process.env.SIGNALCLAW_SSO_SESSION_KEY = "z".repeat(48);

const repoRoot = path.resolve(import.meta.dirname, "..");
const session = await import(path.join(repoRoot, "lib", "ssoSession.ts"));
const registry = await import(path.join(repoRoot, "lib", "ssoSessionRegistry.ts"));
const policyMod = await import(path.join(repoRoot, "lib", "sessionTimeoutPolicy.ts"));

async function freshState() {
  registry._resetForTests();
  policyMod._resetForTests();
  // Drain any in-flight fire-and-forget flushes from previous tests
  // before nuking the directory, so we do not race a tmp+rename.
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 5; i++) {
    try { await fs.rm(path.join(tmpRoot, ".data"), { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 20)); }
  }
}

test("decideTimeout pure helper: idle, absolute, off", () => {
  const policy = {
    enforce: true, idle_timeout_s: 600, absolute_timeout_s: 3600,
    updated_at: null, updated_by: null,
  };
  // Fresh session, recently seen -> ok
  assert.equal(policyMod.decideTimeout(policy, { iat: 1000, last_seen_at: 1500, now: 1600 }), null);
  // Idle: last_seen_at 700s ago, idle limit 600s -> reject
  const idle = policyMod.decideTimeout(policy, { iat: 1000, last_seen_at: 1000, now: 1700 });
  assert.deepEqual(idle, { reason: "idle-timeout" });
  // Absolute: iat 4000s ago, recent activity -> still reject
  const abs = policyMod.decideTimeout(policy, { iat: 1000, last_seen_at: 4999, now: 5000 });
  assert.deepEqual(abs, { reason: "absolute-timeout" });
  // Enforce off -> no rejection regardless
  const off = { ...policy, enforce: false };
  assert.equal(policyMod.decideTimeout(off, { iat: 0, last_seen_at: 0, now: 9_999_999 }), null);
});

test("updatePolicy validates bounds and persists", async () => {
  await freshState();
  const bad = await policyMod.updatePolicy({ idle_timeout_s: 1, actor: "test" });
  assert.equal(bad.ok, false);
  const ok = await policyMod.updatePolicy({
    enforce: true, idle_timeout_s: 120, absolute_timeout_s: 600, actor: "test",
  });
  assert.equal(ok.ok, true);
  policyMod._resetForTests();
  const read = await policyMod.getPolicy();
  assert.equal(read.enforce, true);
  assert.equal(read.idle_timeout_s, 120);
  assert.equal(read.absolute_timeout_s, 600);
  assert.equal(read.updated_by, "test");
});

test("verifySessionCookie rejects an idle-expired session end-to-end", async () => {
  await freshState();
  const cookie = await session.mintSessionCookie({
    sub: "u1", email: "alice@example.com", iss: "https://idp.example.com",
  });
  // First verify -> ok, also registers liveness
  const first = await session.verifySessionCookie(cookie, { liveness: { ip: "10.0.0.1" } });
  assert.ok(first, "fresh cookie verifies");

  // Enforce a 60s idle window.
  const up = await policyMod.updatePolicy({
    enforce: true, idle_timeout_s: 60, absolute_timeout_s: 0, actor: "admin",
  });
  assert.equal(up.ok, true);

  // Backdate the registry row's last_seen_at and iat so the next
  // verify is unambiguously past the idle window.
  const all = await registry.listSessions({ include_revoked: true });
  const jti = all.sessions.find((s) => s.email === "alice@example.com").jti;
  const row = await registry.getSession(jti);
  assert.ok(row);
  const store = await registry._storeForTests();
  const rec = store.records.find((r) => r.jti === jti);
  rec.last_seen_at = Math.floor(Date.now() / 1000) - 3600; // 1h idle
  rec.iat = Math.floor(Date.now() / 1000) - 7200;

  const after = await session.verifySessionCookie(cookie);
  assert.equal(after, null, "idle-expired cookie must not verify");

  // Force the fire-and-forget flush from checkSession to drain before
  // the next test's `fs.rm(.data)` so we do not race the rename.
  await registry.revokeBySession(jti, { actor: "test", reason: "settle" });

  const post = await registry.getSession(jti);
  assert.ok(post.revoked_at, "row is marked revoked");
  assert.equal(post.revoked_reason, "idle-timeout");
  assert.equal(post.revoked_by, "session-timeout-policy");
});

test("absolute-timeout rejects even an actively used session", async () => {
  await freshState();
  const cookie = await session.mintSessionCookie({
    sub: "u2", email: "bob@example.com", iss: "https://idp.example.com",
  });
  assert.ok(await session.verifySessionCookie(cookie, { liveness: { ip: "10.0.0.2" } }));

  await policyMod.updatePolicy({
    enforce: true, idle_timeout_s: 0, absolute_timeout_s: 300, actor: "admin",
  });

  const all = await registry.listSessions();
  const jti = all.sessions.find((s) => s.email === "bob@example.com").jti;
  // Absolute timeout is computed against the cookie's `iat` (the IdP
  // issuance time), not the registry row. Drive checkSession directly
  // with a backdated iat so the policy fires deterministically.
  const fakeIat = Math.floor(Date.now() / 1000) - 3600;
  const fakeExp = Math.floor(Date.now() / 1000) + 3600;
  const status = await registry.checkSession(jti, fakeIat, fakeExp, { ip: "10.0.0.2" });
  assert.equal(status.revoked, true);
  assert.equal(status.reason, "absolute-timeout");

  const post = await registry.getSession(jti);
  assert.equal(post.revoked_reason, "absolute-timeout");
  // And subsequent verifySessionCookie now also rejects (row is revoked).
  assert.equal(await session.verifySessionCookie(cookie), null);
});
