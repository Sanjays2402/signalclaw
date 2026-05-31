// node --experimental-strip-types --test tests/networkPolicy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-netpol-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "networkPolicyStore.ts"));
const {
  getPolicy,
  updatePolicy,
  decideAllowed,
  isLoopback,
  MAX_CIDRS,
  _resetCache,
} = mod;

function reqWithIp(ip) {
  return new Request("http://x/", {
    headers: ip ? { "x-forwarded-for": ip } : {},
  });
}

test("default policy is disabled with no cidrs", async () => {
  const p = await getPolicy();
  assert.equal(p.enabled, false);
  assert.deepEqual(p.cidrs, []);
});

test("disabled policy always allows", () => {
  const p = { enabled: false, cidrs: [], updated_at: null, updated_by: null };
  const d = decideAllowed(reqWithIp("8.8.8.8"), p);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "policy-disabled");
});

test("refuses to enable with empty allowlist", async () => {
  const r = await updatePolicy({ enabled: true, cidrs: [], actor: "test" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "empty_allowlist");
});

test("rejects invalid cidr", async () => {
  const r = await updatePolicy({
    enabled: false,
    cidrs: ["not-an-ip"],
    actor: "test",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_cidr");
});

test("rejects non-array cidrs", async () => {
  const r = await updatePolicy({
    enabled: false,
    cidrs: "10.0.0.0/8",
    actor: "test",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_type");
});

test("enforcing policy blocks unlisted IPs, allows listed, allows loopback", async () => {
  _resetCache();
  const r = await updatePolicy({
    enabled: true,
    cidrs: ["203.0.113.0/24", "2001:db8::/32"],
    actor: "test",
  });
  assert.equal(r.ok, true);
  assert.equal(r.policy.enabled, true);
  assert.deepEqual(r.policy.cidrs, ["203.0.113.0/24", "2001:db8::/32"]);
  assert.equal(r.before.enabled, false);

  const p = await getPolicy();
  // listed v4
  let d = decideAllowed(reqWithIp("203.0.113.42"), p);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "matched");
  // unlisted v4
  d = decideAllowed(reqWithIp("198.51.100.1"), p);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "not-matched");
  // listed v6
  d = decideAllowed(reqWithIp("2001:db8::1"), p);
  assert.equal(d.allowed, true);
  // loopback always allowed
  d = decideAllowed(reqWithIp("127.0.0.1"), p);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "loopback");
  d = decideAllowed(reqWithIp("::1"), p);
  assert.equal(d.allowed, true);
  // no ip when enforcing -> deny
  d = decideAllowed(reqWithIp(null), p);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "no-ip");
});

test("isLoopback handles canonical forms", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("8.8.8.8"), false);
});

test("MAX_CIDRS exported", () => {
  assert.equal(typeof MAX_CIDRS, "number");
  assert.ok(MAX_CIDRS >= 16);
});
