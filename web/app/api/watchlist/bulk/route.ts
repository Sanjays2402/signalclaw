import { NextRequest, NextResponse } from "next/server";
import { addTickersBulk, removeTickersBulk, MAX_TICKERS } from "@/lib/watchlistStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// Bulk import endpoint. Accepts either a `tickers` array of strings or a
// `text` blob (comma, whitespace, newline, semicolon separated). Returns the
// per-row outcome so the UI can report added/skipped/invalid in one pass
// without aborting on the first duplicate or bad row.
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const raw: unknown = Array.isArray(body?.tickers)
    ? body.tickers
    : typeof body?.text === "string"
      ? body.text
      : null;
  if (raw === null) {
    return err(400, "bad_request", "expected 'tickers' array or 'text' string");
  }
  try {
    const result = await addTickersBulk(raw);
    if (result.added.length > 0) {
      const preview = result.added.slice(0, 5).map((e) => e.ticker).join(", ");
      const more = result.added.length > 5 ? ` +${result.added.length - 5} more` : "";
      await recordSafe({
        kind: "system",
        title: `Watchlist · imported ${result.added.length} ticker${result.added.length === 1 ? "" : "s"}`,
        body: `${preview}${more}`,
        href: `/watchlist`,
      });
    }
    return NextResponse.json(
      {
        added: result.added,
        skipped_existing: result.skipped_existing,
        skipped_limit: result.skipped_limit,
        invalid: result.invalid,
        limit: MAX_TICKERS,
      },
      { status: 201 },
    );
  } catch (e: any) {
    return err(400, "bad_request", e?.message ?? "could not import tickers");
  }
}

// Bulk delete endpoint. Accepts a `tickers` array of strings or a `text`
// blob (same parsing as POST). Returns per-row outcome so the UI can show
// removed / not_found / invalid in one pass.
export async function DELETE(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const raw: unknown = Array.isArray(body?.tickers)
    ? body.tickers
    : typeof body?.text === "string"
      ? body.text
      : null;
  if (raw === null) {
    return err(400, "bad_request", "expected 'tickers' array or 'text' string");
  }
  try {
    const result = await removeTickersBulk(raw);
    if (result.removed.length > 0) {
      const preview = result.removed.slice(0, 5).join(", ");
      const more = result.removed.length > 5 ? ` +${result.removed.length - 5} more` : "";
      await recordSafe({
        kind: "system",
        title: `Watchlist · removed ${result.removed.length} ticker${result.removed.length === 1 ? "" : "s"}`,
        body: `${preview}${more}`,
        href: `/watchlist`,
      });
    }
    return NextResponse.json(
      {
        removed: result.removed,
        not_found: result.not_found,
        invalid: result.invalid,
        limit: MAX_TICKERS,
      },
      { status: 200 },
    );
  } catch (e: any) {
    return err(400, "bad_request", e?.message ?? "could not remove tickers");
  }
}
