// POST /api/admin/mfa/enroll (also /mfa/enroll via rewrite).
// Begins TOTP enrollment, returning the secret + otpauth URI exactly once.
// The enrollment is "pending" until the caller proves possession by
// POSTing the 6-digit code to /api/admin/mfa/confirm.

import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { startEnrollment, TOTP_DIGITS, TOTP_STEP_SECONDS } from "@/lib/totpStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCAL_KEY_ID = "local";

function requireAdmin(key: any): NextResponse | null {
  if (!process.env.SIGNALCLAW_ADMIN_KEY) return null;
  if (!key || !key.scopes.includes("admin")) {
    return NextResponse.json(
      { error: { code: "forbidden", message: "admin scope required" } },
      { status: 403 },
    );
  }
  return null;
}

export async function POST(req: NextRequest) {
  const route = "/api/admin/mfa/enroll";
  const key = await authenticate(extractKey(req), { req });
  const denied = requireAdmin(key);
  if (denied) {
    await recordAuditEvent({ req, route, method: "POST", status: 403, key: key ?? null, reason: "forbidden:admin-required" });
    return denied;
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim() : (key?.label ?? "signalclaw-admin");
  const id = key?.id ?? LOCAL_KEY_ID;
  const init = await startEnrollment(id, label);
  await recordAuditEvent({ req, route, method: "POST", status: 200, key, reason: "mfa-enroll-init" });
  // Frontend expects: secret, otpauth_uri, algorithm, digits, period_seconds.
  return NextResponse.json({
    secret: init.secret_b32,
    otpauth_uri: init.otpauth_uri,
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period_seconds: TOTP_STEP_SECONDS,
  });
}
