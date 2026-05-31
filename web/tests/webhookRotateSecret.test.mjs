// Tests webhook signing-secret rotation with grace-window dual-signing.
// Run: node --experimental-strip-types --test tests/webhookRotateSecret.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-webhook-rot-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "webhookStore.ts"));

function parseSig(header) {
  // "t=<ts>,v1=<hex>[,v1=<hex>]"
  const parts = header.split(",");
  const t = parts[0].split("=")[1];
  const macs = parts.slice(1).map((p) => p.split("=")[1]);
  return { t, macs };
}

function verify(secret, body, t, expectedHex) {
  const mac = crypto.createHmac("sha256", secret);
  mac.update(`${t}.${body}`);
  return mac.digest("hex") === expectedHex;
}

test("rotate mints new secret and keeps previous active for grace window", async () => {
  await mod._resetForTests();
  const created = await mod.createWebhook({
    url: "https://example.com/hook",
    events: ["entered"],
    tickers: ["SPY"],
    secret: "original-secret",
  });
  assert.equal(created.ok, true);
  const id = created.webhook.id;

  const r = await mod.rotateWebhookSecret(id, { graceSeconds: 60 });
  assert.equal(r.ok, true);
  assert.notEqual(r.secret, "original-secret");
  assert.equal(r.webhook.secret, r.secret);
  assert.equal(r.webhook.previous_secret, "original-secret");
  assert.ok(r.webhook.previous_secret_expires_at);
  assert.ok(r.webhook.secret_rotated_at);

  // dispatch should produce a signature header carrying BOTH the new and
  // the previous secret macs while we're inside the grace window.
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, text: async () => "ok" };
  };
  await mod.dispatchEvents(
    [{ kind: "entered", ticker: "SPY", as_of: "2026-01-01" }],
    { fetchImpl: fakeFetch, maxAttempts: 1 },
  );
  assert.equal(calls.length, 1);
  const sig = calls[0].init.headers["x-signalclaw-signature"];
  assert.ok(sig, "signature header present");
  const { t, macs } = parseSig(sig);
  assert.equal(macs.length, 2, "both new and previous secret signatures sent");
  const body = calls[0].init.body;
  assert.ok(verify(r.secret, body, t, macs[0]), "new secret mac verifies");
  assert.ok(verify("original-secret", body, t, macs[1]), "previous secret mac verifies");
});

test("zero grace = immediate cutover, no previous secret kept", async () => {
  await mod._resetForTests();
  const created = await mod.createWebhook({
    url: "https://example.com/hook",
    secret: "old",
  });
  const r = await mod.rotateWebhookSecret(created.webhook.id, { graceSeconds: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.webhook.previous_secret, null);
  assert.equal(r.webhook.previous_secret_expires_at, null);

  const calls = [];
  await mod.dispatchEvents(
    [{ kind: "entered", ticker: "SPY", as_of: "2026-01-01" }],
    {
      fetchImpl: async (url, init) => {
        calls.push(init);
        return { status: 200, text: async () => "ok" };
      },
      maxAttempts: 1,
    },
  );
  const { macs } = parseSig(calls[0].headers["x-signalclaw-signature"]);
  assert.equal(macs.length, 1, "only the new secret signs after cutover");
});

test("rotating again before grace expires replaces the previous secret", async () => {
  await mod._resetForTests();
  const created = await mod.createWebhook({ url: "https://example.com/hook", secret: "s1" });
  const r1 = await mod.rotateWebhookSecret(created.webhook.id, { graceSeconds: 60 });
  assert.equal(r1.webhook.previous_secret, "s1");
  const r2 = await mod.rotateWebhookSecret(created.webhook.id, { graceSeconds: 60 });
  assert.equal(r2.webhook.previous_secret, r1.secret, "prev now equals the just-replaced secret");
  assert.notEqual(r2.secret, r1.secret);
});

test("invalid grace_seconds is rejected", async () => {
  await mod._resetForTests();
  const created = await mod.createWebhook({ url: "https://example.com/hook" });
  const r = await mod.rotateWebhookSecret(created.webhook.id, { graceSeconds: -5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_grace");

  const r2 = await mod.rotateWebhookSecret(created.webhook.id, { graceSeconds: 7 * 24 * 3600 + 1 });
  assert.equal(r2.ok, false);
});

test("rotate on missing webhook returns not_found", async () => {
  await mod._resetForTests();
  const r = await mod.rotateWebhookSecret("does-not-exist", { graceSeconds: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_found");
});
