import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";
import {
  getPolicy,
  setPolicy,
  runRetentionSweep,
  type PolicyUpdate,
} from "@/lib/retentionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/retention";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  method: string,
): Promise<NextResponse | null> {
  const k = await authenticate(extractKey(req), { req });
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

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req, "GET");
  if (denied) return denied;
  const policy = await getPolicy();
  return NextResponse.json({ policy });
}

export async function PUT(req: NextRequest) {
  const denied = await requireAdmin(req, "PUT");
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const update: PolicyUpdate = {};
  if (body && typeof body === "object") {
    if ("runs_days" in body) update.runs_days = body.runs_days;
    if ("audit_days" in body) update.audit_days = body.audit_days;
    if ("webhook_deliveries_days" in body)
      update.webhook_deliveries_days = body.webhook_deliveries_days;
  }
  const before = await getPolicy();
  const after = await setPolicy(update);
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "PUT",
    status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: "retention.policy.updated",
    details: {
      before: {
        runs_days: before.runs_days,
        audit_days: before.audit_days,
        webhook_deliveries_days: before.webhook_deliveries_days,
      },
      after: {
        runs_days: after.runs_days,
        audit_days: after.audit_days,
        webhook_deliveries_days: after.webhook_deliveries_days,
      },
    },
  });
  await recordSafe({
    kind: "system",
    title: "Retention policy updated",
    body: `Runs ${after.runs_days || "forever"}d, audit ${after.audit_days || "forever"}d, deliveries ${after.webhook_deliveries_days || "forever"}d.`,
    href: "/settings/retention",
  });
  return NextResponse.json({ policy: after });
}
