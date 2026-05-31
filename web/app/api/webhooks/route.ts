import { NextRequest, NextResponse } from "next/server";
import { listWebhooks, createWebhook, type WebhookIn } from "@/lib/webhookStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET() {
  const subscriptions = await listWebhooks();
  return NextResponse.json({ subscriptions });
}

export async function POST(req: NextRequest) {
  let body: WebhookIn;
  try {
    body = (await req.json()) as WebhookIn;
  } catch {
    return err(400, "invalid_json", "Body must be JSON.");
  }
  if (!body || typeof body.url !== "string" || !body.url.trim()) {
    return err(400, "missing_url", "URL is required.");
  }
  const result = await createWebhook(body);
  if (!result.ok) return err(400, "invalid_input", result.error);
  return NextResponse.json(result.webhook, { status: 201 });
}
