// Admin surface for per-key route allowlists.
//
//   GET  /api/admin/keys/:id/route-allowlist  -> { key_id, route_allowlist, max_entries }
//   PUT  /api/admin/keys/:id/route-allowlist  -> body { route_allowlist: string[] }
//
// Auth: admin scope when SIGNALCLAW_ADMIN_KEY is set; open in local mode.
// Every call is recorded in the audit log (mirroring sibling admin
// endpoints) so SOC2 reviewers can replay who narrowed which key when.
import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import {
  extractKey,
  authenticate,
  getKey,
  setKeyRouteAllowlist,
  publicView,
} from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  canonicalizeRouteList,
  MAX_ROUTE_ENTRIES,
} from "@/lib/routeAllowlist";

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
  if ((method) !== "GET") {
    const __mfaDenied = await enforceAdminMfa(req, k, route, (method));
    if (__mfaDenied) return __mfaDenied;
  }
  return null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/route-allowlist`;
  const denied = await requireAdmin(req, "GET", route);
  if (denied) return denied;
  const k = await getKey(id);
  if (!k) return err(404, "not_found", "key not found");
  return NextResponse.json({
    key_id: id,
    route_allowlist: Array.isArray(k.route_allowlist) ? [...k.route_allowlist] : [],
    max_entries: MAX_ROUTE_ENTRIES,
  });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/route-allowlist`;
  const denied = await requireAdmin(req, "PUT", route);
  if (denied) return denied;

  if (id === "env-admin") {
    return err(409, "env_admin", "the env admin key cannot be route-restricted");
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  let canonical: string[];
  try {
    canonical = canonicalizeRouteList(body?.route_allowlist);
  } catch (e: any) {
    return err(400, e?.code || "bad_request", String(e?.message || e));
  }

  const existing = await getKey(id);
  if (!existing) return err(404, "not_found", "key not found");
  if (existing.revoked) return err(409, "revoked", "cannot edit a revoked key");

  const before = Array.isArray(existing.route_allowlist)
    ? [...existing.route_allowlist]
    : [];
  const updated = await setKeyRouteAllowlist(id, canonical);
  if (!updated) return err(404, "not_found", "key not found");

  await recordAuditEvent({
    req,
    route,
    method: "PUT",
    status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: `route_allowlist:${before.length}->${canonical.length}`,
  });

  return NextResponse.json(publicView(updated));
}
