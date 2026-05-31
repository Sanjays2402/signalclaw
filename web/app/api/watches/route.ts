import { NextRequest, NextResponse } from "next/server";
import { createWatch, listWatches, MAX_WATCHES } from "@/lib/watchStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET() {
  const watches = await listWatches();
  return NextResponse.json({ watches, total: watches.length, limit: MAX_WATCHES });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const r = await createWatch(body);
  if (!r.ok) return err(r.status, r.err.code, r.err.message);
  await recordSafe({
    kind: "system",
    title: `Watch · created ${r.watch.ticker}`,
    body: `every ${r.watch.cadence_hours}h, ${r.watch.lookback_days}d lookback`,
    href: "/watches",
  });
  return NextResponse.json({ watch: r.watch }, { status: 201 });
}
