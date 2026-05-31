// Admin MFA gate.
//
// Pattern in a mutating /api/admin/* route, after admin auth succeeds:
//
//   const mfaDenied = await enforceAdminMfa(req, key, "/api/admin/freeze", "POST");
//   if (mfaDenied) return mfaDenied;
//
// Behaviour:
//   - If SIGNALCLAW_ADMIN_KEY is unset (local single-user mode), MFA is
//     skipped entirely, same as the admin gate itself.
//   - If the authenticated key has no TOTP enrollment, the call is allowed
//     so an admin can still bootstrap MFA on a fresh install. Audit log
//     records reason "mfa-not-enrolled" so a SOC2 reviewer can see which
//     keys have not turned it on.
//   - If the key IS enrolled, the request MUST present a valid 6-digit code
//     in `X-MFA-Code` (or `x-mfa-code`). Missing -> 401 mfa_required.
//     Wrong / replayed / malformed -> 401 mfa_invalid. Both write an audit
//     line so admin-console misuse is visible.
//
// Read-only admin GETs are intentionally not gated: TOTP would force the
// settings page to nag on every render. Only mutating verbs go through here.

import { NextResponse } from "next/server";
import type { StoredKey } from "./keyStore";
import { recordAuditEvent } from "./auditStore";
import { getRecord, verifyAndMark, consumeRecoveryCode } from "./totpStore";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function extractCode(req: Request): string | null {
  const h = req.headers.get("x-mfa-code") ?? req.headers.get("X-MFA-Code");
  if (!h) return null;
  const trimmed = h.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function extractRecovery(req: Request): string | null {
  const h =
    req.headers.get("x-mfa-recovery-code") ??
    req.headers.get("X-MFA-Recovery-Code");
  if (!h) return null;
  const trimmed = h.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function enforceAdminMfa(
  req: Request,
  key: StoredKey | null,
  route: string,
  method: string,
): Promise<NextResponse | null> {
  // Local mode: admin gate already short-circuited; mirror that here.
  if (!process.env.SIGNALCLAW_ADMIN_KEY) return null;
  if (!key) {
    // Belt-and-braces; the admin gate should have caught this.
    await recordAuditEvent({
      req,
      route,
      method,
      status: 401,
      key: null,
      reason: "mfa_required:no_key",
    });
    return err(401, "mfa_required", "MFA required");
  }
  const enrollment = await getRecord(key.id);
  if (!enrollment || !enrollment.confirmed_at) {
    // No TOTP set up for this key yet, or enrollment never confirmed.
    // Allow the call so the admin can enrol; leave a breadcrumb.
    await recordAuditEvent({
      req,
      route,
      method,
      status: 200,
      key,
      reason: "mfa-not-enrolled",
    });
    return null;
  }
  // Recovery-code path: single-use escape hatch when the authenticator
  // is unavailable. Checked first so a queued recovery code is consumed
  // even if the user also left a stale TOTP code in the header.
  const recovery = extractRecovery(req);
  if (recovery) {
    const result = await consumeRecoveryCode(key.id, recovery);
    if (result.ok) {
      await recordAuditEvent({
        req,
        route,
        method,
        status: 200,
        key,
        reason: `mfa-recovery-used:remaining=${result.remaining}`,
      });
      return null;
    }
    await recordAuditEvent({
      req,
      route,
      method,
      status: 401,
      key,
      reason: "mfa_invalid:recovery_rejected",
    });
    return err(401, "mfa_invalid", "recovery code rejected");
  }
  const code = extractCode(req);
  if (!code) {
    await recordAuditEvent({
      req,
      route,
      method,
      status: 401,
      key,
      reason: "mfa_required",
    });
    return err(401, "mfa_required", "X-MFA-Code header required");
  }
  const result = await verifyAndMark(key.id, code);
  if (!result.ok) {
    await recordAuditEvent({
      req,
      route,
      method,
      status: 401,
      key,
      reason: `mfa_invalid:${result.reason}`,
    });
    return err(401, "mfa_invalid", "MFA code rejected");
  }
  return null;
}
