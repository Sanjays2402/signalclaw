// GET /api/admin/siem/deliveries -> recent SIEM dispatch attempts (in memory)
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { listDeliveries } from "@/lib/siemSinkStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const route = "/api/admin/siem/deliveries";
  const k = await authenticate(extractKey(req), { req });
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    if (!k || !k.scopes.includes("admin")) {
      await recordAuditEvent({ req, route, method: "GET", status: 403, key: k ?? null, reason: "forbidden:admin-required" });
      return err(403, "forbidden", "admin scope required");
    }
  }
  await recordAuditEvent({ req, route, method: "GET", status: 200, key: k ?? null });
  return NextResponse.json({ deliveries: listDeliveries() });
}
