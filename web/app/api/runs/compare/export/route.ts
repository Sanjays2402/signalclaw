import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/runStore";
import {
  regimeMix,
  pctChange,
  mixDiff,
  isValidRunId,
  compareToCSV,
  compareExportFilename,
  type CompareMeta,
  type CompareSummary,
} from "@/lib/compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /api/runs/compare/export?a=ID&b=ID&format=csv|json
// Downloads the same summary surfaced on /compare (bars, regime, confidence,
// window return, regime mix, B minus A delta) as CSV or JSON. Same id
// validation and error codes as /api/runs/compare so callers can reuse the
// shape they already handle.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const a = (sp.get("a") ?? "").trim();
  const b = (sp.get("b") ?? "").trim();
  const format = (sp.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    return err(400, "bad_format", "format must be csv or json");
  }
  if (!a || !b) return err(400, "missing_ids", "provide a and b query params");
  if (!isValidRunId(a) || !isValidRunId(b)) {
    return err(400, "bad_id", "ids must match [A-Za-z0-9_-]{6,64}");
  }
  if (a === b) return err(400, "same_id", "a and b must be different runs");

  const [ra, rb] = await Promise.all([getRun(a), getRun(b)]);
  if (!ra) return err(404, "a_not_found", `run a=${a} not found`);
  if (!rb) return err(404, "b_not_found", `run b=${b} not found`);

  const ca = regimeMix(ra.payload);
  const cb = regimeMix(rb.payload);
  const summary: CompareSummary = {
    a: {
      bars: ra.payload.dates.length,
      mix: ca.mix,
      regime: ra.payload.snapshot?.label ?? null,
      confidence: ra.payload.snapshot?.confidence ?? null,
      pct_change: pctChange(ra.payload.close),
    },
    b: {
      bars: rb.payload.dates.length,
      mix: cb.mix,
      regime: rb.payload.snapshot?.label ?? null,
      confidence: rb.payload.snapshot?.confidence ?? null,
      pct_change: pctChange(rb.payload.close),
    },
    mix_diff: mixDiff(ca.mix, cb.mix),
  };
  const meta: CompareMeta = {
    a: { id: ra.id, label: ra.label, ticker: ra.ticker, lookback_days: ra.lookback_days, created_at: ra.created_at },
    b: { id: rb.id, label: rb.label, ticker: rb.ticker, lookback_days: rb.lookback_days, created_at: rb.created_at },
  };
  const filename = compareExportFilename(meta, format as "csv" | "json");

  if (format === "json") {
    return new NextResponse(JSON.stringify({ a: meta.a, b: meta.b, summary }, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, max-age=0, must-revalidate",
      },
    });
  }
  return new NextResponse(compareToCSV(meta, summary), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
}
