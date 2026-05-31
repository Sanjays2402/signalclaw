// POST /api/admin/mfa/recovery-codes/regenerate
// Also reachable as /mfa/recovery-codes/regenerate via the rewrite.
//
// Mints a fresh set of single-use recovery codes for the calling key,
// invalidating any previous codes atomically. Requires proof of possession
// of the current authenticator (a fresh 6-digit TOTP code) so a stolen
// admin key alone cannot rotate the recovery codes silently.
//
// Returns the plaintext codes exactly once. The server only ever persists
// SHA-256 hashes, so codes that scroll off-screen are unrecoverable by
// design.

import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  isFullyEnrolled,
  verifyAndMark,
  regenerateRecoveryCodes,
} from "@/lib/totpStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCAL_KEY_ID = "local";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(req: NextRequest) {
  const route = "/api/admin/mfa/recovery-codes/regenerate";
  const key = await authenticate(extractKey(req), { req });
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    if (!key || !key.scopes.includes("admin")) {
      await recordAuditEvent({ req, route, method: "POST", status: 403, key: key ?? null, reason: "forbidden:admin-required" });
      return err(403, "forbidden", "admin scope required");
    }
  }
  const id = key?.id ?? LOCAL_KEY_ID;
  if (!(await isFullyEnrolled(id))) {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key, reason: "recovery-regen-not-enrolled" });
    return err(400, "not_enrolled", "complete MFA enrollment first");
  }
  // Require a fresh TOTP code. Recovery codes alone cannot rotate recovery
  // codes; otherwise a stolen .txt file would be self-perpetuating.
  const code = req.headers.get("x-mfa-code")?.trim() ?? "";
  if (!/^[0-9]{6}$/.test(code)) {
    await recordAuditEvent({ req, route, method: "POST", status: 401, key, reason: "recovery-regen-missing-code" });
    return err(401, "mfa_required", "X-MFA-Code header required");
  }
  const verify = await verifyAndMark(id, code);
  if (!verify.ok) {
    await recordAuditEvent({ req, route, method: "POST", status: 401, key, reason: `recovery-regen-reject:${verify.reason}` });
    return err(401, "mfa_invalid", "code rejected");
  }
  const out = await regenerateRecoveryCodes(id);
  if (!out) {
    // Race: was disabled between the check and now.
    await recordAuditEvent({ req, route, method: "POST", status: 409, key, reason: "recovery-regen-race" });
    return err(409, "not_enrolled", "MFA was disabled");
  }
  await recordAuditEvent({ req, route, method: "POST", status: 200, key, reason: `recovery-regen:count=${out.codes.length}` });
  return NextResponse.json({
    recovery_codes: out.codes,
    recovery_codes_remaining: out.remaining,
  });
}
