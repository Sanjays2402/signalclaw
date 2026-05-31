// Per-key usage analytics. Owner read.
//
// Returns a dense daily series + per-route breakdown over a window of
// N days (default 14, max RETENTION_DAYS from the store). Same admin
// gate the rest of /api/admin/keys/* uses, so in production posture the
// caller MUST present a key with the `admin` scope.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { listKeys } from "@/lib/keyStore";
import { getUsage, summarise, RETENTION_DAYS } from "@/lib/keyUsageStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/usage`;
  const gate = await requireAdmin(req, route, "GET");
  if (gate.denied) return gate.denied;

  const url = new URL(req.url);
  const rawDays = url.searchParams.get("days");
  let days = 14;
  if (rawDays !== null) {
    const n = Number(rawDays);
    if (!Number.isFinite(n) || n < 1 || n > RETENTION_DAYS) {
      return err(
        400,
        "invalid_days",
        `days must be an integer in [1, ${RETENTION_DAYS}]`,
      );
    }
    days = Math.floor(n);
  }

  // Verify the key id exists at all so we return 404 instead of a
  // misleading "zero usage" empty payload.
  const all = await listKeys();
  const exists = all.some((k) => k.id === id);
  if (!exists) return err(404, "not_found", "key not found");

  const raw = await getUsage(id);
  const summary = summarise(raw, days);
  // Force the summary's key_id to the URL id even when there is no
  // recorded usage yet, so the caller always gets a canonical payload.
  summary.key_id = id;
  return NextResponse.json({
    key_id: id,
    window_days: summary.window_days,
    total_lifetime: summary.total,
    last_request_at: summary.last_request_at,
    window: {
      total: summary.window_total,
      success: summary.window_success,
      client_error: summary.window_client_error,
      server_error: summary.window_server_error,
    },
    daily: summary.daily,
    by_route: summary.by_route,
  });
}
