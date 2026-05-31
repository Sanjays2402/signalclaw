// Per-API-key TOTP (RFC 6238) enrollment + verification.
//
// Real implementation, not a stub:
//   - HMAC-SHA1, 30-second time step, 6-digit code (Google Authenticator /
//     1Password / Authy compatible).
//   - Secret is 20 bytes of CSPRNG, base32-encoded for the otpauth URI.
//   - Persisted under .data/totp.json keyed by API key id. Atomic writes.
//   - Replay protection: the last accepted (step, key_id) tuple is stored and
//     refused for re-use within the same step or earlier.
//   - ±1 step tolerance on verify, so a code that ticks over mid-request
//     still works.
//
// Used by lib/adminMfaGuard.ts to require a TOTP code on every mutating
// admin route, once an admin has enrolled. A key with no enrollment row is
// treated as "MFA not enabled" and admin routes work as before.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "totp.json");

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_TOLERANCE_STEPS = 1;
export const TOTP_SECRET_BYTES = 20;
const ISSUER = "signalclaw";

export type TotpRecord = {
  key_id: string;
  secret_b32: string;        // shared secret, base32, no padding
  created_at: string;
  last_verified_at: string | null;
  last_step: number | null;  // last accepted step counter, for replay defence
};

type Store = { records: TotpRecord[] };

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.records)) return { records: [] };
    return j as Store;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { records: [] };
    throw e;
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

// RFC 4648 base32 (no padding) — small, dependency-free.
const B32_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHA[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHA[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32_ALPHA.indexOf(c);
    if (idx === -1) throw new Error("bad_base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// Core RFC 6238 generator. Exposed for tests.
export function totpAtStep(secretB32: string, step: number): string {
  const key = base32Decode(secretB32);
  const counter = Buffer.alloc(8);
  // 64-bit big-endian counter; JS numbers are safe to ~2^53 which covers
  // 30s steps for hundreds of millions of years, but write it properly.
  let n = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  const hmac = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const mod = 10 ** TOTP_DIGITS;
  return String(bin % mod).padStart(TOTP_DIGITS, "0");
}

export function currentStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

// Constant-time string compare on equal-length 6-digit strings.
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return crypto.timingSafeEqual(ba, bb);
}

export type VerifyResult =
  | { ok: true; step: number }
  | { ok: false; reason: "not_enrolled" | "bad_format" | "invalid" | "replay" };

// Pure verifier. Takes the stored record + a candidate code, returns whether
// any step in the window matches. Replay is checked against last_step.
// Time can be injected for tests.
export function verifyCodeAgainst(
  record: TotpRecord | null,
  code: string,
  nowMs: number = Date.now(),
): VerifyResult {
  if (!record) return { ok: false, reason: "not_enrolled" };
  if (!/^[0-9]{6}$/.test(code)) return { ok: false, reason: "bad_format" };
  const now = currentStep(nowMs);
  for (let d = -TOTP_TOLERANCE_STEPS; d <= TOTP_TOLERANCE_STEPS; d++) {
    const step = now + d;
    let expected: string;
    try {
      expected = totpAtStep(record.secret_b32, step);
    } catch {
      return { ok: false, reason: "invalid" };
    }
    if (ctEq(expected, code)) {
      if (record.last_step !== null && step <= record.last_step) {
        return { ok: false, reason: "replay" };
      }
      return { ok: true, step };
    }
  }
  return { ok: false, reason: "invalid" };
}

// ---- Persistence-bound helpers ----

export async function getRecord(keyId: string): Promise<TotpRecord | null> {
  const s = await readStore();
  return s.records.find((r) => r.key_id === keyId) ?? null;
}

export async function isEnrolled(keyId: string): Promise<boolean> {
  return (await getRecord(keyId)) !== null;
}

export type EnrollmentInit = {
  key_id: string;
  secret_b32: string;
  otpauth_uri: string;
  digits: number;
  step_seconds: number;
};

// Start enrollment. Generates a fresh secret and persists it immediately.
// Caller must complete enrollment by submitting a valid code (verifyAndMark)
// before MFA is actually enforced — but the record is stored so the same
// secret survives page reloads while the user copies it into their app.
export async function startEnrollment(
  keyId: string,
  label: string,
): Promise<EnrollmentInit> {
  const secret = base32Encode(crypto.randomBytes(TOTP_SECRET_BYTES));
  const s = await readStore();
  const idx = s.records.findIndex((r) => r.key_id === keyId);
  const record: TotpRecord = {
    key_id: keyId,
    secret_b32: secret,
    created_at: new Date().toISOString(),
    last_verified_at: null,
    last_step: null,
  };
  if (idx >= 0) s.records[idx] = record;
  else s.records.push(record);
  await writeStore(s);
  const account = encodeURIComponent(`${label || keyId}`);
  const issuer = encodeURIComponent(ISSUER);
  const otpauth =
    `otpauth://totp/${issuer}:${account}` +
    `?secret=${secret}&issuer=${issuer}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
  return {
    key_id: keyId,
    secret_b32: secret,
    otpauth_uri: otpauth,
    digits: TOTP_DIGITS,
    step_seconds: TOTP_STEP_SECONDS,
  };
}

// Verify + advance last_step. Atomic-ish (read-modify-write under the same
// process; this app is single-node by design).
export async function verifyAndMark(
  keyId: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  const s = await readStore();
  const rec = s.records.find((r) => r.key_id === keyId) ?? null;
  const result = verifyCodeAgainst(rec, code, nowMs);
  if (result.ok && rec) {
    rec.last_step = result.step;
    rec.last_verified_at = new Date(nowMs).toISOString();
    await writeStore(s);
  }
  return result;
}

export async function disable(keyId: string): Promise<boolean> {
  const s = await readStore();
  const before = s.records.length;
  s.records = s.records.filter((r) => r.key_id !== keyId);
  if (s.records.length === before) return false;
  await writeStore(s);
  return true;
}

// Public projection — never exposes the shared secret after enrollment.
export type TotpStatus = {
  key_id: string;
  enrolled: boolean;
  last_verified_at: string | null;
  created_at: string | null;
};

export async function statusFor(keyId: string): Promise<TotpStatus> {
  const r = await getRecord(keyId);
  if (!r) {
    return { key_id: keyId, enrolled: false, last_verified_at: null, created_at: null };
  }
  return {
    key_id: keyId,
    enrolled: true,
    last_verified_at: r.last_verified_at,
    created_at: r.created_at,
  };
}
