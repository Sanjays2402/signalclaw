import { NextRequest, NextResponse } from "next/server";
import { replayDelivery } from "@/lib/webhookStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json(
      { error: { code: "missing_id", message: "Delivery id is required." } },
      { status: 400 },
    );
  }
  const result = await replayDelivery(id);
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : 400;
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
  return NextResponse.json({ delivery: d, replay_of: id });
}
