import { NextRequest, NextResponse } from "next/server";
import {
  buildPayload,
  getSub,
  markDelivered,
  recordDelivery,
  signBody,
} from "@/lib/digestSubStore";
import { buildDigest, clampDays, renderDigest } from "@/lib/digest";
import { queryActivity } from "@/lib/activityStore";
import { listRuns } from "@/lib/runStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 8000;

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function postOnce(
  url: string,
  body: string,
  signature: string,
): Promise<{ status: number | null; error: string | null }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signalclaw-event": "digest",
        "x-signalclaw-signature": signature,
        "user-agent": "SignalClawDigest/1 (+https://signalclaw.local)",
      },
      body,
      signal: ctl.signal,
      cache: "no-store",
    });
    return { status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return {
      status: null,
      error: (e as Error).message?.slice(0, 200) ?? "network error",
    };
  } finally {
    clearTimeout(t);
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sub = await getSub(id);
  if (!sub) return err(404, "not_found", "Subscription not found.");

  const days = clampDays(sub.days);
  const { events } = await queryActivity({ limit: 200 });
  const runs = await listRuns();
  const digest = buildDigest({ events, runs, days });
  const rendered = renderDigest(digest);

  const body = buildPayload(sub, {
    headline: digest.headline,
    text: rendered.text,
    html: rendered.html,
    stats: digest.stats as unknown as Record<string, number>,
    range: digest.range,
  });
  const signature = signBody(sub.secret, body);

  // One retry on transient failure (network or 5xx); 4xx never retries.
  let attempt = 1;
  let result = await postOnce(sub.url, body, signature);
  if (
    (result.status === null || (result.status >= 500 && result.status < 600))
  ) {
    await new Promise((r) => setTimeout(r, 600));
    attempt = 2;
    result = await postOnce(sub.url, body, signature);
  }

  await markDelivered(id, result.status, result.error);
  const delivery = await recordDelivery({
    subscription_id: id,
    url: sub.url,
    status: result.status,
    error: result.error,
    attempt,
    delivered_at: new Date().toISOString(),
    signature,
    cadence: sub.cadence,
    format: sub.format,
    bytes: Buffer.byteLength(body, "utf8"),
  });

  await recordSafe({
    kind: result.error ? "webhook.failed" : "webhook.delivered",
    title: result.error
      ? `Digest delivery failed: ${sub.label}`
      : `Digest delivered: ${sub.label}`,
    body: result.error
      ? `${sub.url} (attempt ${attempt}): ${result.error}`
      : `${sub.url} (${Buffer.byteLength(body, "utf8")} bytes)`,
    href: "/digest",
  });

  return NextResponse.json({
    ok: !result.error,
    attempt,
    status: result.status,
    error: result.error,
    delivery,
  });
}
