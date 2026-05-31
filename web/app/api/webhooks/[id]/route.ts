import { NextRequest, NextResponse } from "next/server";
import { deleteWebhook, getWebhook } from "@/lib/webhookStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const wh = await getWebhook(id);
  if (!wh) {
    return NextResponse.json({ error: { code: "not_found", message: "Webhook not found." } }, { status: 404 });
  }
  return NextResponse.json(wh);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const ok = await deleteWebhook(id);
  if (!ok) {
    return NextResponse.json({ error: { code: "not_found", message: "Webhook not found." } }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
