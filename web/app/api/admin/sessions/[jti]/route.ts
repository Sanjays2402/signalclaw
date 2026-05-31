// DELETE /api/admin/sessions/[jti] -> revoke one SSO session by its jti.
//
// Admin gate + MFA. Idempotent: a re-DELETE of an already-revoked
// session returns 200 with the same record. Returns 404 only if the
// jti was never registered. Every call writes an audit line.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import { revokeBySession, getSession, MAX_REASON_LEN } from "@/lib/ssoSessionRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function route(jti: string) { return `/api/admin/sessions/${jti}`; }

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ jti: string }> },
) {
  const { jti } = await ctx.params;
  const ROUTE = route(jti);
  const guard = await requireAdmin(req, ROUTE, "DELETE");
  if (guard.denied) return guard.denied;

  if (!jti || typeof jti !== "string" || jti.length > 64) {
    await recordAuditEvent({
      req, route: ROUTE, method: "DELETE", status: 400, key: guard.key,
      reason: "invalid-jti",
    });
    return err(400, "invalid_jti", "invalid session id");
  }

  let reason: string | null = null;
  try {
    const body = await req.json().catch(() => null);
    if (body && typeof body.reason === "string") {
      reason = body.reason.slice(0, MAX_REASON_LEN);
    }
  } catch {}

  const existing = await getSession(jti);
  if (!existing) {
    await recordAuditEvent({
      req, route: ROUTE, method: "DELETE", status: 404, key: guard.key,
      reason: "session-not-found",
    });
    return err(404, "not_found", "session not found");
  }

  const actor = guard.key?.id ?? "local";
  const row = await revokeBySession(jti, { actor, reason });
  await recordAuditEvent({
    req, route: ROUTE, method: "DELETE", status: 200, key: guard.key,
    reason: `session-revoked:${existing.email}`,
    details: { jti, reason: reason || undefined },
  });
  return NextResponse.json({ session: row });
}
