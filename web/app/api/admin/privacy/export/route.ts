import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { collectExport, exportFilename } from "@/lib/privacyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/privacy/export";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  method: string,
): Promise<NextResponse | null> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({
      req, route: ROUTE, method, status: 403, key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k, reason: "privacy.export" });
  if ((method) !== "GET") {
    const __mfaDenied = await enforceAdminMfa(req, k, "/api/admin/privacy/export", (method));
    if (__mfaDenied) return __mfaDenied;
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req, "GET");
  if (denied) return denied;
  const bundle = await collectExport();
  const fname = exportFilename();
  const body = JSON.stringify(bundle, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${fname}"`,
      "cache-control": "no-store",
    },
  });
}
