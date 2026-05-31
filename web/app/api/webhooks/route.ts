import { NextRequest, NextResponse } from "next/server";
import { listWebhooks, createWebhook, type WebhookIn } from "@/lib/webhookStore";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/webhooks";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const { denied, key } = await requireAdmin(req, ROUTE, "GET");
  if (denied) return denied;
  const subscriptions = await listWebhooks();
  await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 200, key: key ?? null });
  return NextResponse.json({ subscriptions });
}

export async function POST(req: NextRequest) {
  const { denied, key } = await requireAdmin(req, ROUTE, "POST");
  if (denied) return denied;
  let body: WebhookIn;
  try {
    body = (await req.json()) as WebhookIn;
  } catch {
    await recordAuditEvent({ req, route: ROUTE, method: "POST", status: 400, key: key ?? null, reason: "invalid_json" });
    return err(400, "invalid_json", "Body must be JSON.");
  }
  if (!body || typeof body.url !== "string" || !body.url.trim()) {
    await recordAuditEvent({ req, route: ROUTE, method: "POST", status: 400, key: key ?? null, reason: "missing_url" });
    return err(400, "missing_url", "URL is required.");
  }
  const result = await createWebhook(body);
  if (!result.ok) {
    await recordAuditEvent({ req, route: ROUTE, method: "POST", status: 400, key: key ?? null, reason: result.code || "invalid_input" });
    return err(400, result.code || "invalid_input", result.error);
  }
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "POST",
    status: 201,
    key: key ?? null,
    details: { webhook_id: result.webhook.id, url: result.webhook.url },
  });
  return NextResponse.json(result.webhook, { status: 201 });
}
