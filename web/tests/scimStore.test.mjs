// SCIM 2.0 store: auth + lifecycle correctness.
// Run with: node --experimental-strip-types --test tests/scimStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-scim-"));
process.chdir(tmpRoot);
await fs.mkdir(path.join(tmpRoot, ".data"), { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const scim = await import(path.join(repoRoot, "lib", "scimStore.ts"));

test("verifyToken rejects when no token configured", async () => {
  assert.equal(await scim.verifyToken("anything"), false);
  assert.equal(await scim.verifyToken(null), false);
  const s = await scim.getTokenStatus();
  assert.equal(s.configured, false);
});

test("rotateToken issues a usable bearer; revoke invalidates it", async () => {
  const out = await scim.rotateToken();
  assert.ok(out.token.startsWith("scim_live_"));
  assert.equal(out.configured, true);
  assert.equal(await scim.verifyToken(out.token), true);
  // Wrong token rejected.
  assert.equal(await scim.verifyToken("scim_live_" + "0".repeat(48)), false);
  // last_used_at stamped.
  const s = await scim.getTokenStatus();
  assert.ok(s.last_used_at);
  await scim.revokeToken();
  assert.equal(await scim.verifyToken(out.token), false);
});

test("rotateToken invalidates the previous token (cross-credential isolation)", async () => {
  const a = await scim.rotateToken();
  assert.equal(await scim.verifyToken(a.token), true);
  const b = await scim.rotateToken();
  // Old token must not authenticate after rotation.
  assert.equal(await scim.verifyToken(a.token), false);
  assert.equal(await scim.verifyToken(b.token), true);
});

test("createUser validates email and rejects duplicates", async () => {
  const u = await scim.createUser({ userName: "Alice@Example.com", givenName: "A" });
  assert.equal(u.userName, "alice@example.com");
  assert.equal(u.active, true);
  await assert.rejects(
    () => scim.createUser({ userName: "alice@example.com" }),
    /already exists/,
  );
  await assert.rejects(
    () => scim.createUser({ userName: "not-an-email" }),
    /invalid userName/,
  );
});

test("patch with Azure AD shape (no path) toggles active", async () => {
  const u = await scim.createUser({ userName: "bob@example.com" });
  const patched = await scim.patchUser(u.id, [
    { op: "Replace", value: { active: false } },
  ]);
  assert.ok(patched);
  assert.equal(patched.active, false);
});

test("patch with Okta shape (path active) toggles active for string + bool", async () => {
  const u = await scim.createUser({ userName: "carol@example.com" });
  const a = await scim.patchUser(u.id, [{ op: "replace", path: "active", value: "False" }]);
  assert.equal(a.active, false);
  const b = await scim.patchUser(u.id, [{ op: "replace", path: "active", value: true }]);
  assert.equal(b.active, true);
});

test("replaceUser refuses to collide userName with another row", async () => {
  const u1 = await scim.createUser({ userName: "dave@example.com" });
  const u2 = await scim.createUser({ userName: "erin@example.com" });
  await assert.rejects(
    () => scim.replaceUser(u2.id, { userName: "dave@example.com" }),
    /already exists/,
  );
});

test("deleteUser removes and returns true; second delete returns false", async () => {
  const u = await scim.createUser({ userName: "frank@example.com" });
  assert.equal(await scim.deleteUser(u.id), true);
  assert.equal(await scim.deleteUser(u.id), false);
  assert.equal(await scim.getUser(u.id), null);
});

test("listUsers filter supports userName eq", async () => {
  await scim.createUser({ userName: "grace@example.com" });
  await scim.createUser({ userName: "henry@example.com" });
  const got = await scim.listUsers('userName eq "grace@example.com"');
  assert.equal(got.length, 1);
  assert.equal(got[0].userName, "grace@example.com");
});

test("parseScimUserBody pulls userName from primary email when missing", () => {
  const input = scim.parseScimUserBody({
    emails: [
      { value: "fallback@example.com", primary: true, type: "work" },
      { value: "other@example.com" },
    ],
    name: { givenName: "F", familyName: "B" },
  });
  assert.equal(input.userName, "fallback@example.com");
  assert.equal(input.givenName, "F");
});
