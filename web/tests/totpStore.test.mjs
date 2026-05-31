// node --experimental-strip-types --test tests/totpStore.test.mjs
//
// Real RFC 6238 verification, replay defence, and disable flow.
// Uses the project's actual lib/totpStore.ts file (no mocks).
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-totp-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "totpStore.ts"));
const {
  startEnrollment,
  verifyAndMark,
  totpAtStep,
  currentStep,
  isEnrolled,
  disable,
  statusFor,
  base32Encode,
  base32Decode,
  TOTP_STEP_SECONDS,
} = mod;

test("base32 roundtrip", () => {
  const raw = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33]);
  const enc = base32Encode(raw);
  const dec = base32Decode(enc);
  assert.equal(dec.toString("hex"), raw.toString("hex"));
});

test("RFC 6238 reference vector — SHA1 secret '12345678901234567890'", () => {
  // From RFC 6238 Appendix B for time = 59s -> step 1 (using SHA1).
  // Expected 8-digit code 94287082; we use 6 digits so last six.
  const secretAscii = "12345678901234567890";
  const b32 = base32Encode(Buffer.from(secretAscii, "ascii"));
  const step = Math.floor(59 / 30);
  const code = totpAtStep(b32, step);
  assert.equal(code, "287082");
});

test("enroll + verify happy path, then reject the same code as replay", async () => {
  const init = await startEnrollment("key-1", "test admin");
  assert.match(init.otpauth_uri, /^otpauth:\/\/totp\/signalclaw:/);
  assert.equal(init.digits, 6);
  assert.equal(init.step_seconds, TOTP_STEP_SECONDS);
  assert.equal(await isEnrolled("key-1"), true);

  // Use the actual library to compute "now" code so we don't race the
  // 30-second boundary.
  const now = Date.now();
  const step = currentStep(now);
  const code = totpAtStep(init.secret_b32, step);
  const ok = await verifyAndMark("key-1", code, now);
  assert.equal(ok.ok, true);

  // Same code at same step must be refused (replay).
  const replay = await verifyAndMark("key-1", code, now);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "replay");
});

test("invalid code rejected, bad format rejected", async () => {
  await startEnrollment("key-2", "k2");
  const r1 = await verifyAndMark("key-2", "000000", Date.now());
  // Could *technically* match by 1-in-a-million chance; assert reason field
  // is from the expected set.
  if (r1.ok) {
    // skip — astronomically unlikely; nothing to assert.
  } else {
    assert.ok(["invalid", "replay"].includes(r1.reason));
  }
  const r2 = await verifyAndMark("key-2", "abc123", Date.now());
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "bad_format");
  const r3 = await verifyAndMark("key-2", "12345", Date.now());
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, "bad_format");
});

test("not enrolled key fails verification", async () => {
  const r = await verifyAndMark("never-enrolled", "123456", Date.now());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_enrolled");
});

test("disable removes enrollment so MFA is no longer enforced", async () => {
  await startEnrollment("key-3", "k3");
  assert.equal((await statusFor("key-3")).enrolled, true);
  const removed = await disable("key-3");
  assert.equal(removed, true);
  assert.equal((await statusFor("key-3")).enrolled, false);
  // Second disable is a no-op.
  assert.equal(await disable("key-3"), false);
});

test("±1 step tolerance accepts a code from the previous window", async () => {
  const init = await startEnrollment("key-4", "k4");
  const now = Date.now();
  const prevStep = currentStep(now) - 1;
  const prevCode = totpAtStep(init.secret_b32, prevStep);
  const r = await verifyAndMark("key-4", prevCode, now);
  assert.equal(r.ok, true);
});
