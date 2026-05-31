import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { queryRuns } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function parseIntParam(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// GET /v1/runs?q=&ticker=&regime=&limit=&offset=
// Auth: Authorization: Bearer <key>  (read scope)
// Returns a slim public view; no internal hashes or raw payloads.
export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req));
  if (!key) return err(401, "unauthorized", "missing or invalid api key");
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    return err(403, "forbidden", "read scope required");
  }

  const sp = req.nextUrl.searchParams;
  const q = sp.get("q") ?? "";
  const ticker = sp.get("ticker") ?? "";
  const regime = sp.get("regime") ?? "";
  const limit = Math.min(parseIntParam(sp.get("limit"), 25), 200);
  const offset = Math.max(parseIntParam(sp.get("offset"), 0), 0);

  const { runs, total, limit: appliedLimit, offset: appliedOffset } =
    await queryRuns({ q, ticker, regime, limit, offset });

  const items = runs.map((r) => ({
    id: r.id,
    label: r.label,
    ticker: r.ticker,
    lookback_days: r.lookback_days,
    created_at: r.created_at,
    bars: r.payload.dates.length,
    regime: r.payload.snapshot?.label ?? null,
    confidence: r.payload.snapshot?.confidence ?? null,
    share_url: `/r/${r.id}`,
  }));

  return NextResponse.json({
    runs: items,
    total,
    limit: appliedLimit,
    offset: appliedOffset,
    has_more: appliedOffset + items.length < total,
  });
}
