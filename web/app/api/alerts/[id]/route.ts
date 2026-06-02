import { NextRequest, NextResponse } from "next/server";
import { deleteAlert, setAlertEnabled } from "@/lib/alertStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: { code: "bad_id", message: "alert id required" } }, { status: 400 });
  }
  const removed = await deleteAlert(id);
  if (!removed) {
    return NextResponse.json({ error: { code: "not_found", message: "alert not found" } }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: { code: "bad_id", message: "alert id required" } }, { status: 400 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "bad_json", message: "request body must be valid JSON" } }, { status: 400 });
  }
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: { code: "bad_field", message: "enabled must be boolean" } }, { status: 400 });
  }
  const alert = await setAlertEnabled(id, body.enabled);
  if (!alert) {
    return NextResponse.json({ error: { code: "not_found", message: "alert not found" } }, { status: 404 });
  }
  await recordSafe({
    kind: "system",
    title: `Alert · ${alert.enabled ? "enabled" : "disabled"} ${alert.ticker}`,
    body: `${alert.condition} ${alert.value}`,
    href: "/alerts",
  });
  return NextResponse.json({ alert });
}
