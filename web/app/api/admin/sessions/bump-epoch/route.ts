// POST /api/admin/sessions/bump-epoch -> global force-logout kill switch.
//
// Bumps the registry's global session epoch to `now`. Every existing
// session is marked revoked and every cookie issued before this moment
// is rejected on its next verification, even if it was never explicitly
// revoked. Use after a security incident (suspected HMAC key leak,
// suspected device theft, etc.) when "log out everyone right now" is
// the safest course.
//
// Admin gate + MFA. Audited. Body may include {"reason": "..."} which
// is stored on every revoked row for the post-incident review.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import { bumpEpoch, MAX_REASON_LEN } from "@/lib/ssoSessionRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/sessions/bump-epoch";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "POST");
  if (guard.denied) return guard.denied;

  let reason: string | null = null;
  try {
    const body = await req.json().catch(() => null);
    if (body && typeof body.reason === "string") {
      reason = String(body.reason).slice(0, MAX_REASON_LEN);
    }
  } catch {}

  const actor = guard.key?.id ?? "local";
  const out = await bumpEpoch({ actor, reason });
  await recordAuditEvent({
    req, route: ROUTE, method: "POST", status: 200, key: guard.key,
    reason: `sessions-bump-epoch:${out.revoked}`,
    details: { epoch: out.epoch, revoked: out.revoked, reason: reason || undefined },
  });
  return NextResponse.json(out);
}
