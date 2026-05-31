import { NextRequest, NextResponse } from "next/server";
import { listWatchlist, recordCross, type WatchlistEntry } from "@/lib/watchlistStore";
import { queryRuns } from "@/lib/runStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CheckRow = {
  ticker: string;
  target_high: number | null;
  target_low: number | null;
  last_close: number | null;
  last_close_at: string | null;
  source_run_id: string | null;
  status: "no_targets" | "no_data" | "inside" | "above_high" | "below_low";
  crossed_now: boolean;
};

async function latestCloseForTicker(ticker: string): Promise<{
  close: number;
  at: string;
  run_id: string;
} | null> {
  const { runs } = await queryRuns({ ticker, limit: 1, offset: 0 });
  const run = runs[0];
  if (!run) return null;
  const closes = run.payload.close;
  const dates = run.payload.dates;
  if (!closes?.length) return null;
  // Find last finite close (data sometimes has nulls at the tail).
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) {
      return { close: c, at: dates[i] ?? run.created_at, run_id: run.id };
    }
  }
  return null;
}

function classify(entry: WatchlistEntry, close: number): CheckRow["status"] {
  if (entry.target_high === null && entry.target_low === null) return "no_targets";
  if (entry.target_high !== null && close >= entry.target_high) return "above_high";
  if (entry.target_low !== null && close <= entry.target_low) return "below_low";
  return "inside";
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const onlyAlerts = sp.get("alerts") === "1";
  const entries = await listWatchlist();
  const rows: CheckRow[] = [];
  let firedNow = 0;

  for (const entry of entries) {
    const latest = await latestCloseForTicker(entry.ticker);
    const close = latest?.close ?? null;
    const at = latest?.at ?? null;
    const run_id = latest?.run_id ?? null;
    if (close === null) {
      rows.push({
        ticker: entry.ticker,
        target_high: entry.target_high,
        target_low: entry.target_low,
        last_close: null,
        last_close_at: null,
        source_run_id: null,
        status: entry.target_high === null && entry.target_low === null ? "no_targets" : "no_data",
        crossed_now: false,
      });
      continue;
    }
    const status = classify(entry, close);
    let crossed_now = false;
    if (status === "above_high" || status === "below_low") {
      const prev = entry.last_cross;
      if (!prev || prev.side !== status) {
        crossed_now = true;
        await recordCross(entry.ticker, { side: status, price: close, at: new Date().toISOString() });
        await recordSafe({
          kind: "alert.fired",
          title: `Target cross · ${entry.ticker}`,
          body:
            status === "above_high"
              ? `last close ${close} >= target_high ${entry.target_high}`
              : `last close ${close} <= target_low ${entry.target_low}`,
          href: `/watchlist`,
        });
        firedNow++;
      }
    }
    rows.push({
      ticker: entry.ticker,
      target_high: entry.target_high,
      target_low: entry.target_low,
      last_close: close,
      last_close_at: at,
      source_run_id: run_id,
      status,
      crossed_now,
    });
  }

  const filtered = onlyAlerts
    ? rows.filter((r) => r.status === "above_high" || r.status === "below_low")
    : rows;

  return NextResponse.json({
    checked_at: new Date().toISOString(),
    count: filtered.length,
    fired_now: firedNow,
    rows: filtered,
  });
}
