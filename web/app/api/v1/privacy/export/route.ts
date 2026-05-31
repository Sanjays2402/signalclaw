// GET /api/v1/privacy/export
//
// Programmatic GDPR Article 15 (right of access) + Article 20 (data
// portability) self-service. Returns the same bundle the admin console
// produces, so customers can wire it into their own subject-access-request
// workflows without operator handholding.
//
// Auth:    Authorization: Bearer <key>  (read scope is sufficient; any
//          authenticated key gets the workspace bundle it has access to)
// Returns: application/json export bundle with content-disposition so curl
//          -O writes a sensible filename. Rate limited; every call is
//          recorded in the audit log so the access itself is auditable.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { enforceRateLimit } from "@/lib/v1Guard";
import { recordAuditEvent } from "@/lib/auditStore";
import { collectExport, exportFilename } from "@/lib/privacyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/v1/privacy/export";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req), { req });
  if (!key) {
    await recordAuditEvent({
      req, route: ROUTE, method: "GET", status: 401, key: null,
      reason: "unauthorized",
    });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  // Read scope is the floor; admin and trade keys also include read in
  // practice. We intentionally do not require admin: GDPR Article 15 is a
  // data-subject right, not an operator privilege.
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    await recordAuditEvent({
      req, route: ROUTE, method: "GET", status: 403, key,
      reason: "forbidden:read-required",
    });
    return err(403, "forbidden", "read scope required");
  }
  return enforceRateLimit(req, key, ROUTE, async () => {
    const bundle = await collectExport();
    const fname = exportFilename();
    const body = JSON.stringify(bundle, null, 2);
    await recordAuditEvent({
      req, route: ROUTE, method: "GET", status: 200, key,
      reason: "privacy.export",
      details: { stores: Object.keys(bundle.stores).length },
    });
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${fname}"`,
        "cache-control": "no-store",
      },
    });
  });
}
