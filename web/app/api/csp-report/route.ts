// CSP violation report sink.
//
// Browsers POST here when a directive in our Content-Security-Policy
// (or `-Report-Only`) header is violated. We log the violation to the
// audit store so SOC operators can spot a stored XSS attempt, a rogue
// inline script after a deploy, or a third-party host the new policy
// needs to include before flipping from report to enforce.
//
// Modern browsers send `application/csp-report` (legacy) or
// `application/reports+json` (Reporting API). We accept both, dedup
// noisy fields, and cap body size so a hostile page cannot DoS the
// sink with a megabyte of garbage.
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 16 * 1024;

function clip(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function summarize(body: any): Record<string, unknown> {
  // Legacy shape: { "csp-report": { "violated-directive": ..., ... } }
  // Reporting API shape: [ { type: "csp-violation", body: { ... } } ]
  let rec: any = null;
  if (body && typeof body === "object") {
    if (body["csp-report"]) {
      rec = body["csp-report"];
    } else if (Array.isArray(body) && body[0]?.body) {
      rec = body[0].body;
    } else if (body.type === "csp-violation" && body.body) {
      rec = body.body;
    } else {
      rec = body;
    }
  }
  if (!rec || typeof rec !== "object") return { kind: "unparsed" };
  return {
    directive: clip(
      rec["effective-directive"] ?? rec["violated-directive"] ?? rec.effectiveDirective,
    ),
    blocked: clip(rec["blocked-uri"] ?? rec.blockedURL),
    document: clip(rec["document-uri"] ?? rec.documentURL),
    source: clip(rec["source-file"] ?? rec.sourceFile),
    line: typeof (rec["line-number"] ?? rec.lineNumber) === "number"
      ? rec["line-number"] ?? rec.lineNumber
      : null,
    disposition: clip(rec.disposition),
    sample: clip(rec["script-sample"] ?? rec.sample, 160),
  };
}

export async function POST(req: NextRequest) {
  const route = "/api/csp-report";
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key: null, reason: "csp:read_failed" });
    return new NextResponse(null, { status: 204 });
  }
  if (raw.length > MAX_BODY) {
    await recordAuditEvent({ req, route, method: "POST", status: 413, key: null, reason: "csp:too_large" });
    return new NextResponse(null, { status: 204 });
  }
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key: null, reason: "csp:bad_json" });
    return new NextResponse(null, { status: 204 });
  }
  const details = summarize(parsed);
  await recordAuditEvent({
    req,
    route,
    method: "POST",
    status: 204,
    key: null,
    reason: "csp:violation",
    details,
  });
  // Browsers ignore the response body; 204 keeps logs clean.
  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  return NextResponse.json({ ok: true, accepts: ["application/csp-report", "application/reports+json"] });
}
