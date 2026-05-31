import { NextRequest, NextResponse } from "next/server";
import { queryRuns, runsToCSV } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/export?format=csv|json&q=&regime=&ticker=&limit=
// Streams all matching runs (default CSV, capped at 200 runs per request).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const format = (sp.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    return NextResponse.json(
      { error: { code: "bad_format", message: "format must be csv or json" } },
      { status: 400 },
    );
  }
  const limit = Math.min(
    Math.max(Number.parseInt(sp.get("limit") ?? "200", 10) || 200, 1),
    200,
  );
  const { runs, total } = await queryRuns({
    q: sp.get("q") ?? "",
    regime: sp.get("regime") ?? "",
    ticker: sp.get("ticker") ?? "",
    limit,
    offset: 0,
  });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  if (format === "json") {
    return new NextResponse(JSON.stringify({ total, exported: runs.length, runs }, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="signalclaw-runs-${stamp}.json"`,
      },
    });
  }
  const csv = runsToCSV(runs);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="signalclaw-runs-${stamp}.csv"`,
    },
  });
}
