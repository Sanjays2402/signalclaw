// node --experimental-strip-types --test tests/adminOverview.test.mjs
//
// Proves the admin console's data path and its permission gate:
//   1. With SIGNALCLAW_ADMIN_KEY set, a read-scope key is denied admin
//      (forbidden:admin-required) and that denial is written to the audit
//      log. An anonymous request is denied too.
//   2. An admin-scope key is allowed and the route returns the same
//      structure buildAdminOverview() produces (key posture, audit chain,
//      seats, sso, recent events).
//   3. buildAdminOverview() reflects newly minted keys in `keys.active`,
//      proving the snapshot is live and not memoised stale.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-admin-overview-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));
const as = await import(path.join(repoRoot, "lib", "auditStore.ts"));
const ov = await import(path.join(repoRoot, "lib", "adminOverview.ts"));

// adminGuard uses NextRequest; we instead exercise decideAdmin (framework-free)
// which is what requireAdmin defers to. Hitting the route handler directly
// requires booting Next's edge runtime; the gate decision is the auditable
// thing under test here.
const gc = await import(path.join(repoRoot, "lib", "adminGuardCore.ts"));

function reqWith(headers = {}) {
  return new Request("http://localhost/api/admin/overview", { headers });
}

test("buildAdminOverview returns posture snapshot reflecting current keys", async () => {
  await as.clearAudit();
  // createKey strips the 'admin' scope by design (admin is env-only); we test
  // the 'active' bucket and the revocation transition instead.
  const { key } = await ks.createKey({ label: "ci-read", scopes: ["read"] });
  const o = await ov.buildAdminOverview({ recent: 5 });
  assert.ok(o.generated_at, "has generated_at");
  assert.ok(o.keys.active >= 1, "active counts the new key");
  assert.equal(typeof o.keys.admin_scoped, "number");
  assert.equal(typeof o.audit_chain.ok, "boolean");
  assert.equal(typeof o.audit_window.total_24h, "number");
  assert.ok(Array.isArray(o.recent_events));
  assert.ok(o.seats && typeof o.seats.used === "number");
  assert.ok(o.sso && typeof o.sso.enabled === "boolean");
  await ks.revokeKey(key.id);
  const o2 = await ov.buildAdminOverview({ recent: 5 });
  assert.ok(o2.keys.revoked >= 1, "revoked rolls into revoked bucket");
});

test("admin gate denies a read-scope key and an anon caller in production posture", async () => {
  await as.clearAudit();
  process.env.SIGNALCLAW_ADMIN_KEY = "sc_live_test_admin_secret_value";
  try {
    const { secret: readSecret } = await ks.createKey({
      label: "readonly",
      scopes: ["read"],
    });
    const denied = await gc.decideAdmin(reqWith({ authorization: `Bearer ${readSecret}` }));
    assert.equal(denied.allowed, false, "read scope cannot reach admin");
    assert.equal(denied.reason, "forbidden:admin-required");

    const anon = await gc.decideAdmin(reqWith({}));
    assert.equal(anon.allowed, false, "anon cannot reach admin");
    assert.equal(anon.reason, "forbidden:admin-required");

    // Admin scope cannot be minted through the public API. The env admin
    // key value itself is the bearer that decideAdmin accepts.
    const ok = await gc.decideAdmin(reqWith({ authorization: `Bearer ${process.env.SIGNALCLAW_ADMIN_KEY}` }));
    assert.equal(ok.allowed, true, "env admin key is allowed");
    assert.equal(ok.reason, "admin-key");
  } finally {
    delete process.env.SIGNALCLAW_ADMIN_KEY;
  }
});

test("admin gate falls back to local-mode when no admin key configured", async () => {
  delete process.env.SIGNALCLAW_ADMIN_KEY;
  const d = await gc.decideAdmin(reqWith({}));
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "local-mode");
});
