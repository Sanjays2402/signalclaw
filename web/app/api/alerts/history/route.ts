import { NextRequest, NextResponse } from "next/server";
import { listHistory, normalizeTicker } from "@/lib/alertStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(200, Math.max(1, parseInt(sp.get("limit") || "25", 10) || 25));
  const offset = Math.max(0, parseInt(sp.get("offset") || "0", 10) || 0);
  const rawTicker = sp.get("ticker");
  const ticker = rawTicker ? normalizeTicker(rawTicker) || undefined : undefined;
  const data = await listHistory({ limit, offset, ticker });
  return NextResponse.json(data);
}
