import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { listTenantSummary } from "@/lib/alertStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest) {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route: "/api/admin/alerts", method: req.method, status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/admin/alerts", method: req.method, status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route: "/api/admin/alerts", method: req.method, status: 200, key: k });
  if (req.method !== "GET") {
    const denied = await enforceAdminMfa(req, k, "/api/admin/alerts", req.method);
    if (denied) return denied;
  }
  return null;
}

// GET /api/admin/alerts
// Aggregate per-tenant alert footprint. Returns only counts (alert_count,
// armed, history_count) per ownerId, never the alert rows themselves, so a
// compromised admin token cannot exfiltrate tenant alert contents through
// this surface.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const summary = await listTenantSummary();
  return NextResponse.json(summary);
}
