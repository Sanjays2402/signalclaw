import { NextRequest, NextResponse } from "next/server";
import { rotateWebhookSecret, getWebhook } from "@/lib/webhookStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";
import { authenticate, extractKey } from "@/lib/keyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const route = `/api/webhooks/${id}/rotate-secret`;
  const k = await authenticate(extractKey(req));

  let body: { secret?: string; grace_seconds?: number } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key: k ?? null, reason: "invalid_json" });
    return err(400, "invalid_json", "Body must be JSON.");
  }

  const grace =
    body.grace_seconds === undefined || body.grace_seconds === null
      ? 3600
      : Number(body.grace_seconds);
  if (!Number.isFinite(grace)) {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key: k ?? null, reason: "invalid_grace" });
    return err(400, "invalid_grace", "grace_seconds must be a number.");
  }

  const before = await getWebhook(id);
  if (!before) {
    await recordAuditEvent({ req, route, method: "POST", status: 404, key: k ?? null, reason: "not_found" });
    return err(404, "not_found", "Webhook not found.");
  }

  const result = await rotateWebhookSecret(id, {
    secret: typeof body.secret === "string" ? body.secret : undefined,
    graceSeconds: Math.floor(grace),
  });
  if (!result.ok) {
    await recordAuditEvent({
      req,
      route,
      method: "POST",
      status: result.code === "invalid_grace" ? 400 : 404,
      key: k ?? null,
      reason: result.code,
    });
    return err(result.code === "invalid_grace" ? 400 : 404, result.code, result.message);
  }

  await recordAuditEvent({
    req,
    route,
    method: "POST",
    status: 200,
    key: k ?? null,
    details: {
      webhook_id: id,
      grace_seconds: result.grace_seconds,
      had_previous: Boolean(before.secret),
      rotated_at: result.webhook.secret_rotated_at,
    },
  });
  await recordSafe({
    kind: "webhook.secret_rotated",
    title: `Rotated webhook signing secret`,
    body: `${result.webhook.url} · grace ${result.grace_seconds}s`,
    href: "/webhooks",
  });

  return NextResponse.json({
    id: result.webhook.id,
    secret: result.secret,
    secret_rotated_at: result.webhook.secret_rotated_at,
    previous_secret_expires_at: result.webhook.previous_secret_expires_at,
    grace_seconds: result.grace_seconds,
  });
}
