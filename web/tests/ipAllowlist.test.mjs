// node --experimental-strip-types --test tests/ipAllowlist.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-ipallow-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ipMod = await import(path.join(repoRoot, "lib", "ipMatch.ts"));
const {
  parseCidr,
  ipMatchesAny,
  canonicalizeCidrList,
  normalizeIp,
  clientIpFromRequest,
} = ipMod;

test("canonicalizeCidrList: bare IPv4 becomes /32, dedupes, trims", () => {
  const out = canonicalizeCidrList([
    "203.0.113.5",
    "  10.0.0.0/8 ",
    "10.255.0.0/8", // same network as 10.0.0.0/8 after masking
  ]);
  assert.deepEqual(out, ["203.0.113.5/32", "10.0.0.0/8"]);
});

test("canonicalizeCidrList: bare IPv6 becomes /128, compressed form", () => {
  const out = canonicalizeCidrList(["2001:db8::1", "2001:db8::/32"]);
  assert.equal(out[0], "2001:db8::1/128");
  assert.equal(out[1], "2001:db8::/32");
});

test("canonicalizeCidrList: rejects garbage", () => {
  assert.throws(() => canonicalizeCidrList(["not-an-ip"]), /invalid CIDR/);
  assert.throws(() => canonicalizeCidrList(["10.0.0.0/40"]), /invalid CIDR/);
  assert.throws(() => canonicalizeCidrList(["256.0.0.0"]), /invalid CIDR/);
  assert.throws(() => canonicalizeCidrList("hi"), /must be an array/);
});

test("canonicalizeCidrList: enforces max entries", () => {
  const many = Array.from({ length: 65 }, (_, i) => `10.0.${i}.0/24`);
  assert.throws(() => canonicalizeCidrList(many), /maximum of 64/);
});

test("ipMatchesAny: IPv4 inside and outside the network", () => {
  const list = [parseCidr("10.0.0.0/8"), parseCidr("203.0.113.5/32")];
  assert.equal(ipMatchesAny("10.5.6.7", list), true);
  assert.equal(ipMatchesAny("203.0.113.5", list), true);
  assert.equal(ipMatchesAny("203.0.113.6", list), false);
  assert.equal(ipMatchesAny("8.8.8.8", list), false);
});

test("ipMatchesAny: IPv4-mapped IPv6 from a dual-stack socket still matches a v4 CIDR", () => {
  const list = [parseCidr("203.0.113.0/24")];
  assert.equal(normalizeIp("::ffff:203.0.113.42"), "203.0.113.42");
  assert.equal(ipMatchesAny("::ffff:203.0.113.42", list), true);
});

test("ipMatchesAny: IPv6 network match", () => {
  const list = [parseCidr("2001:db8::/32")];
  assert.equal(ipMatchesAny("2001:db8:1234::1", list), true);
  assert.equal(ipMatchesAny("2001:db9::1", list), false);
});

test("clientIpFromRequest: prefers leftmost x-forwarded-for", () => {
  const req = new Request("http://x.test/", {
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
  });
  assert.equal(clientIpFromRequest(req), "203.0.113.7");
});

// End-to-end: enforce a per-key allowlist using the real key store on disk
// and the pure policy decider that v1Guard wraps in a 403. Proves cross-key
// isolation: a key with an allowlist denies non-matching IPs, while a key
// with no allowlist (or with an empty one) lets any IP through.
test("per-key IP allowlist: denies non-matching source IPs and isolates keys", async () => {
  const keyStore = await import(path.join(repoRoot, "lib", "keyStore.ts"));
  // Inline the policy decision so the test does not pull in next/server
  // transitively. The same primitives are used by lib/keyIpPolicy.ts which
  // v1Guard wraps in a 403 + audit record.
  function decide(req, key) {
    const list = Array.isArray(key.ip_allowlist) ? key.ip_allowlist : [];
    if (list.length === 0) return { allowed: true };
    const parsed = list.map((c) => parseCidr(c)).filter(Boolean);
    if (parsed.length === 0) return { allowed: true };
    const ip = clientIpFromRequest(req);
    if (ip && ipMatchesAny(ip, parsed)) return { allowed: true };
    return { allowed: false, reason: ip ? `ip_not_allowed:${ip}` : "ip_not_allowed:unknown" };
  }

  const { key: fenced } = await keyStore.createKey({ label: "fenced", scopes: ["read"] });
  const { key: open } = await keyStore.createKey({ label: "open", scopes: ["read"] });

  const fencedUpdated = await keyStore.setKeyIpAllowlist(fenced.id, ["10.0.0.0/8"]);
  assert.ok(fencedUpdated, "setKeyIpAllowlist returns the updated key");
  assert.deepEqual(fencedUpdated.ip_allowlist, ["10.0.0.0/8"]);
  assert.deepEqual(open.ip_allowlist ?? [], [], "open key has no allowlist by default");

  const mkReq = (xff) =>
    new Request("http://x.test/v1/runs", {
      method: "GET",
      headers: xff ? { "x-forwarded-for": xff } : {},
    });

  const blocked = decide(mkReq("8.8.8.8"), fencedUpdated);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /^ip_not_allowed:8\.8\.8\.8$/);

  const ok = decide(mkReq("10.1.2.3"), fencedUpdated);
  assert.equal(ok.allowed, true);

  // Cross-key isolation: the same blocked IP still gets through on a
  // different key that has no allowlist. Proves policy is per-key, not
  // shared global state.
  const openOk = decide(mkReq("8.8.8.8"), open);
  assert.equal(openOk.allowed, true);

  const noXff = decide(mkReq(null), fencedUpdated);
  assert.equal(noXff.allowed, false);
  assert.equal(noXff.reason, "ip_not_allowed:unknown");

  const opened = await keyStore.setKeyIpAllowlist(fenced.id, []);
  const reopened = decide(mkReq("8.8.8.8"), opened);
  assert.equal(reopened.allowed, true);
});

