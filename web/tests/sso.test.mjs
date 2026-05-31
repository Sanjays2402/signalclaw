// node --experimental-strip-types --test tests/sso.test.mjs
//
// Verifies the SSO session + ID-token plumbing without booting Next:
//   - HMAC-signed session cookies round-trip
//   - Tampered cookies are rejected
//   - Tx cookies enforce TTL + signature
//   - verifyIdToken rejects bad signature, bad nonce, bad issuer, bad aud, expired
//   - decideAdmin accepts a valid SSO session when policy.enabled and the
//     email domain is allowlisted; denies a wrong-domain session
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-sso-"));
process.chdir(tmpRoot);
delete process.env.SIGNALCLAW_ADMIN_KEY;
process.env.SIGNALCLAW_SSO_SESSION_KEY = "x".repeat(48);

const repoRoot = path.resolve(import.meta.dirname, "..");
const session = await import(path.join(repoRoot, "lib", "ssoSession.ts"));
const policyMod = await import(path.join(repoRoot, "lib", "ssoPolicyStore.ts"));
const adminCore = await import(path.join(repoRoot, "lib", "adminGuardCore.ts"));

test("session cookie round-trip", async () => {
  const tok = await session.mintSessionCookie({
    sub: "user-1",
    email: "alice@example.com",
    iss: "https://idp.example.com",
  });
  const out = await session.verifySessionCookie(tok);
  assert.ok(out, "verifies");
  assert.equal(out.sub, "user-1");
  assert.equal(out.email, "alice@example.com");
  assert.equal(out.v, 1);
  assert.ok(out.exp > out.iat);
});

test("tampered session cookie is rejected", async () => {
  const tok = await session.mintSessionCookie({
    sub: "u", email: "a@b.com", iss: "https://i",
  });
  const [body, sig] = tok.split(".");
  // Flip a single base64url char in body.
  const tampered = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A") + "." + sig;
  const out = await session.verifySessionCookie(tampered);
  assert.equal(out, null);
});

test("tx cookie verifies and rejects garbage", async () => {
  const tx = await session.mintTxCookie({
    state: "s1", nonce: "n1", verifier: "v1", return_to: "/settings",
  });
  const ok = await session.verifyTxCookie(tx);
  assert.ok(ok);
  assert.equal(ok.state, "s1");
  assert.equal(await session.verifyTxCookie("garbage"), null);
  assert.equal(await session.verifyTxCookie(null), null);
  // Wrong-domain signature swap (session-signed body presented as tx).
  const tok = await session.mintSessionCookie({ sub: "u", email: "a@b.com", iss: "i" });
  assert.equal(await session.verifyTxCookie(tok), null);
});

test("PKCE pair is correct", () => {
  const p = session.generatePkce();
  const c = crypto.createHash("sha256").update(p.verifier).digest("base64url");
  assert.equal(c, p.challenge);
  assert.equal(p.method, "S256");
});

// ---- ID token verification with an in-memory RSA key ----------------------

async function makeIdToken(claims, kid = "test-key-1") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = { alg: "RS256", typ: "JWT", kid };
  const h64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = Buffer.from(`${h64}.${p64}`);
  const sig = crypto.sign("RSA-SHA256", data, privateKey).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { token: `${h64}.${p64}.${sig}`, jwk };
}

test("verifyIdToken accepts a well-formed token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { token, jwk } = await makeIdToken({
    iss: "https://idp.example.com",
    sub: "user-2",
    aud: "client-abc",
    exp: now + 300,
    iat: now,
    nonce: "the-nonce",
    email: "bob@example.com",
    email_verified: true,
  });
  const claims = await session.verifyIdToken(token, {
    issuer: "https://idp.example.com",
    audience: "client-abc",
    nonce: "the-nonce",
    jwks_uri: "https://unused.local/jwks",
    jwksOverride: { keys: [jwk] },
  });
  assert.equal(claims.sub, "user-2");
  assert.equal(claims.email, "bob@example.com");
});

