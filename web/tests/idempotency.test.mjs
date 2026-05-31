// node --experimental-strip-types --test tests/idempotency.test.mjs
//
// Real-state tests for the Idempotency-Key wrapper. Exercises the store and
// the withIdempotency middleware against a temp .data directory. Proves:
//
//   * missing header is a pass-through
//   * malformed header returns 400 bad_idempotency_key
//   * first call runs the handler and caches a 2xx response
//   * second call with the same body returns the cached body and adds
//     `Idempotent-Replayed: true` without re-running the handler
//   * second call with a different body returns 409 idempotency_conflict
//     and does not run the handler
//   * 4xx responses are not cached (so the client can fix and retry)
//   * per-key isolation: another key reusing the same header value is a miss
//
// Side-effects are constrained to a per-test temp dir so audit + idempotency
// writes don't pollute the dev install.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-idemp-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "idempotencyStore.ts"));
const mw = await import(path.join(repoRoot, "lib", "idempotency.ts"));

function makeKey(id = "k_test") {
  return {
    id,
    label: "test",
    prefix: "sc_live_",
    hash: "x".repeat(64),
    scopes: ["trade"],
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked: false,
  };
}

function req(method, url, body, headers = {}) {
  const init = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(url, init);
}

test("validateHeader: accepts sane values, rejects garbage", () => {
  assert.equal(store.validateHeader("abc-123_ok").ok, true);
  assert.equal(store.validateHeader("").ok, false);
  assert.equal(store.validateHeader(null).ok, false);
  assert.equal(store.validateHeader("has space").ok, false);
  assert.equal(store.validateHeader("x".repeat(300)).ok, false);
});

test("withIdempotency: no header is a pass-through", async () => {
  const key = makeKey("k_passthru");
  const r = req("POST", "http://x/v1/alerts", { ticker: "AAA" });
  const raw = await r.clone().text();
  let calls = 0;
  const res = await mw.withIdempotency(r, key, "/v1/alerts", raw, async ({ body }) => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, body }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.equal(res.headers.get("Idempotent-Replayed"), null);
});

test("withIdempotency: bad header shape returns 400 without running handler", async () => {
  const key = makeKey("k_bad");
  const r = req("POST", "http://x/v1/alerts", { ticker: "AAA" }, { "Idempotency-Key": "bad space" });
  const raw = await r.clone().text();
  let calls = 0;
  const res = await mw.withIdempotency(r, key, "/v1/alerts", raw, async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  });
  assert.equal(res.status, 400);
  assert.equal(calls, 0);
  const body = await res.json();
  assert.equal(body.error.code, "bad_idempotency_key");
});

test("withIdempotency: replay returns cached body and does not re-run handler", async () => {
  const key = makeKey("k_replay");
  const headers = { "Idempotency-Key": "abc-001" };

  let calls = 0;
  const handler = async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "alert_42", run: calls }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  const r1 = req("POST", "http://x/v1/alerts", { ticker: "AAA" }, headers);
  const raw1 = await r1.clone().text();
  const res1 = await mw.withIdempotency(r1, key, "/v1/alerts", raw1, handler);
  assert.equal(res1.status, 201);
  assert.equal(res1.headers.get("Idempotency-Key"), "abc-001");
  assert.equal(res1.headers.get("Idempotent-Replayed"), "false");
  const body1 = await res1.json();
  assert.equal(body1.id, "alert_42");
  assert.equal(body1.run, 1);

  const r2 = req("POST", "http://x/v1/alerts", { ticker: "AAA" }, headers);
  const raw2 = await r2.clone().text();
  const res2 = await mw.withIdempotency(r2, key, "/v1/alerts", raw2, handler);
  assert.equal(res2.status, 201);
  assert.equal(res2.headers.get("Idempotent-Replayed"), "true");
  const body2 = await res2.json();
  assert.equal(body2.run, 1, "handler must not run again on replay");
  assert.equal(calls, 1);
});

test("withIdempotency: same key, different body returns 409 conflict", async () => {
  const key = makeKey("k_conflict");
  const headers = { "Idempotency-Key": "abc-002" };
  let calls = 0;
  const handler = async ({ body }) => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, ticker: body.ticker }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  const r1 = req("POST", "http://x/v1/watchlist", { ticker: "BBB" }, headers);
  await mw.withIdempotency(r1, key, "/v1/watchlist", await r1.clone().text(), handler);

  const r2 = req("POST", "http://x/v1/watchlist", { ticker: "CCC" }, headers);
  const res2 = await mw.withIdempotency(r2, key, "/v1/watchlist", await r2.clone().text(), handler);
  assert.equal(res2.status, 409);
  assert.equal(calls, 1, "handler must not run on conflict");
  const body = await res2.json();
  assert.equal(body.error.code, "idempotency_conflict");
  assert.ok(body.error.first_seen_at);
});

test("withIdempotency: non-2xx responses are not cached", async () => {
  const key = makeKey("k_no_cache_4xx");
  const headers = { "Idempotency-Key": "abc-003" };
  let calls = 0;
  const handler = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: "bad_ticker", message: "x" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  const r1 = req("POST", "http://x/v1/watchlist", { ticker: "?" }, headers);
  const res1 = await mw.withIdempotency(r1, key, "/v1/watchlist", await r1.clone().text(), handler);
  assert.equal(res1.status, 400);

  const r2 = req("POST", "http://x/v1/watchlist", { ticker: "?" }, headers);
  const res2 = await mw.withIdempotency(r2, key, "/v1/watchlist", await r2.clone().text(), handler);
  assert.equal(res2.status, 400);
  assert.equal(res2.headers.get("Idempotent-Replayed"), "false");
  assert.equal(calls, 2, "handler must run again because the 400 was not cached");
});

test("withIdempotency: keys are per api-key (cross-key isolation)", async () => {
  const headers = { "Idempotency-Key": "abc-004" };
  const handler = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const kA = makeKey("k_alpha");
  const kB = makeKey("k_bravo");

  const rA = req("POST", "http://x/v1/watchlist", { ticker: "AAA" }, headers);
  await mw.withIdempotency(rA, kA, "/v1/watchlist", await rA.clone().text(), handler);

  // Different api key, same header value, different body: must be a miss, not
  // a conflict. Proves the (key_id, header) compound scoping is real.
  const rB = req("POST", "http://x/v1/watchlist", { ticker: "BBB" }, headers);
  const resB = await mw.withIdempotency(rB, kB, "/v1/watchlist", await rB.clone().text(), handler);
  assert.equal(resB.status, 200);
  assert.equal(resB.headers.get("Idempotent-Replayed"), "false");

  const listA = await store.listForKey("k_alpha");
  const listB = await store.listForKey("k_bravo");
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 1);
  assert.notEqual(listA[0].fingerprint, listB[0].fingerprint);
});
