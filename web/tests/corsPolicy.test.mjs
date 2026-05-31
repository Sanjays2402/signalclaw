// node --experimental-strip-types --test tests/corsPolicy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "corsPolicy.ts"));
const {
  parseOriginList,
  getPolicy,
  decide,
  applyCors,
  ALLOW_HEADERS,
  ALLOW_METHODS,
  EXPOSE_HEADERS,
  MAX_AGE,
} = mod;

test("parseOriginList trims, dedupes, drops malformed", () => {
  const out = parseOriginList(
    " https://a.example.com , https://a.example.com,https://b.example.com,not-a-url, ftp://x.example.com , https://c.example.com ",
  );
  assert.deepEqual(out, [
    "https://a.example.com",
    "https://b.example.com",
    "https://c.example.com",
  ]);
});

test("parseOriginList handles empty and undefined", () => {
  assert.deepEqual(parseOriginList(undefined), []);
  assert.deepEqual(parseOriginList(""), []);
  assert.deepEqual(parseOriginList("   "), []);
});

test("getPolicy: local mode (no admin key) enables loopback default", () => {
  const p = getPolicy({});
  assert.equal(p.production, false);
  assert.equal(p.loopback_default, true);
  assert.deepEqual(p.origins, []);
});

test("getPolicy: production posture without allowlist denies browser", () => {
  const p = getPolicy({ SIGNALCLAW_ADMIN_KEY: "x" });
  assert.equal(p.production, true);
  assert.equal(p.loopback_default, false);
  assert.deepEqual(p.origins, []);
});

test("getPolicy: explicit allowlist parsed", () => {
  const p = getPolicy({
    SIGNALCLAW_ADMIN_KEY: "x",
    SIGNALCLAW_CORS_ORIGINS:
      "https://app.example.com, https://admin.example.com",
  });
  assert.equal(p.production, true);
  assert.equal(p.loopback_default, false);
  assert.deepEqual(p.origins, [
    "https://app.example.com",
    "https://admin.example.com",
  ]);
});

test("decide: allowlist match echoes exact origin", () => {
  const p = getPolicy({
    SIGNALCLAW_ADMIN_KEY: "x",
    SIGNALCLAW_CORS_ORIGINS: "https://app.example.com",
  });
  const d = decide("https://app.example.com", p);
  assert.equal(d.allowOrigin, "https://app.example.com");
  assert.equal(d.reason, "allowlist");
});

test("decide: production posture, unlisted origin denied", () => {
  const p = getPolicy({
    SIGNALCLAW_ADMIN_KEY: "x",
    SIGNALCLAW_CORS_ORIGINS: "https://app.example.com",
  });
  const d = decide("https://evil.example.com", p);
  assert.equal(d.allowOrigin, null);
  assert.equal(d.reason, "denied");
});

test("decide: production posture with empty allowlist denies even loopback", () => {
  const p = getPolicy({ SIGNALCLAW_ADMIN_KEY: "x" });
  const d = decide("http://localhost:3000", p);
  assert.equal(d.allowOrigin, null);
  assert.equal(d.reason, "denied");
});

test("decide: local mode admits localhost loopback only", () => {
  const p = getPolicy({});
  assert.equal(decide("http://localhost:3000", p).reason, "loopback-default");
  assert.equal(decide("http://127.0.0.1:7430", p).reason, "loopback-default");
  assert.equal(decide("http://localhost", p).reason, "loopback-default");
  assert.equal(decide("https://example.com", p).reason, "denied");
  // No https://localhost — loopback default is http only by design.
  assert.equal(decide("https://localhost:7430", p).reason, "denied");
});

test("decide: never reflects suffix matches", () => {
  const p = getPolicy({
    SIGNALCLAW_ADMIN_KEY: "x",
    SIGNALCLAW_CORS_ORIGINS: "https://app.example.com",
  });
  assert.equal(decide("https://evil.app.example.com", p).reason, "denied");
  assert.equal(decide("https://app.example.com.attacker.io", p).reason, "denied");
});

