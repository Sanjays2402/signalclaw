import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";
import { eraseAll } from "@/lib/privacyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/settings/delete";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// Legacy compatibility route, hardened. Requires admin scope when an
// admin key is configured, writes to the audit log, and routes through
// the central privacy erase so behaviour matches /api/admin/privacy/delete.
// Defaults: user data only; never touches the audit log or API keys.
export async function POST(req: NextRequest) {
  const k = await authenticate(extractKey(req));
  const adminConfigured = !!process.env.SIGNALCLAW_ADMIN_KEY;
  if (adminConfigured && (!k || !k.scopes.includes("admin"))) {
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status: 403, key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return err(403, "forbidden", "admin scope required");
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be JSON");
  }
  if (!body || body.confirm !== "DELETE") {
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status: 400, key: k,
      reason: "privacy.delete.unconfirmed",
    });
    return err(
      400,
      "confirm_required",
      'send { "confirm": "DELETE" } to permanently wipe local account data',
    );
  }
  const summary = await eraseAll({ wipeCompliance: false, wipeAudit: false });
  await recordAuditEvent({
    req, route: ROUTE, method: "POST", status: 200, key: k,
    reason: "privacy.delete.executed.legacy",
    details: {
      removed_count: summary.removed.length,
      preserved_count: summary.preserved.length,
      bytes_freed: summary.bytes_freed,
    },
  });
  await recordSafe({
    kind: "system",
    title: "Workspace data erased",
    body: `Removed ${summary.removed.length} file(s), freed ${summary.bytes_freed} bytes.`,
    href: "/settings/privacy",
  }).catch(() => { /* activity may itself have been wiped */ });
  // Keep the legacy {deleted: string[]} shape for backwards compat.
  return NextResponse.json({
    deleted: summary.removed,
    preserved: summary.preserved,
    bytes_freed: summary.bytes_freed,
  });
}
