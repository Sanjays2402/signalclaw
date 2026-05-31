import { NextRequest, NextResponse } from "next/server";
import {
  extractKey,
  authenticate,
  getKey,
  setKeyIpAllowlist,
  publicView,
} from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { canonicalizeCidrList, MAX_CIDR_ENTRIES } from "@/lib/ipMatch";

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

// GET /api/admin/keys/:id/ip-allowlist
// Returns the canonicalized allowlist for a key. Empty array means
// "any source IP is allowed".
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/ip-allowlist`;
  const denied = await requireAdmin(req, "GET", route);
  if (denied) return denied;
  const k = await getKey(id);
  if (!k) return err(404, "not_found", "key not found");
  return NextResponse.json({
    key_id: id,
    ip_allowlist: Array.isArray(k.ip_allowlist) ? [...k.ip_allowlist] : [],
    max_entries: MAX_CIDR_ENTRIES,
  });
}

// PUT /api/admin/keys/:id/ip-allowlist
// Body: { ip_allowlist: string[] }  (CIDRs or bare IPs; bare IPs become /32 or /128)
// Replaces the allowlist atomically. Pass [] to allow any source.
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/ip-allowlist`;
  const denied = await requireAdmin(req, "PUT", route);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  let canonical: string[];
  try {
    canonical = canonicalizeCidrList(body?.ip_allowlist);
  } catch (e: any) {
    return err(400, e?.code || "bad_request", String(e?.message || e));
  }

  const existing = await getKey(id);
  if (!existing) return err(404, "not_found", "key not found");
  if (existing.revoked) return err(409, "revoked", "cannot edit a revoked key");

  const before = Array.isArray(existing.ip_allowlist) ? [...existing.ip_allowlist] : [];
  const updated = await setKeyIpAllowlist(id, canonical);
  if (!updated) return err(404, "not_found", "key not found");

  await recordAuditEvent({
    req,
    route,
    method: "PUT",
    status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: `ip_allowlist:${before.length}->${canonical.length}`,
  });

  return NextResponse.json(publicView(updated));
}
