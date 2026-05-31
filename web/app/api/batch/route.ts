import { NextRequest, NextResponse } from "next/server";
import { createRun } from "@/lib/runStore";
import {
  parseTickers,
  rowsToCSV,
  mapConcurrent,
  type BatchRow,
} from "@/lib/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7431";
const MAX_TICKERS = 50;
const CONCURRENCY = 4;

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

type ReqBody = {
  tickers?: string | string[];
  lookback_days?: number;
  save?: boolean;
  format?: "json" | "csv";
};

async function classifyOne(
  ticker: string,
  lookback: number,
  save: boolean,
  signal: AbortSignal,
): Promise<BatchRow> {
  const url = `${BASE}/public/regime/demo?ticker=${encodeURIComponent(
    ticker,
  )}&lookback_days=${lookback}`;
  try {
    const res = await fetch(url, { cache: "no-store", signal });
    if (!res.ok) {
      let msg = `upstream ${res.status}`;
      try {
        const j = await res.json();
        if (j?.detail) msg = String(j.detail).slice(0, 200);
      } catch {}
      return {
        ticker,
        ok: false,
        status: res.status,
        regime: null,
        confidence: null,
        risk_scale: null,
        as_of: null,
        run_id: null,
        error: msg,
      };
    }
    const j = await res.json();
    const snap = j?.snapshot ?? null;
    let run_id: string | null = null;
    if (save) {
      try {
        const saved = await createRun({
          label: `batch ${ticker}`,
          ticker,
          lookback_days: lookback,
          payload: {
            ticker: j.ticker,
            dates: j.dates,
            close: j.close,
            regime: j.regime,
            counts: j.counts,
            snapshot: snap,
            disclaimer: j.disclaimer ?? "",
          },
        });
        run_id = saved.id;
      } catch {
        // Persistence failure should not nuke the row.
      }
    }
    return {
      ticker,
      ok: true,
      status: 200,
      regime: snap?.label ?? null,
      confidence: snap?.confidence ?? null,
      risk_scale: snap?.risk_scale ?? null,
      as_of: snap?.as_of ?? null,
      run_id,
      error: null,
    };
  } catch (e: any) {
    return {
      ticker,
      ok: false,
      status: 0,
      regime: null,
      confidence: null,
      risk_scale: null,
      as_of: null,
      run_id: null,
      error: e?.name === "AbortError" ? "timeout" : (e?.message ?? "fetch failed"),
    };
  }
}

export async function POST(req: NextRequest) {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  const raw = Array.isArray(body.tickers)
    ? body.tickers.join(",")
    : (body.tickers ?? "");
  if (typeof raw !== "string") {
    return err(400, "bad_tickers", "tickers must be a string or string array");
  }
  const tickers = parseTickers(raw, MAX_TICKERS);
  if (tickers.length === 0) {
    return err(400, "no_tickers", "no valid tickers parsed from input");
  }

  let lookback = Number(body.lookback_days ?? 504);
  if (!Number.isFinite(lookback)) lookback = 504;
  lookback = Math.max(120, Math.min(Math.trunc(lookback), 1260));

  const save = body.save !== false; // default true
  const format = body.format === "csv" ? "csv" : "json";

  // Per-request timeout so a slow upstream cannot wedge the batch.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);

  let rows: BatchRow[];
  try {
    rows = await mapConcurrent(tickers, CONCURRENCY, (tk) =>
      classifyOne(tk, lookback, save, ctrl.signal),
    );
  } finally {
    clearTimeout(t);
  }

  const summary = {
    requested: tickers.length,
    ok: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
    lookback_days: lookback,
    saved: save,
  };

  if (format === "csv") {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new NextResponse(rowsToCSV(rows), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="signalclaw-batch-${stamp}.csv"`,
        "x-signalclaw-requested": String(summary.requested),
        "x-signalclaw-ok": String(summary.ok),
        "x-signalclaw-failed": String(summary.failed),
      },
    });
  }
  return NextResponse.json({ summary, rows });
}
