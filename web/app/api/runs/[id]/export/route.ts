import { NextRequest, NextResponse } from "next/server";
import { getRun, runsToCSV } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/<id>/export?format=csv|json
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const format = (req.nextUrl.searchParams.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    return NextResponse.json(
      { error: { code: "bad_format", message: "format must be csv or json" } },
      { status: 400 },
    );
  }
  const run = await getRun(id);
  if (!run) {
    return NextResponse.json(
      { error: { code: "not_found", message: "run not found" } },
      { status: 404 },
    );
  }
  const safeTicker = run.ticker.replace(/[^A-Za-z0-9._-]/g, "_");
  const base = `signalclaw-${safeTicker}-${run.id}`;
  if (format === "json") {
    return new NextResponse(JSON.stringify(run, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${base}.json"`,
      },
    });
  }
  return new NextResponse(runsToCSV([run]), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${base}.csv"`,
    },
  });
}
