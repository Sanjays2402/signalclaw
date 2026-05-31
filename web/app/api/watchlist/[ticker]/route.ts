import { NextRequest, NextResponse } from "next/server";
import { removeTicker, updateNote, setTargets, normalizeNote, normalizeTicker, normalizePrice } from "@/lib/watchlistStore";
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
  const hasTargets =
    body && ("target_high" in body || "target_low" in body);
  if (hasTargets) {
    const target_high = normalizePrice(body.target_high);
    const target_low = normalizePrice(body.target_low);
    try {
      const entry = await setTargets(t, target_high, target_low);
      if (!entry) return err(404, "not_found", `ticker ${t} not on watchlist`);
      return NextResponse.json({ entry });
    } catch (e: any) {
      if (e?.message === "low_above_high") {
        return err(400, "low_above_high", "target_low must be below target_high");
      }
      return err(400, "bad_request", e?.message ?? "could not set targets");
    }
  }
  const note = normalizeNote(body?.note);
  const entry = await updateNote(t, note);
  if (!entry) return err(404, "not_found", `ticker ${t} not on watchlist`);
  return NextResponse.json({ entry });
}
