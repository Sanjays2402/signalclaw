// /api/admin/sessions — SSO session registry admin surface.
//
//   GET    /api/admin/sessions                  list active sessions
//   GET    /api/admin/sessions?include_revoked=1  include recently revoked
//   POST   /api/admin/sessions/revoke-by-email    offboard: kill every
//                                                 active session for an email
//   POST   /api/admin/sessions/bump-epoch         global force-logout
//   DELETE /api/admin/sessions/[jti]              kill a single session
//
// Admin gate + MFA on every mutation. Every action writes to the audit log
// with the actor key id so an auditor can prove who killed which session.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import { listSessions } from "@/lib/ssoSessionRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/sessions";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "GET");
  if (guard.denied) return guard.denied;

  const url = new URL(req.url);
  const includeRevoked = url.searchParams.get("include_revoked") === "1"
    || url.searchParams.get("include_revoked") === "true";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(1000, Number(limitRaw) || 0)) : undefined;
  const emailRaw = url.searchParams.get("email");
  const email = emailRaw && emailRaw.length <= 254 ? emailRaw.trim().toLowerCase() : undefined;

  const out = await listSessions({ include_revoked: includeRevoked, limit, email });
  await recordAuditEvent({
    req, route: ROUTE, method: "GET", status: 200, key: guard.key,
    reason: `sessions-list:active=${out.active_count}`,
  });
  return NextResponse.json(out);
}
