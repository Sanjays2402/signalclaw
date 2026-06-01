// /api/admin/break-glass/[id]/revoke — proxy to FastAPI.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/break-glass/[id]/revoke";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const base =
    process.env.SIGNALCLAW_UPSTREAM ||
    process.env.NEXT_PUBLIC_API_URL ||
    "";
  const k = await authenticate(extractKey(req), { req });
  if (!base) {
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status: 501,
      key: k ?? null, reason: "no-upstream",
    });
    return err(
      501,
      "no_upstream",
      "Set NEXT_PUBLIC_API_URL or SIGNALCLAW_UPSTREAM to the FastAPI base URL to use break-glass.",
    );
  }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
    return err(400, "invalid_id", "grant id is malformed");
  }
  const url =
    base.replace(/\/+$/, "") + `/admin/break-glass/${id}/revoke`;
  const headers: Record<string, string> = {};
  for (const h of ["x-api-key", "x-mfa-code", "x-mfa-recovery-code"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, cache: "no-store" });
  } catch (e) {
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status: 502,
      key: k ?? null, reason: "upstream-unreachable",
    });
    return err(502, "upstream_unreachable", (e as Error).message);
  }
  const text = await resp.text();
  await recordAuditEvent({
    req, route: ROUTE, method: "POST", status: resp.status,
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
