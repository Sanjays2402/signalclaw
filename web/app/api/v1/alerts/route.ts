import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { enforceRateLimit } from "@/lib/v1Guard";
import { recordAuditEvent } from "@/lib/auditStore";
import { createAlert, listAlerts, MAX_ALERTS } from "@/lib/alertStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /v1/alerts
// Auth: Authorization: Bearer <key>  (read scope)
// Lists every armed alert in stable order. Single-user terminal model, so
// scope filtering is by ownership of the key, not the alert.
export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req));
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/alerts", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/alerts", method: req.method, status: 403, key, reason: "forbidden:read-required" });
    return err(403, "forbidden", "read scope required");
  }
  await recordAuditEvent({ req, route: "/api/v1/alerts", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/alerts", async () => {
  const alerts = await listAlerts();
  return NextResponse.json({
    alerts,
    total: alerts.length,
    limit: MAX_ALERTS,
  });

  });
}

// POST /v1/alerts
// Auth: Authorization: Bearer <key>  (trade or admin scope)
// Body: { ticker, condition, value, note?, cooldown_hours?, enabled? }
// Arms a new alert. Returns the persisted alert with its id and created_at.
export async function POST(req: NextRequest) {
  const key = await authenticate(extractKey(req));
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/alerts", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/alerts", method: req.method, status: 403, key, reason: "forbidden:trade-required" });
    return err(403, "forbidden", "trade scope required to arm alerts");
  }
  await recordAuditEvent({ req, route: "/api/v1/alerts", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/alerts", async () => {

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  if (!body || typeof body !== "object") {
    return err(400, "bad_body", "request body must be a JSON object");
  }

  const r = await createAlert(body);
  if (!r.ok) return err(r.status, r.err.code, r.err.message);

  await recordSafe({
    kind: "system",
    title: `Alert \u00b7 armed ${r.alert.ticker} (api)`,
    body: `${r.alert.condition} ${r.alert.value}`,
    href: "/alerts",
  });

  return NextResponse.json({ alert: r.alert }, { status: 201 });

  });
}
