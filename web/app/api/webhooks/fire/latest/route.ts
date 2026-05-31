import { NextResponse } from "next/server";
import { dispatchEvents, type PickEvent } from "@/lib/webhookStore";
import { queryRuns } from "@/lib/runStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Synthesize an event from the most recent saved run so users can test
// their webhook end to end without waiting for a real signal.
export async function POST() {
  const { runs } = await queryRuns({ limit: 1, offset: 0 });
  if (runs.length === 0) {
    return NextResponse.json(
      { error: { code: "no_runs", message: "Save a run first, then fire a test event." } },
      { status: 400 },
    );
  }
  const r = runs[0];
  const label = r.payload.snapshot?.label ?? "unknown";
  const asOf = r.payload.dates[r.payload.dates.length - 1] ?? new Date().toISOString().slice(0, 10);
  const events: PickEvent[] = [
    {
      kind: "entered",
      ticker: r.ticker,
      as_of: asOf,
      new_label: label,
      prior_label: null,
      score_delta: r.payload.snapshot?.confidence ?? null,
    },
  ];
  const result = await dispatchEvents(events);
  const ok = result.deliveries.filter((d) => (d.status ?? 0) >= 200 && (d.status ?? 0) < 300).length;
  const failed = result.deliveries.length - ok;
  if (result.deliveries.length > 0) {
    await recordSafe({
      kind: failed > 0 ? "webhook.failed" : "webhook.delivered",
      title:
        failed > 0
          ? `Webhook delivery had ${failed} failure${failed === 1 ? "" : "s"}`
          : `Webhook delivered to ${ok} endpoint${ok === 1 ? "" : "s"}`,
      body: `${r.ticker} · ${label} · ${asOf}`,
      href: "/webhooks",
    });
  }
  return NextResponse.json(result);
}
