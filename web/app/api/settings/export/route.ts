import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { collectExport, exportFilename } from "@/lib/privacyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/settings/export";

// Legacy compatibility route. Hardened in the same pass that added
// /api/admin/privacy/export so the unauth export hole is closed and
// every export is captured in the audit log. Delegates to the same
// privacy bundle so the two paths cannot drift apart.
export async function GET(req: NextRequest) {
  const k = await authenticate(extractKey(req));
  const adminConfigured = !!process.env.SIGNALCLAW_ADMIN_KEY;
  if (adminConfigured && (!k || !k.scopes.includes("admin"))) {
    await recordAuditEvent({
      req, route: ROUTE, method: "GET", status: 403, key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return NextResponse.json(
      { error: { code: "forbidden", message: "admin scope required" } },
      { status: 403 },
    );
  }
  await recordAuditEvent({
    req, route: ROUTE, method: "GET", status: 200, key: k,
    reason: adminConfigured ? "privacy.export.legacy" : "privacy.export.local-mode",
  });
  const bundle = await collectExport();
  const fname = exportFilename();
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${fname}"`,
      "cache-control": "no-store",
    },
  });
}
