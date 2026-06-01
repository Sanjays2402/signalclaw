import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import { cancelRequest, publicView } from "@/lib/dualControlStore";

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
  const route = `/api/admin/approvals/${id}/cancel`;
  const guard = await requireAdmin(req, route, "POST");
  if (guard.denied) return guard.denied;

  const r = await cancelRequest({ id, actor: guard.key?.id ?? "local" });
  if (!r.ok) {
    const status = r.code === "not_found" ? 404 : 409;
    return err(status, r.code, r.message);
  }
  await recordAuditEvent({
    req,
    route,
    method: "POST",
    status: 200,
    key: guard.key ?? null,
    reason: `dual_control:cancel:${r.request.action}`,
    details: { request_id: r.request.id, target: r.request.target },
  });
  return NextResponse.json(publicView(r.request));
}
