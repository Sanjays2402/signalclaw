import { NextRequest, NextResponse } from "next/server";
import { listDeliveries } from "@/lib/digestSubStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sub = sp.get("subscription_id") ?? undefined;
  const limitRaw = sp.get("limit");
  let limit = 50;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n >= 1 && n <= 200) limit = Math.floor(n);
  }
  const deliveries = await listDeliveries(sub, limit);
  return NextResponse.json({ deliveries });
}
