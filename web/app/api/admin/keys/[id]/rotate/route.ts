import { NextRequest, NextResponse } from "next/server";
import {
  rotateKey,
  publicView,
  extractKey,
  authenticate,
} from "@/lib/keyStore";
import { recordSafe } from "@/lib/activityStore";

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

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const out = await rotateKey(id);
  if (!out) {
    return err(404, "not_rotatable", "key not found or revoked");
  }
  await recordSafe({
    kind: "key.rotated",
    title: `Rotated API key · ${out.key.label}`,
    body: `${out.key.prefix} · scopes ${out.key.scopes.join(", ")}`,
    href: "/settings/keys",
  });
  return NextResponse.json({ ...publicView(out.key), secret: out.secret });
}
