// POST /api/admin/mfa/disable (also /mfa/disable via rewrite).
// Disables MFA for the calling admin key. Requires proof of possession:
// either a fresh TOTP code in X-MFA-Code, or a single-use recovery code
// in X-MFA-Recovery-Code. A key that never finished enrollment can be
// cleaned up without a code (nothing to lock out of).

import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getRecord,
  verifyAndMark,
  consumeRecoveryCode,
  disable,
} from "@/lib/totpStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCAL_KEY_ID = "local";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(req: NextRequest) {
  const route = "/api/admin/mfa/disable";
  const key = await authenticate(extractKey(req), { req });
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    if (!key || !key.scopes.includes("admin")) {
      await recordAuditEvent({ req, route, method: "POST", status: 403, key: key ?? null, reason: "forbidden:admin-required" });
      return err(403, "forbidden", "admin scope required");
    }
  }
  const id = key?.id ?? LOCAL_KEY_ID;
  const existing = await getRecord(id);
  if (existing && existing.confirmed_at) {
    const recovery = req.headers.get("x-mfa-recovery-code")?.trim() ?? "";
    if (recovery) {
      const r = await consumeRecoveryCode(id, recovery);
      if (!r.ok) {
        await recordAuditEvent({ req, route, method: "POST", status: 401, key, reason: "mfa-disable-recovery-reject" });
        return err(401, "mfa_invalid", "recovery code rejected");
      }
    } else {
      const code = req.headers.get("x-mfa-code")?.trim() ?? "";
      if (!/^[0-9]{6}$/.test(code)) {
        await recordAuditEvent({ req, route, method: "POST", status: 401, key, reason: "mfa-disable-missing-code" });
        return err(401, "mfa_required", "X-MFA-Code or X-MFA-Recovery-Code header required");
      }
      const result = await verifyAndMark(id, code);
      if (!result.ok) {
        await recordAuditEvent({ req, route, method: "POST", status: 401, key, reason: `mfa-disable-reject:${result.reason}` });
        return err(401, "mfa_invalid", "code rejected");
      }
    }
  }
  const removed = await disable(id);
  await recordAuditEvent({ req, route, method: "POST", status: 200, key, reason: removed ? "mfa-disabled" : "mfa-not-enrolled" });
  return NextResponse.json({ ok: true, removed });
}
