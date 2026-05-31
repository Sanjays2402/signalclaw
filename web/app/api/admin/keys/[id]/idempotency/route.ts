// GET /api/admin/keys/:id/idempotency
// Returns the recent Idempotency-Key cache entries for an API key so the
// owner can see which retried requests are being replayed and which slot
// would conflict if reused.
import { NextRequest, NextResponse } from "next/server";
import { extractKey, authenticate } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { listForKey } from "@/lib/idempotencyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  method: string,
  route: string,
): Promise<NextResponse | null> {
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

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/idempotency`;
  const denied = await requireAdmin(req, "GET", route);
  if (denied) return denied;
  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(
    Math.max(Number.parseInt(rawLimit ?? "50", 10) || 50, 1),
    200,
  );
  const records = await listForKey(id, limit);
  // Never leak the cached response body or full fingerprint; trim to safe view.
  const view = records.map((r) => ({
    header: r.header,
    fingerprint_prefix: r.fingerprint.slice(0, 12),
    status: r.status,
    created_at: r.created_at,
    expires_at: r.expires_at,
    bytes: r.body.length,
  }));
  return NextResponse.json({ key_id: id, count: view.length, records: view });
}
