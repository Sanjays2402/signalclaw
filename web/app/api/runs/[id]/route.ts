import { NextRequest, NextResponse } from "next/server";
import { getRun, deleteRun, renameRun } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return err(404, "not_found", "run not found");
  return NextResponse.json(run);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteRun(id);
  if (!ok) return err(404, "not_found", "run not found");
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  if (!label) return err(400, "bad_label", "label must be a non-empty string");
  if (label.length > 80) return err(400, "label_too_long", "label exceeds 80 chars");
  const run = await renameRun(id, label);
  if (!run) return err(404, "not_found", "run not found");
  return NextResponse.json({ id: run.id, label: run.label });
}
