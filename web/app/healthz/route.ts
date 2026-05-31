import { NextRequest, NextResponse } from "next/server";
import {
  classifyRoute,
  observeRequest,
  incInFlight,
  decInFlight,
} from "@/lib/metricsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness probe. Returns 200 if the process is up and the event loop is
// responsive. Intentionally does NOT touch the filesystem or any dependency,
// so a flaky disk doesn't take the pod out of rotation when it's only
// readiness that should drop.
export async function GET(req: NextRequest) {
  const t0 = Date.now();
  incInFlight();
  try {
    const body = {
      status: "ok",
      service: "signalclaw-web",
      version: process.env.npm_package_version || "0.0.0",
      uptime_seconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
    };
    const res = NextResponse.json(body, { status: 200 });
    res.headers.set("cache-control", "no-store");
    return res;
  } finally {
    decInFlight();
    observeRequest({
      method: req.method,
      status: 200,
      route_class: classifyRoute("/healthz"),
      durationMs: Date.now() - t0,
    });
  }
}
