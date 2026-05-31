import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { enforceRateLimit } from "@/lib/v1Guard";
import { recordAuditEvent } from "@/lib/auditStore";
import { queryRuns, runsToCSV } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /v1/runs/export?format=csv|json&q=&ticker=&regime=&limit=
// Auth: Bearer <key>  (read scope)
// Bulk export of saved runs matching the same filters as GET /v1/runs.
// Capped at 200 rows per request to keep responses bounded.
export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req), { req });
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/runs/export", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/runs/export", method: req.method, status: 403, key, reason: "forbidden:read-required" });
    return err(403, "forbidden", "read scope required");
  }
  await recordAuditEvent({ req, route: "/api/v1/runs/export", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/runs/export", async () => {

  const sp = req.nextUrl.searchParams;
  const format = (sp.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    return err(400, "bad_format", "format must be csv or json");
  }

  const requested = Number.parseInt(sp.get("limit") ?? "200", 10);
  const limit = Math.min(
    Math.max(Number.isFinite(requested) ? requested : 200, 1),
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
    return new NextResponse(
      JSON.stringify({ total, exported: runs.length, runs }, null, 2),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="signalclaw-runs-${stamp}.json"`,
        },
      },
    );
  }
  return new NextResponse(runsToCSV(runs), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="signalclaw-runs-${stamp}.csv"`,
    },
  });

  });
}
