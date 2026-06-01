import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import { approveRequest, publicView } from "@/lib/dualControlStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/approvals/${id}/approve`;
  const guard = await requireAdmin(req, route, "POST");
  if (guard.denied) return guard.denied;

  const approver = guard.key?.id;
  if (!approver) {
    // local single-admin mode has no second admin to provide. Do not
    // pretend to approve. Tell the operator to set SIGNALCLAW_ADMIN_KEY
    // and use real keys for both maker and checker.
    return err(
      409,
      "no_second_admin",
      "dual-control approvals require multi-admin mode (set SIGNALCLAW_ADMIN_KEY and use distinct admin keys)",
    );
  }

  const r = await approveRequest({ id, approver });
  if (!r.ok) {
    const status =
      r.code === "not_found"
        ? 404
        : r.code === "self_approval"
          ? 403
          : r.code === "expired"
            ? 410
            : 409;
    await recordAuditEvent({
      req,
      route,
      method: "POST",
      status,
      key: guard.key ?? null,
      reason: `dual_control:approve:${r.code}`,
      details: { request_id: id },
    });
    return err(status, r.code, r.message);
  }

  await recordAuditEvent({
    req,
    route,
    method: "POST",
    status: 200,
    key: guard.key ?? null,
    reason: `dual_control:approve:${r.request.action}`,
    details: {
      request_id: r.request.id,
      target: r.request.target,
      requested_by: r.request.requested_by,
    },
  });
  // Token is returned ONCE, here. It is not stored anywhere readable.
  return NextResponse.json({
    request: publicView(r.request),
    approval_token: r.token,
    approval_token_expires_at: r.request.approval_token_expires_at,
  });
}
