import { NextRequest } from "next/server";
import {
  renderProm,
  classifyRoute,
  observeRequest,
  incInFlight,
  decInFlight,
} from "@/lib/metricsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Prometheus text exposition. Counters and histograms are process-local;
// scrape per replica. Cardinality is bounded by design (method + status_class
// + route_class), so this endpoint stays cheap even on long-running pods.
export async function GET(req: NextRequest) {
  const t0 = Date.now();
  incInFlight();
  try {
    const body = renderProm();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } finally {
    decInFlight();
    observeRequest({
      method: req.method,
      status: 200,
      route_class: classifyRoute("/metrics"),
      durationMs: Date.now() - t0,
    });
  }
}
