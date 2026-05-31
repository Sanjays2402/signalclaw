// node --experimental-strip-types --test tests/siemSinkStore.test.mjs
//
// Verifies the SIEM forwarder:
//   - validation rejects bad URL, weak secret, bad timeout, etc
//   - cannot enable without url+secret
//   - dispatch is a no-op when disabled (silent permission denial)
//   - dispatch HMAC-signs the body with sha256 over the raw JSON
//   - delivery log records both successful and failed attempts
//   - fetch errors do not throw
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-siem-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const siem = await import(path.join(repoRoot, "lib", "siemSinkStore.ts"));

function sampleEvent() {
  return {
    id: "evt-1",
    ts: new Date().toISOString(),
    route: "/api/v1/runs",
    method: "POST",
    status: 200,
    ok: true,
    key_id: "key-x",
    key_label: "ci",
    scopes: ["read"],
    reason: null,
    request_id: "req-1",
    ip_hash: "abc",
    hash: "hh",
  };
}

test("rejects non-http URL", async () => {
  siem._resetForTests();
  await assert.rejects(
    () => siem.updateSink({ url: "file:///etc/passwd" }),
    (e) => e.code === "bad_scheme",
  );
});

test("rejects URL with userinfo", async () => {
  siem._resetForTests();
  await assert.rejects(
    () => siem.updateSink({ url: "https://attacker@example.com/" }),
    (e) => e.code === "userinfo",
  );
});

test("rejects weak secret", async () => {
  siem._resetForTests();
  await assert.rejects(
    () => siem.updateSink({ secret: "short" }),
    (e) => e.code === "bad_secret",
  );
});

test("rejects out-of-range timeout", async () => {
  siem._resetForTests();
  await assert.rejects(
    () => siem.updateSink({ timeout_ms: 50 }),
    (e) => e.code === "bad_timeout",
  );
});

test("cannot enable without url+secret", async () => {
  siem._resetForTests();
  await assert.rejects(
    () => siem.updateSink({ enabled: true }),
    (e) => e.code === "missing_url",
  );
  await siem.updateSink({ url: "https://collector.example.com/in" });
  await assert.rejects(
    () => siem.updateSink({ enabled: true }),
    (e) => e.code === "missing_secret",
  );
});

test("dispatch is no-op when disabled (permission-denial style)", async () => {
  siem._resetForTests();
  await siem.updateSink({
    url: "https://collector.example.com/in",
    secret: "0123456789abcdef-supersecret",
  });
  let called = false;
  const r = await siem.dispatch(sampleEvent(), {
    fetchImpl: async () => {
      called = true;
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(r, null, "must not dispatch when disabled");
  assert.equal(called, false, "fetch must not be called");
  assert.equal(siem.listDeliveries().length, 0);
});

test("dispatch signs body with HMAC-SHA256 of secret", async () => {
  siem._resetForTests();
  const secret = "supersecret-very-long-1234567890";
  await siem.updateSink({
    url: "https://collector.example.com/in",
    secret,
  });
  await siem.updateSink({ enabled: true });

  let seenBody = null;
  let seenSig = null;
  let seenHeaders = null;
  const r = await siem.dispatch(sampleEvent(), {
    fetchImpl: async (_url, init) => {
      seenBody = init.body;
      seenHeaders = init.headers;
      seenSig = init.headers["x-signalclaw-signature"];
      return new Response("ok", { status: 202 });
    },
  });
  assert.ok(r, "delivery attempt returned");
  assert.equal(r.ok, true);
  assert.equal(r.status, 202);
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(seenBody).digest("hex");
  assert.equal(seenSig, expected, "HMAC signature must match");
  assert.equal(seenHeaders["x-signalclaw-event-id"], "evt-1");
  assert.equal(siem.listDeliveries().length, 1);
});

test("dispatch records failed attempts without throwing", async () => {
  siem._resetForTests();
  await siem.updateSink({
    url: "https://collector.example.com/in",
    secret: "supersecret-very-long-1234567890",
  });
  await siem.updateSink({ enabled: true });
  const r = await siem.dispatch(sampleEvent(), {
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.error, /network down/);
  assert.equal(siem.listDeliveries()[0].ok, false);
});

test("getSink redacts the secret", async () => {
  siem._resetForTests();
  await siem.updateSink({
    url: "https://collector.example.com/in",
    secret: "supersecret-very-long-1234567890",
    extra_header_name: "X-Tenant",
    extra_header_value: "abc123",
  });
  const view = await siem.getSink();
  assert.equal(view.secret_set, true);
  assert.equal(view.extra_header_set, true);
  assert.equal("secret" in view, false, "must not leak plaintext secret");
  assert.equal(
    "extra_header_value" in view,
    false,
    "must not leak plaintext header value",
  );
});
