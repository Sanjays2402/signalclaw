import { NextRequest, NextResponse } from "next/server";
import { listDeliveries } from "@/lib/webhookStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Number.parseInt(sp.get("limit") ?? "50", 10);
  const sub = sp.get("subscription_id") ?? undefined;
  const deliveries = await listDeliveries(Number.isFinite(limit) ? limit : 50, sub || undefined);
  return NextResponse.json({ deliveries });
}
