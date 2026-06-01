// /api/admin/watchlists — proxy to the FastAPI /admin/watchlists endpoint.
//
// The source of truth for per-tenant watchlists lives in the Python
// WatchlistStore (see src/signalclaw/watchlist/), so this Next route
// just forwards the request when SIGNALCLAW_UPSTREAM is configured.
// Production deployments set NEXT_PUBLIC_API_URL to talk straight to
// FastAPI; this proxy exists for the same-origin dev setup where the
// browser hits Next first and Next forwards to the API.
//
// Admin scope is enforced upstream (the FastAPI route already requires
// require_scope("admin") + require_mfa_for_admin). We still record an
// audit event on this side so the local audit chain reflects who looked.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/watchlists";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const upstream =
    process.env.SIGNALCLAW_UPSTREAM ||
    process.env.NEXT_PUBLIC_API_URL ||
    "";
  const k = await authenticate(extractKey(req), { req });

  if (!upstream) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method: "GET",
      status: 501,
      key: k ?? null,
      reason: "no-upstream",
    });
    return err(
      501,
      "no_upstream",
      "Set NEXT_PUBLIC_API_URL or SIGNALCLAW_UPSTREAM to the FastAPI base URL to view per-tenant watchlists.",
    );
  }

  const url = upstream.replace(/\/+$/, "") + "/admin/watchlists";
  const headers: Record<string, string> = {};
  const passthrough = ["x-api-key", "x-mfa-code", "x-mfa-recovery-code"];
  for (const h of passthrough) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(url, { headers, cache: "no-store" });
  } catch (e) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method: "GET",
      status: 502,
      key: k ?? null,
      reason: "upstream-unreachable",
    });
    return err(502, "upstream_unreachable", (e as Error).message);
  }

  const body = await upstreamResp.text();
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "GET",
    status: upstreamResp.status,
    key: k ?? null,
    reason: `upstream:${upstreamResp.status}`,
  });
  return new NextResponse(body, {
    status: upstreamResp.status,
    headers: { "content-type": upstreamResp.headers.get("content-type") || "application/json" },
  });
}
