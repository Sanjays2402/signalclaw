import { NextRequest, NextResponse } from "next/server";
import { listRuns } from "@/lib/runStore";
import { queryActivity } from "@/lib/activityStore";
import { buildDigest, clampDays, renderDigest } from "@/lib/digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const daysRaw = sp.get("days");
  const days = clampDays(daysRaw ?? 7);
  if (daysRaw !== null && !Number.isFinite(Number(daysRaw))) {
    return err(400, "bad_days", "days must be a number between 1 and 90");
  }
  const format = sp.get("format") ?? "json";

  // Pull a generous slice of events; queryActivity caps at 200 per page.
  // Two-day digest typically fits in 200; for longer windows we accept the
  // most recent 200 events as a bounded ceiling.
  const { events } = await queryActivity({ limit: 200 });
  const runs = await listRuns();

  const digest = buildDigest({ events, runs, days });
  const rendered = renderDigest(digest);

  if (format === "html") {
    return new NextResponse(rendered.html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (format === "text") {
    return new NextResponse(rendered.text, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.json(rendered);
}
