// node --experimental-strip-types --test tests/authLockoutStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-lockout-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const lockMod = await import(path.join(repoRoot, "lib", "authLockoutStore.ts"));
const {
  setConfig,
  getConfig,
  decideLockout,
  recordAuthFailure,
  clearAuthFailures,
  unlockIp,
  listLockouts,
  _resetCache,
} = lockMod;

const keyMod = await import(path.join(repoRoot, "lib", "keyStore.ts"));
const { createKey, authenticateWithStatus } = keyMod;

function mkReq(ip) {
  return new Request("http://t/", { headers: { "x-forwarded-for": ip } });
}

test("disabled by default: failures do not lock", async () => {
  _resetCache();
  await setConfig({ enabled: false, threshold: 3, window_seconds: 60, cooldown_seconds: 60 });
  for (let i = 0; i < 10; i++) await recordAuthFailure("9.9.9.1");
  const d = await decideLockout("9.9.9.1");
  assert.equal(d.locked, false);
});

test("locks an IP after threshold consecutive failures", async () => {
  _resetCache();
  await setConfig({ enabled: true, threshold: 3, window_seconds: 60, cooldown_seconds: 60 });
  for (let i = 0; i < 3; i++) await recordAuthFailure("9.9.9.2");
  const d = await decideLockout("9.9.9.2");
  assert.equal(d.locked, true);
  assert.ok(d.retry_after_seconds > 0 && d.retry_after_seconds <= 60);
});

test("clearAuthFailures resets the counter and unlocks", async () => {
  _resetCache();
  await setConfig({ enabled: true, threshold: 3, window_seconds: 60, cooldown_seconds: 60 });
  for (let i = 0; i < 3; i++) await recordAuthFailure("9.9.9.3");
  await clearAuthFailures("9.9.9.3");
  const d = await decideLockout("9.9.9.3");
  assert.equal(d.locked, false);
});

test("manual unlockIp returns false for unknown IP", async () => {
  _resetCache();
  const ok = await unlockIp("203.0.113.42");
  assert.equal(ok, false);
});

test("end-to-end: bad keys from one IP lock the IP, then good key is rejected as locked", async () => {
  _resetCache();
  await setConfig({ enabled: true, threshold: 3, window_seconds: 60, cooldown_seconds: 60 });

  // Mint a real key.
  const { secret } = await createKey({ label: "test", scopes: ["read"] });

  // Three wrong attempts from the same IP.
  const badReq = mkReq("8.8.8.8");
  for (let i = 0; i < 3; i++) {
    const r = await authenticateWithStatus("sc_live_wrong_attempt_" + i, { req: badReq });
    assert.equal(r.kind, "unauthorized");
  }

  // Now even the correct key from that IP is locked out.
  const stillLocked = await authenticateWithStatus(secret, { req: mkReq("8.8.8.8") });
  assert.equal(stillLocked.kind, "locked");
  assert.ok(stillLocked.retry_after_seconds > 0);

  // A different IP using the same correct key is unaffected.
  const cleanIp = await authenticateWithStatus(secret, { req: mkReq("8.8.8.9") });
  assert.equal(cleanIp.kind, "ok");
});

test("successful auth from a previously-failing IP clears its counter", async () => {
  _resetCache();
  await setConfig({ enabled: true, threshold: 5, window_seconds: 60, cooldown_seconds: 60 });

  const { secret } = await createKey({ label: "test2", scopes: ["read"] });
  const req = mkReq("7.7.7.7");

  // Two wrong attempts (under threshold).
  for (let i = 0; i < 2; i++) {
    await authenticateWithStatus("sc_live_wrong_" + i, { req });
  }

  // One correct attempt clears counter (let async clear settle).
  const ok = await authenticateWithStatus(secret, { req });
  assert.equal(ok.kind, "ok");
  await new Promise((r) => setTimeout(r, 30));

  // Now 4 more wrong attempts should NOT yet lock (counter was cleared).
  for (let i = 0; i < 4; i++) {
    await authenticateWithStatus("sc_live_wrong_again_" + i, { req });
  }
  const d = await decideLockout("7.7.7.7");
  assert.equal(d.locked, false);
});

test("missing credentials are not counted as brute force", async () => {
  _resetCache();
  await setConfig({ enabled: true, threshold: 2, window_seconds: 60, cooldown_seconds: 60 });

  const req = mkReq("6.6.6.6");
  for (let i = 0; i < 10; i++) {
    const r = await authenticateWithStatus("", { req });
    assert.equal(r.kind, "unauthorized");
  }
  const d = await decideLockout("6.6.6.6");
  assert.equal(d.locked, false);
});

test("listLockouts surfaces locked entries first", async () => {
  _resetCache();
  // Clear any leftover state from prior tests.
  await unlockIp("1.1.1.1");
  await unlockIp("2.2.2.2");
  await setConfig({ enabled: true, threshold: 2, window_seconds: 60, cooldown_seconds: 60 });
  await recordAuthFailure("1.1.1.1");
  await recordAuthFailure("2.2.2.2");
  await recordAuthFailure("2.2.2.2"); // locks
  const list = await listLockouts();
  const a = list.find((e) => e.ip === "1.1.1.1");
  const b = list.find((e) => e.ip === "2.2.2.2");
  assert.ok(a && b, "both IPs present in lockout listing");
  assert.equal(b.locked, true);
  assert.equal(a.locked, false);
  // Locked entry ordered before clear entry.
  assert.ok(list.indexOf(b) < list.indexOf(a));
});
