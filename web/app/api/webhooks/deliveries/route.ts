import { NextRequest, NextResponse } from "next/server";
import { listDeliveries } from "@/lib/webhookStore";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/webhooks/deliveries";

export async function GET(req: NextRequest) {
  const { denied, key } = await requireAdmin(req, ROUTE, "GET");
  if (denied) return denied;
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
  await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 200, key: key ?? null });
  return NextResponse.json({ deliveries });
}
