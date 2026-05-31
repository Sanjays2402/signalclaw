import { NextRequest, NextResponse } from "next/server";
import { deleteAlert } from "@/lib/alertStore";

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
