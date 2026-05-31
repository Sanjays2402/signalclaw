import { NextRequest, NextResponse } from "next/server";
import {
  revokeKey,
  extractKey,
  authenticate,
} from "@/lib/keyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  if (!process.env.SIGNALCLAW_ADMIN_KEY) return null;
  const k = await authenticate(extractKey(req));
  if (!k || !k.scopes.includes("admin")) {
    return err(403, "forbidden", "admin scope required");
  }
  return null;
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const ok = await revokeKey(id);
  if (!ok) return err(404, "not_found", "key not found");
  return NextResponse.json({ ok: true });
}
