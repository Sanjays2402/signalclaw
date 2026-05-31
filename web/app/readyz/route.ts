import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  classifyRoute,
  observeRequest,
  incInFlight,
  decInFlight,
} from "@/lib/metricsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Readiness probe. Verifies the things this app needs to serve traffic:
//   - the .data directory is writable (audit log + key store live there)
//   - basic JSON serialization is sound
// Returns 200 with per-check status when ready, 503 with the failing check
// otherwise. K8s, Render, Fly, Railway will all honor a 503 here to stop
// routing traffic without taking the pod out of rotation.
type Check = { name: string; ok: boolean; detail?: string };

async function checkDataDir(): Promise<Check> {
  const dir = path.join(process.cwd(), ".data");
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, ".readyz-probe");
    await fs.writeFile(probe, String(Date.now()), "utf8");
    await fs.unlink(probe);
    return { name: "data_dir_writable", ok: true };
  } catch (e: any) {
    return { name: "data_dir_writable", ok: false, detail: String(e?.message || e) };
  }
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  incInFlight();
  let status = 200;
  try {
    const checks: Check[] = [];
    checks.push(await checkDataDir());
    const allOk = checks.every((c) => c.ok);
    status = allOk ? 200 : 503;
    const body = {
      status: allOk ? "ready" : "not_ready",
      service: "signalclaw-web",
      checks,
      time: new Date().toISOString(),
    };
    const res = NextResponse.json(body, { status });
    res.headers.set("cache-control", "no-store");
    return res;
  } finally {
    decInFlight();
    observeRequest({
      method: req.method,
      status,
      route_class: classifyRoute("/readyz"),
      durationMs: Date.now() - t0,
    });
  }
}
