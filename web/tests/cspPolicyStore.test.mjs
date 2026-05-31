// node --experimental-strip-types --test tests/cspPolicyStore.test.mjs
//
// Verifies the CSP policy store:
//   - default policy is "off" when no env is set
//   - canonicalizeHosts rejects garbage and caps the list
//   - update persists and returns before/after
//   - buildCspHeader includes report-uri only when reporting is on
//   - cspHeaderName matches the chosen mode
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-csp-"));
process.chdir(tmpRoot);
delete process.env.SIGNALCLAW_CSP_MODE;
delete process.env.SIGNALCLAW_CSP_EXTRA_HOSTS;

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "cspPolicyStore.ts"));

test("default policy is off with no env override", async () => {
  const p = await mod.getCspPolicy();
  assert.equal(p.mode, "off");
  assert.deepEqual(p.extra_hosts, []);
  assert.equal(p.reporting_enabled, true);
});

test("canonicalizeHosts dedupes and validates", () => {
  const out = mod.canonicalizeHosts([
    "cdn.example.com",
    "CDN.example.com",
    "*.intercom.io",
    "'self'",
    "https://api.stripe.com",
  ]);
  assert.deepEqual(out, [
    "cdn.example.com",
    "*.intercom.io",
    "'self'",
    "https://api.stripe.com",
  ]);
});

test("canonicalizeHosts rejects garbage", () => {
  assert.throws(() => mod.canonicalizeHosts(["javascript:alert(1)"]), /invalid CSP source/);
  assert.throws(() => mod.canonicalizeHosts(["<script>"]), /invalid CSP source/);
  assert.throws(() => mod.canonicalizeHosts(["http://exa mple.com"]), /invalid CSP source/);
});

test("canonicalizeHosts caps at MAX_HOSTS", () => {
  const many = Array.from({ length: mod.MAX_HOSTS + 5 }, (_, i) => `h${i}.example.com`);
  assert.throws(() => mod.canonicalizeHosts(many), /too many hosts/);
});

test("updateCspPolicy persists and returns before/after", async () => {
  const r1 = await mod.updateCspPolicy({
    mode: "report",
    extra_hosts: ["cdn.example.com"],
    reporting_enabled: true,
    actor: "key-1",
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.policy.mode, "report");
  assert.equal(r1.before.mode, "off");

  const r2 = await mod.updateCspPolicy({
    mode: "enforce",
    extra_hosts: ["cdn.example.com", "*.intercom.io"],
    reporting_enabled: false,
    actor: "key-2",
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.before.mode, "report");
  assert.equal(r2.policy.mode, "enforce");
  assert.equal(r2.policy.reporting_enabled, false);
  assert.equal(r2.policy.updated_by, "key-2");
});

test("updateCspPolicy rejects bad mode", async () => {
  const r = await mod.updateCspPolicy({
    // @ts-ignore intentional bad input
    mode: "loose",
    extra_hosts: [],
    reporting_enabled: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_mode");
});

test("updateCspPolicy surfaces bad_host", async () => {
  const r = await mod.updateCspPolicy({
    mode: "enforce",
    extra_hosts: ["javascript:evil"],
    reporting_enabled: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_host");
});

test("buildCspHeader composes directives and report-uri", () => {
  const h1 = mod.buildCspHeader({
    mode: "enforce",
    extra_hosts: ["cdn.example.com"],
    reporting_enabled: true,
    updated_at: null,
    updated_by: null,
  });
  assert.match(h1, /default-src 'self'/);
  assert.match(h1, /script-src 'self' cdn\.example\.com/);
  assert.match(h1, /report-uri \/api\/csp-report/);

  const h2 = mod.buildCspHeader({
    mode: "report",
    extra_hosts: [],
    reporting_enabled: false,
    updated_at: null,
    updated_by: null,
  });
  assert.doesNotMatch(h2, /report-uri/);
});

test("cspHeaderName matches mode", () => {
  const base = { extra_hosts: [], reporting_enabled: true, updated_at: null, updated_by: null };
  assert.equal(mod.cspHeaderName({ ...base, mode: "off" }), null);
  assert.equal(mod.cspHeaderName({ ...base, mode: "report" }), "Content-Security-Policy-Report-Only");
  assert.equal(mod.cspHeaderName({ ...base, mode: "enforce" }), "Content-Security-Policy");
});
