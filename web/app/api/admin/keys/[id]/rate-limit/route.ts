import { NextRequest, NextResponse } from "next/server";
import { extractKey, authenticate } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getLimitForKey,
  setLimitForKey,
  DEFAULT_PER_MINUTE,
  WINDOW_SECONDS,
} from "@/lib/rateLimitStore";

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

// GET /api/admin/keys/:id/rate-limit
// Returns the current per-key per-minute cap and the default fallback.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/rate-limit`;
  const denied = await requireAdmin(req, "GET", route);
  if (denied) return denied;
  const limit = await getLimitForKey(id);
  return NextResponse.json({
    key_id: id,
    limit_per_minute: limit,
    default_per_minute: DEFAULT_PER_MINUTE,
    window_seconds: WINDOW_SECONDS,
    is_override: limit !== DEFAULT_PER_MINUTE,
  });
}

// PUT /api/admin/keys/:id/rate-limit  { limit: number | null }
// null resets the override back to the default.
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/rate-limit`;
  const denied = await requireAdmin(req, "PUT", route);
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  if (!body || typeof body !== "object") {
    return err(400, "bad_body", "request body must be a JSON object");
  }
  const raw = body.limit;
  if (raw !== null && (typeof raw !== "number" || !Number.isFinite(raw))) {
    return err(400, "bad_limit", "limit must be a positive number or null");
  }
  try {
    const next = await setLimitForKey(id, raw === null ? null : raw);
    return NextResponse.json({
      key_id: id,
      limit_per_minute: next,
      default_per_minute: DEFAULT_PER_MINUTE,
      window_seconds: WINDOW_SECONDS,
      is_override: next !== DEFAULT_PER_MINUTE,
    });
  } catch (e: any) {
    return err(400, "bad_limit", e?.message || "limit rejected");
  }
}
