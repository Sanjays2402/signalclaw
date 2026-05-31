import { NextRequest, NextResponse } from "next/server";
import { revokeInvite, getInvite, publicView } from "@/lib/inviteStore";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest, route: string, method: string) {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route, method, status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({ req, route, method, status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route, method, status: 200, key: k });
  return null;
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const denied = await requireAdmin(req, `/api/admin/invites/${token}`, "DELETE");
  if (denied) return denied;
  const ok = await revokeInvite(token);
  if (!ok) return err(404, "not_found", "invite not found");
  await recordSafe({
    kind: "invite.revoked",
    title: "Invite revoked",
    body: `Token ${token.slice(0, 12)}… revoked.`,
    href: "/settings/invites",
  });
  return NextResponse.json({ ok: true });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const denied = await requireAdmin(req, `/api/admin/invites/${token}`, "GET");
  if (denied) return denied;
  const inv = await getInvite(token);
  if (!inv) return err(404, "not_found", "invite not found");
  return NextResponse.json(publicView(inv));
}
