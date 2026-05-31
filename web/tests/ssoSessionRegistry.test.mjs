// node --experimental-strip-types --test tests/ssoSessionRegistry.test.mjs
//
// Verifies the server-side SSO session revocation registry:
//   * a freshly-minted session round-trips through verifySessionCookie
//   * a revoked-by-jti session fails verification
//   * a revoked-by-email kill drops every other session for that email
//   * a bump-epoch invalidates every active session (force-logout all)
//   * an unknown jti is rejected (no forged-but-HMAC-valid cookie can pass)
//   * listSessions hides revoked rows by default and surfaces them with
//     include_revoked=true; ?email= filter narrows to one address
//   * liveness updates last_seen_at on a successful verify
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-sso-reg-"));
process.chdir(tmpRoot);
delete process.env.SIGNALCLAW_ADMIN_KEY;
process.env.SIGNALCLAW_SSO_SESSION_KEY = "y".repeat(48);

const repoRoot = path.resolve(import.meta.dirname, "..");
const session = await import(path.join(repoRoot, "lib", "ssoSession.ts"));
const registry = await import(path.join(repoRoot, "lib", "ssoSessionRegistry.ts"));

async function freshState() {
  registry._resetForTests();
  await fs.rm(path.join(tmpRoot, ".data"), { recursive: true, force: true });
}

test("minted session round-trips and registers a jti", async () => {
  await freshState();
  const cookie = await session.mintSessionCookie({
    sub: "u1", email: "alice@example.com", iss: "https://idp.example.com",
  });
  const out = await session.verifySessionCookie(cookie);
  assert.ok(out, "valid cookie verifies");
  assert.equal(out.email, "alice@example.com");
  assert.ok(out.jti && out.jti.length >= 8, "jti is embedded");

  const list = await registry.listSessions();
  assert.equal(list.active_count, 1);
  assert.equal(list.sessions[0].email, "alice@example.com");
});

test("revokeBySession kills exactly one cookie", async () => {
  await freshState();
  const c1 = await session.mintSessionCookie({ sub: "u1", email: "a@x.com", iss: "i" });
  const c2 = await session.mintSessionCookie({ sub: "u1", email: "a@x.com", iss: "i" });
  const s1 = await session.verifySessionCookie(c1);
  const s2 = await session.verifySessionCookie(c2);
  assert.ok(s1 && s2);
  assert.notEqual(s1.jti, s2.jti);

  const row = await registry.revokeBySession(s1.jti, { actor: "admin-key-id", reason: "lost-laptop" });
  assert.ok(row);
  assert.ok(row.revoked_at);
  assert.equal(row.revoked_reason, "lost-laptop");

  assert.equal(await session.verifySessionCookie(c1), null, "revoked session rejected");
  const stillOk = await session.verifySessionCookie(c2);
  assert.ok(stillOk, "sibling session still valid");
});

test("revokeByEmail offboards every session for one address", async () => {
  await freshState();
  const a1 = await session.mintSessionCookie({ sub: "alice", email: "alice@corp.com", iss: "i" });
  const a2 = await session.mintSessionCookie({ sub: "alice", email: "alice@corp.com", iss: "i" });
  const b1 = await session.mintSessionCookie({ sub: "bob",   email: "bob@corp.com",   iss: "i" });

  // Mixed-case input must still match (registry lowercases on write).
  const n = await registry.revokeByEmail("Alice@Corp.com", { actor: "hr-bot", reason: "offboarded" });
  assert.equal(n, 2, "both alice sessions revoked");

  assert.equal(await session.verifySessionCookie(a1), null);
  assert.equal(await session.verifySessionCookie(a2), null);
  const bob = await session.verifySessionCookie(b1);
  assert.ok(bob, "bob untouched");

  // Idempotent: a second call revokes zero.
  const n2 = await registry.revokeByEmail("alice@corp.com", { actor: "hr-bot" });
  assert.equal(n2, 0);
});

