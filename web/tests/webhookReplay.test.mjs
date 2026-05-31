// Tests the webhook delivery replay path.
// Run: node --experimental-strip-types --test tests/webhookReplay.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-webhook-replay-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "webhookStore.ts"));

test("failed delivery can be replayed and succeed", async () => {
  await mod._resetForTests();
  const r = await mod.createWebhook({
    url: "https://example.com/hook",
    events: ["entered"],
    tickers: ["SPY"],
  });
  assert.equal(r.ok, true);

  let callCount = 0;
  let lastBody = null;
  const failingFetch = async (_url, init) => {
    callCount += 1;
    lastBody = init.body;
    return { status: 500 };
  };
  await mod.dispatchEvents(
    [{ kind: "entered", ticker: "SPY", as_of: "2024-01-02" }],
    { fetchImpl: failingFetch, maxAttempts: 1, backoffMs: 0, timeoutMs: 100 },
  );
  const log = await mod.listDeliveries(10);
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 500);
  assert.ok(Array.isArray(log[0].events));
  assert.equal(log[0].events.length, 1);
  assert.equal(log[0].events[0].ticker, "SPY");

  const okFetch = async (_url, init) => {
    callCount += 1;
    lastBody = init.body;
    return { status: 200 };
  };
  const replay = await mod.replayDelivery(log[0].id, {
    fetchImpl: okFetch,
    maxAttempts: 1,
    backoffMs: 0,
    timeoutMs: 100,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.delivery.status, 200);
  assert.equal(replay.delivery.replay_of, log[0].id);

  // Body of the replayed call should carry the same event payload.
  const parsed = JSON.parse(lastBody);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].ticker, "SPY");
  assert.equal(parsed.events[0].as_of, "2024-01-02");

  const log2 = await mod.listDeliveries(10);
  assert.equal(log2.length, 2);
  // Newest first
  assert.equal(log2[0].replay_of, log[0].id);

  // Filter status=ok returns only the replay; failed returns only original.
  const okOnly = await mod.listDeliveries(10, undefined, "ok");
  assert.equal(okOnly.length, 1);
  assert.equal(okOnly[0].status, 200);
  const failedOnly = await mod.listDeliveries(10, undefined, "failed");
  assert.equal(failedOnly.length, 1);
  assert.equal(failedOnly[0].status, 500);

  assert.ok(callCount >= 2);
});

test("replay of missing delivery returns not_found", async () => {
  await mod._resetForTests();
  const r = await mod.replayDelivery("does-not-exist");
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_found");
});

test("replay of legacy delivery without events returns no_events", async () => {
  await mod._resetForTests();
  // Hand-craft a log entry missing the events field (legacy).
  const dataDir = path.join(process.cwd(), ".data");
  await fs.mkdir(dataDir, { recursive: true });
  const sub = await mod.createWebhook({ url: "https://example.com/hook" });
  assert.equal(sub.ok, true);
  const subId = (await mod.listWebhooks())[0].id;
  const legacy = [
    {
      id: "legacy-1",
      subscription_id: subId,
      url: "https://example.com/hook",
      status: 500,
      error: "boom",
      attempt: 1,
      delivered_at: new Date().toISOString(),
      signature: null,
      event_count: 1,
    },
  ];
  await fs.writeFile(path.join(dataDir, "webhook-deliveries.json"), JSON.stringify(legacy), "utf8");
  const r = await mod.replayDelivery("legacy-1");
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_events");
});
