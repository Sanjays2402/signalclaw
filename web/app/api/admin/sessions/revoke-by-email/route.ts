// POST /api/admin/sessions/revoke-by-email -> offboard helper.
//
// Kills every currently-active SSO session whose email matches the
// supplied address (case-insensitive). Used when a user leaves and the
// IdP entry has already been removed, so the next attempted refresh
// fails but in-flight cookies stay valid until first re-auth — this
// closes that window immediately.
//
// Body: { "email": "alice@example.com", "reason": "offboarded" }
// Admin gate + MFA. Returns the count revoked so the UI can confirm.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import { revokeByEmail, MAX_REASON_LEN } from "@/lib/ssoSessionRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/sessions/revoke-by-email";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// Lightweight email shape check. Full RFC5322 is overkill; we only need
// "looks like one address with one @ and a dot in the host".
const EMAIL_RE = /^[^\s@]{1,128}@[^\s@.]{1,63}(\.[^\s@.]{1,63})+$/;

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "POST");
  if (guard.denied) return guard.denied;

  let body: any;
  try { body = await req.json(); }
  catch { return err(400, "invalid_json", "request body must be JSON"); }

  const email = String(body?.email || "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status: 400, key: guard.key,
      reason: "invalid-email",
    });
    return err(400, "invalid_email", "email is required and must be a valid address");
  }

  const reason = typeof body?.reason === "string"
    ? String(body.reason).slice(0, MAX_REASON_LEN)
    : null;

  const actor = guard.key?.id ?? "local";
  const n = await revokeByEmail(email, { actor, reason });
  await recordAuditEvent({
    req, route: ROUTE, method: "POST", status: 200, key: guard.key,
    reason: `sessions-revoked-by-email:${email}:${n}`,
    details: { email, revoked: n, reason: reason || undefined },
  });
  return NextResponse.json({ email, revoked: n });
}
