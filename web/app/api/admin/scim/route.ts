// Admin surface for the SCIM 2.0 provisioning token. Lets an admin mint
// the bearer Okta/Azure AD will use to push users, rotate it, or revoke
// it. The plaintext is shown exactly once at mint time and never stored.
//
// GET    -> status (configured, prefix, created_at, last_used_at)
// POST   -> rotate; returns { token } once
// DELETE -> revoke (provisioning stops accepting requests)
import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getTokenStatus,
  rotateToken,
  revokeToken,
} from "@/lib/scimStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/scim";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest, method: string) {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: ROUTE, method, status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k });
  if (method !== "GET") {
    const mfa = await enforceAdminMfa(req, k, ROUTE, method);
    if (mfa) return mfa;
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req, "GET");
  if (denied) return denied;
  const s = await getTokenStatus();
  return NextResponse.json(s);
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req, "POST");
  if (denied) return denied;
  const out = await rotateToken();
  await recordAuditEvent({
    req, route: ROUTE, method: "POST", status: 200, key: null,
    reason: "scim:token-rotated", details: { prefix: out.prefix },
  });
  return NextResponse.json(out);
}

export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req, "DELETE");
  if (denied) return denied;
  await revokeToken();
  await recordAuditEvent({
    req, route: ROUTE, method: "DELETE", status: 200, key: null,
    reason: "scim:token-revoked",
  });
  return NextResponse.json({ ok: true });
}
