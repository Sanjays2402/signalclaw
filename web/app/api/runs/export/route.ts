import { NextRequest, NextResponse } from "next/server";
import { queryRuns, runsToCSV, runsToMarkdown } from "@/lib/runStore";
import { parseExportFormat, parseExportQuery, exportHeaders } from "@/lib/runsExportParams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/export?format=csv|json&q=&regime=&ticker=&tag=&pinned=&limit=
// Streams all matching runs (default CSV, capped at 200 runs per request).
// Honors the same filters as /api/runs so an export from the history page
// returns exactly what the user can see. Sets X-Total-Count and
// X-Exported-Count so callers can detect truncation when total > exported.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const format = parseExportFormat(sp.get("format"));
  if (!format) {
    return NextResponse.json(
      { error: { code: "bad_format", message: "format must be csv, json, or md" } },
      { status: 400 },
    );
  }
  const opts = parseExportQuery(sp);
  const { runs, total } = await queryRuns(opts);
  const headers = exportHeaders(total, runs.length, format);
  if (format === "json") {
    return new NextResponse(
      JSON.stringify({ total, exported: runs.length, truncated: runs.length < total, runs }, null, 2),
      { status: 200, headers },
    );
  }
  if (format === "md") {
    return new NextResponse(runsToMarkdown(runs), { status: 200, headers });
  }
  return new NextResponse(runsToCSV(runs), { status: 200, headers });
}
