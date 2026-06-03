import { NextRequest, NextResponse } from "next/server";
import { listDeliveries } from "@/lib/webhookStore";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import { deliveriesToCSV, deliveriesToJSON } from "@/lib/webhookDeliveriesExport";

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
  const formatRaw = sp.get("format");
  const format = formatRaw === "csv" || formatRaw === "json" ? formatRaw : null;

  // Export pulls every matching delivery (capped at 500 by the store) so
  // users get the full filtered history in one click rather than the
  // 25-row UI page.
  const effectiveLimit = format ? 500 : Number.isFinite(limit) ? limit : 50;
  const deliveries = await listDeliveries(
    effectiveLimit,
    sub || undefined,
    status,
  );
  await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 200, key: key ?? null });

  if (format === "csv") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new NextResponse(deliveriesToCSV(deliveries), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="webhook-deliveries-${stamp}.csv"`,
      },
    });
  }
  if (format === "json") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new NextResponse(deliveriesToJSON(deliveries), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="webhook-deliveries-${stamp}.json"`,
      },
    });
  }
  return NextResponse.json({ deliveries });
}
