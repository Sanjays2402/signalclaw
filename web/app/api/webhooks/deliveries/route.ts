import { NextRequest, NextResponse } from "next/server";
import { listDeliveries } from "@/lib/webhookStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Number.parseInt(sp.get("limit") ?? "50", 10);
  const sub = sp.get("subscription_id") ?? undefined;
  const statusRaw = sp.get("status");
  const status = statusRaw === "ok" || statusRaw === "failed" ? statusRaw : undefined;
  const deliveries = await listDeliveries(
    Number.isFinite(limit) ? limit : 50,
    sub || undefined,
    status,
  );
  return NextResponse.json({ deliveries });
}
