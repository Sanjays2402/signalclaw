import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import {
  listWatchlist,
  addTicker,
  normalizeTicker,
  normalizeNote,
  MAX_TICKERS,
} from "@/lib/watchlistStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /v1/watchlist
// Auth: Authorization: Bearer <key>  (read scope)
// Returns every tracked ticker in stable insertion order. Single-user
// terminal model, so there is exactly one watchlist per install.
export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req));
  if (!key) return err(401, "unauthorized", "missing or invalid api key");
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    return err(403, "forbidden", "read scope required");
  }
  const entries = await listWatchlist();
  return NextResponse.json({
    entries,
    tickers: entries.map((e) => e.ticker),
    total: entries.length,
    limit: MAX_TICKERS,
  });
}

// POST /v1/watchlist
// Auth: Authorization: Bearer <key>  (trade or admin scope)
// Body: { ticker: string, note?: string }
// Adds a ticker. Re-adding an existing ticker with a note updates the note
// and returns the same entry. Returns 409 when the watchlist is full.
export async function POST(req: NextRequest) {
  const key = await authenticate(extractKey(req));
  if (!key) return err(401, "unauthorized", "missing or invalid api key");
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    return err(403, "forbidden", "trade scope required to edit watchlist");
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  if (!body || typeof body !== "object") {
    return err(400, "bad_body", "request body must be a JSON object");
  }

  const ticker = normalizeTicker(body.ticker);
  if (!ticker) {
    return err(
      400,
      "bad_ticker",
      "ticker must be 1 to 16 chars, start with A-Z, and contain only A-Z, 0-9, dot or dash",
    );
  }
  const note = normalizeNote(body.note);

  try {
    const entry = await addTicker(ticker, note);
    await recordSafe({
      kind: "system",
      title: `Watchlist \u00b7 added ${entry.ticker} (api)`,
      body: entry.note ?? "tracked by daily pipeline",
      href: `/ticker/${entry.ticker}`,
    });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (e: any) {
    if (e?.message === "limit_reached") {
      return err(
        409,
        "limit_reached",
        `watchlist is capped at ${MAX_TICKERS} tickers`,
      );
    }
    return err(400, "bad_request", e?.message ?? "could not add ticker");
  }
}
