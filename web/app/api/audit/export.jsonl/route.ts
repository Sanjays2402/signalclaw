// GET /api/audit/export.jsonl  (admin SIEM surface)
//
// Streams an NDJSON (JSON Lines) export of matching audit events. Mirrors
// the filter query params of GET /api/audit and /api/audit/export.csv, but
// unlike the CSV export this preserves:
//
//   * the full ``details`` JSON object (CSV flattens to a string),
//   * the tamper-evidence fields ``prev_hash`` and ``hash``,
//   * the full ``scopes`` array (CSV joins with ``|``).
//
// That makes the JSONL stream the correct input for Splunk / Datadog / Elastic
// ingest pipelines that need to verify chain integrity after import. The act
// of exporting is itself recorded in the audit log so the chain captures
// "who pulled what".
//
// Requires the ``admin`` scope when SIGNALCLAW_ADMIN_KEY is set; otherwise
// behaves like the other /api/audit routes and trusts the local operator.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent, streamAuditFiltered } from "@/lib/auditStore";

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
        route: "/api/audit/export.jsonl",
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
  const requested = limitRaw ? Number.parseInt(limitRaw, 10) : 100_000;
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 100_000, 1), 1_000_000);

  const filter = {
    key_id: keyIdRaw ?? undefined,
    method: methodRaw ?? undefined,
    route: routeRaw ?? undefined,
    ok: okFilter,
    since: sinceRaw ?? undefined,
    limit,
  };

  const encoder = new TextEncoder();
  let exported = 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of streamAuditFiltered(filter)) {
          // One JSON object per line. JSON.stringify already escapes any
          // embedded newlines / control characters so each row is one line.
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
          exported += 1;
        }
        controller.close();
      } catch (e: any) {
        controller.error(e);
      }
    },
  });

  // Record the export attempt up front so the audit row exists even if the
  // client disconnects mid-stream. The ``rows`` count reflects the cap that
  // applied, not necessarily what made it across the wire.
  await recordAuditEvent({
    req,
    route: "/api/audit/export.jsonl",
    method: "GET",
    status: 200,
    key: key ?? null,
    reason: process.env.SIGNALCLAW_ADMIN_KEY ? null : "local-mode",
    details: {
      format: "ndjson",
      limit,
      filters: {
        key_id: keyIdRaw,
        method: methodRaw,
        route: routeRaw,
        ok: okFilter,
        since: sinceRaw,
      },
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="audit-export-${today}.jsonl"`,
      "cache-control": "no-store",
      // Hint to downstream SIEM tools that records carry a verifiable hash chain.
      "x-signalclaw-audit-format": "ndjson;chain=hmac-sha256",
    },
  });
}
