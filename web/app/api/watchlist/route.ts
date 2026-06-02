import { NextRequest, NextResponse } from "next/server";
import {
  listWatchlist,
  addTicker,
  normalizeTicker,
  normalizeNote,
  entriesToCSV,
  entriesToMarkdown,
  MAX_TICKERS,
} from "@/lib/watchlistStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const entries = await listWatchlist();
  const fmt = (sp.get("format") ?? "").toLowerCase();
  if (fmt === "csv") {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new NextResponse(entriesToCSV(entries), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="signalclaw-watchlist-${stamp}.csv"`,
      },
    });
  }
  if (fmt === "md" || fmt === "markdown") {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new NextResponse(entriesToMarkdown(entries), {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="signalclaw-watchlist-${stamp}.md"`,
      },
    });
  }
  // Back-compat: legacy clients expected { tickers: string[] }.
  return NextResponse.json({
    tickers: entries.map((e) => e.ticker),
    entries,
    total: entries.length,
    limit: MAX_TICKERS,
  });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const ticker = normalizeTicker(body?.ticker);
  if (!ticker) {
    return err(400, "bad_ticker", "ticker must be 1 to 16 chars, A-Z, 0-9, dot or dash");
  }
  const note = normalizeNote(body?.note);
  try {
    const entry = await addTicker(ticker, note);
    await recordSafe({
      kind: "system",
      title: `Watchlist · added ${entry.ticker}`,
      body: entry.note ?? "tracked by daily pipeline",
      href: `/ticker/${entry.ticker}`,
    });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (e: any) {
    if (e?.message === "limit_reached") {
      return err(409, "limit_reached", `watchlist is capped at ${MAX_TICKERS} tickers`);
    }
    return err(400, "bad_request", e?.message ?? "could not add ticker");
  }
}
