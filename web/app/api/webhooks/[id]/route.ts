import { NextRequest, NextResponse } from "next/server";
import { deleteWebhook, getWebhook } from "@/lib/webhookStore";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const route = `/api/webhooks/${id}`;
  const { denied, key } = await requireAdmin(req, route, "GET");
  if (denied) return denied;
  const wh = await getWebhook(id);
  if (!wh) {
    await recordAuditEvent({ req, route, method: "GET", status: 404, key: key ?? null, reason: "not_found" });
    return NextResponse.json({ error: { code: "not_found", message: "Webhook not found." } }, { status: 404 });
  }
  await recordAuditEvent({ req, route, method: "GET", status: 200, key: key ?? null });
  return NextResponse.json(wh);
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const route = `/api/webhooks/${id}`;
  const { denied, key } = await requireAdmin(req, route, "DELETE");
  if (denied) return denied;
  const ok = await deleteWebhook(id);
  if (!ok) {
    await recordAuditEvent({ req, route, method: "DELETE", status: 404, key: key ?? null, reason: "not_found" });
    return NextResponse.json({ error: { code: "not_found", message: "Webhook not found." } }, { status: 404 });
  }
  await recordAuditEvent({ req, route, method: "DELETE", status: 200, key: key ?? null, details: { webhook_id: id } });
  return NextResponse.json({ ok: true });
}
