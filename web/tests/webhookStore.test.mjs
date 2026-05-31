// Tests the webhook store: create/list/delete, HMAC signing, delivery retry, and dispatch matching.
// Run: node --experimental-strip-types --test tests/webhookStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-webhook-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "webhookStore.ts"));

test("create + list + delete roundtrip", async () => {
  await mod._resetForTests();
  const created = await mod.createWebhook({
    url: "https://example.com/hook",
    events: ["entered", "exited"],
    tickers: ["aapl", "MSFT"],
    secret: "shh",
  });
  assert.equal(created.ok, true);
  const list = await mod.listWebhooks();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].tickers, ["AAPL", "MSFT"]);
  assert.deepEqual(list[0].events.sort(), ["entered", "exited"]);
  assert.equal(list[0].enabled, true);

  const removed = await mod.deleteWebhook(list[0].id);
  assert.equal(removed, true);
  assert.equal((await mod.listWebhooks()).length, 0);
});

test("rejects invalid url", async () => {
  await mod._resetForTests();
  const r = await mod.createWebhook({ url: "ftp://nope" });
  assert.equal(r.ok, false);
});

test("dispatch signs body, matches filters, retries on 500", async () => {
  await mod._resetForTests();
  const r = await mod.createWebhook({
    url: "https://example.com/hook",
    events: ["entered"],
    tickers: ["SPY"],
    secret: "topsecret",
  });
  assert.equal(r.ok, true);

  // Mismatched ticker is also created and should NOT be called.
  const r2 = await mod.createWebhook({
    url: "https://other.example.com/hook",
    events: ["entered"],
    tickers: ["QQQ"],
  });
  assert.equal(r2.ok, true);

  const calls = [];
  let firstCall = true;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("example.com/hook") && firstCall) {
      firstCall = false;
      return { status: 503, text: async () => "boom" };
    }
    return { status: 200, text: async () => "ok" };
  };

  const result = await mod.dispatchEvents(
    [{ kind: "entered", ticker: "SPY", as_of: "2024-01-02", new_label: "bull" }],
    { fetchImpl, backoffMs: 1, maxAttempts: 3 },
  );

  // Only the SPY-matching subscription got called; retried once after 503.
  assert.equal(calls.length, 2);
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].status, 200);
  assert.equal(result.deliveries[0].attempt, 2);

  // Verify HMAC signature shape and validity.
  const sig = calls[0].init.headers["x-signalclaw-signature"];
  const ts = calls[0].init.headers["x-signalclaw-timestamp"];
  assert.match(sig, /^t=\d+,v1=[a-f0-9]{64}$/);
  const mac = crypto.createHmac("sha256", "topsecret").update(`${ts}.${calls[0].init.body}`).digest("hex");
  assert.ok(sig.endsWith(mac));

  // Delivery log appended.
  const log = await mod.listDeliveries();
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 200);
});

test("disabled subscription is skipped", async () => {
  await mod._resetForTests();
  const r = await mod.createWebhook({
    url: "https://example.com/hook",
    enabled: false,
  });
  assert.equal(r.ok, true);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, text: async () => "ok" };
  };
  const result = await mod.dispatchEvents(
    [{ kind: "entered", ticker: "SPY", as_of: "2024-01-02" }],
    { fetchImpl, backoffMs: 1 },
  );
  assert.equal(calls.length, 0);
  assert.equal(result.deliveries.length, 0);
});
