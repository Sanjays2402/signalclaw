import { NextRequest, NextResponse } from "next/server";
import { replayDelivery } from "@/lib/webhookStore";
import { recordSafe } from "@/lib/activityStore";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const route = `/api/webhooks/deliveries/${id}/replay`;
  const { denied, key } = await requireAdmin(req, route, "POST");
  if (denied) return denied;
  if (!id) {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key: key ?? null, reason: "missing_id" });
    return NextResponse.json(
      { error: { code: "missing_id", message: "Delivery id is required." } },
      { status: 400 },
    );
  }
  const result = await replayDelivery(id);
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : 400;
    await recordAuditEvent({ req, route, method: "POST", status, key: key ?? null, reason: result.code });
    return NextResponse.json({ error: { code: result.code, message: result.message } }, { status });
  }
  const d = result.delivery;
  const ok = d.status !== null && d.status >= 200 && d.status < 300;
  await recordSafe({
    kind: ok ? "webhook.delivered" : "webhook.failed",
    title: ok ? `Webhook replay delivered (HTTP ${d.status})` : `Webhook replay failed`,
    body: `${d.event_count} event(s) to ${d.url}`,
    href: "/webhooks",
  });
  await recordAuditEvent({
    req,
    route,
    method: "POST",
    status: 200,
    key: key ?? null,
    details: { replay_of: id, delivery_id: d.id, http_status: d.status, ok },
  });
  return NextResponse.json({ delivery: d, replay_of: id });
}