test("verifyIdToken rejects wrong nonce, issuer, aud, and expired", async () => {
  const now = Math.floor(Date.now() / 1000);
  const baseClaims = {
    iss: "https://idp.example.com",
    sub: "u", aud: "client-abc",
    exp: now + 300, iat: now, nonce: "n",
  };
  const { token, jwk } = await makeIdToken(baseClaims);
  const base = {
    issuer: "https://idp.example.com",
    audience: "client-abc",
    nonce: "n",
    jwks_uri: "https://unused.local/jwks",
    jwksOverride: { keys: [jwk] },
  };
  await assert.rejects(
    () => session.verifyIdToken(token, { ...base, nonce: "other" }),
    /nonce mismatch/,
  );
  await assert.rejects(
    () => session.verifyIdToken(token, { ...base, issuer: "https://evil.example.com" }),
    /issuer mismatch/,
  );
  await assert.rejects(
    () => session.verifyIdToken(token, { ...base, audience: "other-client" }),
    /audience mismatch/,
  );
  const { token: exp } = await makeIdToken({ ...baseClaims, exp: now - 600, iat: now - 1200 });
  // Note: this uses a fresh keypair so it won't be in jwk above; build with its own jwk.
  const { token: exp2, jwk: jwk2 } = await makeIdToken({ ...baseClaims, exp: now - 600, iat: now - 1200 });
  await assert.rejects(
    () => session.verifyIdToken(exp2, { ...base, jwksOverride: { keys: [jwk2] } }),
    /expired/,
  );
});

test("verifyIdToken rejects tampered signature", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { token, jwk } = await makeIdToken({
    iss: "i", sub: "u", aud: "a", exp: now + 60, iat: now, nonce: "n",
  });
  const [h, p, s] = token.split(".");
  const tampered = `${h}.${p}.${s.slice(0, -2)}AA`;
  await assert.rejects(
    () => session.verifyIdToken(tampered, {
      issuer: "i", audience: "a", nonce: "n",
      jwks_uri: "https://unused.local/jwks", jwksOverride: { keys: [jwk] },
    }),
    /signature invalid|jwt/,
  );
});

// ---- adminGuardCore with SSO session ---------------------------------------

function makeReq({ cookie } = {}) {
  // Cookie is a forbidden request header in undici; build a Request-shaped
  // object that exposes the bits decideAdmin actually reads. This is what
  // the route handler effectively sees on the server side.
  const headers = new Map();
  if (cookie) headers.set("cookie", cookie);
  return {
    url: "https://app.example.com/api/admin/keys",
    headers: {
      get(name) { return headers.get(String(name).toLowerCase()) ?? null; },
    },
  };
}

test("decideAdmin accepts SSO session when policy enabled + domain allowed", async () => {
  await policyMod.updateSsoPolicy({
    enabled: true,
    issuer: "https://accounts.google.com",
    client_id: "client-x",
    client_secret: "secret-y",
    allowed_domains: ["example.com"],
    enforce: false,
    actor: "test",
  });
  const tok = await session.mintSessionCookie({
    sub: "u", email: "alice@example.com", iss: "https://accounts.google.com",
  });
  const req = makeReq({ cookie: `sc_sso=${encodeURIComponent(tok)}` });
  const d = await adminCore.decideAdmin(req);
  assert.equal(d.allowed, true);
  assert.equal(d.mode, "sso");
  assert.equal(d.reason, "sso-session");
});

test("decideAdmin denies SSO session whose email is outside allowed_domains", async () => {
  await policyMod.updateSsoPolicy({
    enabled: true,
    issuer: "https://accounts.google.com",
    client_id: "client-x",
    client_secret: "secret-y",
    allowed_domains: ["example.com"],
    enforce: true,
    actor: "test",
  });
  const tok = await session.mintSessionCookie({
    sub: "u", email: "intruder@evil.com", iss: "https://accounts.google.com",
  });
  const req = makeReq({ cookie: `sc_sso=${encodeURIComponent(tok)}` });
  const d = await adminCore.decideAdmin(req);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "forbidden:sso-domain");
});

test("decideAdmin without admin key and SSO enforce-on refuses anonymous", async () => {
  await policyMod.updateSsoPolicy({
    enabled: true,
    issuer: "https://accounts.google.com",
    client_id: "client-x",
    client_secret: "secret-y",
    allowed_domains: [],
    enforce: true,
    actor: "test",
  });
  delete process.env.SIGNALCLAW_ADMIN_KEY;
  const req = makeReq();
  const d = await adminCore.decideAdmin(req);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "forbidden:sso-required");
});

test("policy validation rejects bad issuer + bad domain", async () => {
  await assert.rejects(
    () => policyMod.updateSsoPolicy({ enabled: false, issuer: "http://insecure.example.com", actor: "t" }),
    /https/,
  );
  await assert.rejects(
    () => policyMod.updateSsoPolicy({ allowed_domains: ["not a domain"] }),
    /invalid domain/,
  );
  await assert.rejects(
    () => policyMod.updateSsoPolicy({ enabled: true, enforce: false, issuer: "https://i", client_id: "c", client_secret: null }),
    /required when enabled/,
  );
});
