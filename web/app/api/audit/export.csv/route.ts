// GET /api/audit/export.csv  (admin UI surface)
// Streams a CSV export of matching audit events. Mirrors the filter
// query params of GET /api/audit so the export always reflects the
// exact view the operator is looking at. Requires the ``admin`` scope
// when SIGNALCLAW_ADMIN_KEY is set; otherwise behaves like the other
// /api/audit routes and trusts the local operator.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { queryAudit, recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CSV_FIELDS = [
  "ts",
  "id",
  "method",
  "route",
  "status",
  "ok",
  "key_id",
  "key_label",
  "key_prefix",
  "scopes",
  "ip_hash",
  "user_agent",
  "reason",
  "request_id",
] as const;

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function csvCell(v: unknown): string {
  // RFC 4180-ish: quote if value contains comma / quote / newline.
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("|") : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req), { req });
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    if (!key || !key.scopes.includes("admin")) {
      await recordAuditEvent({
        req,
        route: "/api/audit/export.csv",
        method: "GET",
        status: 403,
        key: key ?? null,
        reason: "forbidden:admin-required",
      });
      return err(403, "forbidden", "admin scope required");
    }
  }
  const sp = req.nextUrl.searchParams;
  const keyIdRaw = sp.get("key_id");
  const methodRaw = sp.get("method");
  const routeRaw = sp.get("route");
  const okRaw = sp.get("ok");
  const sinceRaw = sp.get("since");
  const limitRaw = sp.get("limit");

  if (keyIdRaw && keyIdRaw.length > 64) return err(400, "bad_key_id", "key_id too long");
  if (methodRaw && methodRaw.length > 16) return err(400, "bad_method", "method too long");
  if (routeRaw && routeRaw.length > 200) return err(400, "bad_route", "route too long");
  if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) {
    return err(400, "bad_since", "since must be an ISO 8601 timestamp");
  }
  const okFilter = okRaw === null ? undefined : okRaw === "1" || okRaw === "true";
  // Cap export to 10k rows by default; up to 100k on explicit ?limit=.
  const requested = limitRaw ? Number.parseInt(limitRaw, 10) : 10_000;
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 10_000, 1), 100_000);

  const out = await queryAudit({
    key_id: keyIdRaw ?? undefined,
    method: methodRaw ?? undefined,
    route: routeRaw ?? undefined,
    ok: okFilter,
    since: sinceRaw ?? undefined,
    limit,
    offset: 0,
  });

  // Stream the response so a large export does not buffer in memory.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(CSV_FIELDS.join(",") + "\n"));
      for (const ev of out.events) {
        const row: Record<string, unknown> = ev as unknown as Record<string, unknown>;
        const line = CSV_FIELDS.map((f) => csvCell(row[f])).join(",");
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });

  await recordAuditEvent({
    req,
    route: "/api/audit/export.csv",
    method: "GET",
    status: 200,
    key: key ?? null,
    reason: process.env.SIGNALCLAW_ADMIN_KEY ? null : "local-mode",
    details: { rows: out.events.length, filters: { key_id: keyIdRaw, method: methodRaw, route: routeRaw, ok: okFilter, since: sinceRaw } },
  });

  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="audit-export-${today}.csv"`,
      "cache-control": "no-store",
    },
  });
}
