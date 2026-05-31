// /api/admin/sso  -> GET, PUT  (admin gate + MFA on write)
//
// Manages the workspace OIDC SSO policy. GET returns the public view
// (client_secret is never serialized; we return client_secret_set so the
// UI can show a "•••• set" indicator). PUT replaces with full validation
// including a live discovery probe so a typo'd issuer can't be saved.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getSsoPolicy,
  updateSsoPolicy,
  toPublic,
  fetchDiscovery,
} from "@/lib/ssoPolicyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/sso";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "GET");
  if (guard.denied) return guard.denied;
  const policy = await getSsoPolicy();
  return NextResponse.json({ policy: toPublic(policy) });
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "PUT");
  if (guard.denied) return guard.denied;

  let body: any;
  try { body = await req.json(); }
  catch { return err(400, "invalid_json", "request body must be JSON"); }

  const before = await getSsoPolicy();

  try {
    // Pre-flight discovery probe whenever issuer changes or enabling.
    const wantEnabled = typeof body?.enabled === "boolean" ? body.enabled : before.enabled;
    const wantIssuer = typeof body?.issuer === "string" ? String(body.issuer).trim().replace(/\/+$/, "") : before.issuer;
    if (wantEnabled && wantIssuer) {
      try {
        await fetchDiscovery(wantIssuer, { force: true });
      } catch (e: any) {
        await recordAuditEvent({
          req, route: ROUTE, method: "PUT", status: 400, key: guard.key,
          reason: `discovery-failed:${e?.message || "unknown"}`,
        });
        return err(400, "discovery_failed", `OIDC discovery failed: ${e?.message || "unknown"}`);
      }
    }

    const actor = guard.key?.id ?? "local";
    const { after } = await updateSsoPolicy({ ...body, actor });
    await recordAuditEvent({
      req, route: ROUTE, method: "PUT", status: 200, key: guard.key,
      reason: "sso-policy-updated",
    });
    return NextResponse.json({ policy: toPublic(after) });
  } catch (e: any) {
    return err(400, "invalid_input", e?.message || "invalid input");
  }
}
