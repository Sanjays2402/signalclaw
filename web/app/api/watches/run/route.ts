// Scheduler entrypoint for watches. Hit from cron / Vercel scheduled fn /
// external pinger. Protected by WATCH_CRON_TOKEN (header or query) when set.
// Iterates due watches, classifies via upstream, saves a SavedRun, stamps the
// watch with last_run, and emits an activity event on regime change.
import { NextRequest, NextResponse } from "next/server";
import { listWatches, isDue, recordRunResult, type Watch } from "@/lib/watchStore";
import { createRun } from "@/lib/runStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7431";
const TIMEOUT_MS = 8000;

function unauthorized() {
  return NextResponse.json(
    { error: { code: "unauthorized", message: "Bad or missing cron token." } },
    { status: 401 },
  );
}

function checkAuth(req: NextRequest): boolean {
  const expected = process.env.WATCH_CRON_TOKEN;
  if (!expected) return true; // dev convenience: no token configured = open
  const headerTok = req.headers.get("x-cron-token") || "";
  const queryTok = new URL(req.url).searchParams.get("token") || "";
  return headerTok === expected || queryTok === expected;
}

type Tick = {
  watch_id: string;
  ticker: string;
  ok: boolean;
  run_id: string | null;
  regime: string | null;
  changed: boolean;
  error: string | null;
};

async function runOne(w: Watch): Promise<Tick> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url = `${BASE}/public/regime/demo?ticker=${encodeURIComponent(w.ticker)}&lookback_days=${w.lookback_days}`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) {
      let msg = `upstream ${res.status}`;
      try {
        const j = await res.json();
        if (j?.detail) msg = String(j.detail).slice(0, 200);
      } catch {}
      await recordRunResult(w.id, { run_id: null, regime: null, error: msg });
      return { watch_id: w.id, ticker: w.ticker, ok: false, run_id: null, regime: null, changed: false, error: msg };
    }
    const j: any = await res.json();
    const snap = j?.snapshot ?? null;
    const regime: string | null = snap?.label ?? null;
    let run_id: string | null = null;
    try {
      const saved = await createRun({
        label: `${w.label} · auto`,
        ticker: w.ticker,
        lookback_days: w.lookback_days,
        tags: ["watch", "auto"],
        payload: {
          ticker: j.ticker,
          dates: j.dates,
          close: j.close,
          regime: j.regime,
          counts: j.counts,
          snapshot: snap,
          disclaimer: j.disclaimer ?? "",
        },
      });
      run_id = saved.id;
    } catch (e: any) {
      const msg = (e && e.message) ? String(e.message).slice(0, 200) : "save failed";
      await recordRunResult(w.id, { run_id: null, regime, error: msg });
      return { watch_id: w.id, ticker: w.ticker, ok: false, run_id: null, regime, changed: false, error: msg };
    }
    const changed = !!regime && !!w.last_regime && regime !== w.last_regime;
    await recordRunResult(w.id, { run_id, regime, error: null });
    if (changed) {
      await recordSafe({
        kind: "system",
        title: `Watch · regime change ${w.ticker}`,
        body: `${w.last_regime} -> ${regime}`,
        href: `/r/${run_id}`,
      });
    }
    return { watch_id: w.id, ticker: w.ticker, ok: true, run_id, regime, changed, error: null };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "timeout" : (e?.message ? String(e.message).slice(0, 200) : "fetch failed");
    await recordRunResult(w.id, { run_id: null, regime: null, error: msg });
    return { watch_id: w.id, ticker: w.ticker, ok: false, run_id: null, regime: null, changed: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return unauthorized();
  const all = await listWatches();
  const now = new Date();
  const force = new URL(req.url).searchParams.get("force") === "1";
  const onlyId = new URL(req.url).searchParams.get("id");
  let due = onlyId
    ? all.filter((w) => w.id === onlyId)
    : all.filter((w) => (force ? w.enabled : isDue(w, now)));
  const ticks: Tick[] = [];
  for (const w of due) {
    ticks.push(await runOne(w));
  }
  return NextResponse.json({
    ran_at: now.toISOString(),
    checked: all.length,
    due: due.length,
    ticks,
  });
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return unauthorized();
  const all = await listWatches();
  const now = new Date();
  const due = all.filter((w) => isDue(w, now));
  return NextResponse.json({ now: now.toISOString(), checked: all.length, due: due.length });
}
