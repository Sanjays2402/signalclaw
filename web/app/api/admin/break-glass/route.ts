// /api/admin/break-glass — proxy to FastAPI /admin/break-glass.
//
// Source of truth for emergency admin elevation lives in the Python
// BreakGlassStore (src/signalclaw/break_glass/). This Next route
// forwards GET (list) and POST (issue) when SIGNALCLAW_UPSTREAM (or
// NEXT_PUBLIC_API_URL) is set; otherwise it returns 501 so the
// operator knows to point at the FastAPI base URL.
//
// Admin scope + admin MFA are enforced upstream. We still record the
// access locally so the Next-side audit chain reflects who issued the
// elevation request, even if the upstream rejects it.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/break-glass";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function upstreamBase(): string {
  return (
    process.env.SIGNALCLAW_UPSTREAM ||
    process.env.NEXT_PUBLIC_API_URL ||
    ""
  );
}

const PASSTHROUGH = ["x-api-key", "x-mfa-code", "x-mfa-recovery-code"];

function forwardHeaders(req: NextRequest): Record<string, string> {
  const h: Record<string, string> = {};
  for (const k of PASSTHROUGH) {
    const v = req.headers.get(k);
    if (v) h[k] = v;
  }
  return h;
}

async function proxy(
  req: NextRequest,
  method: "GET" | "POST",
  upstreamPath: string,
  body?: string,
): Promise<NextResponse> {
  const base = upstreamBase();
  const k = await authenticate(extractKey(req), { req });
  if (!base) {
    await recordAuditEvent({
      req, route: ROUTE, method, status: 501,
      key: k ?? null, reason: "no-upstream",
    });
    return err(
      501,
      "no_upstream",
      "Set NEXT_PUBLIC_API_URL or SIGNALCLAW_UPSTREAM to the FastAPI base URL to use break-glass.",
    );
  }
  const url = base.replace(/\/+$/, "") + upstreamPath;
  const headers: Record<string, string> = forwardHeaders(req);
  if (body !== undefined) headers["content-type"] = "application/json";
  let resp: Response;
  try {
    resp = await fetch(url, { method, headers, body, cache: "no-store" });
  } catch (e) {
    await recordAuditEvent({
      req, route: ROUTE, method, status: 502,
      key: k ?? null, reason: "upstream-unreachable",
    });
    return err(502, "upstream_unreachable", (e as Error).message);
  }
  const text = await resp.text();
  await recordAuditEvent({
    req, route: ROUTE, method, status: resp.status,
    key: k ?? null, reason: `upstream:${resp.status}`,
  });
  return new NextResponse(text, {
    status: resp.status,
    headers: {
      "content-type":
        resp.headers.get("content-type") || "application/json",
    },
  });
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const qs = u.search || "";
  return proxy(req, "GET", "/admin/break-glass" + qs);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  return proxy(req, "POST", "/admin/break-glass", body);
}
