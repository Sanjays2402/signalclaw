import { NextRequest, NextResponse } from "next/server";
import { removeTicker, updateNote, normalizeNote, normalizeTicker } from "@/lib/watchlistStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  const t = normalizeTicker(ticker);
  if (!t) return err(400, "bad_ticker", "invalid ticker");
  const ok = await removeTicker(t);
  if (!ok) return err(404, "not_found", `ticker ${t} not on watchlist`);
  await recordSafe({
    kind: "system",
    title: `Watchlist · removed ${t}`,
    body: "no longer tracked",
  });
  return NextResponse.json({ ok: true, ticker: t });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  const t = normalizeTicker(ticker);
  if (!t) return err(400, "bad_ticker", "invalid ticker");
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const note = normalizeNote(body?.note);
  const entry = await updateNote(t, note);
  if (!entry) return err(404, "not_found", `ticker ${t} not on watchlist`);
  return NextResponse.json({ entry });
}
