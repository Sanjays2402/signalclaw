import { NextRequest, NextResponse } from "next/server";
import { deleteAlert, setAlertEnabled, updateAlert } from "@/lib/alertStore";
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
  // Backwards compatible: a body of only { enabled: boolean } keeps the
  // original toggle behaviour and audit message. Any other field (value,
  // note, cooldown_hours) routes through updateAlert for an inline edit.
  const keys = body && typeof body === "object" ? Object.keys(body) : [];
  const isToggleOnly = keys.length === 1 && keys[0] === "enabled" && typeof body.enabled === "boolean";
  if (isToggleOnly) {
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

  const editable = ["value", "note", "cooldown_hours", "enabled"] as const;
  const patch: Record<string, unknown> = {};
  for (const k of editable) {
    if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: { code: "bad_field", message: "patch must include value, note, cooldown_hours, or enabled" } }, { status: 400 });
  }
  const r = await updateAlert(id, patch);
  if (!r.ok) {
    return NextResponse.json({ error: r.err }, { status: r.status });
  }
  await recordSafe({
    kind: "system",
    title: `Alert · edited ${r.alert.ticker}`,
    body: `${r.alert.condition} ${r.alert.value}`,
    href: "/alerts",
  });
  return NextResponse.json({ alert: r.alert });
}
