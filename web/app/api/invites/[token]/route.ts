import { NextRequest, NextResponse } from "next/server";
import { getInvite, redeemerView, statusOf } from "@/lib/inviteStore";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const inv = await getInvite(token);
  if (!inv) {
    await recordAuditEvent({
      req,
      route: `/api/invites/${token}`,
      method: "GET",
      status: 404,
      key: null,
      reason: "invite_not_found",
    });
    return NextResponse.json(
      { error: { code: "not_found", message: "invite not found" } },
      { status: 404 },
    );
  }
  await recordAuditEvent({
    req,
    route: `/api/invites/${token}`,
    method: "GET",
    status: 200,
    key: null,
    reason: `invite_lookup:${statusOf(inv)}`,
  });
  return NextResponse.json(redeemerView(inv));
}
