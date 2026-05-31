import { NextRequest, NextResponse } from "next/server";
import {
  revokeKey,
  extractKey,
  authenticate,
} from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest, route: string): Promise<NextResponse | null> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route, method: "DELETE", status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({ req, route, method: "DELETE", status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route, method: "DELETE", status: 200, key: k });
  return null;
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const denied = await requireAdmin(req, `/api/admin/keys/${id}`);
  if (denied) return denied;
  const ok = await revokeKey(id);
  if (!ok) return err(404, "not_found", "key not found");
  return NextResponse.json({ ok: true });
}
