import { NextRequest, NextResponse } from "next/server";
import {
  extractKey,
  authenticate,
  getKey,
  setKeySuspended,
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
    await recordAuditEvent({
      req,
      route,
      method,
      status: 403,
      key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route, method, status: 200, key: k });
  return null;
}

// GET /api/admin/keys/:id/suspend
// Returns the current suspension state of an API key.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/suspend`;
  const denied = await requireAdmin(req, "GET", route);
  if (denied) return denied;
  const k = await getKey(id);
  if (!k) return err(404, "not_found", "key not found");
  return NextResponse.json({
    key_id: id,
    suspended: !!k.suspended,
    suspended_at: k.suspended_at ?? null,
    suspended_reason: k.suspended_reason ?? null,
  });
}

// PUT /api/admin/keys/:id/suspend
// Body: { suspended: boolean, reason?: string }
// Reversible operational hold. A suspended key fails to authenticate on
// every /v1/* and admin endpoint (returns 401) until an admin unsuspends
// it. Distinct from DELETE (revoke), which is permanent. Reason is recorded
// in the audit trail.
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/suspend`;
  const denied = await requireAdmin(req, "PUT", route);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  if (typeof body?.suspended !== "boolean") {
    return err(400, "bad_request", "suspended must be a boolean");
  }
  const reason =
    body.reason == null
      ? null
      : typeof body.reason === "string"
        ? body.reason
        : undefined;
  if (reason === undefined) {
    return err(400, "bad_request", "reason must be a string or null");
  }

  const existing = await getKey(id);
  if (!existing) return err(404, "not_found", "key not found");
  if (existing.revoked) return err(409, "revoked", "cannot suspend a revoked key");
  if (id === "env-admin")
    return err(409, "env_admin", "cannot suspend the env admin key");

  const updated = await setKeySuspended(id, body.suspended, reason);
  if (!updated) return err(404, "not_found", "key not found");

  const transition = `${existing.suspended ? "suspended" : "active"}->${updated.suspended ? "suspended" : "active"}`;
  await recordAuditEvent({
    req,
    route,
    method: "PUT",
    status: 200,
    key: await authenticate(extractKey(req)),
    reason: `suspend:${transition}`,
    details: reason ? { reason: reason.slice(0, 200) } : null,
  });

  return NextResponse.json(publicView(updated));
}
