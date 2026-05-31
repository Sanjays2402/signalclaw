// POST /api/admin/mfa/confirm (also /mfa/confirm via rewrite).
// Verifies the 6-digit code against the pending enrollment, marks it
// confirmed, and mints the initial set of single-use recovery codes.
// Plaintext recovery codes are returned exactly once and never again.

import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  verifyAndMark,
  regenerateRecoveryCodes,
  statusFor,
} from "@/lib/totpStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCAL_KEY_ID = "local";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(req: NextRequest) {
  const route = "/api/admin/mfa/confirm";
  const key = await authenticate(extractKey(req), { req });
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    if (!key || !key.scopes.includes("admin")) {
      await recordAuditEvent({ req, route, method: "POST", status: 403, key: key ?? null, reason: "forbidden:admin-required" });
      return err(403, "forbidden", "admin scope required");
    }
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^[0-9]{6}$/.test(code)) {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key, reason: "mfa-confirm-bad-format" });
    return err(400, "bad_code", "code must be a 6-digit string");
  }
  const id = key?.id ?? LOCAL_KEY_ID;
  const result = await verifyAndMark(id, code);
  if (!result.ok) {
    await recordAuditEvent({ req, route, method: "POST", status: 401, key, reason: `mfa-confirm-fail:${result.reason}` });
    return err(401, "mfa_invalid", `code rejected: ${result.reason}`);
  }
  // Successful verify also marks confirmed_at if not already. Mint recovery
  // codes now (or re-mint if confirm is called twice, e.g. after a wipe).
  const recovery = await regenerateRecoveryCodes(id);
  const status = await statusFor(id);
  await recordAuditEvent({ req, route, method: "POST", status: 200, key, reason: "mfa-confirm-ok" });
  return NextResponse.json({
    enrolled: status.enrolled,
    recovery_codes: recovery?.codes ?? [],
    recovery_codes_remaining: status.recovery_codes_remaining,
  });
}
