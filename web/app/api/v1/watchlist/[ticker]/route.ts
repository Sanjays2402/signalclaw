import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  removeTicker,
  updateNote,
  normalizeNote,
  normalizeTicker,
} from "@/lib/watchlistStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// PATCH /v1/watchlist/{ticker}
// Auth: Authorization: Bearer <key>  (trade or admin scope)
// Body: { note: string | null }
// Updates the note on an existing watchlist entry. Returns 404 if the
// ticker is not currently tracked.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ ticker: string }> },
) {
  const key = await authenticate(extractKey(req));
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/watchlist/[ticker]", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/watchlist/[ticker]", method: req.method, status: 403, key, reason: "forbidden:trade-required" });
    return err(403, "forbidden", "trade scope required to edit watchlist");
  }
  await recordAuditEvent({ req, route: "/api/v1/watchlist/[ticker]", method: req.method, status: 200, key });

  const { ticker } = await ctx.params;
  const t = normalizeTicker(ticker);
  if (!t) return err(400, "bad_ticker", "invalid ticker");

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  if (!body || typeof body !== "object") {
    return err(400, "bad_body", "request body must be a JSON object");
  }
  const note = normalizeNote(body.note);
  const entry = await updateNote(t, note);
  if (!entry) return err(404, "not_found", `ticker ${t} not on watchlist`);
  return NextResponse.json({ entry });
}

// DELETE /v1/watchlist/{ticker}
// Auth: Authorization: Bearer <key>  (trade or admin scope)
// Removes the ticker. Returns 404 if it was not on the watchlist.
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ ticker: string }> },
) {
  const key = await authenticate(extractKey(req));
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/watchlist/[ticker]", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/watchlist/[ticker]", method: req.method, status: 403, key, reason: "forbidden:trade-required" });
    return err(403, "forbidden", "trade scope required to edit watchlist");
  }
  await recordAuditEvent({ req, route: "/api/v1/watchlist/[ticker]", method: req.method, status: 200, key });
  const { ticker } = await ctx.params;
  const t = normalizeTicker(ticker);
  if (!t) return err(400, "bad_ticker", "invalid ticker");
  const ok = await removeTicker(t);
  if (!ok) return err(404, "not_found", `ticker ${t} not on watchlist`);
  await recordSafe({
    kind: "system",
    title: `Watchlist \u00b7 removed ${t} (api)`,
    body: "no longer tracked",
  });
  return NextResponse.json({ ok: true, ticker: t });
}
