import { NextRequest, NextResponse } from "next/server";
import {
  listHistory,
  listAllHistory,
  eventsToCSV,
  eventsToJSON,
  eventsToMarkdown,
  normalizeTicker,
} from "@/lib/alertStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const rawTicker = sp.get("ticker");
  const ticker = rawTicker ? normalizeTicker(rawTicker) || undefined : undefined;
  const fmt = (sp.get("format") ?? "").toLowerCase();

  if (fmt === "csv" || fmt === "json" || fmt === "md" || fmt === "markdown") {
    const events = await listAllHistory({ ticker });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    if (fmt === "csv") {
      return new NextResponse(eventsToCSV(events), {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="signalclaw-alert-history-${stamp}.csv"`,
        },
      });
    }
    if (fmt === "md" || fmt === "markdown") {
      return new NextResponse(eventsToMarkdown(events), {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="signalclaw-alert-history-${stamp}.md"`,
        },
      });
    }
    return new NextResponse(eventsToJSON(events), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="signalclaw-alert-history-${stamp}.json"`,
      },
    });
  }

  const limit = Math.min(200, Math.max(1, parseInt(sp.get("limit") || "25", 10) || 25));
  const offset = Math.max(0, parseInt(sp.get("offset") || "0", 10) || 0);
  const data = await listHistory({ limit, offset, ticker });
  return NextResponse.json(data);
}
