import { NextRequest, NextResponse } from "next/server";
import {
  extractKey,
  authenticate,
  getKey,
  setKeyExpiry,
  publicView,
} from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";

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
  const k = await authenticate(extractKey(req));
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

// GET /api/admin/keys/:id/expiry
// Returns the current expiry timestamp (or null) for an API key. Useful
// for an admin UI that wants to render a date picker pre-filled.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/expiry`;
  const denied = await requireAdmin(req, "GET", route);
  if (denied) return denied;
  const k = await getKey(id);
  if (!k) return err(404, "not_found", "key not found");
  return NextResponse.json({
    key_id: id,
    expires_at: k.expires_at ?? null,
  });
}

// PUT /api/admin/keys/:id/expiry
// Body: { expires_at: string | null }  // ISO 8601 UTC, or null to clear.
// Sets an absolute cutoff after which the key no longer authenticates on
// any route. Reject revoked keys and past timestamps. Audited.
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/expiry`;
  const denied = await requireAdmin(req, "PUT", route);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  const raw = body?.expires_at;
  const iso = raw === null || raw === "" ? null
    : typeof raw === "string" ? raw
    : undefined;
  if (iso === undefined) {
    return err(400, "bad_request", "expires_at must be an ISO 8601 string or null");
  }

  const existing = await getKey(id);
  if (!existing) return err(404, "not_found", "key not found");
  if (existing.revoked) return err(409, "revoked", "cannot edit a revoked key");

  let updated;
  try {
    updated = await setKeyExpiry(id, iso);
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.startsWith("invalid_expiry")) {
      return err(400, "invalid_expiry", msg.replace(/^invalid_expiry:\s*/, ""));
    }
    throw e;
  }
  if (!updated) return err(404, "not_found", "key not found");

  await recordAuditEvent({
    req,
    route,
    method: "PUT",
    status: 200,
    key: await authenticate(extractKey(req)),
    reason: `expiry:${existing.expires_at ?? "null"}->${updated.expires_at ?? "null"}`,
  });

  return NextResponse.json(publicView(updated));
}
