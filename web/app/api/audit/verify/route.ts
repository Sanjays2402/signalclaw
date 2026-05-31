// GET /api/audit/verify
//
// Recomputes the HMAC hash chain over every persisted audit event and
// reports whether the on-disk log has been tampered with. SOC2 reviewers
// ask for tamper-evident audit logs; this endpoint is the auditor-facing
// surface that proves the property holds right now.
//
// Auth mirrors /api/audit: in local single-user mode (no SIGNALCLAW_ADMIN_KEY
// env set) the verify is open; with the env set, a key with the admin scope
// is required. The verify itself is also recorded as an audit event so the
// act of checking integrity is part of the chain going forward.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent, verifyChain } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req), { req });
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    if (!key || !key.scopes.includes("admin")) {
      await recordAuditEvent({
        req,
        route: "/api/audit/verify",
        method: "GET",
        status: 403,
        key: key ?? null,
        reason: "forbidden:admin-required",
      });
      return err(403, "forbidden", "admin scope required");
    }
  }
  const result = await verifyChain();
  await recordAuditEvent({
    req,
    route: "/api/audit/verify",
    method: "GET",
    status: 200,
    key: key ?? null,
    reason: result.ok ? "chain-verified" : "chain-broken",
    details: {
      ok: result.ok,
      checked: result.checked,
      skipped_legacy: result.skipped_legacy,
      reason: result.reason,
    },
  });
  return NextResponse.json({
    ok: result.ok,
    checked: result.checked,
    skipped_legacy: result.skipped_legacy,
    first_chained_index: result.first_chained_index,
    last_hash: result.last_hash,
    break_at_index: result.break_at_index,
    break_event_id: result.break_event_id,
    reason: result.reason,
    verified_at: new Date().toISOString(),
  });
}
