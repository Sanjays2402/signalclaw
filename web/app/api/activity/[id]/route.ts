import { NextRequest, NextResponse } from "next/server";
import { markRead, deleteEvent } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function PATCH(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!id) return err(400, "bad_id", "id required");
  const ev = await markRead(id);
  if (!ev) return err(404, "not_found", "event not found");
  return NextResponse.json({ event: ev });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!id) return err(400, "bad_id", "id required");
  const ok = await deleteEvent(id);
  if (!ok) return err(404, "not_found", "event not found");
  return NextResponse.json({ deleted: true });
}
