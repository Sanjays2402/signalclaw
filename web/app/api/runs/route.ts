import { NextRequest, NextResponse } from "next/server";
import { createRun, listRuns } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET() {
  const runs = await listRuns();
  // Strip heavy payload in list view.
  const items = runs.map(({ id, label, ticker, lookback_days, created_at, payload }) => ({
    id,
    label,
    ticker,
    lookback_days,
    created_at,
    bars: payload.dates.length,
    regime: payload.snapshot?.label ?? null,
  }));
  return NextResponse.json({ runs: items });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const { ticker, lookback_days, payload, label } = body ?? {};
  if (typeof ticker !== "string" || ticker.length === 0 || ticker.length > 32) {
    return err(400, "bad_ticker", "ticker must be a non-empty string up to 32 chars");
  }
  if (typeof lookback_days !== "number" || lookback_days < 1 || lookback_days > 10000) {
    return err(400, "bad_lookback", "lookback_days must be a number between 1 and 10000");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.dates) ||
    !Array.isArray(payload.close) ||
    !Array.isArray(payload.regime) ||
    typeof payload.counts !== "object"
  ) {
    return err(400, "bad_payload", "payload must include dates, close, regime, counts");
  }
  if (payload.dates.length === 0) {
    return err(400, "empty_payload", "payload.dates is empty");
  }
  if (payload.dates.length > 5000) {
    return err(400, "payload_too_large", "payload.dates exceeds 5000 entries");
  }
  const safeLabel =
    typeof label === "string" && label.trim().length > 0
      ? label.trim().slice(0, 80)
      : `${ticker} · ${lookback_days}d`;
  const run = await createRun({
    label: safeLabel,
    ticker,
    lookback_days,
    payload,
  });
  return NextResponse.json({ id: run.id, label: run.label, created_at: run.created_at });
}
