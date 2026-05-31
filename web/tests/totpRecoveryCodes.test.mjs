// node --experimental-strip-types --test tests/totpRecoveryCodes.test.mjs
//
// Proves the single-use recovery-code escape hatch for TOTP MFA:
//   - codes are minted only after a successful TOTP confirm
//   - exactly 10 codes are returned, each in the canonical XXXXX-XXXXX form
//   - the server only persists SHA-256 hashes (no plaintext on disk)
//   - each code works exactly once and is then burned
//   - normalisation: lower-case + missing dash both accepted
//   - regenerate invalidates the entire previous batch atomically
//   - consume on an unknown code returns ok=false without mutating state
//
// Uses lib/totpStore.ts directly (no mocks, no HTTP).
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-recovery-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "totpStore.ts"));
const {
  startEnrollment,
  verifyAndMark,
  totpAtStep,
  currentStep,
  regenerateRecoveryCodes,
  consumeRecoveryCode,
  recoveryCodesRemaining,
  statusFor,
  RECOVERY_CODE_COUNT,
} = mod;

async function freshConfirmed(keyId) {
  const init = await startEnrollment(keyId, keyId);
  const now = Date.now();
  const code = totpAtStep(init.secret_b32, currentStep(now));
  const v = await verifyAndMark(keyId, code, now);
  assert.equal(v.ok, true, "verifyAndMark should succeed for fresh code");
  return init;
}

test("regenerate refuses to mint until enrollment is confirmed", async () => {
  await startEnrollment("k-unconfirmed", "x"); // pending only
  const out = await regenerateRecoveryCodes("k-unconfirmed");
  assert.equal(out, null);
});

test("confirm + regenerate yields exactly RECOVERY_CODE_COUNT canonical codes", async () => {
  await freshConfirmed("k-mint");
  const out = await regenerateRecoveryCodes("k-mint");
  assert.ok(out, "should return codes after confirm");
  assert.equal(out.codes.length, RECOVERY_CODE_COUNT);
  assert.equal(out.remaining, RECOVERY_CODE_COUNT);
  for (const c of out.codes) {
    assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/, `code ${c} canonical form`);
  }
  // All unique.
  assert.equal(new Set(out.codes).size, out.codes.length);
});

test("disk persists only SHA-256 hashes, never plaintext codes", async () => {
  await freshConfirmed("k-disk");
  const out = await regenerateRecoveryCodes("k-disk");
  const raw = await fs.readFile(path.join(tmpRoot, ".data", "totp.json"), "utf8");
  for (const c of out.codes) {
    assert.equal(raw.includes(c), false, `plaintext ${c} must not appear on disk`);
    const h = crypto.createHash("sha256").update(c, "utf8").digest("hex");
    assert.equal(raw.includes(h), true, `hash for ${c} should be persisted`);
  }
});

test("consume burns exactly one code; same code rejected on second use", async () => {
  await freshConfirmed("k-burn");
  const out = await regenerateRecoveryCodes("k-burn");
  const code = out.codes[0];
  const r1 = await consumeRecoveryCode("k-burn", code);
  assert.equal(r1.ok, true);
  assert.equal(r1.remaining, RECOVERY_CODE_COUNT - 1);
  const r2 = await consumeRecoveryCode("k-burn", code);
  assert.equal(r2.ok, false, "second use of same code must fail");
  assert.equal(r2.remaining, RECOVERY_CODE_COUNT - 1);
});

test("normalisation accepts lower-case and dash-free forms", async () => {
  await freshConfirmed("k-norm");
  const out = await regenerateRecoveryCodes("k-norm");
  // Lower-case version of code 1.
  const lower = out.codes[1].toLowerCase();
  const r1 = await consumeRecoveryCode("k-norm", lower);
  assert.equal(r1.ok, true);
  // Dash-stripped version of code 2.
  const noDash = out.codes[2].replace("-", "");
  const r2 = await consumeRecoveryCode("k-norm", noDash);
  assert.equal(r2.ok, true);
  assert.equal(await recoveryCodesRemaining("k-norm"), RECOVERY_CODE_COUNT - 2);
});

test("unknown / malformed codes never decrement remaining", async () => {
  await freshConfirmed("k-bad");
  await regenerateRecoveryCodes("k-bad");
  const before = await recoveryCodesRemaining("k-bad");
  const r1 = await consumeRecoveryCode("k-bad", "ZZZZZ-ZZZZZ");
  assert.equal(r1.ok, false);
  const r2 = await consumeRecoveryCode("k-bad", "");
  assert.equal(r2.ok, false);
  const r3 = await consumeRecoveryCode("k-bad", "short");
  assert.equal(r3.ok, false);
  const after = await recoveryCodesRemaining("k-bad");
  assert.equal(after, before);
});

test("regenerate invalidates the previous batch atomically", async () => {
  await freshConfirmed("k-rotate");
  const first = await regenerateRecoveryCodes("k-rotate");
  const second = await regenerateRecoveryCodes("k-rotate");
  assert.equal(second.codes.length, RECOVERY_CODE_COUNT);
  // No overlap (would be 1-in-many-billions); assert disjoint to catch bugs.
  const overlap = first.codes.filter((c) => second.codes.includes(c));
  assert.equal(overlap.length, 0);
  // Old codes must all be rejected.
  for (const oldCode of first.codes) {
    const r = await consumeRecoveryCode("k-rotate", oldCode);
    assert.equal(r.ok, false, `old code ${oldCode} should be invalidated`);
  }
  // New codes must all work.
  for (const newCode of second.codes) {
    const r = await consumeRecoveryCode("k-rotate", newCode);
    assert.equal(r.ok, true, `new code ${newCode} should consume`);
  }
  assert.equal(await recoveryCodesRemaining("k-rotate"), 0);
});

test("status surfaces recovery_codes_remaining and pending flag", async () => {
  await startEnrollment("k-status", "x");
  let s = await statusFor("k-status");
  assert.equal(s.enrolled, false);
  assert.equal(s.pending, true);
  assert.equal(s.recovery_codes_remaining, 0);

  // Confirm.
  const rec = await freshConfirmed("k-status2");
  await regenerateRecoveryCodes("k-status2");
  s = await statusFor("k-status2");
  assert.equal(s.enrolled, true);
  assert.equal(s.pending, false);
  assert.equal(s.recovery_codes_remaining, RECOVERY_CODE_COUNT);
});
