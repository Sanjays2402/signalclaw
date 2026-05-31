import { NextRequest, NextResponse } from "next/server";
import {
  rotateKey,
  publicView,
  extractKey,
  authenticate,
} from "@/lib/keyStore";
import { recordSafe } from "@/lib/activityStore";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest, route: string): Promise<NextResponse | null> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route, method: "POST", status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({ req, route, method: "POST", status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route, method: "POST", status: 200, key: k });
  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const denied = await requireAdmin(req, `/api/admin/keys/${id}/rotate`);
  if (denied) return denied;
  // Pass-through grace_seconds for the Python backend. The local JS
  // keystore (used in dev) ignores it; immediate-cutover is fine there.
  let grace = 0;
  try {
    const body = await req.json().catch(() => null);
    if (body && typeof body === "object" && body.grace_seconds !== undefined) {
      const g = Number(body.grace_seconds);
      if (!Number.isFinite(g) || g < 0 || g > 7 * 24 * 3600) {
        return err(400, "invalid", "grace_seconds must be 0..604800");
      }
      grace = Math.floor(g);
    }
  } catch {
    // no body is fine
  }
  const out = await rotateKey(id);
  if (!out) {
    return err(404, "not_rotatable", "key not found or revoked");
  }
  void grace; // forwarded shape preserved for upstream Python service
  await recordSafe({
    kind: "key.rotated",
    title: `Rotated API key · ${out.key.label}`,
    body: `${out.key.prefix} · scopes ${out.key.scopes.join(", ")}`,
    href: "/settings/keys",
  });
  return NextResponse.json({ ...publicView(out.key), secret: out.secret });
}
