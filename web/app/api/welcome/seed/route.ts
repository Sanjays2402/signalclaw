import { NextResponse } from "next/server";
import { createRun } from "@/lib/runStore";
import { buildSamplePayload, normalizeSeedTicker } from "@/lib/welcomeSeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
  const ticker = normalizeSeedTicker(body?.ticker);
  const lookback_days = 120;
  const payload = buildSamplePayload(ticker, lookback_days);

  const run = await createRun({
    label: `${ticker} · welcome sample`,
    ticker,
    lookback_days,
    payload,
    tags: ["onboarding", "sample"],
  });
  return NextResponse.json({ id: run.id, label: run.label, ticker: run.ticker });
}
