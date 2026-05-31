// node --experimental-strip-types --test tests/egressPolicy.test.mjs
//
// Verifies the outbound webhook egress policy:
//   - default-deny on private/loopback/link-local/multicast destinations
//   - cloud metadata host (169.254.169.254) is blocked
//   - allow_private toggle bypasses the blocklist
//   - non-empty CIDR allowlist requires EVERY resolved IP to match
//   - DNS resolver test-seam works for hostnames (rebind defense)
//   - createWebhook + deliverOne both refuse a blocked destination
//   - delivery-time policy check produces a recorded "egress_blocked:" attempt
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-egress-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const egress = await import(path.join(repoRoot, "lib", "egressPolicy.ts"));
const webhooks = await import(path.join(repoRoot, "lib", "webhookStore.ts"));

const resolveTo = (addrs) => async (_host) => addrs;

test("rejects non-http(s) scheme", async () => {
  const policy = await egress.getPolicy();
  const r = await egress.evaluateUrl("file:///etc/passwd", policy);
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_scheme");
});

test("rejects URLs with userinfo", async () => {
  const policy = await egress.getPolicy();
  const r = await egress.evaluateUrl("https://attacker@example.com/", policy, {
    resolve: resolveTo(["93.184.216.34"]),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "userinfo");
});

test("blocks loopback IPv4 literal by default", async () => {
  const policy = await egress.getPolicy();
  const r = await egress.evaluateUrl("http://127.0.0.1:9000/hook", policy);
  assert.equal(r.ok, false);
  assert.equal(r.code, "private_destination");
});

test("blocks RFC1918 IPv4 literal by default", async () => {
  const policy = await egress.getPolicy();
  for (const u of [
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.20.0.1/",
  ]) {
    const r = await egress.evaluateUrl(u, policy);
    assert.equal(r.ok, false, `expected block for ${u}`);
    assert.equal(r.code, "private_destination");
  }
});

test("blocks cloud metadata link-local 169.254.169.254", async () => {
  const policy = await egress.getPolicy();
  const r = await egress.evaluateUrl("http://169.254.169.254/latest/meta-data/", policy);
  assert.equal(r.ok, false);
  assert.equal(r.code, "private_destination");
});

test("blocks IPv6 loopback and link-local", async () => {
  const policy = await egress.getPolicy();
  for (const u of ["http://[::1]/", "http://[fe80::1]/", "http://[fc00::1]/"]) {
    const r = await egress.evaluateUrl(u, policy);
    assert.equal(r.ok, false, `expected block for ${u}`);
    assert.equal(r.code, "private_destination");
  }
});

test("blocks hostname that resolves to a private address (DNS rebind)", async () => {
  const policy = await egress.getPolicy();
  // Caller passes a perfectly innocent-looking hostname; resolver returns
  // an RFC1918 address. Must still be refused.
  const r = await egress.evaluateUrl("https://hooks.example.com/x", policy, {
    resolve: resolveTo(["10.1.2.3"]),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "private_destination");
});

test("blocks when ANY resolved address is private (mixed answer)", async () => {
  const policy = await egress.getPolicy();
  const r = await egress.evaluateUrl("https://mixed.example.com/", policy, {
    resolve: resolveTo(["93.184.216.34", "127.0.0.1"]),
  });
  assert.equal(r.ok, false);
});

test("public destination passes when allowlist is empty", async () => {
  const policy = await egress.getPolicy();
  const r = await egress.evaluateUrl("https://hooks.example.com/", policy, {
    resolve: resolveTo(["93.184.216.34"]),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.resolved, ["93.184.216.34"]);
});

test("allow_private bypasses the blocklist", async () => {
  await egress.setPolicy({ allow_private: true, cidrs: [] }, "test-actor");
  const policy = await egress.getPolicy();
  const r = await egress.evaluateUrl("http://127.0.0.1:9000/", policy);
  assert.equal(r.ok, true);
  // restore
  await egress.setPolicy({ allow_private: false, cidrs: [] }, "test-actor");
});

test("non-empty allowlist forces every resolved IP to match", async () => {
  await egress.setPolicy(
    { allow_private: false, cidrs: ["93.184.216.0/24"] },
    "test-actor",
  );
  const policy = await egress.getPolicy();
  const inAllow = await egress.evaluateUrl("https://ok.example.com/", policy, {
    resolve: resolveTo(["93.184.216.34"]),
  });
  assert.equal(inAllow.ok, true);
  const outOfAllow = await egress.evaluateUrl("https://nope.example.com/", policy, {
    resolve: resolveTo(["8.8.8.8"]),
  });
  assert.equal(outOfAllow.ok, false);
  assert.equal(outOfAllow.code, "not_in_allowlist");
  await egress.setPolicy({ allow_private: false, cidrs: [] }, "test-actor");
});

test("setPolicy rejects garbage CIDR entries", async () => {
  const out = await egress.setPolicy(
    { allow_private: false, cidrs: ["not-a-cidr"] },
    "x",
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad_cidr");
});

test("createWebhook refuses a private destination", async () => {
  await webhooks._resetForTests();
  const r = await webhooks.createWebhook(
    { url: "http://127.0.0.1/hook", events: ["entered"] },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "private_destination");
});

test("createWebhook refuses a hostname that resolves private", async () => {
  await webhooks._resetForTests();
  const r = await webhooks.createWebhook(
    { url: "https://intranet.example.com/hook", events: ["entered"] },
    { resolve: resolveTo(["10.0.0.5"]) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "private_destination");
});

test("createWebhook accepts a public destination and records the subscription", async () => {
  await webhooks._resetForTests();
  const r = await webhooks.createWebhook(
    { url: "https://ok.example.com/hook", events: ["entered"] },
    { resolve: resolveTo(["93.184.216.34"]) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.webhook.url, "https://ok.example.com/hook");
});

test("dispatchEvents records an egress_blocked attempt without calling fetch", async () => {
  await webhooks._resetForTests();
  // Bypass createWebhook validation by storing a sub directly via fetch-mock.
  // Easiest path: create with a public address, then have the delivery-time
  // resolver flip to a private one (DNS rebind simulation).
  const created = await webhooks.createWebhook(
    { url: "https://flippy.example.com/hook", events: ["entered"] },
    { resolve: resolveTo(["93.184.216.34"]) },
  );
  assert.equal(created.ok, true);
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { status: 200, text: async () => "" };
  };
  const out = await webhooks.dispatchEvents(
    [
      {
        kind: "entered",
        ticker: "AAPL",
        as_of: "2026-05-31",
        new_label: "bull",
      },
    ],
    { fetchImpl, resolve: resolveTo(["10.0.0.5"]) },
  );
  assert.equal(fetchCalls, 0, "fetch must not be called for blocked egress");
  assert.equal(out.deliveries.length, 1);
  const att = out.deliveries[0];
  assert.equal(att.status, null);
  assert.match(att.error || "", /^egress_blocked:private_destination:/);
  assert.equal(att.attempt, 0);
});
