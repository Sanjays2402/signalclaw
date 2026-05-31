// Scheduler entrypoint: hit this from cron / Vercel scheduled functions /
// any external pinger. Protected by DIGEST_CRON_TOKEN (header or query) when
// the env var is set. Iterates every enabled subscription, sends if due.
import { NextRequest, NextResponse } from "next/server";
import {
  buildPayload,
  isDueNow,
  listSubs,
  markDelivered,
  recordDelivery,
  signBody,
} from "@/lib/digestSubStore";
import { buildDigest, clampDays, renderDigest } from "@/lib/digest";
import { queryActivity } from "@/lib/activityStore";
import { listRuns } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 8000;

function unauthorized() {
  return NextResponse.json(
    { error: { code: "unauthorized", message: "Bad or missing cron token." } },
    { status: 401 },
  );
}

function checkAuth(req: NextRequest): boolean {
  const expected = process.env.DIGEST_CRON_TOKEN;
  if (!expected) return true; // unset = open (dev mode)
  const header = req.headers.get("x-cron-token");
  const q = req.nextUrl.searchParams.get("token");
  return header === expected || q === expected;
}

async function deliverOne(sub: Awaited<ReturnType<typeof listSubs>>[number]) {
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
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(sub.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signalclaw-event": "digest",
        "x-signalclaw-signature": signature,
      },
      body,
      signal: ctl.signal,
      cache: "no-store",
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message?.slice(0, 200) ?? "network error";
  } finally {
    clearTimeout(t);
  }
  await markDelivered(sub.id, status, error);
  await recordDelivery({
    subscription_id: sub.id,
    url: sub.url,
    status,
    error,
    attempt: 1,
    delivered_at: new Date().toISOString(),
    signature,
    cadence: sub.cadence,
    format: sub.format,
    bytes: Buffer.byteLength(body, "utf8"),
  });
  return { id: sub.id, status, error };
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return unauthorized();
  const force = req.nextUrl.searchParams.get("force") === "1";
  const subs = await listSubs();
  const due = subs.filter((s) => (force ? s.enabled : isDueNow(s)));
  const results = await Promise.all(due.map(deliverOne));
  return NextResponse.json({
    checked: subs.length,
    delivered: results.length,
    results,
  });
}

export async function GET(req: NextRequest) {
  // Convenience for cron services that only do GET.
  return POST(req);
}
