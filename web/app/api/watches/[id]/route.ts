import { NextRequest, NextResponse } from "next/server";
import { deleteWatch, getWatch, setEnabled } from "@/lib/watchStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const w = await getWatch(id);
  if (!w) return err(404, "not_found", "watch not found");
  return NextResponse.json({ watch: w });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  if (typeof body?.enabled !== "boolean") {
    return err(400, "bad_input", "body must include boolean `enabled`");
  }
  const w = await setEnabled(id, body.enabled);
  if (!w) return err(404, "not_found", "watch not found");
  return NextResponse.json({ watch: w });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const w = await getWatch(id);
  if (!w) return err(404, "not_found", "watch not found");
  const ok = await deleteWatch(id);
  if (!ok) return err(404, "not_found", "watch not found");
  await recordSafe({
    kind: "system",
    title: `Watch · removed ${w.ticker}`,
    body: `cadence ${w.cadence_hours}h`,
    href: "/watches",
  });
  return NextResponse.json({ ok: true });
}
