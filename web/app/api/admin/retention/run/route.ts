import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";
import { runRetentionSweep } from "@/lib/retentionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/retention/run";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  method: string,
): Promise<NextResponse | null> {
  const k = await authenticate(extractKey(req));
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method,
      status: 403,
      key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k });
  return null;
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req, "POST");
  if (denied) return denied;
  const result = await runRetentionSweep();
  await recordSafe({
    kind: "system",
    title: "Retention sweep ran",
    body: `Purged ${result.counts.runs} runs, ${result.counts.audit} audit, ${result.counts.webhook_deliveries} deliveries.`,
    href: "/settings/retention",
  });
  return NextResponse.json(result);
}
