import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import {
  extractKey,
  authenticate,
  getKey,
  setKeyRole,
  publicView,
  ALL_ROLES,
  type KeyRole,
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
  if (method !== "GET") {
    const denied = await enforceAdminMfa(req, k, route, method);
    if (denied) return denied;
  }
  return null;
}

// GET /api/admin/keys/:id/role
// Returns the current RBAC role for a key (or the inferred role if the
// key predates the role field). Useful for an admin UI that wants to
// render a role picker pre-filled with the live value.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/role`;
  const denied = await requireAdmin(req, "GET", route);
  if (denied) return denied;
  const k = await getKey(id);
  if (!k) return err(404, "not_found", "key not found");
  const view = publicView(k);
  return NextResponse.json({
    key_id: id,
    role: view.role,
    effective_scopes: view.effective_scopes,
  });
}

// PUT /api/admin/keys/:id/role
// Body: { role: "owner" | "admin" | "member" | "viewer" }
// Sets the coarse RBAC role on a key. The underlying scopes array is
// rewritten atomically to match the role's canonical scope set, so the
// auth path never observes drift between role label and effective
// privileges. Audited with the before/after role transition. Refuses to
// edit the env admin (rotate SIGNALCLAW_ADMIN_KEY instead) or revoked
// keys. MFA-gated like every other mutating admin route.
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/role`;
  const denied = await requireAdmin(req, "PUT", route);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  const raw = body?.role;
  if (typeof raw !== "string") {
    return err(400, "bad_request", "role must be a string");
  }
  const next = raw.trim().toLowerCase() as KeyRole;
  if (!ALL_ROLES.includes(next)) {
    return err(
      400,
      "invalid_role",
      `role must be one of: ${ALL_ROLES.join(", ")}`,
    );
  }

  const existing = await getKey(id);
  if (!existing) return err(404, "not_found", "key not found");
  if (existing.revoked) return err(409, "revoked", "cannot edit a revoked key");
  if (id === "env-admin") {
    return err(409, "forbidden_target", "cannot change role of the env admin");
  }

  let updated;
  try {
    updated = await setKeyRole(id, next);
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.startsWith("invalid_role")) {
      return err(400, "invalid_role", msg.replace(/^invalid_role:\s*/, ""));
    }
    throw e;
  }
  if (!updated) return err(404, "not_found", "key not found");

  const beforeRole = existing.role ?? "unset";
  await recordAuditEvent({
    req,
    route,
    method: "PUT",
    status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: `role:${beforeRole}->${updated.role}`,
  });

  return NextResponse.json(publicView(updated));
}
