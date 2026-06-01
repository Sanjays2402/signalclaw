// /api/break-glass/me — proxy to FastAPI /break-glass/me.
//
// Non-admin: any caller asks "do I have a live emergency elevation?"
// using their own API key. Used by the on-call engineer's view of the
// break-glass page.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const base =
    process.env.SIGNALCLAW_UPSTREAM ||
    process.env.NEXT_PUBLIC_API_URL ||
    "";
  if (!base) {
    return NextResponse.json(
      { active: false, grant: null, upstream: false },
      { status: 200 },
    );
  }
  const url = base.replace(/\/+$/, "") + "/break-glass/me";
  const headers: Record<string, string> = {};
  const k = req.headers.get("x-api-key");
  if (k) headers["x-api-key"] = k;
  let resp: Response;
  try {
    resp = await fetch(url, { headers, cache: "no-store" });
  } catch (e) {
    return NextResponse.json(
      { error: { code: "upstream_unreachable", message: (e as Error).message } },
      { status: 502 },
    );
  }
  const text = await resp.text();
  return new NextResponse(text, {
    status: resp.status,
    headers: {
      "content-type":
        resp.headers.get("content-type") || "application/json",
    },
  });
}
