// node --experimental-strip-types --test tests/whoami.test.mjs
//
// Tests the auth surface that GET /api/v1/whoami relies on. The route itself
// is a thin wrapper around keyStore.authenticate + extractKey, so we exercise
// those with synthetic Request objects shaped exactly like the route sees.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-whoami-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));

function makeReq(headers = {}) {
  return new Request("http://localhost/api/v1/whoami", { headers });
}

test("whoami auth: missing header yields no key", async () => {
  const secret = ks.extractKey(makeReq());
  const key = await ks.authenticate(secret);
  assert.equal(secret, "");
  assert.equal(key, null);
});

test("whoami auth: unknown bearer rejected", async () => {
  const req = makeReq({ authorization: "Bearer sc_live_bogus" });
  const secret = ks.extractKey(req);
  assert.equal(secret, "sc_live_bogus");
  const key = await ks.authenticate(secret);
  assert.equal(key, null);
});

test("whoami auth: valid bearer resolves to minted key, hash never surfaces", async () => {
  const { secret, key: created } = await ks.createKey({
    label: "test",
    scopes: ["read"],
  });
  const req = makeReq({ authorization: `Bearer ${secret}` });
  const key = await ks.authenticate(ks.extractKey(req));
  assert.ok(key);
  assert.equal(key.id, created.id);
  assert.equal(key.label, "test");
  assert.deepEqual(key.scopes, ["read"]);
  const pub = ks.publicView(key);
  assert.equal("hash" in pub, false);
});

test("whoami auth: x-api-key header is accepted equivalently", async () => {
  const { secret } = await ks.createKey({ label: "via-x", scopes: ["read"] });
  const req = makeReq({ "x-api-key": secret });
  const key = await ks.authenticate(ks.extractKey(req));
  assert.ok(key);
  assert.equal(key.label, "via-x");
});

test("whoami auth: revoked key is rejected", async () => {
  const { secret, key: created } = await ks.createKey({
    label: "doomed",
    scopes: ["read"],
  });
  await ks.revokeKey(created.id);
  const req = makeReq({ authorization: `Bearer ${secret}` });
  const key = await ks.authenticate(ks.extractKey(req));
  assert.equal(key, null);
});