test("decide: missing or malformed origin", () => {
  const p = getPolicy({});
  assert.equal(decide(null, p).reason, "no-origin");
  assert.equal(decide("", p).reason, "no-origin");
  assert.equal(decide("javascript:alert(1)", p).reason, "denied");
  assert.equal(decide("file:///etc/passwd", p).reason, "denied");
  assert.equal(decide("http://", p).reason, "denied");
  assert.equal(decide("a".repeat(400), p).reason, "denied");
});

test("applyCors: simple response with allow sets credentials + expose", () => {
  const h = new Headers();
  applyCors(
    h,
    { allowOrigin: "https://app.example.com", reason: "allowlist" },
    false,
  );
  assert.equal(h.get("Access-Control-Allow-Origin"), "https://app.example.com");
  assert.equal(h.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(h.get("Access-Control-Expose-Headers"), EXPOSE_HEADERS);
  assert.equal(h.get("Vary"), "Origin");
  // Preflight-only headers must NOT be set on simple responses.
  assert.equal(h.get("Access-Control-Allow-Methods"), null);
  assert.equal(h.get("Access-Control-Allow-Headers"), null);
  assert.equal(h.get("Access-Control-Max-Age"), null);
});

test("applyCors: preflight sets methods, headers, max-age", () => {
  const h = new Headers();
  applyCors(
    h,
    { allowOrigin: "https://app.example.com", reason: "allowlist" },
    true,
  );
  assert.equal(h.get("Access-Control-Allow-Methods"), ALLOW_METHODS);
  assert.equal(h.get("Access-Control-Allow-Headers"), ALLOW_HEADERS);
  assert.equal(h.get("Access-Control-Max-Age"), MAX_AGE);
  // Vary picks up the preflight-specific entries too.
  const vary = h.get("Vary") || "";
  assert.ok(vary.includes("Origin"));
  assert.ok(vary.includes("Access-Control-Request-Method"));
  assert.ok(vary.includes("Access-Control-Request-Headers"));
});

test("applyCors: denied decision sets Vary but no ACAO", () => {
  const h = new Headers();
  applyCors(h, { allowOrigin: null, reason: "denied" }, false);
  assert.equal(h.get("Access-Control-Allow-Origin"), null);
  assert.equal(h.get("Access-Control-Allow-Credentials"), null);
  assert.equal(h.get("Vary"), "Origin");
});

test("applyCors: appends to existing Vary header instead of overwriting", () => {
  const h = new Headers();
  h.set("Vary", "Accept-Encoding");
  applyCors(
    h,
    { allowOrigin: "https://app.example.com", reason: "allowlist" },
    false,
  );
  const parts = (h.get("Vary") || "").split(",").map((s) => s.trim());
  assert.ok(parts.includes("Accept-Encoding"));
  assert.ok(parts.includes("Origin"));
});

test("source: middleware imports corsPolicy and short-circuits OPTIONS", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    path.join(repoRoot, "middleware.ts"),
    "utf8",
  );
  assert.ok(
    src.includes('from "@/lib/corsPolicy"'),
    "middleware must import the shared CORS policy",
  );
  assert.ok(
    /req\.method\s*===\s*"OPTIONS"/.test(src),
    "middleware must short-circuit OPTIONS preflight",
  );
  assert.ok(
    /applyCors\(/.test(src),
    "middleware must call applyCors so allowlisted origins receive ACAO",
  );
});

test("source: /api/admin/cors readout is admin-gated and read-only", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    path.join(repoRoot, "app/api/admin/cors/route.ts"),
    "utf8",
  );
  assert.ok(
    src.includes('from "@/lib/adminGuard"'),
    "admin CORS route must use shared admin gate",
  );
  assert.ok(/export async function GET/.test(src));
  // No write verbs: the allowlist is env-driven on purpose.
  assert.ok(!/export async function (POST|PUT|PATCH|DELETE)/.test(src));
});