test("bumpEpoch invalidates every existing session at once", async () => {
  await freshState();
  const c1 = await session.mintSessionCookie({ sub: "u1", email: "a@x.com", iss: "i" });
  const c2 = await session.mintSessionCookie({ sub: "u2", email: "b@x.com", iss: "i" });
  assert.ok(await session.verifySessionCookie(c1));
  assert.ok(await session.verifySessionCookie(c2));

  // Tick clock forward so iat <= epoch comparison fires deterministically.
  await new Promise((r) => setTimeout(r, 1100));
  const out = await registry.bumpEpoch({ actor: "incident-responder", reason: "key-leak" });
  assert.equal(out.revoked, 2);
  assert.ok(out.epoch > 0);

  assert.equal(await session.verifySessionCookie(c1), null);
  assert.equal(await session.verifySessionCookie(c2), null);

  // New sessions minted strictly AFTER the bump epoch second are valid.
  await new Promise((r) => setTimeout(r, 1100));
  const c3 = await session.mintSessionCookie({ sub: "u3", email: "c@x.com", iss: "i" });
  const ok = await session.verifySessionCookie(c3);
  assert.ok(ok, "post-bump session works");
});

test("cookie without a known jti is rejected even with valid HMAC", async () => {
  await freshState();
  // Hand-mint a legacy-shaped cookie (no jti) using the same key path.
  const crypto = await import("node:crypto");
  const key = process.env.SIGNALCLAW_SSO_SESSION_KEY;
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, sub: "x", email: "x@y.com", iss: "i", iat: now, exp: now + 3600 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", Buffer.from(key, "utf-8")).update(body).digest().toString("base64url");
  const legacy = `${body}.${sig}`;

  // Default verify consults the registry and rejects unknown jti.
  assert.equal(await session.verifySessionCookie(legacy), null);

  // skipRegistry escape hatch (used by logout) lets the payload through.
  const raw = await session.verifySessionCookie(legacy, { skipRegistry: true });
  assert.ok(raw);
  assert.equal(raw.email, "x@y.com");
});

test("listSessions hides revoked by default and exposes them on request", async () => {
  await freshState();
  const c1 = await session.mintSessionCookie({ sub: "u1", email: "a@x.com", iss: "i" });
  const c2 = await session.mintSessionCookie({ sub: "u2", email: "b@x.com", iss: "i" });
  const s1 = await session.verifySessionCookie(c1);
  await registry.revokeBySession(s1.jti, { actor: "admin", reason: "test" });

  const active = await registry.listSessions();
  assert.equal(active.active_count, 1);
  assert.equal(active.sessions.length, 1);
  assert.equal(active.sessions[0].email, "b@x.com");

  const all = await registry.listSessions({ include_revoked: true });
  assert.equal(all.sessions.length, 2);
  // c2 still valid.
  assert.ok(await session.verifySessionCookie(c2));
});

test("listSessions filters to a single email", async () => {
  await freshState();
  await session.mintSessionCookie({ sub: "alice", email: "alice@corp.com", iss: "i" });
  await session.mintSessionCookie({ sub: "alice", email: "alice@corp.com", iss: "i" });
  await session.mintSessionCookie({ sub: "bob",   email: "bob@corp.com",   iss: "i" });

  const onlyAlice = await registry.listSessions({ email: "alice@corp.com" });
  assert.equal(onlyAlice.sessions.length, 2);
  for (const s of onlyAlice.sessions) assert.equal(s.email, "alice@corp.com");
  // active_count is global, not filtered \u2014 it answers "is anyone signed in",
  // not "how many rows did this query return".
  assert.equal(onlyAlice.active_count, 3);

  // Case-insensitive match.
  const upper = await registry.listSessions({ email: "ALICE@corp.com" });
  assert.equal(upper.sessions.length, 2);
});

test("liveness updates last_seen_at on a successful verify", async () => {
  await freshState();
  const cookie = await session.mintSessionCookie({
    sub: "u", email: "live@x.com", iss: "i",
  });
  // Sanity: first verify with no liveness leaves last_seen_at null.
  await session.verifySessionCookie(cookie);
  let list = await registry.listSessions();
  assert.equal(list.sessions[0].last_seen_at, null);

  // Verify with liveness writes last_seen_at + ip hash. Flush is async,
  // so wait a tick.
  const out = await session.verifySessionCookie(cookie, { liveness: { ip: "203.0.113.7" } });
  assert.ok(out);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  list = await registry.listSessions();
  assert.ok(list.sessions[0].last_seen_at, "last_seen_at populated");
  assert.ok(list.sessions[0].last_seen_ip_hash, "last_seen_ip_hash populated");
  // Raw IP never persisted.
  for (const row of list.sessions) {
    assert.ok(!row.last_seen_ip_hash.includes("203.0.113.7"));
  }
});
