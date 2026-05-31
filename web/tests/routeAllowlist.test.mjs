// node --experimental-strip-types --test tests/routeAllowlist.test.mjs
//
// Proves the per-API-key route allowlist:
//   - canonicalizer rejects non-v1 paths, bad chars, and over-large lists,
//     and deduplicates / normalizes trailing slashes and "*" wildcards
//   - isRouteAllowed permits prefix matches and rejects everything else
//   - empty / missing allowlist means "any v1 path"
//   - persistence round-trips through keyStore.setKeyRouteAllowlist and is
//     reflected in publicView so the admin UI sees the change
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-routeallow-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const rl = await import(path.join(repoRoot, "lib", "routeAllowlist.ts"));
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));

test("canonicalizeRouteList: normalizes trailing slash and wildcard", () => {
  const out = rl.canonicalizeRouteList([
    "/api/v1/runs/",
    "/api/v1/runs/*",
    "/api/v1/watchlist",
  ]);
  assert.deepEqual(out, ["/api/v1/runs", "/api/v1/watchlist"]);
});

test("canonicalizeRouteList: rejects non-v1 paths", () => {
  assert.throws(
    () => rl.canonicalizeRouteList(["/api/admin/keys"]),
    /must start with \/api\/v1\//,
  );
  assert.throws(
    () => rl.canonicalizeRouteList(["/v1/runs"]),
    /must start with \/api\/v1\//,
  );
});

test("canonicalizeRouteList: rejects bad characters and shapes", () => {
  assert.throws(() => rl.canonicalizeRouteList(["/api/v1/runs?x=1"]), /invalid characters/);
  assert.throws(() => rl.canonicalizeRouteList(["/api/v1//runs"]), /empty path segment/);
  assert.throws(() => rl.canonicalizeRouteList("not-an-array"), /must be an array/);
  assert.throws(() => rl.canonicalizeRouteList([123]), /must be a string/);
});

test("canonicalizeRouteList: enforces max entries", () => {
  const many = Array.from(
    { length: rl.MAX_ROUTE_ENTRIES + 1 },
    (_, i) => `/api/v1/r${i}`,
  );
  assert.throws(
    () => rl.canonicalizeRouteList(many),
    /maximum of/,
  );
});

test("isRouteAllowed: empty allowlist allows any path", () => {
  assert.equal(rl.isRouteAllowed("/api/v1/runs", []), true);
  assert.equal(rl.isRouteAllowed("/api/v1/anything", null), true);
  assert.equal(rl.isRouteAllowed("/api/v1/anything", undefined), true);
});

test("isRouteAllowed: prefix matches reach nested paths", () => {
  const list = rl.canonicalizeRouteList([
    "/api/v1/runs",
    "/api/v1/watchlist",
  ]);
  assert.equal(rl.isRouteAllowed("/api/v1/runs", list), true);
  assert.equal(rl.isRouteAllowed("/api/v1/runs/abc/export", list), true);
  assert.equal(rl.isRouteAllowed("/api/v1/watchlist/AAPL", list), true);
});

test("isRouteAllowed: cross-route requests are denied", () => {
  const list = rl.canonicalizeRouteList(["/api/v1/runs"]);
  // Critical least-privilege check: a key scoped to runs MUST NOT reach
  // alerts, audit, or any other v1 resource. This is the property an
  // enterprise procurement reviewer will explicitly test for.
  assert.equal(rl.isRouteAllowed("/api/v1/alerts", list), false);
  assert.equal(rl.isRouteAllowed("/api/v1/audit", list), false);
  assert.equal(rl.isRouteAllowed("/api/v1/runs-extra", list), false); // no false prefix
  assert.equal(rl.isRouteAllowed("/api/v1/whoami", list), false);
});

test("keyStore round-trips route_allowlist through publicView", async () => {
  const minted = await ks.createKey({ label: "ra-test", scopes: ["read"] });
  assert.ok(minted.key.id);
  const updated = await ks.setKeyRouteAllowlist(minted.key.id, [
    "/api/v1/runs",
    "/api/v1/watchlist",
  ]);
  assert.ok(updated);
  const view = ks.publicView(updated);
  assert.deepEqual(view.route_allowlist, ["/api/v1/runs", "/api/v1/watchlist"]);

  const cleared = await ks.setKeyRouteAllowlist(minted.key.id, []);
  assert.deepEqual(ks.publicView(cleared).route_allowlist, []);
});

test("keyStore refuses to narrow env-admin", async () => {
  const out = await ks.setKeyRouteAllowlist("env-admin", ["/api/v1/runs"]);
  assert.equal(out, null);
});
