import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { getRun, runsToCSV } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /v1/runs/:id/export?format=csv|json
// Auth: Bearer <key>  (read scope)
// Returns a downloadable CSV or JSON for a single saved run.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const key = await authenticate(extractKey(req));
  if (!key) return err(401, "unauthorized", "missing or invalid api key");
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    return err(403, "forbidden", "read scope required");
  }

  const format = (req.nextUrl.searchParams.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    return err(400, "bad_format", "format must be csv or json");
  }

  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return err(404, "not_found", "run not found");

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
