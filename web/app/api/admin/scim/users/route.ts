// Admin: read-only list of SCIM-provisioned users for the admin console.
// Mutations go through /scim/v2/Users with the IdP token; this exists so
// an operator can audit what the IdP has pushed without leaving the UI.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { listUsers } from "@/lib/scimStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/scim/users";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const k = await authenticate(extractKey(req), { req });
  if (process.env.SIGNALCLAW_ADMIN_KEY && (!k || !k.scopes.includes("admin"))) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 200, key: k });
  const users = await listUsers();
  return NextResponse.json({
    total: users.length,
    active: users.filter((u) => u.active).length,
    users: users.map((u) => ({
      id: u.id,
      userName: u.userName,
      givenName: u.givenName,
      familyName: u.familyName,
      active: u.active,
      externalId: u.externalId,
      created_at: u.created_at,
      updated_at: u.updated_at,
    })),
  });
}
