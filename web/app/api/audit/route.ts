// GET /api/audit  (admin UI surface)
// In local single-user mode (no SIGNALCLAW_ADMIN_KEY env) returns the log
// unauthenticated, mirroring how /api/admin/keys behaves. With the env set,
// requires a key with the admin scope.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { queryAudit, recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function parseInt0(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req));
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    if (!key || !key.scopes.includes("admin")) {
      await recordAuditEvent({ req, route: "/api/audit", method: "GET", status: 403, key: key ?? null, reason: "forbidden:admin-required" });
      return err(403, "forbidden", "admin scope required");
    }
  }
  const sp = req.nextUrl.searchParams;
  const keyIdRaw = sp.get("key_id");
  const methodRaw = sp.get("method");
  const routeRaw = sp.get("route");
  const okRaw = sp.get("ok");
  const sinceRaw = sp.get("since");

  if (keyIdRaw && keyIdRaw.length > 64) return err(400, "bad_key_id", "key_id too long");
  if (methodRaw && methodRaw.length > 16) return err(400, "bad_method", "method too long");
  if (routeRaw && routeRaw.length > 200) return err(400, "bad_route", "route too long");
  if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) {
    return err(400, "bad_since", "since must be an ISO 8601 timestamp");
  }
  const okFilter = okRaw === null ? undefined : okRaw === "1" || okRaw === "true";

  const out = await queryAudit({
    key_id: keyIdRaw ?? undefined,
    method: methodRaw ?? undefined,
    route: routeRaw ?? undefined,
    ok: okFilter,
    since: sinceRaw ?? undefined,
    limit: parseInt0(sp.get("limit"), 200),
    offset: parseInt0(sp.get("offset"), 0),
  });
  await recordAuditEvent({ req, route: "/api/audit", method: "GET", status: 200, key: key ?? null, reason: process.env.SIGNALCLAW_ADMIN_KEY ? null : "local-mode" });
  return NextResponse.json({
    ...out,
    has_more: out.offset + out.events.length < out.total,
  });
}
