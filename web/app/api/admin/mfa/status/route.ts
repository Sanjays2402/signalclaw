// GET /api/admin/mfa/status (also /mfa/status via rewrite).
// Returns enrollment status + remaining recovery codes for the calling key.

import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { statusFor } from "@/lib/totpStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCAL_KEY_ID = "local";

function keyIdFor(key: any): string {
  return key?.id ?? LOCAL_KEY_ID;
}

export async function GET(req: NextRequest) {
  const route = "/api/admin/mfa/status";
  const key = await authenticate(extractKey(req), { req });
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    if (!key || !key.scopes.includes("admin")) {
      await recordAuditEvent({
        req,
        route,
        method: "GET",
        status: 403,
        key: key ?? null,
        reason: "forbidden:admin-required",
      });
      return NextResponse.json(
        { error: { code: "forbidden", message: "admin scope required" } },
        { status: 403 },
      );
    }
  }
  const status = await statusFor(keyIdFor(key));
  await recordAuditEvent({ req, route, method: "GET", status: 200, key });
  // The frontend expects required_for_admin too.
  return NextResponse.json({
    ...status,
    required_for_admin: !!process.env.SIGNALCLAW_REQUIRE_MFA,
  });
}
