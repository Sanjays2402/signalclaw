import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { deleteComment } from "@/lib/commentStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// Deleting comments is owner-only. We follow the same posture as the admin
// keys endpoint: when SIGNALCLAW_ADMIN_KEY is set, require an admin-scoped
// key; otherwise local single-user mode allows the owner to moderate freely.
async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  if (!process.env.SIGNALCLAW_ADMIN_KEY) return null;
  const k = await authenticate(extractKey(req), { req });
  if (!k || !k.scopes.includes("admin")) {
    return err(403, "forbidden", "admin scope required");
  }
  return null;
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string }> },
) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const { id, cid } = await ctx.params;
  const ok = await deleteComment(id, cid);
  if (!ok) return err(404, "not_found", "comment not found");
  return NextResponse.json({ ok: true });
}
