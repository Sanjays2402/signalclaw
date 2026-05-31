import { NextRequest, NextResponse } from "next/server";
import { bulkRunOp, getRun, runsToCSV, type SavedRun } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BULK = 200;

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

type BulkBody = {
  ids?: unknown;
  action?: unknown;
  tags?: unknown;
  format?: unknown;
};

// POST /api/runs/bulk
// Body: { ids: string[], action: "delete"|"pin"|"unpin"|"add_tags"|"remove_tags"|"set_tags"|"export", tags?: string[], format?: "csv"|"json" }
export async function POST(req: NextRequest) {
  let body: BulkBody;
  try {
    body = (await req.json()) as BulkBody;
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!action) return err(400, "bad_action", "action is required");

  const rawIds = Array.isArray(body.ids) ? body.ids : null;
  if (!rawIds || rawIds.length === 0) {
    return err(400, "bad_ids", "ids must be a non-empty array");
  }
  if (rawIds.length > MAX_BULK) {
    return err(400, "too_many", `ids exceeds ${MAX_BULK}`);
  }
  const ids = rawIds.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (ids.length === 0) return err(400, "bad_ids", "ids must be strings");

  // Export action: stream CSV or JSON for the given ids.
  if (action === "export") {
    const format = (typeof body.format === "string" ? body.format : "csv").toLowerCase();
    if (format !== "csv" && format !== "json") {
      return err(400, "bad_format", "format must be csv or json");
    }
    const found: SavedRun[] = [];
    for (const id of ids) {
      const r = await getRun(id);
      if (r) found.push(r);
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    if (format === "json") {
      return new NextResponse(
        JSON.stringify({ requested: ids.length, exported: found.length, runs: found }, null, 2),
        {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="signalclaw-runs-selected-${stamp}.json"`,
          },
        },
      );
    }
    return new NextResponse(runsToCSV(found), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="signalclaw-runs-selected-${stamp}.csv"`,
      },
    });
  }

  const allowed = new Set([
    "delete",
    "pin",
    "unpin",
    "add_tags",
    "remove_tags",
    "set_tags",
  ]);
  if (!allowed.has(action)) {
    return err(400, "bad_action", `action must be one of ${[...allowed, "export"].join(", ")}`);
  }

  if (action === "add_tags" || action === "remove_tags" || action === "set_tags") {
    if (!Array.isArray(body.tags)) {
      return err(400, "bad_tags", "tags must be an array of strings");
    }
  }

  const result = await bulkRunOp(
    ids,
    action as "delete" | "pin" | "unpin" | "add_tags" | "remove_tags" | "set_tags",
    body.tags,
  );

  return NextResponse.json({ ok: true, action, ...result });
}
