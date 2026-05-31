// Webhook management surface must require admin gating, matching the rest
// of the /api/admin/* posture. Local mode (no SIGNALCLAW_ADMIN_KEY env var)
// still allows the call but writes a `local-mode` audit line; production
// posture rejects unauthenticated callers with 403 before any side effect.
//
// This test pins two things so a future refactor can't silently regress
// SSRF / abuse exposure on the webhook surface:
//   1. `requireAdmin` returns a 403 for unauthenticated requests when
//      SIGNALCLAW_ADMIN_KEY is set, and passes through in local mode.
//   2. Every webhook management route file imports and calls
//      `requireAdmin`. (We can't cheaply boot Next route handlers in this
//      test runner, so we assert on the source contract instead, which is
//      what a reviewer would also check.)
//
// Run: node --experimental-strip-types --test tests/webhookAdminGuard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-wh-guard-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const { decideAdmin } = await import(path.join(repoRoot, "lib", "adminGuardCore.ts"));
const keyStore = await import(path.join(repoRoot, "lib", "keyStore.ts"));

function bearerReq(secret) {
  return new Request("http://x/", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

test("local mode lets unauthenticated callers through with a local-mode reason", async () => {
  delete process.env.SIGNALCLAW_ADMIN_KEY;
  const d = await decideAdmin(bearerReq(null));
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "local-mode");
  assert.equal(d.key, null);
});

test("production posture rejects unauthenticated callers", async () => {
  process.env.SIGNALCLAW_ADMIN_KEY = "test-bootstrap";
  const d = await decideAdmin(bearerReq(null));
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "forbidden:admin-required");
  delete process.env.SIGNALCLAW_ADMIN_KEY;
});

test("production posture rejects an unknown bearer", async () => {
  process.env.SIGNALCLAW_ADMIN_KEY = "test-bootstrap";
  const d = await decideAdmin(bearerReq("sc_live_does_not_exist"));
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "forbidden:admin-required");
  delete process.env.SIGNALCLAW_ADMIN_KEY;
});

test("production posture rejects a real key without admin scope (proves permission denial)", async () => {
  process.env.SIGNALCLAW_ADMIN_KEY = "test-bootstrap";
  const minted = await keyStore.createKey({ label: "reader", scopes: ["read"] });
  const d = await decideAdmin(bearerReq(minted.secret));
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "forbidden:admin-required");
  assert.ok(d.key, "key should authenticate, just not be authorised");
  assert.deepEqual(d.key.scopes, ["read"]);
  delete process.env.SIGNALCLAW_ADMIN_KEY;
});

test("production posture admits the env admin secret", async () => {
  process.env.SIGNALCLAW_ADMIN_KEY = "test-bootstrap";
  const d = await decideAdmin(bearerReq("test-bootstrap"));
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "admin-key");
  assert.ok(d.key && d.key.scopes.includes("admin"));
  delete process.env.SIGNALCLAW_ADMIN_KEY;
});

test("every webhook management route gates via requireAdmin", async () => {
  const routes = [
    "app/api/webhooks/route.ts",
    "app/api/webhooks/[id]/route.ts",
    "app/api/webhooks/[id]/rotate-secret/route.ts",
    "app/api/webhooks/deliveries/route.ts",
    "app/api/webhooks/deliveries/[id]/replay/route.ts",
    "app/api/webhooks/fire/latest/route.ts",
  ];
  for (const rel of routes) {
    const abs = path.join(repoRoot, rel);
    const src = await fs.readFile(abs, "utf8");
    assert.match(
      src,
      /from\s+["']@\/lib\/adminGuard["']/,
      `${rel} must import requireAdmin from @/lib/adminGuard`,
    );
    assert.match(
      src,
      /requireAdmin\s*\(/,
      `${rel} must call requireAdmin(...)`,
    );
    // And every exported handler must early-return on denied.
    const handlers = [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(/g)];
    assert.ok(handlers.length > 0, `${rel} should export at least one HTTP handler`);
    assert.match(
      src,
      /if\s*\(\s*denied\s*\)\s*return\s+denied/,
      `${rel} must short-circuit on denied`,
    );
  }
});
